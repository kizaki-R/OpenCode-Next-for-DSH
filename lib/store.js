import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function getHomeDir() {
  return os.homedir();
}

/**
 * Path of the credential file this plugin writes itself.
 *
 * Exposed so the web API can report and remove exactly the file this plugin
 * owns, without re-deriving `~/.dsh/...` from a URL (which would break the
 * moment `lib/` is bundled to another depth).
 */
export function defaultDshTokenPath() {
  return path.join(getHomeDir(), '.dsh', 'opencode-next.token.json');
}

export function defaultAccountsPath() {
  return path.join(getHomeDir(), '.dsh', 'opencode-next.accounts.json');
}

/** 自動切換帳號的設定檔（只有一個布林值，不含任何憑證）。 */
export function defaultAutoSwitchPath() {
  return path.join(getHomeDir(), '.dsh', 'opencode-next.autoswitch.json');
}

/**
 * 自動切換的持久化開關。
 *
 * 刻意只存 `enabled`：免費方案沒有可信的流量額度訊號，任何「帳號健康度」
 * 持久化都只會變成下一次誤判的依據。真正的觸發條件由 adapter 每次請求
 * 重新證實（同一帳號 refresh 後仍 401），不從檔案推論。
 */
export class AutoSwitchStore {
  #path;
  #defaultEnabled;
  #state;
  #loaded = false;

  constructor({ path: customPath, defaultEnabled = false } = {}) {
    this.#path = customPath || defaultAutoSwitchPath();
    this.#defaultEnabled = defaultEnabled === true;
    this.#state = { enabled: this.#defaultEnabled };
  }

  #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      if (!fs.existsSync(this.#path)) return;
      const parsed = JSON.parse(fs.readFileSync(this.#path, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return;
      this.#state = { enabled: parsed.enabled === true };
    } catch {
      // 壞掉的設定檔等同沒設定過；自動切換寧可關著，也不要因讀檔失敗而開啟。
      this.#state = { enabled: this.#defaultEnabled };
    }
  }

  get() {
    this.#load();
    return { enabled: this.#state.enabled };
  }

  set(patch = {}) {
    this.#load();
    const enabled =
      patch && patch.enabled !== undefined ? patch.enabled === true : this.#state.enabled;
    this.#state = { enabled };
    try {
      const dir = path.dirname(this.#path);
      fs.mkdirSync(dir, { recursive: true });
      const temporary = `${this.#path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, enabled }, null, 2), {
          encoding: 'utf8',
          mode: 0o600
        });
        fs.renameSync(temporary, this.#path);
      } finally {
        try {
          if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        } catch {}
      }
    } catch {
      // 寫不進去時仍套用記憶體狀態，讓同一個 process 內的行為一致；
      // 下次啟動會回到預設值。
    }
    return this.get();
  }
}

export function loadAccounts(customPath) {
  const file = customPath || defaultAccountsPath();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.accounts) || data.accounts.length === 0) return null;
    if (data.accounts.some((account) => !account || typeof account.id !== 'string' || typeof account.access !== 'string')) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 把一組 OAuth 憑證追加進帳號清單，並設為目前帳號。
 *
 * CLI 登入原本只寫舊版單一憑證檔。帳號清單存在時，解析順序會先讀它，
 * 那次登入就等於沒發生。這裡在清單已存在時追加；清單不存在就建立。
 * 相同 access token 不重複新增，只更新續期資料並切過去。
 * 檔案存在但讀不出可用清單時拒絕覆寫，避免把壞掉的檔蓋成只剩新帳號。
 */
export function appendAccountCredential(cred, { accountsPath, label } = {}) {
  if (!isOAuthAccessToken(cred?.access)) {
    throw new Error('An OpenCode OAuth token is required');
  }
  const target = accountsPath || defaultAccountsPath();
  let existing = null;
  if (fs.existsSync(target)) {
    existing = loadAccounts(target);
    if (!existing) {
      throw new Error('accounts file exists but is not a usable account list; refusing to overwrite it');
    }
  }
  const data = existing || { version: 1, activeId: null, accounts: [] };
  const orgId = typeof cred.orgId === 'string' ? cred.orgId.trim() : '';
  const match = data.accounts.find((account) => account.access === cred.access);
  if (match) {
    if (cred.refresh) match.refresh = cred.refresh;
    if (cred.expires) match.expires = cred.expires;
    if (orgId) match.orgId = orgId;
    match.lastUsedAt = Date.now();
    data.activeId = match.id;
    saveAccounts(data, target);
    return { path: target, accountId: match.id, created: false, alreadyPresent: true };
  }

  let id;
  do {
    id = `acc-${randomBytes(4).toString('hex')}`;
  } while (data.accounts.some((account) => account.id === id));
  const account = {
    id,
    label: String(label || `帳號 ${data.accounts.length + 1}`).trim() || `帳號 ${data.accounts.length + 1}`,
    access: cred.access,
    refresh: cred.refresh,
    expires: cred.expires || 0,
    addedAt: Date.now(),
    lastUsedAt: Date.now(),
    ...(orgId ? { orgId } : {})
  };
  data.accounts.push(account);
  data.activeId = id;
  saveAccounts(data, target);
  return { path: target, accountId: id, created: !existing, alreadyPresent: false };
}

export function saveAccounts(data, customPath) {
  if (!data || data.version !== 1 || !Array.isArray(data.accounts)) throw new TypeError('Invalid accounts data');
  const target = customPath || defaultAccountsPath();
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
  return target;
}

function credentialFor(account) {
  if (!account || !isOAuthAccessToken(account.access)) return null;
  return {
    access: account.access,
    refresh: account.refresh,
    expires: account.expires || 0,
    source: 'accounts',
    accountId: account.id,
    label: account.label,
    ...(account.orgId ? { orgId: account.orgId } : {})
  };
}

export function resolveFromAccounts(customPath) {
  const data = loadAccounts(customPath);
  return data ? credentialFor(data.accounts.find((a) => a.id === data.activeId)) : null;
}

export function resolveAccountById(id, customPath) {
  const data = loadAccounts(customPath);
  return data ? credentialFor(data.accounts.find((a) => a.id === id)) : null;
}

/**
 * Lightweight resolver for local OpenCode organization ID matching a specific token if provided.
 */
export function resolveLocalOrgId(accessToken) {
  const home = getHomeDir();
  const dbPath = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (!fs.existsSync(dbPath)) return null;

  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let row = null;
    if (typeof accessToken === 'string' && accessToken.startsWith('st_')) {
      row = db.prepare(
        "SELECT value FROM credential WHERE (integration_id = 'opencode' OR connector_id = 'opencode') AND value LIKE ? LIMIT 1"
      ).get(`%"${accessToken}"%`);
    }
    if (!row) {
      row = db.prepare(
        "SELECT value FROM credential WHERE integration_id = 'opencode' OR connector_id = 'opencode' ORDER BY active DESC, time_updated DESC LIMIT 1"
      ).get();
    }
    db.close();
    if (!row?.value) return null;
    const v = JSON.parse(row.value);
    return v.metadata?.orgID || v.metadata?.orgId || null;
  } catch {
    return null;
  }
}

/**
 * Resolve OpenCode OAuth credentials from local OpenCode Desktop database.
 * Returns { access, refresh, expires, source: 'local-db' } or null.
 */
export function resolveFromLocalOpenCodeDb() {
  const home = getHomeDir();
  const dbPath = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  
  if (!fs.existsSync(dbPath)) return null;

  try {
    // Try native node:sqlite DatabaseSync first
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });

    // OpenCode keeps several opencode credentials side by side: an OAuth
    // "Personal" login plus API-key entries. Its `active` flag can point at an
    // API key (which the free lane always rejects), so `active` is only a
    // tie-breaker here — an OAuth token always wins.
    const rows = db.prepare(
      "SELECT value, active, time_updated FROM credential WHERE integration_id = 'opencode' OR connector_id = 'opencode' ORDER BY time_updated DESC"
    ).all();

    db.close();

    const parsed = [];
    for (const row of rows) {
      if (!row?.value) continue;
      try {
        const v = JSON.parse(row.value);
        const access = v.access || v.access_token;
        if (!access) continue;
        const orgId = v.metadata?.orgID || v.metadata?.orgId || null;
        parsed.push({
          access,
          refresh: v.refresh || v.refresh_token,
          expires: v.expires || v.expires_at || 0,
          orgId,
          active: row.active === 1,
          oauth: isOAuthAccessToken(access),
          updated: row.time_updated ?? 0
        });
      } catch {
        // Skip malformed rows.
      }
    }

    // 1) active OAuth, 2) any OAuth, 3) active key, 4) newest key.
    const chosen =
      parsed.find((c) => c.oauth && c.active) ??
      parsed.find((c) => c.oauth) ??
      parsed.find((c) => c.active) ??
      parsed[0];

    if (chosen) {
      return {
        access: chosen.access,
        refresh: chosen.refresh,
        expires: chosen.expires,
        orgId: chosen.orgId || null,
        source: 'local-db'
      };
    }
  } catch (err) {
    // If node:sqlite is unavailable or fails, try fallback
  }

  return null;
}

/**
 * Resolve OpenCode credentials from local auth.json.
 */
export function resolveFromLocalAuthJson() {
  const home = getHomeDir();
  const authPath = path.join(home, '.local', 'share', 'opencode', 'auth.json');
  if (!fs.existsSync(authPath)) return null;

  try {
    const raw = fs.readFileSync(authPath, 'utf8');
    const data = JSON.parse(raw);
    const opencode = data.opencode;
    if (!opencode) return null;

    if (typeof opencode === 'string') {
      return { access: opencode, source: 'local-auth-json' };
    }
    if (opencode.key) {
      return { access: opencode.key, source: 'local-auth-json' };
    }
    if (opencode.access || opencode.access_token) {
      return {
        access: opencode.access || opencode.access_token,
        refresh: opencode.refresh || opencode.refresh_token,
        source: 'local-auth-json'
      };
    }
  } catch {}

  return null;
}

/**
 * Resolve credentials saved by DSH OAuth flow (~/.dsh/opencode-next.token.json).
 */
export function resolveFromDshTokenFile(customPath) {
  const tokenPath = customPath || defaultDshTokenPath();
  if (!fs.existsSync(tokenPath)) return null;

  try {
    const raw = fs.readFileSync(tokenPath, 'utf8');
    const data = JSON.parse(raw);
    if (data.access || data.access_token) {
      return {
        access: data.access || data.access_token,
        refresh: data.refresh || data.refresh_token,
        expires: data.expires || data.expires_in || 0,
        source: 'dsh-token-file',
        ...(typeof data.orgId === 'string' && data.orgId.trim() ? { orgId: data.orgId.trim() } : {})
      };
    }
  } catch {}

  return null;
}

/**
 * Save credentials obtained via DSH Device OAuth flow.
 */
export function saveDshTokenFile(tokenData, customPath) {
  const targetPath = customPath || path.join(getHomeDir(), '.dsh', 'opencode-next.token.json');
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const orgId = typeof tokenData.orgId === 'string' ? tokenData.orgId.trim() : '';
  const payload = {
    access: tokenData.access || tokenData.access_token,
    refresh: tokenData.refresh || tokenData.refresh_token,
    expires: tokenData.expires || tokenData.expires_in || 0,
    updatedAt: Date.now(),
    ...(orgId ? { orgId } : {})
  };

  const temporary = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, targetPath);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
  return targetPath;
}

/**
 * Master credential resolver prioritizing:
 * 1. Explicit DSH token file (~/.dsh/opencode-next.token.json)
 * 2. Local OpenCode Desktop DB (~/.local/share/opencode/opencode.db)
 * 3. Local OpenCode auth.json (~/.local/share/opencode/auth.json)
 *
 * Only OAuth access tokens (`st_` prefix) are accepted. An `sk_` API key is
 * rejected here on purpose: OpenCode's free lane answers `403 FreeTierError`
 * for API-key bearer auth, so falling back to one produces a misleading error
 * that looks like a plugin defect instead of a missing login.
 */
export function resolveCredential(customPath, customAccountsPath) {
  const candidates = [
    resolveFromAccounts(customAccountsPath),
    resolveFromDshTokenFile(customPath),
    resolveFromLocalOpenCodeDb(),
    resolveFromLocalAuthJson()
  ];
  for (const candidate of candidates) {
    if (candidate?.access && isOAuthAccessToken(candidate.access)) return candidate;
  }
  // No OAuth token anywhere. Keep a non-OAuth candidate only for diagnostics.
  return null;
}

/** An OpenCode OAuth access token; API keys use the `sk-` prefix. */
export function isOAuthAccessToken(token) {
  return typeof token === 'string' && token.startsWith('st_');
}

/**
 * Explain why no usable credential was found, for the adapter error message.
 */
export function describeMissingCredential() {
  const authJson = resolveFromLocalAuthJson();
  if (authJson?.access && !isOAuthAccessToken(authJson.access)) {
    return (
      'OpenCode Console is signed out: the only stored credential is an API key ' +
      `(${authJson.access.slice(0, 8)}...), and the free lane rejects API keys. ` +
      'Sign in again in OpenCode Desktop, or run `opencode-next-login` for a browser login.'
    );
  }
  return (
    'No OpenCode OAuth credential found. Sign in with OpenCode Desktop, ' +
    'or run `opencode-next-login` to authorize in a browser.'
  );
}
