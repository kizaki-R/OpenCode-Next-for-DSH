/**
 * OpenCode Go 官方唯讀端點用戶端（Stage 1）。
 *
 * 僅存取兩個官方唯讀端點：
 *   - GET https://opencode.ai/inference/go/v1/usage
 *   - GET https://opencode.ai/inference/go/v1/models
 *
 * 安全不變式：
 *   - 固定官方目的地（`https://opencode.ai`），絕不跟隨 HTTP 重新導向。
 *   - 使用 Bearer Personal API Key 與本外掛自己的 User-Agent；不帶 `org_id` 或 OAuth 標頭。
 *   - 錯誤訊息必經脫敏處理，絕不外洩 API key。
 */

import {
  GO_REQUEST_TIMEOUT_MS,
  OPENCODE_GO_CHAT_URL,
  OPENCODE_GO_MODELS_URL,
  OPENCODE_GO_ORIGIN,
  OPENCODE_GO_USAGE_URL
} from '../constants.js';
import { redactSecret } from './credentials.js';
import { normalizeGoModelsPayload } from './catalog.js';

export class GoClientError extends Error {
  constructor(message, {
    category = 'transient',
    subCategory = null,
    status = null,
    retryable = false,
    retryAfterMs = null,
    errorType = null
  } = {}) {
    super(message);
    this.name = 'GoClientError';
    this.category = category;
    this.subCategory = subCategory;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.errorType = errorType;
  }
}

const ALLOWED_GO_PATHS = new Set([
  '/inference/go/v1/usage',
  '/inference/go/v1/models',
  '/inference/go/openai/v1/chat/completions'
]);

/**
 * 嚴格驗證目的地必須為官方 `https://opencode.ai` Go 端點。
 */
export function assertOfficialGoUrl(rawUrl, expectedPath = null) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new GoClientError('Invalid OpenCode Go endpoint URL.', {
      category: 'invalid-destination',
      retryable: false
    });
  }

  if (
    parsed.protocol !== 'https:'
    || parsed.origin !== OPENCODE_GO_ORIGIN
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || !ALLOWED_GO_PATHS.has(parsed.pathname)
    || (expectedPath && parsed.pathname !== expectedPath)
  ) {
    throw new GoClientError('Blocked non-official OpenCode Go destination URL.', {
      category: 'invalid-destination',
      retryable: false
    });
  }

  return parsed.toString();
}

function getHeaderValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === target) return v;
  }
  return null;
}

export function parseRetryAfterMs(headers, now = Date.now()) {
  const raw = getHeaderValue(headers, 'retry-after');
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - now);
  }
  return null;
}

function extractErrorMeta(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { type: null, code: null, message: '' };
  }
  try {
    const parsed = JSON.parse(rawText);
    const err = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
    const type = typeof err?.type === 'string' ? err.type : (typeof parsed?.type === 'string' ? parsed.type : null);
    const code = typeof err?.code === 'string' ? err.code : (typeof parsed?.code === 'string' ? parsed.code : null);
    const message = typeof err?.message === 'string'
      ? err.message
      : (typeof parsed?.message === 'string' ? parsed.message : rawText);
    return { type, code, message };
  } catch {
    return { type: null, code: null, message: rawText };
  }
}

const INVALID_KEY_TYPE_RE = /(?:authentication|invalid[_-]?api[_-]?key|unauthorized|auth[_-]?error|token[_-]?invalid)/i;
const INVALID_KEY_MSG_RE = /(?:invalid\s+api\s*key|invalid\s+key|api\s*key\s+(?:is\s+)?invalid|expired\s+api\s*key|revoked\s+api\s*key|unauthorized|authentication\s+failed|missing\s+bearer)/i;

const ENTITLEMENT_TYPE_RE = /(?:entitlement|subscription|no[_-]?go[_-]?plan|plan[_-]?required)/i;
const ENTITLEMENT_MSG_RE = /(?:entitlement|not\s+subscribed|no\s+active\s+subscription|subscription\s+required|subscribe\s+to\s+opencode\s+go|opencode\s+go\s+subscription|upgrade\s+to\s+(?:opencode\s+)?go|no\s+go\s+access|go\s+plan\s+required)/i;

/**
 * 區分無效 key、無 Go 權益、其他權限／政策錯誤與暫時故障。
 */
export function classifyGoHttpFailure(status, rawText = '', headers = null, activeKey = '') {
  const { type, code, message } = extractErrorMeta(rawText);
  const safeMessage = redactSecret(String(message || '').trim(), activeKey).slice(0, 300);
  const combinedTag = `${type || ''} ${code || ''}`.trim();

  if (status >= 300 && status < 400) {
    return new GoClientError('OpenCode Go blocked an unexpected HTTP redirect.', {
      category: 'redirect-blocked',
      subCategory: 'http-redirect',
      status,
      retryable: false,
      errorType: type
    });
  }

  if (
    status === 401
    || ((status === 400 || status === 403) && (INVALID_KEY_TYPE_RE.test(combinedTag) || INVALID_KEY_MSG_RE.test(safeMessage)))
  ) {
    return new GoClientError(
      safeMessage || 'OpenCode Go API key is invalid or revoked.',
      {
        category: 'invalid-key',
        subCategory: 'unauthorized',
        status,
        retryable: false,
        errorType: type
      }
    );
  }

  if (
    (status === 403 || status === 402)
    && (ENTITLEMENT_TYPE_RE.test(combinedTag) || ENTITLEMENT_MSG_RE.test(safeMessage))
  ) {
    return new GoClientError(
      safeMessage || 'This workspace does not have an active OpenCode Go subscription.',
      {
        category: 'no-entitlement',
        subCategory: 'entitlement-required',
        status,
        retryable: false,
        errorType: type
      }
    );
  }

  if (status === 403) {
    const lower = `${combinedTag} ${safeMessage}`.toLowerCase();
    let subCategory = 'policy-denied';
    if (lower.includes('region') || lower.includes('country') || lower.includes('geo')) {
      subCategory = 'region-restricted';
    } else if (lower.includes('privacy') || lower.includes('data policy') || lower.includes('zero data retention')) {
      subCategory = 'privacy-policy';
    } else if (lower.includes('network') || lower.includes('abusive') || lower.includes('ip address')) {
      subCategory = 'network-policy';
    } else if (lower.includes('scope') || lower.includes('permission') || lower.includes('models')) {
      subCategory = 'scope-denied';
    }

    return new GoClientError(
      safeMessage || 'OpenCode Go rejected this request due to workspace permissions or policy.',
      {
        category: 'permission-policy',
        subCategory,
        status,
        retryable: false,
        errorType: type
      }
    );
  }

  if (status === 429) {
    const lower = `${combinedTag} ${safeMessage}`.toLowerCase();
    const isQuota = /(?:quota|allowance|usage\s*limit|rolling|weekly|monthly|exhausted)/i.test(lower);
    const retryAfterMs = parseRetryAfterMs(headers);
    return new GoClientError(
      safeMessage || (isQuota
        ? 'OpenCode Go subscription quota reached.'
        : 'OpenCode Go rate limit reached; try again later.'),
      {
        category: 'transient',
        subCategory: isQuota ? 'quota-exceeded' : 'rate-limited',
        status,
        retryable: true,
        retryAfterMs,
        errorType: type
      }
    );
  }

  if (status === 400) {
    const lower = safeMessage.toLowerCase();
    let subCategory = 'bad-request';
    if (
      lower.includes('maximum context length')
      || lower.includes('context length')
      || lower.includes('too many tokens')
      || lower.includes('prompt is too long')
    ) {
      subCategory = 'context-overflow';
    } else if (
      lower.includes('model is unavailable')
      || lower.includes('model unavailable')
      || lower.includes('no such model')
      || lower.includes('unknown model')
    ) {
      subCategory = 'unavailable';
    }
    return new GoClientError(
      safeMessage || 'OpenCode Go rejected this request (HTTP 400).',
      {
        category: 'invalid-request',
        subCategory,
        status,
        retryable: false,
        errorType: type
      }
    );
  }

  if (status === 408 || (status >= 500 && status <= 599)) {
    return new GoClientError(
      safeMessage || `OpenCode Go temporary upstream failure (HTTP ${status}).`,
      {
        category: 'transient',
        subCategory: status === 408 ? 'timeout' : 'upstream-error',
        status,
        retryable: true,
        errorType: type
      }
    );
  }

  return new GoClientError(
    safeMessage || `OpenCode Go request failed (HTTP ${status}).`,
    {
      category: 'invalid-response',
      subCategory: status === 404 ? 'endpoint-not-found' : 'http-error',
      status,
      retryable: false,
      errorType: type
    }
  );
}

function normalizeWindow(rawWindow) {
  if (!rawWindow || typeof rawWindow !== 'object' || Array.isArray(rawWindow)) {
    return null;
  }
  const status = typeof rawWindow.status === 'string' && rawWindow.status.trim()
    ? rawWindow.status.trim()
    : null;
  if (!status) return null;

  const percent = typeof rawWindow.percent === 'number' && Number.isFinite(rawWindow.percent) && rawWindow.percent >= 0
    ? rawWindow.percent
    : null;
  if (percent === null) return null;

  let resetsAt;
  if (rawWindow.resetsAt === null) {
    resetsAt = null;
  } else if (typeof rawWindow.resetsAt === 'string' && rawWindow.resetsAt.trim()) {
    const trimmed = rawWindow.resetsAt.trim();
    if (!Number.isFinite(Date.parse(trimmed))) return null;
    resetsAt = trimmed;
  } else if (typeof rawWindow.resetsAt === 'number' && Number.isFinite(rawWindow.resetsAt)) {
    resetsAt = rawWindow.resetsAt;
  } else {
    return null;
  }

  return { status, percent, resetsAt };
}

/**
 * 正規化官方 `/inference/go/v1/usage` 回應（`usage.rolling`／`weekly`／`monthly`）。
 *
 * 合約要求：
 *   - 若明確指出未訂閱／無資格，回傳 `no-entitlement` 錯誤。
 *   - 空回應或缺少 `usage.{rolling, weekly, monthly}` 合約欄位者，回傳 `invalid-response`，
 *     不可標記已連線，也不可繼續查 `/models`。
 *   - 不從未公開欄位推定方案或 Extra Usage 已關閉。
 */
export function normalizeUsagePayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new GoClientError('Invalid OpenCode Go usage response.', {
      category: 'invalid-response',
      status: 200,
      retryable: false
    });
  }

  if (
    data.entitled === false
    || data.subscribed === false
    || data.active === false
    || data.hasSubscription === false
  ) {
    throw new GoClientError('This workspace does not have an active OpenCode Go subscription.', {
      category: 'no-entitlement',
      subCategory: 'entitlement-required',
      status: 200,
      retryable: false
    });
  }

  const usageObj = data.usage;
  if (!usageObj || typeof usageObj !== 'object' || Array.isArray(usageObj)) {
    throw new GoClientError('OpenCode Go /usage response does not match official usage contract.', {
      category: 'invalid-response',
      status: 200,
      retryable: false
    });
  }

  const rolling = normalizeWindow(usageObj.rolling);
  const weekly = normalizeWindow(usageObj.weekly);
  const monthly = normalizeWindow(usageObj.monthly);

  if (!rolling || !weekly || !monthly) {
    throw new GoClientError('OpenCode Go /usage response is missing required rolling, weekly, or monthly windows.', {
      category: 'invalid-response',
      status: 200,
      retryable: false
    });
  }

  return {
    entitled: true,
    windows: {
      rolling,
      weekly,
      monthly
    }
  };
}

function buildCombinedSignal(callerSignal, timeoutMs) {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : GO_REQUEST_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(limit);
  if (!callerSignal) {
    return { signal: timeoutSignal, dispose: () => {} };
  }
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([callerSignal, timeoutSignal]), dispose: () => {} };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(callerSignal.reason);
  const onTimeout = () => controller.abort(timeoutSignal.reason);
  if (callerSignal.aborted) controller.abort(callerSignal.reason);
  else callerSignal.addEventListener('abort', onAbort, { once: true });
  timeoutSignal.addEventListener('abort', onTimeout, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      callerSignal.removeEventListener?.('abort', onAbort);
      timeoutSignal.removeEventListener?.('abort', onTimeout);
    }
  };
}

async function performGoGet({
  url,
  expectedPath,
  key,
  fetchFn = globalThis.fetch,
  signal = undefined,
  timeoutMs = GO_REQUEST_TIMEOUT_MS,
  userAgent = 'opencode-next-go/1'
}) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new GoClientError('Missing OpenCode Go API key.', {
      category: 'invalid-key',
      retryable: false
    });
  }
  if (typeof fetchFn !== 'function') {
    throw new GoClientError('No fetch implementation available.', {
      category: 'transient',
      subCategory: 'network',
      retryable: true
    });
  }

  const targetUrl = assertOfficialGoUrl(url, expectedPath);
  const combined = buildCombinedSignal(signal, timeoutMs);

  let res;
  try {
    res = await fetchFn(targetUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': userAgent
      },
      signal: combined.signal
    });
  } catch (err) {
    if (signal?.aborted) {
      throw new GoClientError('OpenCode Go request aborted.', {
        category: 'aborted',
        retryable: false
      });
    }
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const safeMsg = redactSecret(err?.message || 'OpenCode Go network request failed.', key);
    throw new GoClientError(safeMsg, {
      category: 'transient',
      subCategory: isTimeout ? 'timeout' : 'network',
      retryable: true
    });
  } finally {
    combined.dispose();
  }

  if (res?.type === 'opaqueredirect' || res?.redirected === true || (res?.status >= 300 && res?.status < 400)) {
    throw new GoClientError('OpenCode Go blocked an unexpected HTTP redirect.', {
      category: 'redirect-blocked',
      subCategory: 'http-redirect',
      status: res?.status ?? 302,
      retryable: false
    });
  }

  if (!res?.ok) {
    let rawText = '';
    try {
      rawText = typeof res?.text === 'function' ? await res.text() : '';
    } catch {}
    throw classifyGoHttpFailure(res?.status ?? 500, rawText, res?.headers, key);
  }

  try {
    if (typeof res.json === 'function') {
      return await res.json();
    }
    const text = typeof res.text === 'function' ? await res.text() : '';
    return JSON.parse(text);
  } catch (err) {
    throw new GoClientError(
      `Invalid JSON from OpenCode Go endpoint: ${redactSecret(err?.message || 'parse error', key)}`,
      {
        category: 'invalid-response',
        status: res?.status ?? 200,
        retryable: false
      }
    );
  }
}

export async function fetchGoUsage({
  key,
  fetchFn = globalThis.fetch,
  signal = undefined,
  timeoutMs = GO_REQUEST_TIMEOUT_MS,
  userAgent = 'opencode-next-go/1',
  url = OPENCODE_GO_USAGE_URL
} = {}) {
  const payload = await performGoGet({
    url,
    expectedPath: '/inference/go/v1/usage',
    key,
    fetchFn,
    signal,
    timeoutMs,
    userAgent
  });
  return normalizeUsagePayload(payload);
}

export async function fetchGoModels({
  key,
  fetchFn = globalThis.fetch,
  signal = undefined,
  timeoutMs = GO_REQUEST_TIMEOUT_MS,
  userAgent = 'opencode-next-go/1',
  url = OPENCODE_GO_MODELS_URL
} = {}) {
  const payload = await performGoGet({
    url,
    expectedPath: '/inference/go/v1/models',
    key,
    fetchFn,
    signal,
    timeoutMs,
    userAgent
  });
  try {
    return normalizeGoModelsPayload(payload);
  } catch (err) {
    throw new GoClientError(
      redactSecret(err?.message || 'Invalid OpenCode Go models payload.', key),
      {
        category: 'invalid-response',
        status: 200,
        retryable: false
      }
    );
  }
}

/**
 * 嚴格驗證 DSH 提供的 `options.sessionId`。
 * 不使用 `session.id`、`conversationId`、首則訊息雜湊或隨機 UUID 代替。
 */
export function validateGoSessionId(options) {
  const raw = options?.sessionId;
  if (typeof raw !== 'string') {
    throw new GoClientError('OpenCode Go requires a valid DSH sessionId; missing sessionId.', {
      category: 'invalid-request',
      subCategory: 'missing-session-id',
      retryable: false
    });
  }
  const sid = raw.trim();
  if (!sid || sid.length > 256 || /[\x00-\x1f\x7f\s]/.test(sid)) {
    throw new GoClientError('OpenCode Go requires a valid DSH sessionId; invalid sessionId.', {
      category: 'invalid-request',
      subCategory: 'missing-session-id',
      retryable: false
    });
  }
  return sid;
}

/**
 * 發送單次 OpenCode Go Chat Completions SSE 請求（不重送、不跟隨重新導向）。
 */
export async function postGoChatCompletions({
  key,
  sessionId,
  payload,
  fetchFn = globalThis.fetch,
  signal = undefined,
  userAgent = 'opencode-next-go/1',
  url = OPENCODE_GO_CHAT_URL
} = {}) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new GoClientError('Missing OpenCode Go API key.', {
      category: 'invalid-key',
      retryable: false
    });
  }
  const validSessionId = validateGoSessionId({ sessionId });
  if (typeof fetchFn !== 'function') {
    throw new GoClientError('No fetch implementation available.', {
      category: 'transient',
      subCategory: 'network',
      retryable: false
    });
  }

  const targetUrl = assertOfficialGoUrl(url, '/inference/go/openai/v1/chat/completions');

  let res;
  try {
    res = await fetchFn(targetUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': userAgent,
        'x-opencode-session': validSessionId
      },
      body: JSON.stringify(payload),
      signal
    });
  } catch (err) {
    if (signal?.aborted) {
      throw err;
    }
    const safeMsg = redactSecret(err?.message || 'OpenCode Go inference transport failed.', key);
    throw new GoClientError(safeMsg, {
      category: 'transient',
      subCategory: 'network',
      retryable: false
    });
  }

  if (res?.type === 'opaqueredirect' || res?.redirected === true || (res?.status >= 300 && res?.status < 400)) {
    throw new GoClientError('OpenCode Go blocked an unexpected HTTP redirect.', {
      category: 'redirect-blocked',
      subCategory: 'http-redirect',
      status: res?.status ?? 302,
      retryable: false
    });
  }

  if (!res?.ok) {
    let rawText = '';
    try {
      rawText = typeof res?.text === 'function' ? await res.text() : '';
    } catch {}
    throw classifyGoHttpFailure(res?.status ?? 500, rawText, res?.headers, key);
  }

  if (!res.body || typeof res.body.getReader !== 'function') {
    throw new GoClientError('OpenCode Go inference response did not provide an SSE body.', {
      category: 'invalid-response',
      status: res?.status ?? 200,
      retryable: false
    });
  }

  return res;
}
