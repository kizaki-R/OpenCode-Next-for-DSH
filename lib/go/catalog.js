/**
 * OpenCode Go 模型目錄正規化與隔離快取模組（Stage 1）。
 *
 * 設計規則：
 *   - 僅處理 `/inference/go/v1/models` 的正規化與 Go 專用快取。
 *   - 絕不混用免費 OAuth 的 `STATIC_FREE_MODELS` 或 `~/.dsh/opencode-oauth.models.json`。
 *   - 缺欄位不冒稱支援：未明確提供的 `limit`、`capabilities`、`modalities` 一律保留 `null`。
 *   - 快取以 `credentialFingerprint` 隔離；換 key 或停用時清除舊快取。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

function positiveIntOrNull(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function normalizeStringArrayOrNull(arr) {
  if (!Array.isArray(arr)) return null;
  const cleaned = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().toLowerCase();
    if (trimmed && !cleaned.includes(trimmed)) cleaned.push(trimmed);
  }
  return cleaned;
}

/**
 * 正規化單一 Go 模型中繼資料。
 * 涵蓋 `id`、`type`、`limit`、`capabilities` 與 `modalities`；缺欄位不冒稱支援。
 */
export function normalizeGoModel(raw, fallbackId = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawId = typeof raw.id === 'string' ? raw.id.trim() : (typeof fallbackId === 'string' ? fallbackId.trim() : '');
  if (!rawId) return null;

  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim()
    : (typeof raw.display_name === 'string' && raw.display_name.trim() ? raw.display_name.trim() : rawId);

  const type = typeof raw.type === 'string' && raw.type.trim()
    ? raw.type.trim()
    : null;

  const limit = {
    context: positiveIntOrNull(raw.limit?.context ?? raw.context_window ?? raw.contextWindow),
    output: positiveIntOrNull(raw.limit?.output ?? raw.max_output_tokens ?? raw.max_tokens),
    input: positiveIntOrNull(raw.limit?.input ?? raw.max_input_tokens)
  };

  const capObj = raw.capabilities && typeof raw.capabilities === 'object' && !Array.isArray(raw.capabilities)
    ? raw.capabilities
    : {};

  const capabilities = {
    reasoning: boolOrNull(capObj.reasoning ?? raw.reasoning),
    toolCall: boolOrNull(capObj.toolCall ?? capObj.tool_call ?? raw.toolCall ?? raw.tool_call),
    attachment: boolOrNull(capObj.attachment ?? raw.attachment),
    structuredOutput: boolOrNull(capObj.structuredOutput ?? capObj.structured_output ?? raw.structuredOutput ?? raw.structured_output),
    temperature: boolOrNull(capObj.temperature ?? raw.temperature)
  };

  const inputModalities = normalizeStringArrayOrNull(raw.modalities?.input ?? raw.inputModalities);
  const outputModalities = normalizeStringArrayOrNull(raw.modalities?.output ?? raw.outputModalities);

  const modalities = {
    input: inputModalities,
    output: outputModalities
  };

  return {
    id: rawId,
    name,
    type,
    limit,
    capabilities,
    modalities,
    status: typeof raw.status === 'string' && raw.status.trim() ? raw.status.trim() : null,
    ownedBy: typeof raw.owned_by === 'string' && raw.owned_by.trim()
      ? raw.owned_by.trim()
      : (typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim() : null)
  };
}

/**
 * 解析並正規化 `/inference/go/v1/models` 回應清單。
 */
export function normalizeGoModelsPayload(payload) {
  let entries = null;
  let keyed = false;

  if (Array.isArray(payload)) {
    entries = payload;
  } else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.data)) {
      entries = payload.data;
    } else if (Array.isArray(payload.models)) {
      entries = payload.models;
    } else if (payload.models && typeof payload.models === 'object') {
      entries = Object.entries(payload.models);
      keyed = true;
    }
  }

  if (!entries) {
    throw new TypeError('Invalid OpenCode Go models payload shape.');
  }

  const seen = new Set();
  const normalized = [];
  for (const entry of entries) {
    const item = keyed ? normalizeGoModel(entry[1], entry[0]) : normalizeGoModel(entry, null);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    normalized.push(item);
  }
  return normalized;
}

export function cloneGoModels(models) {
  if (!Array.isArray(models)) return [];
  return models.map((m) => ({
    ...m,
    limit: m.limit ? { ...m.limit } : { context: null, output: null, input: null },
    capabilities: m.capabilities
      ? { ...m.capabilities }
      : { reasoning: null, toolCall: null, attachment: null, structuredOutput: null, temperature: null },
    modalities: {
      input: Array.isArray(m.modalities?.input) ? [...m.modalities.input] : null,
      output: Array.isArray(m.modalities?.output) ? [...m.modalities.output] : null
    }
  }));
}

const INACTIVE_STATUSES = new Set(['deprecated', 'disabled', 'retired', 'inactive']);
const ELIGIBLE_CHAT_TYPES = new Set(['chat', 'chat-completions', 'text']);

function hasCatalogImageModality(inputModalities) {
  if (!Array.isArray(inputModalities)) return false;
  return inputModalities.some((entry) => {
    if (typeof entry !== 'string') return false;
    const lower = entry.trim().toLowerCase();
    return lower === 'image' || lower.startsWith('image/');
  });
}

/**
 * 評估 Go 模型是否具備進入 DSH 正式模型選單之結構資格，並回傳不合格原因碼（單一判斷來源）。
 *
 * 僅限「狀態有效、type 為 chat/chat-completions/text，且具備明確 limit.context 與 limit.output」
 * 的模型可入選；缺 type、缺上限、已下架／停用、非文字模型或其它協定一律僅供預覽。
 */
export function classifyGoPickerModel(model) {
  if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim()) {
    return { eligible: false, reasons: ['invalid-model'] };
  }
  const reasons = [];
  if (typeof model.status === 'string' && INACTIVE_STATUSES.has(model.status.trim().toLowerCase())) {
    reasons.push('inactive-status');
  }
  if (typeof model.type !== 'string' || !model.type.trim()) {
    reasons.push('missing-type');
  } else if (!ELIGIBLE_CHAT_TYPES.has(model.type.trim().toLowerCase())) {
    reasons.push('unsupported-type');
  }
  if (
    !Number.isSafeInteger(model.limit?.context) || model.limit.context <= 0
    || !Number.isSafeInteger(model.limit?.output) || model.limit.output <= 0
  ) {
    reasons.push('missing-limits');
  }
  if (
    (Array.isArray(model.modalities?.input) && !model.modalities.input.includes('text'))
    || (Array.isArray(model.modalities?.output) && model.modalities.output.length > 0 && !model.modalities.output.includes('text'))
  ) {
    reasons.push('non-text-modality');
  }
  return {
    eligible: reasons.length === 0,
    reasons
  };
}

/**
 * 判斷 Go 模型是否可於第二階段進入 DSH 正式模型選單。
 */
export function isEligibleGoPickerModel(model) {
  return classifyGoPickerModel(model).eligible;
}

/**
 * 判斷 Go 模型是否支援透過 `/inference/go/openai/v1/chat/completions` 接收圖片。
 * 須同時滿足：進選單資格，且上游目錄宣告 `image`／`image/*` 輸入模態（不限於手動白名單，未來新模型可自動支援）。
 */
export function supportsGoImageInput(model) {
  if (!isEligibleGoPickerModel(model)) return false;
  return hasCatalogImageModality(model.modalities?.input);
}

/**
 * 轉成 DSH LlmModel 描述物件。
 * 不填補預設上限；凡進選單且上游目錄宣告 `image`／`image/*` 的模型皆自動開放 `'image'` 輸入，其餘維持純文字。
 */
export function toGoPickerDescriptor(provider, model) {
  const inputModalities = supportsGoImageInput(model) ? ['text', 'image'] : ['text'];
  return {
    provider,
    id: model.id,
    name: model.name || model.id,
    inputModalities,
    context: { contextWindow: model.limit.context },
    defaultMaxTokens: model.limit.output
  };
}

export function defaultGoCachePath() {
  return path.join(os.homedir(), '.dsh', 'opencode-go.cache.json');
}

/**
 * OpenCode Go 專屬快取儲存器。
 * 絕不儲存任何明文密鑰，僅記錄 `credentialFingerprint` 與正規化後的狀態預覽。
 */
export class GoCacheStore {
  #path;

  constructor(cachePath = null) {
    this.#path = typeof cachePath === 'string' && cachePath.trim()
      ? cachePath.trim()
      : (cachePath === null ? null : defaultGoCachePath());
  }

  get path() {
    return this.#path;
  }

  read(expectedFingerprint = null) {
    if (!this.#path) return null;
    try {
      if (!fs.existsSync(this.#path)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.#path, 'utf8'));
      if (!parsed || parsed.version !== 1 || typeof parsed.credentialFingerprint !== 'string') {
        return null;
      }
      if (expectedFingerprint && parsed.credentialFingerprint !== expectedFingerprint) {
        return null;
      }
      return {
        version: 1,
        credentialFingerprint: parsed.credentialFingerprint,
        checkedAt: Number.isFinite(parsed.checkedAt) ? parsed.checkedAt : null,
        usage: parsed.usage ?? null,
        previewModels: cloneGoModels(Array.isArray(parsed.previewModels) ? parsed.previewModels : [])
      };
    } catch {
      return null;
    }
  }

  write({ credentialFingerprint, checkedAt, usage, previewModels }) {
    if (!this.#path || !credentialFingerprint) return false;
    const payload = {
      version: 1,
      credentialFingerprint,
      checkedAt: Number.isFinite(checkedAt) ? checkedAt : Date.now(),
      usage: usage ?? null,
      previewModels: cloneGoModels(previewModels)
    };
    try {
      const dir = path.dirname(this.#path);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.#path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, this.#path);
      } finally {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {}
      }
      return true;
    } catch {
      return false;
    }
  }

  clear() {
    if (!this.#path) return false;
    try {
      if (fs.existsSync(this.#path)) {
        fs.rmSync(this.#path, { force: true });
        return true;
      }
    } catch {}
    return false;
  }
}
