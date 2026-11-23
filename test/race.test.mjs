/**
 * 併發與競態測試。
 *
 * 為什麼需要這一組：其他測試都是「一次做一件事」，但真實使用者的行為是連點
 * 按鈕、開兩個分頁、在等待時改變主意。這類缺陷只有在請求真正重疊時才會出現，
 * 而且症狀很難重現（「登入有時候要按兩次」），所以必須用測試固定住。
 *
 * 手法：把 lib/ 複製到暫存目錄，只替換 device-flow.js 成可控的假實作。複製而
 * 不是改寫原檔，是為了讓受測的 web-api.js 與正式版本逐位元組相同——如果測試
 * 用的是另一份程式碼，測到的就不是上線的東西。
 *
 * 全程不發任何網路請求、不碰真實帳號：假實作回傳 example.invalid 網址，且
 * pollDeviceToken 永不完成（模擬使用者還沒去核准）。
 */
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let checks = 0;
function check(name, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${name}${cond ? '' : `  ${detail}`}`);
}

const SRC = fileURLToPath(new URL('../', import.meta.url));
// 變異測試會把這個指向一份「刻意改壞」的副本。沒有這個入口，就無法證明這些
// 檢查真的抓得到問題——一支永遠全綠的測試可能只是在空轉。
const SRC_ACTUAL = process.env.OCOA_RACE_SRC
  ? path.join(process.env.OCOA_RACE_SRC, path.sep)
  : SRC;
const work = mkdtempSync(path.join(tmpdir(), 'ocoa-race-'));
const asUrl = (p) => new URL(`file://${p.replace(/\\/g, '/')}`).href;

try {
  mkdirSync(path.join(work, 'lib'), { recursive: true });
  cpSync(path.join(SRC_ACTUAL, 'lib'), path.join(work, 'lib'), { recursive: true });
  cpSync(path.join(SRC_ACTUAL, 'package.json'), path.join(work, 'package.json'));

  /* ------------------------------------ 假的 device-flow（可控且不連外） */

  writeFileSync(path.join(work, 'lib', 'device-flow.js'), `
export const issued = [];
export async function requestDeviceCode() {
  const n = issued.length + 1;
  issued.push('CODE-' + n);
  // 模擬真實網路延遲：這正是競態窗口所在。
  await new Promise((r) => setTimeout(r, 60));
  return {
    device_code: 'dev-' + n,
    user_code: 'CODE-' + n,
    verification_url: 'https://example.invalid/auth',
    interval: 5,
    expires_in: 900
  };
}
export async function pollDeviceToken(_deviceCode, _interval, _timeout, signal) {
  // 永不完成：模擬「使用者還沒去核准」，但必須對取消訊號作出反應。
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      const error = new Error('Device login polling aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}
export function classifyDeviceLoginError() {
  return null;
}
export async function refreshAccessToken() {
  throw new Error('not used in this test');
}
`, 'utf8');

  const { registerWebApi } = await import(asUrl(path.join(work, 'lib', 'web-api.js')));
  const { issued } = await import(asUrl(path.join(work, 'lib', 'device-flow.js')));
  const { ModelCatalog } = await import(asUrl(path.join(work, 'lib', 'catalog.js')));

  /* --------------------------------------------------------- 假的依賴 */

  const tokenManager = {
    async getValidToken() { return 'fake-token'; },
    async refresh() { return { refreshed: true }; },
    setCredential() {},
    describeCredential: () => ({ present: false, source: 'test' })
  };
  const catalog = {
    async init() {},
    invalidateProbe() {},
    getProbeResults: () => [],
    async refreshAvailability() { return { results: [], total: 0, tested: 0, blocked: false }; }
  };
  const statusReporter = {
    buildStatus: () => ({
      health: 'signed-out',
      healthMessage: 'x',
      provider: { id: 'opencode-oauth', name: 'OpenCode (OAuth)' },
      version: '0.1.0',
      credential: { present: false },
      models: { total: 0, available: 0, probed: 0, models: [] },
      config: {},
      generatedAt: Date.now()
    }),
    describeProbe: () => null
  };

  let handler = null;
  const webCtx = {
    effect(fn) { try { fn(); } catch { /* ignore */ } },
    webServer: { register({ handler: h }) { handler = h; return { dispose() {} }; } }
  };
  registerWebApi(
    { inject(_n, fn) { fn(webCtx); }, effect() {} },
    { tokenManager, catalog, statusReporter, config: {} }
  );
  check('registerWebApi 掛上了路由', typeof handler === 'function');

  /* ------------------------------------------------------- 假的 req/res */

  const makeReq = (method, url) => ({ method, url, headers: {}, on() {} });
  const makeRes = () => {
    const chunks = [];
    return {
      statusCode: 0,
      headers: {},
      headersSent: false,
      body: undefined,
      done: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs ?? {}); this.headersSent = true; },
      end(body) {
        if (body !== undefined) chunks.push(Buffer.from(String(body)));
        this.body = Buffer.concat(chunks).toString('utf8');
        this.done = true;
      },
      on() {}
    };
  };

  const PREFIX = '/dsh-opencode-oauth/api';
  async function hit(method, route) {
    const res = makeRes();
    // handler 收到的是含前綴的完整路徑（它內部再自行剝掉前綴）。
    await handler(makeReq(method, `${PREFIX}${route}`), res);
    for (let i = 0; i < 100 && !res.done; i++) await new Promise((r) => setTimeout(r, 20));
    let json = null;
    try { json = JSON.parse(res.body); } catch { /* ignore */ }
    return { status: res.statusCode, json, body: res.body };
  }

  /* ------------------------------------------------------ 登入競態測試 */

  console.log('\n--- 單一登入請求 ---');
  const one = await hit('POST', '/login');
  check('回 200', one.status === 200, `HTTP ${one.status}`);
  check('取得 userCode', typeof one.json?.value?.userCode === 'string', JSON.stringify(one.json));
  check('標記 reused:false', one.json?.value?.reused === false, String(one.json?.value?.reused));
  check('向上游索取一組代碼', issued.length === 1, `issued=${issued.length}`);

  console.log('\n--- 已有一組進行中時再要求（應重用，不重複索取） ---');
  const two = await hit('POST', '/login');
  check('重用同一組代碼', two.json?.value?.userCode === one.json?.value?.userCode,
    `${one.json?.value?.userCode} vs ${two.json?.value?.userCode}`);
  check('標記 reused:true', two.json?.value?.reused === true, String(two.json?.value?.reused));
  check('沒有再索取新代碼', issued.length === 1, `issued=${issued.length}`);

  console.log('\n--- 頁面取消等待中的登入 ---');
  const cancelledPending = await hit('POST', '/login/cancel');
  check('取消路由回 200', cancelledPending.status === 200, `HTTP ${cancelledPending.status}`);
  check('取消路由回報 cancelled:true', cancelledPending.json?.value?.cancelled === true,
    JSON.stringify(cancelledPending.json?.value));
  await new Promise((r) => setTimeout(r, 20));
  const afterPendingCancel = await hit('GET', '/status');
  check('取消後沒有殘留 pendingLogin', afterPendingCancel.json?.value?.pendingLogin == null,
    JSON.stringify(afterPendingCancel.json?.value?.pendingLogin));

  console.log('\n--- 兩個幾乎同時到達的登入 ---');
  // 這是核心情境：使用者在頁面還沒更新成「等待核准」之前連點兩下。
  // 修正前會各自索取一組代碼，後者覆蓋前者，使用者可能核准了沒被追蹤的那組。
  await hit('POST', '/logout');
  await new Promise((r) => setTimeout(r, 30));
  const before = issued.length;

  const [a, b] = await Promise.all([hit('POST', '/login'), hit('POST', '/login')]);
  const newIssued = issued.length - before;
  const codeA = a.json?.value?.userCode;
  const codeB = b.json?.value?.userCode;
  console.log(`        A = ${codeA} (reused=${a.json?.value?.reused})`);
  console.log(`        B = ${codeB} (reused=${b.json?.value?.reused})`);
  console.log(`        這一輪向上游索取 ${newIssued} 組 device code`);

  check('兩個請求都成功', a.status === 200 && b.status === 200, `${a.status}, ${b.status}`);
  check('兩個請求只產生一組 device code',
    new Set([codeA, codeB].filter(Boolean)).size === 1, `${codeA} / ${codeB}`);
  check('上游只被索取一次', newIssued === 1, `索取 ${newIssued} 次`);

  console.log('\n--- 索取代碼期間按下登出 ---');
  // 使用者在「正在登入…」時改變主意按了登出。索取請求還在 await；它醒來後
  // 不該把 pendingLogin 寫回去，否則畫面會又冒出一個等待核准的登入。
  await hit('POST', '/logout');
  await new Promise((r) => setTimeout(r, 30));

  const loginP = hit('POST', '/login');
  await new Promise((r) => setTimeout(r, 20)); // 讓它進入 await
  await hit('POST', '/logout');
  const cancelled = await loginP;

  check('被打斷的登入仍回 200', cancelled.status === 200, `HTTP ${cancelled.status}`);
  check('被打斷的登入標記 cancelled:true', cancelled.json?.value?.cancelled === true,
    JSON.stringify(cancelled.json?.value));
  // 取消的登入不得回傳可開啟的驗證網址：前端看到它就會開新分頁，讓使用者
  // 以為登入正在進行。這裡把「不回傳」固定成契約。
  check('被打斷的登入不回傳 verificationUrl',
    cancelled.json?.value?.verificationUrl === undefined,
    JSON.stringify(cancelled.json?.value));
  check('被打斷的登入不回傳 userCode',
    cancelled.json?.value?.userCode === undefined,
    JSON.stringify(cancelled.json?.value));

  const afterCancel = await hit('GET', '/status');
  const leftover =
    afterCancel.json?.value?.pendingLogin === null || afterCancel.json?.value?.pendingLogin === undefined;
  check('登出後狀態頁沒有殘留的 pendingLogin', leftover,
    JSON.stringify(afterCancel.json?.value?.pendingLogin));

  const issuedBeforeFresh = issued.length;
  const fresh = await hit('POST', '/login');
  check('登出後重新登入取得全新的代碼',
    typeof fresh.json?.value?.userCode === 'string' && fresh.json?.value?.reused === false,
    JSON.stringify(fresh.json?.value));
  // 用實際索取紀錄比對，而不是跟取消回應裡的欄位比——後者現在刻意不回傳。
  check('重新登入確實向上游索取了一組新代碼',
    issued.length === issuedBeforeFresh + 1,
    `issued ${issuedBeforeFresh} -> ${issued.length}`);
  check('新代碼與被取消的那組不同',
    fresh.json?.value?.userCode === issued[issued.length - 1],
    `${fresh.json?.value?.userCode} vs 最後索取 ${issued[issued.length - 1]}`);
  await hit('POST', '/logout');

  /* ------------------------------------------------ 路由契約（併發下） */

  console.log('\n--- 併發下的路由契約 ---');
  const many = await Promise.all(Array.from({ length: 8 }, () => hit('GET', '/status')));
  check('8 個同時的 GET /status 全部回 200', many.every((r) => r.status === 200),
    many.map((r) => r.status).join(', '));
  check('沒有競態造成的非 JSON 回應', many.every((r) => r.json !== null));

  const unknowns = await Promise.all(Array.from({ length: 5 }, () => hit('GET', '/nope')));
  check('5 個同時的未知路由都回 404', unknowns.every((r) => r.status === 404),
    unknowns.map((r) => r.status).join(', '));

  /* -------------------------------------------- 探測的單例合併（重複探測） */

  console.log('\n--- 多個同時的探測只會真的跑一次 ---');
  // 三個並行探測若不共用同一個 promise，上游會收到三倍的請求量。
  let probeCalls = 0;
  const cat = new ModelCatalog({ probeCachePath: path.join(work, 'probe-cache.json') });
  const fakeProbe = async (_token, ids) => {
    probeCalls++;
    await new Promise((r) => setTimeout(r, 40));
    return {
      results: ids.map((id) => ({ id, ok: true, status: 200, ms: 10 })),
      blocked: false,
      tested: ids.length,
      total: ids.length
    };
  };
  // 先塞入模型，否則沒有東西可探。setModels 是公開方法，不需為測試開後門。
  cat.setModels([
    { id: 'm1', name: 'm1' },
    { id: 'm2', name: 'm2' },
    { id: 'm3', name: 'm3' }
  ]);

  const probes = await Promise.all([
    cat.refreshAvailability('tok', fakeProbe),
    cat.refreshAvailability('tok', fakeProbe),
    cat.refreshAvailability('tok', fakeProbe)
  ]);
  check('三個並行探測都拿到結果', probes.every((p) => p !== undefined && p !== null));
  check('探測只執行一次（沒有重複打上游）', probeCalls <= 1, `實際執行 ${probeCalls} 次`);
  check('三次回傳同一個結果物件（合併成功）',
    probes[0] === probes[1] && probes[1] === probes[2]);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? `✔ Race tests passed (${checks} checks)` : `❌ ${failures} / ${checks} checks failed`}`);
if (failures > 0) process.exit(1);
