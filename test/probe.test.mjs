/**
 * 探測模組的迴歸測試（離線）。
 *
 * 這份測試原本直接打真實上游，驗「某個模型現在可用」——但那是把
 * **外部服務的當下狀態**寫成測試的前提。2026-10-19 這台機器的出口 IP 被
 * 上游風控之後，`deepseek-v4.1-flash-free` 從 200 變成 403，測試就紅了，
 * 而外掛本身一行都沒錯。這種測試會讓人開始忽略紅燈，比沒有測試更糟。
 *
 * 現在改成兩層：
 *
 *  1. **分類行為**（上面這一層，永遠跑）——用錄下來的真實上游回應當 fixture，
 *     驗「這種回應會被判成什麼」。這才是我們真正擁有的契約，也不會隨網路漂移。
 *
 *  2. **即時連線**（下面那一層，可選）——只有設了 `PROBE_LIVE=1` 才跑，
 *     而且在通道被擋時視為「環境限制」而非失敗。
 *
 * fixture 全部取自 2026-10-19 的實測回應，原文照抄，不做美化。
 */
import { probeModel, probeModels, readRetryAfterMs } from '../lib/probe.js';

console.log('--- Testing Availability Probe (offline fixtures) ---');

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok - ${label}`);
  } else {
    fail++;
    console.log(`  FAIL - ${label}: got ${a}, want ${e}`);
  }
}

/* ------------------------------------------------------- 真實上游 fixture */

const ABUSE = "OpenCode's free models aren't available from your current network because "
  + "we've detected abusive traffic from this IP address. This isn't related to your "
  + "account. If you're on a VPN or proxy, turn it off and try again, or subscribe to "
  + "OpenCode Go at https://opencode.ai/go to keep building.";

const FIXTURES = {
  // 200 + 一個 SSE frame：模型真的能回答。
  ok: {
    status: 200,
    body: 'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n',
    headers: { 'content-type': 'text/event-stream' }
  },
  // 403 FreeTierError：整條免費通道擋掉這個出口（本機實測狀態）。
  networkBlocked: {
    status: 403,
    body: JSON.stringify({ type: 'error', error: { type: 'FreeTierError', message: ABUSE } })
  },
  // 410 已下架，並附上上游建議的替代模型。
  deprecated: {
    status: 410,
    body: JSON.stringify({
      type: 'error',
      error: { type: 'ModelDeprecated', message: 'Model space-bunny-free has been deprecated. Use minimax-m3.1-flash-free instead.' },
      metadata: { model: 'space-bunny-free', replacement: 'minimax-m3.1-flash-free' }
    })
  },
  // 400：免費通道用來表示「這個模型現在不提供」。
  unavailable: {
    status: 400,
    body: JSON.stringify({ error: { type: 'server_error', message: 'Upstream request failed: Model is unavailable.' } })
  },
  // 403 RegionError：只有這個模型受地區限制，通道本身正常。
  regionRestricted: {
    status: 403,
    body: JSON.stringify({ error: { type: 'RegionError', message: 'This model is not available in your region.' } })
  },
  // 404 at a generic inference route does not identify a missing model.
  endpointNotFound: {
    status: 404,
    body: JSON.stringify({ error: { message: 'Cannot POST /v1/chat/completions' } })
  },
  // A structured model-specific 404 is authoritative retirement evidence.
  modelNotFound: {
    status: 404,
    body: JSON.stringify({
      error: { type: 'ModelNotFoundError', message: 'Model some-free was not found.' }
    })
  },
  // 429：這次沒問到，但通道還在。
  rateLimited: {
    status: 429,
    body: JSON.stringify({ error: { message: 'Rate limit exceeded.' } })
  }
};

/**
 * 用假的 fetch 替換全域 fetch，回傳指定的 fixture。
 *
 * 必須在呼叫 probe 前換掉、結束後換回來：`probe.js` 直接用全域 `fetch`，
 * 沒有注入點可改，這是唯一不改動正式程式碼的做法。
 */
async function withFetch(fixture, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: fixture.status,
    ok: fixture.status >= 200 && fixture.status < 300,
    headers: new Map(Object.entries(fixture.headers ?? { 'content-type': 'application/json' })),
    text: async () => fixture.body,
    body: {
      getReader: () => {
        let done = false;
        const encoder = new TextEncoder();
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: encoder.encode(fixture.body) };
          },
          cancel: async () => {},
          releaseLock: () => {}
        };
      }
    }
  });
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const probe = (fixture, model = 'some-free') =>
  withFetch(fixture, () => probeModel('fake-token', model));

/* ---------------------------------------------------------------- 分類行為 */

console.log('\n[可達性]');

const ok = await probe(FIXTURES.ok);
check('200 + SSE → ok', ok.ok, true);
check('200 + SSE → reachable', ok.reachable, true);

// 網路風控：這一個是本機實測狀態，也是最重要的判準。
// 它必須 reachable=false——擋的是整個出口，繼續探測其餘模型只是多送請求。
const blocked = await probe(FIXTURES.networkBlocked);
check('403 風控 → ok=false', blocked.ok, false);
check('403 風控 → reachable=false（整條通道不可用）', blocked.reachable, false);
check('403 風控 → reason=network-blocked', blocked.reason, 'network-blocked');

const deprecated = await probe(FIXTURES.deprecated);
check('410 → ok=false', deprecated.ok, false);
check('410 → reachable（通道本身正常）', deprecated.reachable, true);
check('410 → reason=deprecated', deprecated.reason, 'deprecated');

const unavailable = await probe(FIXTURES.unavailable);
check('400 → ok=false', unavailable.ok, false);
check('400 → reachable（只影響這個模型）', unavailable.reachable, true);
check('400 → reason=unavailable', unavailable.reason, 'unavailable');

const region = await probe(FIXTURES.regionRestricted);
check('403 RegionError → ok=false', region.ok, false);
check('403 RegionError → reason=region-restricted', region.reason, 'region-restricted');

const limited = await probe(FIXTURES.rateLimited);
check('429 + explicit rate-limit message → reason=rate-limited-explicit', limited.reason, 'rate-limited-explicit');
check('429 → reachable', limited.reachable, true);

const route404 = await probe(FIXTURES.endpointNotFound);
check('generic endpoint 404 is not classified as a missing model', route404.reason, 'endpoint-not-found');
const missingModel404 = await probe(FIXTURES.modelNotFound);
check('model-specific 404 is classified as terminal not-found', missingModel404.reason, 'not-found');

// 連線層失敗：不是 HTTP 回應，也要有可控的結果而不是整個爆掉。
const transport = await withFetch(
  { status: 0, body: '' },
  async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('ECONNRESET');
    };
    try {
      return await probeModel('t', 'x');
    } finally {
      globalThis.fetch = original;
    }
  }
);
check('連線失敗 → ok=false', transport.ok, false);
check('連線失敗 → reason=transport', transport.reason, 'transport');

/* -------------------------------------------------- 整輪探測的停止條件 */

console.log('\n[整輪探測]');

// 通道被擋時必須立刻停手：`blocked` 要為 true，而且不能把剩下的模型
// 全部送出去——擋的是 IP，多送只會讓評分更差。
let fetched = 0;
const blockedRun = await withFetch(FIXTURES.networkBlocked, async () => {
  const wrapped = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetched++;
    return wrapped(...args);
  };
  try {
    return await probeModels('t', ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'], { concurrency: 2 });
  } finally {
    globalThis.fetch = wrapped;
  }
});
check('通道被擋 → outcome.blocked = true', blockedRun.blocked, true);
check('通道被擋 → 沒有把所有模型都送出去', fetched < 8, true);
console.log(`  (實際送出 ${fetched} 個請求，共 8 個模型)`);

// 只有單一模型下架時，通道仍然正常，整輪要繼續跑完。
const mixedRun = await withFetch(FIXTURES.deprecated, () =>
  probeModels('t', ['a', 'b', 'c'], { concurrency: 3 })
);
check('單一模型下架 → outcome.blocked = false', mixedRun.blocked, false);
check('單一模型下架 → 每個模型都被探測', mixedRun.tested, 3);
check('單一模型下架 → 結果數正確', mixedRun.results.length, 3);
check('單一模型下架 → 沒有熔斷', mixedRun.stopped, null);
check('單一模型下架 → 沒有未驗的模型', mixedRun.untested.length, 0);

// 429 熔斷：模型本身有效（reachable），但整輪要停手以保住當日額度。
// 關鍵是 outcome 必須說清楚「停在哪裡、還有幾個沒驗」。
const rateLimitedRun = await withFetch(FIXTURES.rateLimited, () =>
  probeModels('t', ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'], { concurrency: 1 })
);
check('429 熔斷 → stopped = rate-limited', rateLimitedRun.stopped, 'rate-limited');
check('429 熔斷 → 不是 channel-blocked', rateLimitedRun.blocked, false);
check('429 熔斷 → 只送出一輪', rateLimitedRun.tested, 1);
check('429 熔斷 → 其餘模型列為未驗', rateLimitedRun.untested.length, 5);
check('429 熔斷 → 未驗清單不含已驗的', rateLimitedRun.untested.includes('r1'), false);
check('429 熔斷 → stoppedBy 指出是哪一個模型', rateLimitedRun.stoppedBy?.id, 'r1');
check('429 熔斷 → stoppedBy 帶狀態碼', rateLimitedRun.stoppedBy?.status, 429);

// 通道中斷也要標出原因，不能和額度熔斷混為一談。
check('通道被擋 → stopped = unreachable', blockedRun.stopped, 'unreachable');
check('通道被擋 → 未驗清單與已驗清單互補',
  blockedRun.untested.length + blockedRun.tested, 8);

// 完整跑完時不能誤報熔斷。
check('完整跑完 → stopped = null', mixedRun.stopped, null);
check('完整跑完 → stoppedBy = null', mixedRun.stoppedBy, null);

/* ------------------------------------------- retry-after：額度解除時間 */

// 上游 429 會帶 retry-after（實測 5397 秒）。這是唯一能回答「還要等多久」
// 的權威來源，必須讀出來，不能丟掉。
const mkHeaders = (value) => ({ get: (name) => (String(name).toLowerCase() === 'retry-after' ? value : null) });
check('retry-after 秒數 → 毫秒', readRetryAfterMs(mkHeaders('5397')), 5397 * 1000);
check('retry-after 0 秒 → 0', readRetryAfterMs(mkHeaders('0')), 0);
check('retry-after 缺失 → null', readRetryAfterMs(mkHeaders(null)), null);
check('retry-after 亂碼 → null（不猜）', readRetryAfterMs(mkHeaders('soon')), null);
check('沒有 headers → null', readRetryAfterMs(undefined), null);
const httpDate = new Date(Date.now() + 120_000).toUTCString();
const parsedDate = readRetryAfterMs(mkHeaders(httpDate));
check('retry-after HTTP-date 也吃得下', parsedDate > 60_000 && parsedDate <= 120_000, true);

// 探測單一模型時要真的把標頭讀出來並換成絕對時間。
const retryModel = await withFetch({
  status: 429,
  body: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached."}}',
  headers: { 'content-type': 'application/json', 'retry-after': '5397' }
}, () => probeModel('t', 'rate-me'));
check('429 結果帶 retryAfterMs', retryModel.retryAfterMs, 5397 * 1000);
check('429 結果帶絕對 retryAt',
  Math.abs(retryModel.retryAt - (Date.now() + 5397 * 1000)) < 5000, true);
check('非 429 不帶 retryAt', (await probe(FIXTURES.ok)).retryAt, null);

if (fail > 0) throw new Error(`Probe fixtures: ${fail} check(s) failed`);
console.log(`\n✔ Probe module tests passed (${pass} checks, offline)`);

/* ------------------------------------------------------- 即時連線（可選） */

if (process.env.PROBE_LIVE === '1') {
  console.log('\n[即時連線：PROBE_LIVE=1]');
  const { TokenManager } = await import('../lib/token-manager.js');
  try {
    const tm = new TokenManager();
    const token = await tm.getValidToken();
    const live = await probeModel(token, 'deepseek-v4.1-flash-free');
    console.log(`  deepseek-v4.1-flash-free → ${live.status} ok=${live.ok} reason=${live.reason}`);
    if (!live.ok && live.reason === 'network-blocked') {
      console.log('  ! 這個出口 IP 被上游風控，即時檢查無法判定模型狀態（不是外掛的問題）。');
    }
  } catch (err) {
    console.log(`  ! 即時檢查略過：${err.message}`);
  }
} else {
  console.log('\n（即時連線檢查未啟用；需要時設 PROBE_LIVE=1）');
}
