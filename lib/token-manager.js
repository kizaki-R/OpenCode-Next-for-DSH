import { randomBytes } from 'node:crypto';
import {
  resolveCredential,
  resolveFromLocalOpenCodeDb,
  resolveLocalOrgId,
  saveDshTokenFile,
  loadAccounts,
  saveAccounts,
  defaultAccountsPath,
  describeMissingCredential
} from './store.js';
import { refreshAccessToken } from './device-flow.js';

/** 憑證剩餘壽命低於這個秒數就視為「該換了」，與 getValidToken 共用。 */
const REFRESH_THRESHOLD_SECONDS = 300;

/** expires 可能是秒或毫秒（舊資料兩種都出現過），統一成正規化成秒。 */
function normalizeExpiry(expires) {
  const value = Number(expires);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 2000000000 ? Math.floor(value / 1000) : Math.floor(value);
}

function needsRefresh(expires) {
  const normalized = normalizeExpiry(expires);
  if (normalized <= 0) return false;
  return normalized - Math.floor(Date.now() / 1000) < REFRESH_THRESHOLD_SECONDS;
}

export class TokenManager {
  #storePath;
  #accountsPath;
  #cachedCredential = null;
  /** 憑證快照的單調版本號。每次更換目前憑證就 +1，供 CAS 判斷「還是不是同一個」。 */
  #version = 0;
  /**
   * 逐帳號的 refresh 單飛（single-flight）。
   *
   * 舊版用一個全域 #refreshPromise：A 帳號正在 refresh 時切到 B，B 的請求會
   * 直接拿到 A 的 promise，於是 A 的新 token 被當成 B 的 token 用。以帳號 id
   * 當 key 後，兩個帳號各自等待自己的結果，不可能互相冒充。
   */
  #accountRefreshes = new Map();
  /** 非帳號來源（DSH token 檔／本機 DB）的單飛；key 是當下的憑證物件本身。 */
  #credentialRefreshes = new Map();
  #refreshAccessToken;

  constructor(storePath, accountsPath, options = {}) {
    this.#storePath = storePath;
    this.#accountsPath = accountsPath || defaultAccountsPath();
    this.#refreshAccessToken =
      typeof options.refreshAccessToken === 'function' ? options.refreshAccessToken : refreshAccessToken;
  }

  #ensureImportedAccounts() {
    let data = loadAccounts(this.#accountsPath);
    if (data) return data;
    const legacy = resolveFromLocalOpenCodeDb();
    if (!legacy?.access?.startsWith('st_')) return null;
    const now = Date.now();
    const account = {
      id: `acc-${Math.random().toString(16).slice(2, 8)}`,
      label: 'OpenCode Desktop',
      access: legacy.access,
      refresh: legacy.refresh,
      expires: legacy.expires || 0,
      addedAt: now,
      lastUsedAt: now
    };
    data = { version: 1, activeId: account.id, accounts: [account] };
    saveAccounts(data, this.#accountsPath);
    return data;
  }

  /** 更換目前快取憑證，並推進版本號。所有寫入 #cachedCredential 的地方都走這裡。 */
  #setCached(credential) {
    this.#cachedCredential = credential;
    this.#version += 1;
    return credential;
  }

  /**
   * 目前憑證的不透明身分：只有版本／帳號／來源，**不含任何 token 值**。
   * adapter 用它來確認「重試的請求與當初送出的請求仍是同一個帳號」。
   */
  credentialSnapshot() {
    const credential = this.#cachedCredential;
    const isLocalDb = credential?.source === 'local-db' || credential?.label === 'OpenCode Desktop';
    return {
      version: this.#version,
      accountId: credential?.accountId ?? null,
      source: credential?.source ?? null,
      orgId: credential?.orgId || (isLocalDb ? resolveLocalOrgId() : null)
    };
  }

  /**
   * 找出已存在相同 access token 的帳號 id，供匯入去重使用。
   * 只回傳 id，不把 token 本身交給呼叫端或前端。
   */
  findAccountIdByAccess(access) {
    if (typeof access !== 'string' || access === '') return null;
    const data = this.#ensureImportedAccounts();
    return data?.accounts.find((a) => a.access === access)?.id ?? null;
  }

  listAccounts() {
    const data = this.#ensureImportedAccounts();
    const now = Math.floor(Date.now() / 1000);
    return (data?.accounts ?? []).map(({ id, label, expires }) => {
      const normalized = normalizeExpiry(expires);
      const expiresInSeconds = normalized ? normalized - now : null;
      return {
        id,
        label: label || '未命名',
        expires: normalized || null,
        expiresInSeconds,
        expired: expiresInSeconds !== null && expiresInSeconds <= 0,
        isActive: data.activeId === id,
        source: 'accounts'
      };
    });
  }

  /**
   * 切換目前帳號。
   *
   * 原子性原則：**先把目標帳號的憑證準備好，才提交 activeId**。
   * 舊版先寫 activeId 再 refresh；refresh 失敗時檔案已指向一個沒有可用 token
   * 的帳號，而且快取仍留著前一帳號的 token，下一次請求就會用錯身分。
   */
  async switchTo(id, { expectedVersion } = {}) {
    const data = this.#ensureImportedAccounts();
    const startingVersion = this.#version;
    const startingActiveId = data?.activeId ?? null;
    if (Number.isInteger(expectedVersion) && expectedVersion !== startingVersion) return null;
    const selected = data?.accounts.find((a) => a.id === id);
    if (!selected) throw new Error('Account not found');

    let credential = {
      access: selected.access,
      refresh: selected.refresh,
      expires: selected.expires,
      source: 'accounts',
      accountId: id,
      label: selected.label,
      ...(selected.orgId ? { orgId: selected.orgId } : {})
    };

    if (needsRefresh(selected.expires)) {
      if (!selected.refresh) {
        // 已過期又沒有 refresh token：切過去只會拿到一個必定被上游拒絕的
        // 憑證，不如直接說明，不要讓使用者以為切換成功。
        throw new Error('Account expired and has no refresh token; sign in again');
      }
      // 只 refresh 這個帳號；結果只寫回這個帳號自己的紀錄（見 #refreshAccount）。
      credential = await this.#refreshAccount(selected);
    }

    // refresh 期間檔案可能被別的登入／切換改寫，提交前重讀一次，避免把舊資料
    // 連同 activeId 一起蓋回去，也確保目標帳號還存在。
    const latest = loadAccounts(this.#accountsPath);
    const target = latest?.accounts.find((a) => a.id === id);
    if (!target) throw new Error('Account not found');
    // Refresh may have yielded to a manual switch, another auto-switch, or an
    // external store update. Never overwrite that newer active choice.
    if (this.#version !== startingVersion || (Number.isInteger(expectedVersion) && this.#version !== expectedVersion)) return null;
    if ((latest?.activeId ?? null) !== startingActiveId) return null;

    target.lastUsedAt = Date.now();
    latest.activeId = id;
    saveAccounts(latest, this.#accountsPath);
    this.#setCached({
      access: target.access,
      refresh: target.refresh,
      expires: target.expires,
      source: 'accounts',
      accountId: id,
      label: target.label,
      ...(target.orgId || credential.orgId ? { orgId: target.orgId || credential.orgId } : {})
    });
    return this.#cachedCredential;
  }

  /**
   * 憑證失效後切到下一個可用帳號（自動切換專用）。
   *
   * 回傳新憑證的快照（不含 token）或 null。只有「目標帳號的憑證已準備成功」
   * 才會提交 activeId；任何一步失敗都維持原本的 active account 不變。
   */
  async switchToNextAccount(currentAccountId, { version } = {}) {
    const data = this.#ensureImportedAccounts();
    if (!data || !Array.isArray(data.accounts) || data.accounts.length < 2) return null;

    // 呼叫端送出 401 的那個憑證若已經被換掉（手動切換或另一個自動切換），
    // 就不要再用舊事實去輪替，免得把使用者剛選的帳號又換走。
    if (Number.isInteger(version) && version !== this.#version) return null;

    const candidates = data.accounts.filter(
      (account) => account.id !== currentAccountId && typeof account.access === 'string' && account.access.startsWith('st_')
    );

    for (const candidate of candidates) {
      try {
        const switched = await this.switchTo(candidate.id, { expectedVersion: version });
        if (!switched) return null;
        return this.credentialSnapshot();
      } catch {
        // 目標帳號 refresh 失敗就試下一個；全部失敗則維持原帳號。
      }
    }
    return null;
  }

  addAccount(cred, label) {
    if (!cred?.access?.startsWith('st_')) throw new Error('An OpenCode OAuth token is required');
    const data = this.#ensureImportedAccounts() || { version: 1, activeId: null, accounts: [] };
    const n = data.accounts.length + 1;
    let id;
    do {
      id = `acc-${randomBytes(4).toString('hex')}`;
    } while (data.accounts.some((a) => a.id === id));

    const account = {
      id,
      label: String(label || `帳號 ${n}`).trim(),
      access: cred.access,
      refresh: cred.refresh,
      expires: cred.expires || 0,
      addedAt: Date.now(),
      lastUsedAt: Date.now(),
      ...(cred.orgId ? { orgId: cred.orgId } : {})
    };
    data.accounts.push(account);
    if (!data.activeId) data.activeId = id;
    saveAccounts(data, this.#accountsPath);
    if (data.activeId === id) {
      this.#setCached({ ...cred, source: 'accounts', accountId: id, label: account.label });
    }
    return id;
  }

  clearCache() {
    this.#setCached(null);
  }

  removeAccount(id) {
    const data = loadAccounts(this.#accountsPath);
    if (!data || data.accounts.length <= 1) throw new Error('At least one account must remain');
    data.accounts = data.accounts.filter((a) => a.id !== id);
    if (data.accounts.length === (loadAccounts(this.#accountsPath)?.accounts.length ?? 0)) {
      throw new Error('Account not found');
    }
    if (data.activeId === id) data.activeId = data.accounts[0].id;
    saveAccounts(data, this.#accountsPath);
    if (this.#cachedCredential?.accountId === id) this.#setCached(null);
    return true;
  }

  #resolveCached() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const credential = resolveCredential(this.#storePath, this.#accountsPath);
      if (credential?.access) return this.#setCached(credential);
    }
    return null;
  }

  /**
   * Returns a valid OpenCode OAuth access token.
   * Automatically resolves from local OpenCode Desktop or DSH token file,
   * and refreshes if expired or near expiration (< 5 mins).
   */
  async getValidToken() {
    if (!this.#cachedCredential?.access) {
      // resolveCredential 本身會先讀 accounts 檔；失敗再退回本機來源。
      this.#resolveCached();
    }

    if (!this.#cachedCredential?.access) {
      // Try once more in case of late file write
      this.#resolveCached();
    }

    if (!this.#cachedCredential?.access) {
      throw new Error(describeMissingCredential());
    }

    if (needsRefresh(this.#cachedCredential.expires) && this.#cachedCredential.refresh) {
      const captured = this.#cachedCredential;
      try {
        await this.refresh();
      } catch (err) {
        // 若期間已被切換到別的帳號，就不要用前一個帳號的 DB 結果蓋掉新選擇。
        if (this.#cachedCredential !== captured) {
          return this.#cachedCredential?.access ?? captured.access;
        }
        // If refresh fails, try re-reading local DB in case Desktop app already refreshed it
        const dbFresh = captured.source === 'accounts' ? null : resolveFromLocalOpenCodeDb();
        if (dbFresh?.access && dbFresh.access !== captured.access) {
          this.#setCached(dbFresh);
        } else {
          // Log and continue with existing access token as last resort
          console.warn('[dsh-opencode-oauth] Token refresh failed, trying existing token:', err.message);
        }
      }
    }

    return this.#cachedCredential.access;
  }

  /**
   * 取得「送出請求當下」的憑證與身分快照。adapter 用它把 401、refresh、
   * 切換三者綁在同一個帳號上，避免跨帳號歸因。
   */
  async acquireCredential() {
    const token = await this.getValidToken();
    return { token, ...this.credentialSnapshot() };
  }

  /**
   * 明確刷新目前憑證（公開 API，回傳 token 字串）。
   */
  async refresh() {
    let captured = this.#cachedCredential;
    if (!captured?.access) captured = this.#resolveCached();
    if (!captured?.access) throw new Error(describeMissingCredential());
    return this.#refreshCaptured(captured);
  }

  /**
   * 只刷新「送出請求時所使用」的那個憑證。
   *
   * 回傳 `{ stale: true }` 代表等待期間目前帳號已被換掉，呼叫端不該把這次
   * 刷新結果或隨後的切換歸因給原本的請求。成功時回傳新的 token 與版本，
   * 讓 adapter 能用新版本做下一次 CAS。
   */
  async refreshCredential(snapshot) {
    const captured = this.#cachedCredential;
    if (!captured?.access) throw new Error(describeMissingCredential());

    if (
      snapshot &&
      Number.isInteger(snapshot.version) &&
      snapshot.version !== this.#version
    ) {
      return { stale: true };
    }
    if (snapshot?.accountId && captured.accountId !== snapshot.accountId) {
      return { stale: true };
    }

    const token = await this.#refreshCaptured(captured);
    const current = this.#cachedCredential;
    if (!current?.access) return { stale: true };

    // 帳號來源比 accountId；非帳號來源（DB／token 檔）只能比來源。
    const sameIdentity = snapshot?.accountId
      ? current.accountId === snapshot.accountId
      : current.source === captured.source;
    if (!sameIdentity) return { stale: true };

    return {
      token,
      version: this.#version,
      accountId: current.accountId ?? null,
      source: current.source ?? null
    };
  }

  #refreshCaptured(captured) {
    if (captured.source === 'accounts' && captured.accountId) {
      return this.#refreshAccount(captured).then((credential) => credential.access);
    }

    const inFlight = this.#credentialRefreshes.get(captured);
    if (inFlight) return inFlight.then((credential) => credential.access);

    const entry = { promise: null };
    entry.promise = (async () => {
      // 先看看本機 DB 是不是已經有新 token（Desktop 可能已自行刷新）。
      const dbFresh = resolveFromLocalOpenCodeDb();
      if (dbFresh?.access && dbFresh.access !== captured.access) {
        if (this.#cachedCredential === captured) this.#setCached(dbFresh);
        return dbFresh;
      }

      if (!captured.refresh) throw new Error('Cannot refresh token: no refresh token available');
      const refreshed = await this.#refreshAccessToken(captured.refresh);
      const next = {
        access: refreshed.access_token,
        refresh: refreshed.refresh_token ?? captured.refresh,
        expires: Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600),
        source: captured.source
      };
      if (captured.source === 'dsh-token-file') saveDshTokenFile(next, this.#storePath);
      // CAS：只有目前快取仍是「我刷的那一個」才替換；期間被切換就只回傳 token
      // 給原本的請求，不覆蓋新的 active 帳號。
      if (this.#cachedCredential === captured) this.#setCached(next);
      return next;
    })();

    this.#credentialRefreshes.set(captured, entry.promise);
    entry.promise
      .catch(() => {})
      .finally(() => {
        if (this.#credentialRefreshes.get(captured) === entry.promise) {
          this.#credentialRefreshes.delete(captured);
        }
      });
    return entry.promise.then((credential) => credential.access);
  }

  /**
   * 刷新單一帳號。以 account.id 做單飛，並只把結果寫回該帳號自己的紀錄。
   * 回傳完整憑證物件（含新 access/refresh/expires 與身分）。
   */
  #refreshAccount(account) {
    if (!account.refresh) {
      return Promise.reject(new Error('Cannot refresh token: no refresh token available'));
    }

    // 呼叫端可能傳入快取憑證（身分鍵是 accountId）或帳號紀錄（身分鍵是 id）。
    // 兩者必須先正規化成同一個帳號 id，否則寫回時永遠找不到紀錄。
    const accountKey = account.id || account.accountId;
    if (!accountKey) {
      return Promise.reject(new Error('Cannot refresh token: account identity is missing'));
    }

    const inFlight = this.#accountRefreshes.get(accountKey);
    if (inFlight) return inFlight;

    const entry = { promise: null };
    entry.promise = (async () => {
      // accounts 帳號一律用自己的 refresh token 換，不採用本機 DB 的 token：
      // DB 的 token 不屬於任何已綁定帳號，拿來寫進特定帳號就是跨帳號污染。
      const refreshed = await this.#refreshAccessToken(account.refresh);
      const next = {
        access: refreshed.access_token,
        refresh: refreshed.refresh_token ?? account.refresh,
        expires: Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600),
        ...(refreshed.org_id ? { orgId: refreshed.org_id } : {})
      };

      // 只寫回這個 id 的紀錄。若等待期間帳號被刪除，什麼都不寫。
      const latest = loadAccounts(this.#accountsPath);
      const target = latest?.accounts.find((a) => a.id === accountKey);
      if (!target) throw new Error('Account not found');
      // If another writer refreshed/replaced this account while the network call
      // was pending, retain that newer record instead of overwriting it.
      if (target.access !== account.access || target.refresh !== account.refresh) {
        const newer = {
          access: target.access,
          refresh: target.refresh,
          expires: target.expires,
          source: 'accounts',
          accountId: target.id,
          label: target.label,
          ...(target.orgId ? { orgId: target.orgId } : {})
        };
        if (this.#cachedCredential === account
            || this.#cachedCredential?.accountId === accountKey) this.#setCached(newer);
        return newer;
      }
      target.access = next.access;
      target.refresh = next.refresh;
      target.expires = next.expires;
      target.lastUsedAt = Date.now();
      if (next.orgId) target.orgId = next.orgId;
      saveAccounts(latest, this.#accountsPath);

      const credential = {
        access: target.access,
        refresh: target.refresh,
        expires: target.expires,
        source: 'accounts',
        accountId: target.id,
        label: target.label,
        ...(target.orgId ? { orgId: target.orgId } : {})
      };

      // 只有這個帳號仍是目前帳號時才更新快取；否則保持別人的 active 不變。
      if (this.#cachedCredential === account
          || this.#cachedCredential?.accountId === accountKey) this.#setCached(credential);
      return credential;
    })();

    this.#accountRefreshes.set(accountKey, entry.promise);
    entry.promise
      .catch(() => {})
      .finally(() => {
        if (this.#accountRefreshes.get(accountKey) === entry.promise) {
          this.#accountRefreshes.delete(accountKey);
        }
      });
    return entry.promise;
  }

  setCredential(cred) {
    this.#setCached(cred);
    if (cred.source === 'dsh-token-file') {
      saveDshTokenFile(cred, this.#storePath);
    }
  }

  getCached() {
    return this.#cachedCredential;
  }

  /**
   * 描述目前憑證的狀態，**刻意不含 token 本身**。
   *
   * 狀態頁是在瀏覽器裡渲染的：任何它讀得到的東西都可能經由截圖或 devtools
   * 外流。所以這裡只回答「有沒有憑證、從哪裡來、什麼時候過期」，
   * 絕不回傳 access/refresh 的值。畫面要顯示「已登入」不需要看見密鑰。
   *
   * 順便重新解析一次來源，這樣使用者在 OpenCode Desktop 登入後打開狀態頁，
   * 看到的就是現在的事實，而不是外掛啟動當下的舊快取。
   */
  describeCredential() {
    let credential = this.#cachedCredential;

    if (!credential?.access) {
      try {
        credential = resolveCredential(this.#storePath);
      } catch {
        credential = null;
      }
    }

    if (!credential?.access) {
      return {
        present: false,
        source: null,
        hasRefresh: false,
        expiresAt: null,
        expiresInSeconds: null,
        expiringSoon: false,
        expired: false
      };
    }

    const normalized = normalizeExpiry(credential.expires);
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresInSeconds = normalized > 0 ? normalized - nowSec : null;

    return {
      present: true,
      source: credential.source ?? null,
      accountLabel: credential.label ?? null,
      accountCount: loadAccounts(this.#accountsPath)?.accounts.length ?? 0,
      hasRefresh: Boolean(credential.refresh),
      expiresAt: normalized > 0 ? normalized : null,
      expiresInSeconds,
      // 與 getValidToken 的門檻一致（5 分鐘），避免狀態頁顯示「正常」
      // 但下一次請求其實已經觸發刷新。
      expiringSoon: expiresInSeconds !== null && expiresInSeconds < REFRESH_THRESHOLD_SECONDS,
      expired: expiresInSeconds !== null && expiresInSeconds <= 0
    };
  }
}
