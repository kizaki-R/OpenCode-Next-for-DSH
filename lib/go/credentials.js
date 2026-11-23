/**
 * OpenCode Go 獨立憑證解析模組（Stage 1）。
 *
 * 設計界線：
 *   - 僅解析 OpenCode Console Personal API Key，不沿用免費通道的 OAuth token (`st_*`) 或 `org_id`。
 *   - 不自動匯入其他外掛的憑證，也不讀取 `opencode.db`、`auth.json` 或 `opencode-oauth.*.json`。
 *   - 優先嘗試 DSH 安全憑證服務（`ctx.get('credentials')` / `ctx.credentials`），不適用時退回環境變數。
 *   - 絕不把明文 key 寫入一般設定、狀態 API、錯誤訊息或日誌。
 */

import { createHash } from 'node:crypto';
import { GO_CREDENTIAL_ENV_VAR } from '../constants.js';

const SAFE_REF_RE = /^[A-Za-z_][A-Za-z0-9_.:/-]{0,127}$/;
const RAW_SECRET_PREFIX_RE = /^(?:sk[-_]|oc[_-]|st_|bearer\s+)/i;

/**
 * 檢查設定中的憑證參照名稱是否合法。
 * 拒絕看起來像真實 API key 或含有空白的值，避免使用者把明文 key 貼進設定檔。
 */
export function validateCredentialRef(rawRef) {
  const ref = typeof rawRef === 'string' ? rawRef.trim() : '';
  if (!ref) {
    return {
      valid: false,
      reason: 'invalid-credential-ref',
      message: 'Go credential reference is empty.'
    };
  }
  if (RAW_SECRET_PREFIX_RE.test(ref) || /\s/.test(ref) || !SAFE_REF_RE.test(ref)) {
    return {
      valid: false,
      reason: 'invalid-credential-ref',
      message: 'Invalid Go credential reference; store only a reference name, not a raw API key.'
    };
  }
  return { valid: true, ref };
}

/**
 * 產生不可逆的 key 指紋，供快取隔離與換 key 偵測使用。
 * 絕不回傳明文內容或可用於還原的片段。
 */
export function fingerprintSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/**
 * 從錯誤訊息或日誌字串移除任何可能外洩的密鑰與 Bearer 權杖。
 */
export function redactSecret(text, secret = '') {
  if (typeof text !== 'string' || text.length === 0) return '';
  let sanitized = text;
  if (typeof secret === 'string' && secret.length >= 4) {
    sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  sanitized = sanitized.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  sanitized = sanitized.replace(/\b(?:oc_[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{6,}|st_[A-Za-z0-9._-]{6,})\b/g, '[REDACTED]');
  return sanitized;
}

function extractResolvedSecret(hit) {
  if (typeof hit === 'string') return hit.trim();
  if (hit && typeof hit === 'object') {
    const raw = hit.value ?? hit.secret ?? hit.token ?? hit.apiKey ?? '';
    return typeof raw === 'string' ? raw.trim() : '';
  }
  return '';
}

function getDshCredentialService(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  try {
    const fromGet = typeof ctx.get === 'function' ? ctx.get('credentials') : null;
    const service = fromGet ?? ctx.credentials ?? null;
    if (service && typeof service === 'object') return service;
  } catch {
    // 宿主未掛載安全憑證服務時安全退回環境變數。
  }
  return null;
}

export function getDshCredentialCapabilities(ctx) {
  const service = getDshCredentialService(ctx);
  return {
    service,
    canResolve: Boolean(service && typeof service.resolve === 'function'),
    canSet: Boolean(service && typeof service.set === 'function'),
    canUnset: Boolean(service && typeof service.unset === 'function'),
    canDescribe: Boolean(service && typeof service.describe === 'function')
  };
}

function buildKeyResult({ key, source, ref, dshCredentialsAvailable, canSave = false, canClear = false }) {
  // 嚴格隔離：若誤填入 OAuth token（st_*），拒絕在 Go 通道使用，且不回顯內容。
  if (key.startsWith('st_')) {
    return {
      present: false,
      key: null,
      source,
      ref,
      fingerprint: null,
      dshCredentialsAvailable,
      canSave,
      canClear,
      error: 'invalid-credential-type',
      message: 'OpenCode Go requires an OpenCode Console Personal API Key, not an OAuth token.'
    };
  }
  return {
    present: true,
    key,
    source,
    ref,
    fingerprint: fingerprintSecret(key),
    dshCredentialsAvailable,
    canSave,
    canClear,
    error: null,
    message: null
  };
}

/**
 * 解析 OpenCode Go 憑證：
 *   1. 若 DSH 提供 `credentials` 服務且可解析 `ref`，優先採用；
 *   2. 否則退回讀取環境變數（預設 `OPENCODE_GO_API_KEY`）。
 */
export async function resolveGoCredential({
  ctx = null,
  credentialRef = GO_CREDENTIAL_ENV_VAR,
  env = process.env
} = {}) {
  const checkedRef = validateCredentialRef(credentialRef || GO_CREDENTIAL_ENV_VAR);
  if (!checkedRef.valid) {
    return {
      present: false,
      key: null,
      source: null,
      ref: null,
      fingerprint: null,
      dshCredentialsAvailable: false,
      canSave: false,
      canClear: false,
      error: checkedRef.reason,
      message: checkedRef.message
    };
  }

  const ref = checkedRef.ref;
  const { service, canResolve, canSet, canUnset, canDescribe } = getDshCredentialCapabilities(ctx);
  const dshCredentialsAvailable = canResolve;

  if (canDescribe) {
    try {
      await service.describe(ref);
    } catch {
      // describe 失敗不阻斷後續 resolve 或環境變數退路。
    }
  }

  if (canResolve) {
    try {
      const hit = await service.resolve(ref);
      const key = extractResolvedSecret(hit);
      if (key) {
        return buildKeyResult({
          key,
          source: 'dsh-credentials',
          ref,
          dshCredentialsAvailable,
          canSave: canSet,
          canClear: canUnset
        });
      }
    } catch (err) {
      return {
        present: false,
        key: null,
        source: 'dsh-credentials',
        ref,
        fingerprint: null,
        dshCredentialsAvailable,
        canSave: canSet,
        canClear: canUnset,
        error: 'credential-resolve-failed',
        message: redactSecret(err?.message || 'Could not resolve credential from DSH credential service.')
      };
    }
  }

  const envValue = env && typeof env === 'object' ? env[ref] : undefined;
  const envKey = typeof envValue === 'string' ? envValue.trim() : '';
  if (envKey) {
    return buildKeyResult({
      key: envKey,
      source: 'env',
      ref,
      dshCredentialsAvailable,
      canSave: canSet,
      canClear: canUnset
    });
  }

  return {
    present: false,
    key: null,
    source: null,
    ref,
    fingerprint: null,
    dshCredentialsAvailable,
    canSave: canSet,
    canClear: canUnset,
    error: null,
    message: null
  };
}

/**
 * 透過 DSH 安全憑證服務儲存 OpenCode Go API key。
 * 絕不將明文 key 寫入一般設定、cordis 或外掛 JSON 檔案。
 */
export async function saveGoCredential({
  ctx = null,
  credentialRef = GO_CREDENTIAL_ENV_VAR,
  key
} = {}) {
  const checkedRef = validateCredentialRef(credentialRef || GO_CREDENTIAL_ENV_VAR);
  if (!checkedRef.valid) {
    return { ok: false, error: checkedRef.reason, message: checkedRef.message };
  }

  const { service, canSet } = getDshCredentialCapabilities(ctx);
  if (!canSet) {
    return {
      ok: false,
      error: 'credentials_write_unavailable',
      message: 'DSH credential service (credentials.set) is unavailable in this process; API key was not saved.'
    };
  }

  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!trimmed) {
    return {
      ok: false,
      error: 'empty_key',
      message: 'OpenCode Go API key cannot be empty.'
    };
  }
  if (trimmed.startsWith('st_')) {
    return {
      ok: false,
      error: 'invalid_credential_type',
      message: 'OpenCode Go requires an OpenCode Console Personal API Key, not an OAuth token.'
    };
  }

  try {
    await service.set(checkedRef.ref, trimmed);
    return { ok: true, ref: checkedRef.ref, source: 'dsh-credentials' };
  } catch (err) {
    return {
      ok: false,
      error: 'credential_save_failed',
      message: redactSecret(err?.message || 'Could not save OpenCode Go API key.', trimmed)
    };
  }
}

/**
 * 透過 DSH 安全憑證服務移除已儲存的 OpenCode Go API key。
 */
export async function clearGoCredential({
  ctx = null,
  credentialRef = GO_CREDENTIAL_ENV_VAR
} = {}) {
  const checkedRef = validateCredentialRef(credentialRef || GO_CREDENTIAL_ENV_VAR);
  if (!checkedRef.valid) {
    return { ok: false, error: checkedRef.reason, message: checkedRef.message };
  }

  const { service, canUnset } = getDshCredentialCapabilities(ctx);
  if (!canUnset) {
    return {
      ok: false,
      error: 'credentials_clear_unavailable',
      message: 'DSH credential service (credentials.unset) is unavailable in this process.'
    };
  }

  try {
    await service.unset(checkedRef.ref);
    return { ok: true, ref: checkedRef.ref };
  } catch (err) {
    return {
      ok: false,
      error: 'credential_clear_failed',
      message: redactSecret(err?.message || 'Could not clear OpenCode Go API key.')
    };
  }
}

/**
 * 產生可安全回傳給設定頁／狀態 API 的憑證摘要（絕不含密鑰本體或片段）。
 */
export function describeGoCredential(resolved) {
  const present = Boolean(resolved?.present);
  return {
    present,
    source: resolved?.source ?? null,
    ref: resolved?.ref ?? null,
    fingerprint: resolved?.fingerprint ?? null,
    masked: present ? '••••' : null,
    dshCredentialsAvailable: Boolean(resolved?.dshCredentialsAvailable),
    canSave: Boolean(resolved?.canSave),
    canClear: Boolean(resolved?.canClear),
    error: resolved?.error ?? null,
    message: resolved?.message ? redactSecret(resolved.message) : null
  };
}
