import {
  OAUTH_CLIENT_ID,
  OAUTH_DEVICE_CODE_URL,
  OAUTH_DEVICE_TOKEN_URL
} from './constants.js';

/** 單次 OAuth HTTP 請求的逾時。輪詢總期限另計，不受這 15 秒限制。 */
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

function resolveTimeoutMs(options) {
  const value = options?.timeoutMs;
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_HTTP_TIMEOUT_MS;
}

function combineAbortSignals(outer, timeout) {
  if (!outer) return timeout;
  if (outer.aborted) return outer;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([outer, timeout]);
  const controller = new AbortController();
  const forward = (signal) => {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  };
  forward(outer);
  forward(timeout);
  return controller.signal;
}

function timeoutError(timeoutMs, cause) {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const error = new Error(`OpenCode request timed out after ${seconds} seconds`);
  error.name = 'TimeoutError';
  if (cause) error.cause = cause;
  return error;
}

/**
 * 給單次 fetch 加上逾時，且不讓逾時把呼叫端的取消訊號一併作廢。
 * 呼叫端已取消時原樣拋出，方便上層分辨「使用者取消」與「網路逾時」。
 */
async function fetchWithTimeout(url, init, { signal, timeoutMs } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = combineAbortSignals(signal, timeout);
  try {
    return await fetch(url, { ...init, signal: combined });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timeout.aborted || err?.name === 'TimeoutError') throw timeoutError(timeoutMs, err);
    throw err;
  }
}

/** 登入失敗要給設定頁看的訊息。取消不是失敗；權杖一律遮掉。 */
export function classifyDeviceLoginError(error) {
  if (!error) return null;
  const raw = String(error.message ?? error);
  if (error.name === 'AbortError' || /polling aborted/i.test(raw)) return null;
  let code = 'failed';
  if (error.name === 'TimeoutError' || /OpenCode request timed out/i.test(raw)) code = 'network';
  else if (/Device login timed out/i.test(raw)) code = 'timeout';
  else if (/access_denied|access denied/i.test(raw)) code = 'denied';
  else if (/expired_token|code expired|device code expired/i.test(raw)) code = 'expired';
  else if (/failed to request device code|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network/i.test(raw)) {
    code = 'network';
  }
  return { code, message: sanitizeLoginDetail(raw) };
}

function sanitizeLoginDetail(text) {
  return String(text)
    .replace(/st_[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/**
 * Step 1: Request a device code from OpenCode Console.
 * Returns { device_code, user_code, verification_url, expires_in, interval }
 */
export async function requestDeviceCode(signal, options = {}) {
  const res = await fetchWithTimeout(OAUTH_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      supports_org_scope: true
    })
  }, { signal, timeoutMs: resolveTimeoutMs(options) });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to request device code (HTTP ${res.status}): ${text}`);
  }

  const data = await res.json();
  const rawUrl = data?.verification_uri_complete || data?.verification_uri;
  if (!data?.device_code || !data?.user_code || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('Device authorization response missing required fields');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl, 'https://opencode.ai/');
  } catch {
    throw new Error(`Invalid verification URL format: ${rawUrl}`);
  }

  if (
    parsedUrl.protocol !== 'https:' ||
    !(parsedUrl.hostname === 'opencode.ai' || parsedUrl.hostname.endsWith('.opencode.ai'))
  ) {
    throw new Error(`Insecure or untrusted verification URL: ${parsedUrl.href}`);
  }

  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_url: parsedUrl.href,
    expires_in: data.expires_in || 600,
    interval: data.interval || 5
  };
}

function abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(new Error('Device login polling aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error('Device login polling aborted'));
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * Step 2: Poll OpenCode Console until user approves device code or timeout occurs.
 */
export async function pollDeviceToken(deviceCode, intervalSec = 5, timeoutSec = 600, signal, options = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let intervalMs = Math.max(2, intervalSec) * 1000;
  const timeoutMs = resolveTimeoutMs(options);

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('Device login polling aborted');
    }

    let res;
    try {
      res = await fetchWithTimeout(OAUTH_DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: OAUTH_CLIENT_ID,
          device_code: deviceCode
        })
      }, { signal, timeoutMs });
    } catch (err) {
      if (signal?.aborted) throw err;
      // 單次 HTTP 逾時或短暫斷線：保留輪詢，不把整段授權作廢。
      await abortableSleep(intervalMs, signal);
      continue;
    }

    if (res.ok) {
      const tokenData = await res.json();
      const access = tokenData.access_token || tokenData.access;
      const refresh = tokenData.refresh_token || tokenData.refresh;
      if (!access || !refresh) {
        throw new Error('Device token response did not contain access and refresh tokens');
      }
      return {
        access_token: access,
        refresh_token: refresh,
        expires_in: tokenData.expires_in || 3600,
        org_id: tokenData.org_id
      };
    }

    const body = await res.text().catch(() => '');
    let errorCode = '';
    try {
      errorCode = JSON.parse(body)?.error ?? '';
    } catch {
      // 非 JSON 的回應仍可用文字判斷 authorization_pending。
    }

    // RFC 8628: 收到 slow_down 時，輪詢間隔必須至少延長 5 秒
    const isSlowDown = errorCode === 'slow_down' || body.includes('slow_down');
    if (isSlowDown) {
      intervalMs += 5000;
    }

    const waiting =
      errorCode === 'authorization_pending' ||
      isSlowDown ||
      body.includes('authorization_pending');
    if (waiting) {
      await abortableSleep(intervalMs, signal);
      continue;
    }

    // 服務端暫時錯誤仍可重試；參數或授權錯誤要立刻回報，不能假裝在等待。
    if (res.status >= 500 || res.status === 429) {
      await abortableSleep(intervalMs, signal);
      continue;
    }

    throw new Error(`Device token polling failed with HTTP ${res.status}: ${body}`);
  }

  throw new Error(`Device login timed out after ${timeoutSec} seconds`);
}

/**
 * Refresh an expired access token using refresh_token.
 */
export async function refreshAccessToken(refreshToken, options = {}) {
  if (!refreshToken) {
    throw new Error('No refresh token provided');
  }

  const res = await fetchWithTimeout(OAUTH_DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID
    })
  }, { timeoutMs: resolveTimeoutMs(options) });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (HTTP ${res.status}): ${text}`);
  }

  const data = await res.json();
  const access = data.access_token || data.access;
  if (!access) {
    throw new Error('Token refresh response did not contain an access token');
  }
  return {
    access_token: access,
    refresh_token: data.refresh_token || data.refresh || refreshToken,
    expires_in: data.expires_in || 3600,
    org_id: data.org_id
  };
}
