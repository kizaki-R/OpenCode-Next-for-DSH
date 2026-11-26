/**
 * 同源 HTTP API：狀態頁唯一的資料來源。
 *
 * 為什麼用 HTTP 路由而不是別的綁定方式：這些路由由同一個宿主行程提供，
 * 在那個行程裡 `webServer` 一定存在（見 agy-next 與 @opencode2dsh 兩份參考實作
 * 都採同一條路）。前端因此可以只用 fetch 就拿到全部資料，不需要額外的傳輸抽象。
 *
 * 路由（全部掛在 `/opencode-next/api` 底下）：
 *   GET  status   狀態頁要顯示的所有東西，一次往返拿完
 *   POST login    開始裝置授權登入，回傳使用者代碼與驗證網址
 *   POST login/cancel 取消等待中的裝置授權
 *   POST logout   刪除本外掛自己存的憑證
 *   POST refresh  強制重新整理 access token
 *   POST probe    立即重新探測所有模型的可用性
 *   POST fallback 設定模型備援開關與前三順位
 *   POST context  設定或恢復單一模型的上下文容量
 *
 *   POST go/refresh         重新驗證 OpenCode Go 訂閱資格與模型目錄
 *   POST go/clear           清除 OpenCode Go 快取狀態
 *   POST go/credential      透過 DSH 憑證服務儲存 OpenCode Go API Key（不寫入設定檔，不回傳明文）
 *   DELETE go/credential    透過 DSH 憑證服務清除 OpenCode Go API Key
 *   POST go/credential/clear 透過 DSH 憑證服務清除 OpenCode Go API Key
 *
 * **OAuth token 只存在宿主行程；狀態 API 與瀏覽器永遠拿不到任何明文密鑰。**
 * OpenCode Go Personal API Key 若由設定頁提交，也只會交由宿主 `ctx.credentials`
 * 安全寫入／清除，絕不寫入一般設定檔、日誌或回應體；頁面永遠只看得到「已設定／未設定」與來源。
 */

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { requestDeviceCode, pollDeviceToken, classifyDeviceLoginError } from './device-flow.js';
import { describeBunEnvironment, lastInferenceReport } from './bun-transport.js';
import { defaultDshTokenPath, loadAccounts, resolveFromLocalOpenCodeDb, resolveFromLocalAuthJson, isOAuthAccessToken } from './store.js';
import { MAX_FALLBACK_MODELS, normalizeModelList } from './fallback.js';
import { redactSecret } from './go/credentials.js';

const PREFIX = '/opencode-next/api';

/**
 * 從套件資訊讀版本，而不是在這裡再寫一份。
 *
 * 手寫的副本在改版後會靜默地繼續回報舊版號，而那正是「錯誤回報裡帶著過期版本」
 * 的來源。BOM 必須先剝掉：以 UTF-8 BOM 寫出的 package.json（PowerShell 的
 * Set-Content 就會）會讓 JSON.parse 直接爆掉，然後退回 0.0.0。
 */
const VERSION = (() => {
  try {
    const manifest = fileURLToPath(new URL('../package.json', import.meta.url));
    const text = readFileSync(manifest, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(response) {
  return sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
}

/**
 * 讀完整個請求主體。
 *
 * `POST fallback` 的內容只有一組開關和三個 model id，但用暫存區塊累積而不是
 * 假設「一次就讀完」：`data` 事件可能分好幾次才把 body 送達。

 * 上限 64 KB 是刻意的防護：這支路由只接受小份 JSON，沒有理由讓任何人送一個
 * 大 body 進來佔住行程記憶體。
 */
const MAX_BODY_BYTES = 64 * 1024;

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** 目前進行中的登入（由頁面發起）。同一時間只允許一筆。 */
let pendingLogin = null;

/**
 * 背景輪詢失敗後留給設定頁的說明。
 * 只含代碼與已遮罩的短訊息，不含 access／refresh token。
 * 取消與登出會清掉，避免把使用者自己按掉的流程說成失敗。
 */
let loginError = null;

/**
 * 正在向上游索取 device code 的那個請求。
 *
 * 沒有這個的話，「檢查 pendingLogin → 索取 → 寫回 pendingLogin」之間有一個 await，
 * 兩個同時到達的登入請求會各自索取一組代碼，後寫入的那組覆蓋前面那組。使用者
 * 可能照著畫面核准了第一組，而當時追蹤的已經是第二組，於是登入看似完成卻沒有
 * 憑證。
 *
 * 存的是 Promise 而不是結果：並行的第二個請求要等第一個索取完成，然後直接重用
 * 它拿到的代碼，而不是自己也去要一組。
 */
let deviceCodeRequest = null;

/** 目前登入流程的 AbortController，讓頁面可以取消等待中的裝置授權。 */
let loginAbortController = null;

/**
 * 登入的世代編號，每次登出或取消登入加一。
 *
 * 用來擋掉這個情況：某個登入請求正在 await 索取 device code，此時使用者按下
 * 登出；該請求醒來後若照樣把 pendingLogin 寫回去，畫面就會又冒出一個「等待
 * 核准」的登入，而使用者明明已經登出。請求在開始時記下編號，寫入前比對，
 * 不一致就放棄。
 */
let loginGeneration = 0;

/**
 * 刪除本外掛自己寫下的憑證檔。
 *
 * 刻意**不動** OpenCode Desktop 的資料庫與 auth.json——那是使用者別的應用程式的
 * 資料，刪掉會造成本外掛職責之外的破壞。所以「登出」只清掉我們自己那一份；
 * 若憑證其實來自 local-db，狀態頁會明白說明必須在 OpenCode Desktop 登出。
 */
function clearOwnCredential(credentialPath) {
  const target = credentialPath || defaultDshTokenPath();

  // 這裡用 existsSync 先確認存在再刪，讓回傳值能誠實反映「到底有沒有東西被刪」。
  if (!existsSync(target)) return { removed: false, path: target };
  try {
    rmSync(target, { force: true });
    return { removed: true, path: target };
  } catch (err) {
    return { removed: false, path: target, error: err?.message ?? String(err) };
  }
}

/** 取消裝置登入，並讓已在背景等待的請求失效。 */
function cancelPendingLogin() {
  const hadPending = Boolean(pendingLogin || deviceCodeRequest || loginAbortController);
  loginGeneration++;
  pendingLogin = null;
  loginError = null;
  deviceCodeRequest = null;
  loginAbortController?.abort();
  loginAbortController = null;
  return hadPending;
}

/** 驗證請求來源是否為合法本機或 DSH 客戶端，防範跨站請求偽造（CSRF）。 */
function isAllowedLocalOrigin(originStr, hostHeader) {
  if (typeof originStr !== 'string' || !originStr.trim()) return false;
  try {
    const u = new URL(originStr);
    if (u.protocol === 'dsh-app:' || u.protocol === 'file:') return true;
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const isLoopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
      if (!isLoopback) return false;
      if (typeof hostHeader === 'string' && hostHeader.trim()) {
        const hostPort = hostHeader.includes(':') ? hostHeader.split(':')[1] : (u.protocol === 'https:' ? '443' : '80');
        const originPort = u.port || (u.protocol === 'https:' ? '443' : '80');
        return originPort === hostPort;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isAllowedLocalRequest(request) {
  const headers = request?.headers;
  if (!headers || typeof headers !== 'object') return true;

  const getHeader = (name) => {
    if (typeof headers.get === 'function') return headers.get(name);
    return headers[name.toLowerCase()] ?? headers[name];
  };

  const secFetchSite = getHeader('sec-fetch-site');
  if (
    typeof secFetchSite === 'string' &&
    secFetchSite !== '' &&
    secFetchSite !== 'same-origin' &&
    secFetchSite !== 'none'
  ) {
    return false;
  }

  const host = getHeader('host');
  const origin = getHeader('origin');
  if (typeof origin === 'string' && origin !== '' && !isAllowedLocalOrigin(origin, host)) {
    return false;
  }

  const referer = getHeader('referer');
  if (typeof referer === 'string' && referer !== '' && !isAllowedLocalOrigin(referer, host)) {
    return false;
  }

  return true;
}

/**
 * 透過 DSH 宿主 `connection.requestRejection` 執行官方准入檢查（DSH 0.2.0-rc.2+）。
 *
 * - 若宿主已提供 `connection.requestRejection`，以宿主 Host/Origin 政策與瀏覽器認證為準；
 *   拒絕時回傳 401 或 403，且拋錯時採 Fail-Closed 回傳 403，絕不洩漏內部資料。
 * - 若環境不提供 `connection` 服務（舊版 DSH 或無瀏覽器測試環境），則回報 `handled: false`，
 *   交由第二道本機來源檢查 `isAllowedLocalRequest()` 把關。
 */
function normalizeHeadersForAdmission(rawHeaders) {
  if (!rawHeaders || typeof rawHeaders !== 'object') return {};
  if (typeof rawHeaders.entries === 'function') {
    return Object.fromEntries(rawHeaders.entries());
  }
  return rawHeaders;
}

function checkConnectionAdmission(ctx, webCtx, request) {
  const connection = webCtx?.get?.('connection') ?? ctx?.get?.('connection');
  const check = connection?.requestRejection;
  if (typeof check !== 'function') {
    return { handled: false, rejection: undefined };
  }
  try {
    const rejection = check.call(connection, {
      headers: normalizeHeadersForAdmission(request?.headers)
    });
    if (rejection === 401 || rejection === 403) {
      return { handled: true, rejection };
    }
    return { handled: true, rejection: undefined };
  } catch {
    return { handled: true, rejection: 403 };
  }
}

function isCrossSiteFetch(request) {
  const headers = request?.headers;
  if (!headers || typeof headers !== 'object') return false;
  const secFetchSite = typeof headers.get === 'function'
    ? headers.get('sec-fetch-site')
    : (headers['sec-fetch-site'] ?? headers['Sec-Fetch-Site']);
  return (
    typeof secFetchSite === 'string' &&
    secFetchSite !== '' &&
    secFetchSite !== 'same-origin' &&
    secFetchSite !== 'none'
  );
}

/**
 * 註冊路由。
 *
 * 以 `ctx.inject(['webServer'], ...)` 包住：沒有 web server 的 profile（例如純
 * headless 執行）仍然載得進本外掛，只是沒有狀態頁，而不是在啟動時直接爆掉。
 * 請求進來時優先走宿主 `connection.requestRejection` 准入檢查，並保留本機來源防線。
 */
export function registerWebApi(ctx, {
  tokenManager,
  catalog,
  statusReporter,
  fallback = null,
  autoSwitch = null,
  contextWindowStore = null,
  goService = null,
  onAdaptersUpdated = null,
  config = {}
}) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: async (request, response) => {
          const admission = checkConnectionAdmission(ctx, webCtx, request);
          if (admission.rejection) {
            response.writeHead(admission.rejection, { 'cache-control': 'no-store' });
            response.end();
            return;
          }
          if (isCrossSiteFetch(request)) {
            return sendJson(response, 403, { ok: false, error: 'forbidden_origin' });
          }
          if (!admission.handled && !isAllowedLocalRequest(request)) {
            return sendJson(response, 403, { ok: false, error: 'forbidden_origin' });
          }

          const url = new URL(request.url || '/', 'http://dsh.local');
          let route = url.pathname.replace(/^\/opencode-next\/api\/?/, '');
          const addAccountLogin = route === 'accounts' && request.method === 'POST';
          if (addAccountLogin) route = 'login';

          let secretToRedact = null;
          try {
            if (route === 'accounts') {
              if (request.method === 'GET') {
                const accounts = tokenManager.listAccounts();
                return sendJson(response, 200, { ok: true, value: { accounts, activeId: accounts.find((a) => a.isActive)?.id ?? null } });
              }
              if (request.method === 'DELETE') {
                const payload = JSON.parse((await readBody(request)) || '{}');
                tokenManager.removeAccount(payload.id);
                return sendJson(response, 200, { ok: true, value: { removed: true, accounts: tokenManager.listAccounts() } });
              }
              return sendMethodNotAllowed(response);
            }
            if (route === 'accounts/switch') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              const payload = JSON.parse((await readBody(request)) || '{}');
              await tokenManager.switchTo(payload.id);
              return sendJson(response, 200, { ok: true, value: { accounts: tokenManager.listAccounts() } });
            }

            if (route === 'accounts/import-local') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);

              // 只讀取 OpenCode Desktop 的登入狀態，不修改它的資料庫或檔案。
              const local = resolveFromLocalOpenCodeDb();
              if (!local?.access) {
                const authJson = resolveFromLocalAuthJson();
                if (authJson?.access && !isOAuthAccessToken(authJson.access)) {
                  return sendJson(response, 200, {
                    ok: false,
                    error: 'api_key_only',
                    message: '本機 OpenCode 只有 API key，免費通道不接受 API key；請改用網頁登入或在 OpenCode App 內登入。'
                  });
                }
                return sendJson(response, 200, {
                  ok: false,
                  error: 'local_login_not_found',
                  message: '本機未偵測到 OpenCode App 的登入資料。請先開啟 OpenCode Desktop 完成登入，或改用「新增帳號」的網頁登入。'
                });
              }

              // 同一組本機登入重複按匯入時，不要一直新增重複帳號：
              // 已經有相同 access token 的帳號就直接切過去。
              const existingId = tokenManager.findAccountIdByAccess?.(local.access);
              if (existingId) {
                await tokenManager.switchTo(existingId);
                return sendJson(response, 200, {
                  ok: true,
                  value: { imported: false, alreadyPresent: true, accountId: existingId, accounts: tokenManager.listAccounts() }
                });
              }

              const accountId = tokenManager.addAccount({
                access: local.access,
                refresh: local.refresh,
                expires: local.expires || 0,
                orgId: local.orgId || undefined
              }, 'OpenCode Desktop');
              await tokenManager.switchTo(accountId);
              return sendJson(response, 200, {
                ok: true,
                value: { imported: true, accountId, accounts: tokenManager.listAccounts() }
              });
            }
            if (route === 'bun/rescan') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              return sendJson(response, 200, {
                ok: true,
                value: describeBunEnvironment(config.bunTransport?.bunPath, { refresh: true })
              });
            }
            if (route === '' || route === 'status') {
              if (request.method !== 'GET') return sendMethodNotAllowed(response);
              const value = {
                ...statusReporter.buildStatus(),
                bun: {
                  ...describeBunEnvironment(config.bunTransport?.bunPath),
                  enabled: config.bunTransport?.enabled === true,
                  last: lastInferenceReport()
                },
                anonymousChannel: {
                  enabled: config.anonymousChannel?.enabled === true
                },
                accounts: tokenManager.listAccounts?.() ?? [],
                version: VERSION,
                pendingLogin: pendingLogin
                  ? {
                      userCode: pendingLogin.userCode,
                      verificationUrl: pendingLogin.verificationUrl,
                      startedAt: pendingLogin.startedAt
                    }
                  : null,
                loginError: loginError
                  ? {
                      code: loginError.code,
                      message: loginError.message,
                      at: loginError.at
                    }
                  : null
              };
              return sendJson(response, 200, { ok: true, value });
            }

            if (route === 'login/cancel') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              return sendJson(response, 200, {
                ok: true,
                value: { cancelled: cancelPendingLogin() }
              });
            }

            if (route === 'login') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);

              let loginPayload = {};
              if (addAccountLogin) {
                const loginRaw = await readBody(request);
                if (loginRaw.trim()) loginPayload = JSON.parse(loginRaw);
              }
              // 已經有一筆在等就重用它：使用者連點兩下不該產生兩組裝置代碼，
              // 否則第一組會被作廢，使用者輸入到一半會突然失敗。
              if (pendingLogin) {
                return sendJson(response, 200, {
                  ok: true,
                  value: {
                    userCode: pendingLogin.userCode,
                    verificationUrl: pendingLogin.verificationUrl,
                    reused: true
                  }
                });
              }

              // 記下這一代的編號：await 期間可能發生登出或取消，屆時就不該再寫入。
              const generation = loginGeneration;

              // 另一個請求正在索取代碼：等它，然後共用同一組。這裡不能只看
              // pendingLogin，因為在索取完成之前它還是 null。
              if (deviceCodeRequest) {
                let shared = null;
                try {
                  shared = await deviceCodeRequest;
                } catch {
                  // 前一個請求索取失敗，落到下面自己重試一次。
                }
                if (generation !== loginGeneration) {
                  return sendJson(response, 200, {
                    ok: true,
                    value: { reused: false, cancelled: true }
                  });
                }
                if (shared && pendingLogin === shared) {
                  return sendJson(response, 200, {
                    ok: true,
                    value: {
                      userCode: shared.userCode,
                      verificationUrl: shared.verificationUrl,
                      reused: true
                    }
                  });
                }
              }

              const controller = new AbortController();
              loginAbortController = controller;
              // 新的一輪登入開始，舊的失敗說明不該還掛在畫面上。
              loginError = null;

              // 注意：這個變數不能叫 request——handler 的參數就叫 request，
              // 同一個區塊內宣告會遮蔽它，而上面的 request.method 檢查會踩到
              // 「宣告前使用」的錯誤。
              const deviceRequest = (async () => {
                const device = await requestDeviceCode(controller.signal);
                return {
                  deviceCode: device.device_code,
                  userCode: device.user_code,
                  verificationUrl: device.verification_url,
                  // 輪詢節奏由上游指定，一併留著；不這樣做的話後面的
                  // pollDeviceToken 就沒有間隔可用。
                  interval: device.interval,
                  expiresIn: device.expires_in,
                  startedAt: Date.now(),
                  generation,
                  label: typeof loginPayload.label === 'string' ? loginPayload.label.trim() : ''
                };
              })();
              deviceCodeRequest = deviceRequest;

              let entry;
              try {
                entry = await deviceRequest;
              } catch (error) {
                if (loginAbortController === controller) loginAbortController = null;
                if (generation !== loginGeneration) {
                  return sendJson(response, 200, {
                    ok: true,
                    value: { reused: false, cancelled: true }
                  });
                }
                return sendJson(response, 200, {
                  ok: false,
                  error: 'device_code_failed',
                  message: error?.message ?? String(error)
                });
              } finally {
                // 只在還是我這一筆時才清，免得把後續請求正在等的東西清掉。
                if (deviceCodeRequest === deviceRequest) deviceCodeRequest = null;
              }

              // 索取期間發生了登出：這組代碼已經沒人要了，不要再追蹤、也不要
              // 去輪詢它，否則會在登出後又寫回一份憑證。
              //
              // 刻意不回傳 verificationUrl：前端看到它就會開新分頁。取消的登入
              // 還開一個驗證頁，只會讓使用者以為登入正在進行。
              if (generation !== loginGeneration) {
                if (loginAbortController === controller) loginAbortController = null;
                return sendJson(response, 200, {
                  ok: true,
                  value: { reused: false, cancelled: true }
                });
              }

              pendingLogin = entry;

              // 背景輪詢授權結果；完成後寫入憑證並清掉 pending。
              // 這裡刻意不 await：頁面需要立刻拿到 user code 顯示給使用者，
              // 而授權本身可能要等幾十秒。狀態頁靠輪詢 /status 得知結果。
              pollDeviceToken(entry.deviceCode, entry.interval, entry.expiresIn, controller.signal)
                .then((token) => {
                  // 取消與完成可能在同一個事件迴圈交錯；寫入帳號前再檢查一次，
                  // 避免使用者按取消後，剛回來的 token 仍被保存。
                  if (generation !== loginGeneration || pendingLogin !== entry) return false;
                  const orgId = typeof token.org_id === 'string' ? token.org_id.trim() : '';
                  const accountId = tokenManager.addAccount({
                    access: token.access_token,
                    refresh: token.refresh_token,
                    expires: Math.floor(Date.now() / 1000) + (token.expires_in || 3600),
                    ...(orgId ? { orgId } : {})
                  }, entry.label);
                  return tokenManager.switchTo(accountId).then(() => true);
                })
                .then((completed) => {
                  if (!completed) return;
                  loginError = null;
                  // 憑證換到了：把探測結果標成不新鮮，下一輪重新驗證。
                  // 這裡刻意不刪快取——開機不會自動探測，刪掉就再也補不回來，
                  // 使用者會看到整張表空白（見 catalog.js markProbeStale）。
                  try { catalog.markProbeStale?.(); } catch { /* 標記失敗不影響登入成功 */ }
                })
                .catch((error) => {
                  // 取消與完成可能交錯。世代已變、或這筆已不是目前等待的登入，
                  // 就不要把取消說成失敗。
                  if (generation !== loginGeneration || pendingLogin !== entry) return;
                  if (controller.signal.aborted) return;
                  const classified = classifyDeviceLoginError(error);
                  if (!classified) return;
                  loginError = { ...classified, at: Date.now() };
                })
                .finally(() => {
                  if (pendingLogin === entry) pendingLogin = null;
                  if (loginAbortController === controller) loginAbortController = null;
                });

              return sendJson(response, 200, {
                ok: true,
                value: {
                  userCode: entry.userCode,
                  verificationUrl: entry.verificationUrl,
                  reused: false
                }
              });
            }

            if (route === 'logout') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);

              // 進行中的登入也要一併取消，否則登出後不久又被寫回憑證。
              cancelPendingLogin();
              tokenManager.clearCache?.();
              // 登出是唯一該丟掉探測紀錄的時機：這台機器上已經沒有可信憑證，
              // 留著只會讓下次登入前的畫面顯示上一份結果。
              catalog.invalidateProbe?.();
              const removal = clearOwnCredential(config.credentialPath);
              return sendJson(response, 200, {
                ok: true,
                value: {
                  ...removal,
                  // 如果憑證另外還來自 OpenCode Desktop，這裡誠實說明沒被清掉。
                  note: removal.removed
                    ? '已刪除本外掛儲存的憑證。'
                    : '本外掛沒有自己的憑證檔；若仍顯示已登入，代表 token 來自 OpenCode Desktop，請在該應用程式內登出。'
                }
              });
            }

            if (route === 'anonymous-channel') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              const payload = JSON.parse((await readBody(request)) || '{}');
              if (config.anonymousChannel) {
                config.anonymousChannel.enabled = payload.enabled === true;
              }
              return sendJson(response, 200, {
                ok: true,
                value: { enabled: config.anonymousChannel?.enabled === true }
              });
            }

            if (route === 'refresh') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              try {
                await tokenManager.refresh();
                return sendJson(response, 200, { ok: true, value: { refreshed: true } });
              } catch (err) {
                return sendJson(response, 200, {
                  ok: false,
                  error: 'refresh_failed',
                  message: err?.message ?? String(err)
                });
              }
            }

            if (route === 'probe') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              try {
                const token = await tokenManager.getValidToken();
                const { probeModels } = await import('./probe.js');
                const raw = await readBody(request);
                let payload = {};
                if (raw && raw.trim()) {
                  try { payload = JSON.parse(raw); } catch {}
                }
                const modelIds = Array.isArray(payload.modelIds) && payload.modelIds.length > 0
                  ? payload.modelIds.filter((id) => typeof id === 'string')
                  : undefined;
                await catalog.refreshAvailability(token, probeModels, {
                  inferenceUrl: config.inferenceUrl,
                  bunTransport: config.bunTransport,
                  modelIds
                });
                return sendJson(response, 200, { ok: true, value: statusReporter.buildStatus() });
              } catch (err) {
                return sendJson(response, 200, {
                  ok: false,
                  error: 'probe_failed',
                  message: err?.message ?? String(err)
                });
              }
            }

            if (route === 'auto-switch') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              if (!autoSwitch) return sendJson(response, 200, { ok: false, error: 'not_supported' });
              const raw = await readBody(request);
              let payload = {};
              if (raw.trim()) {
                try { payload = JSON.parse(raw); }
                catch { return sendJson(response, 200, { ok: false, error: 'bad_json' }); }
              }
              const saved = autoSwitch.set({ enabled: payload.enabled === true });
              return sendJson(response, 200, { ok: true, value: { enabled: saved.enabled } });
            }

            if (route === 'fallback') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              if (!fallback) {
                return sendJson(response, 200, {
                  ok: false,
                  error: 'not_supported',
                  message: '此載入方式沒有可寫入的備援設定。'
                });
              }

              // 讀完再解析：請求可能帶 query string，也可能是空的 body。
              const raw = await readBody(request);
              let payload = {};
              if (raw.trim() !== '') {
                try {
                  payload = JSON.parse(raw);
                } catch {
                  return sendJson(response, 200, {
                    ok: false,
                    error: 'bad_json',
                    message: '請求內容不是合法的 JSON。'
                  });
                }
              }

              // 驗證在伺服器端做，不信任瀏覽器送來的內容。
              //
              // 特別是 model id：備援清單會被直接拿去當請求的 model 參數送出，
              // 一個不存在的 id 就是一次注定失敗的請求，所以只接受 catalog
              // 真的認識的 id（含靜態清單，因為 catalog 可能還沒抓完）。
              if (payload.models !== undefined) {
                const requested = Array.isArray(payload.models) ? payload.models : [];
                const unknown = requested
                  .filter((id) => typeof id === 'string')
                  .filter((id) => !catalog.getModel(id));
                if (unknown.length > 0) {
                  return sendJson(response, 200, {
                    ok: false,
                    error: 'unknown_model',
                    message: `catalog 裡沒有這些模型：${unknown.join(', ')}`
                  });
                }
              }

              const saved = fallback.set({
                enabled: payload.enabled,
                models: payload.models === undefined ? undefined : normalizeModelList(payload.models)
              });

              return sendJson(response, 200, {
                ok: true,
                value: {
                  enabled: saved.enabled,
                  models: saved.models,
                  maxModels: MAX_FALLBACK_MODELS
                }
              });
            }

            if (route === 'context') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              if (!contextWindowStore) {
                return sendJson(response, 200, { ok: false, error: 'not_supported' });
              }

              const raw = await readBody(request);
              let payload = {};
              if (raw.trim()) {
                try { payload = JSON.parse(raw); }
                catch { return sendJson(response, 200, { ok: false, error: 'bad_json' }); }
              }

              if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                return sendJson(response, 200, { ok: false, error: 'bad_json' });
              }
              const modelId = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
              if (!modelId) {
                return sendJson(response, 200, { ok: false, error: 'invalid_model' });
              }
              if (!catalog.getModel(modelId)) {
                return sendJson(response, 200, { ok: false, error: 'unknown_model' });
              }

              try {
                if (payload.contextWindow === null) contextWindowStore.reset(modelId);
                else contextWindowStore.set(modelId, payload.contextWindow);
              } catch (error) {
                return sendJson(response, 200, {
                  ok: false,
                  error: error instanceof RangeError || error instanceof TypeError
                    ? 'invalid_context_window'
                    : 'context_save_failed',
                  message: error?.message ?? String(error)
                });
              }

              onAdaptersUpdated?.();
              const model = catalog.getModel(modelId);
              return sendJson(response, 200, {
                ok: true,
                value: {
                  modelId,
                  contextWindow: model.contextWindow,
                  catalogContextWindow: model.catalogContextWindow,
                  contextOverride: model.contextOverride,
                  contextSource: model.contextSource
                }
              });
            }

            if (route === 'picker') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              if (typeof catalog.setPickerShown !== 'function') {
                return sendJson(response, 200, { ok: false, error: 'not_supported' });
              }

              const raw = await readBody(request);
              let payload = {};
              if (raw.trim()) {
                try { payload = JSON.parse(raw); }
                catch { return sendJson(response, 200, { ok: false, error: 'bad_json' }); }
              }

              // 兩種操作：恢復自動管理，或調整單一模型的勾選。
              if (payload.mode === 'auto') {
                const state = catalog.resetPicker();
                if (!state) return sendJson(response, 200, { ok: false, error: 'not_supported' });
                onAdaptersUpdated?.();
                return sendJson(response, 200, { ok: true, value: statusReporter.buildStatus() });
              }

              const modelId = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
              if (!modelId) return sendJson(response, 200, { ok: false, error: 'invalid_model' });
              const state = catalog.setPickerShown(modelId, payload.shown === true);
              if (!state) return sendJson(response, 200, { ok: false, error: 'unknown_model' });
              // 勾選會改變發佈給宿主的模型清單，要發出與探測完成相同的事件，
              // 讓選擇器立刻重新整理。
              onAdaptersUpdated?.();
              return sendJson(response, 200, { ok: true, value: statusReporter.buildStatus() });
            }

            if (route === 'go/refresh') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              if (!goService) {
                return sendJson(response, 200, { ok: false, error: 'not_supported' });
              }
              if (!goService.isEnabled?.()) {
                return sendJson(response, 200, {
                  ok: false,
                  error: 'go_disabled',
                  message: 'OpenCode Go subscription provider is disabled.',
                  value: statusReporter.buildStatus()
                });
              }
              await goService.refresh({ force: true });
              onAdaptersUpdated?.();
              return sendJson(response, 200, { ok: true, value: statusReporter.buildStatus() });
            }

            if (route === 'go/clear') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              if (!goService) {
                return sendJson(response, 200, { ok: false, error: 'not_supported' });
              }
              goService.clear();
              onAdaptersUpdated?.();
              return sendJson(response, 200, { ok: true, value: statusReporter.buildStatus() });
            }

            if (route === 'go/picker') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              if (!goService || typeof goService.setPickerShown !== 'function') {
                return sendJson(response, 200, { ok: false, error: 'not_supported' });
              }
              const raw = await readBody(request);
              let payload = {};
              if (raw.trim()) {
                try { payload = JSON.parse(raw); }
                catch { return sendJson(response, 200, { ok: false, error: 'bad_json' }); }
              }
              if (payload.mode === 'auto') {
                goService.resetPicker();
                onAdaptersUpdated?.();
                return sendJson(response, 200, { ok: true, value: statusReporter.buildStatus() });
              }
              const modelId = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
              if (!modelId) return sendJson(response, 200, { ok: false, error: 'invalid_model' });
              const state = goService.setPickerShown(modelId, payload.shown === true);
              if (!state) return sendJson(response, 200, { ok: false, error: 'unknown_model' });
              onAdaptersUpdated?.();
              return sendJson(response, 200, { ok: true, value: statusReporter.buildStatus() });
            }

            if (route === 'go/credential') {
              if (request.method === 'DELETE') {
                if (!goService) {
                  return sendJson(response, 200, { ok: false, error: 'not_supported' });
                }
                const res = await goService.clearCredential();
                onAdaptersUpdated?.();
                return sendJson(response, 200, {
                  ok: res.ok,
                  ...(res.ok ? {} : { error: res.error, message: redactSecret(res.message) }),
                  value: statusReporter.buildStatus()
                });
              }
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              if (!goService) {
                return sendJson(response, 200, { ok: false, error: 'not_supported' });
              }
              const raw = await readBody(request);
              let payload = {};
              if (raw.trim()) {
                try { payload = JSON.parse(raw); }
                catch { return sendJson(response, 200, { ok: false, error: 'bad_json', message: 'Invalid JSON payload.' }); }
              }
              if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                return sendJson(response, 200, { ok: false, error: 'bad_json', message: 'Invalid JSON payload.' });
              }
              if (typeof payload.key === 'string' && payload.key.trim()) {
                secretToRedact = payload.key.trim();
              }
              const res = await goService.saveCredential(payload.key);
              onAdaptersUpdated?.();
              return sendJson(response, 200, {
                ok: res.ok,
                ...(res.ok ? {} : { error: res.error, message: redactSecret(res.message, secretToRedact) }),
                value: statusReporter.buildStatus()
              });
            }

            if (route === 'go/credential/clear') {
              if (request.method !== 'POST') return sendMethodNotAllowed(response);
              if (!goService) {
                return sendJson(response, 200, { ok: false, error: 'not_supported' });
              }
              const res = await goService.clearCredential();
              onAdaptersUpdated?.();
              return sendJson(response, 200, {
                ok: res.ok,
                ...(res.ok ? {} : { error: res.error, message: redactSecret(res.message) }),
                value: statusReporter.buildStatus()
              });
            }

            return sendJson(response, 404, { ok: false, error: 'not_found' });
          } catch (error) {
            // 回 200 並帶 ok:false：這是使用者唯一能看到「為什麼操作不能進行」的地方，
            // 一個裸 500 只會讓前端顯示「未知錯誤」；同時強制遮蔽任何可能殘留的密鑰。
            return sendJson(response, 200, {
              ok: false,
              error: 'internal',
              message: redactSecret(error?.message ?? String(error), secretToRedact)
            });
          }
        }
      })
    );
  });
}

export { PREFIX };
