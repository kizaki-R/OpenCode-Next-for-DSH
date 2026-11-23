/**
 * 失敗分類與錯誤碼傳遞的迴歸測試。
 *
 * 這裡守住的是一個很容易再犯的錯：在 plain Error 上寫 `.code` 看起來很合理，
 * 但 DSH 的 normalizeLlmFailure 只信任 `.failure`（且要求 `.failure.code`
 * 與 `.code` 一致），其餘一律核銷成 `UNKNOWN`。
 *
 * 為什麼本檔驗證的是「形狀」而不是「真的呼叫 core 的正規化函式」：
 * 外掛不能 import core 的套件（它們由宿主提供、不在相依清單裡），而把安裝路徑
 * 寫死會讓這份測試換一台機器就壞。所以這裡鎖定我們自己擁有的契約——`.failure`
 * 的形狀與合法錯誤碼；而「core 真的會丟棄 plain `.code`」這件事，是用 asar
 * 抽出的真實 normalizeLlmFailure 另外實測確認的（見 _scratch/check-failures.mjs）。
 * 有人把 toFailure 拿掉，這份測試就會紅。
 */
import {
  FREE_TIER_ERROR,
  REGION_ERROR,
  classifyHttpFailure,
  detectErrorType,
  parseErrorType,
  toFailure
} from '../lib/failures.js';

console.log('--- Testing Failure Classification ---');

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`  ok - ${label}`);
  } else {
    fail++;
    console.log(`  FAIL - ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

// 403 的三種意思必須分開：換模型就好 vs 通道整個不能用。
const freeBlocked = classifyHttpFailure(403, FREE_TIER_ERROR);
check('403 + FreeTierError is free-lane-blocked', freeBlocked.reason, 'free-lane-blocked');
check('403 + FreeTierError is not retryable', freeBlocked.retryable, false);
check('403 + RegionError is region-restricted', classifyHttpFailure(403, REGION_ERROR).reason, 'region-restricted');
check('bare 403 is forbidden', classifyHttpFailure(403, null).reason, 'forbidden');

// 產出的碼必須全在 DSH 的合法集合內。'UPSTREAM' 這種自創碼會靜默失效。
const LEGAL = new Set([
  'CONTEXT_WINDOW_EXCEEDED', 'QUOTA', 'ACCOUNT_QUOTA', 'EMPTY_RESPONSE',
  'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'AUTH', 'RATE_LIMIT',
  'INVALID_REQUEST', 'SERVER', 'TRANSPORT', 'TIMEOUT', 'UNKNOWN_MODEL',
  'IMAGE_OFFLOAD_REQUIRED', 'UNSUPPORTED_CONTENT'
]);
const illegal = [];
for (const status of [400, 401, 402, 403, 404, 409, 410, 418, 422, 429, 499, 500, 502, 503, 504, 507]) {
  const { code } = classifyHttpFailure(status, null);
  if (!LEGAL.has(code)) illegal.push(`${status}->${code}`);
}
check('every produced code is a legal DSH code', illegal.join(',') || 'none', 'none');

// 核心：錯誤碼必須以 `.failure` 的形式掛上去，否則上層讀不到。
const fixed403 = toFailure(new Error('403 FreeTierError'), { ...freeBlocked, status: 403 });
check('toFailure sets .code', fixed403.code, 'AUTH');
check('toFailure sets .failure.code', fixed403.failure.code, 'AUTH');
check('toFailure keeps .failure.code in sync with .code', fixed403.failure.code, fixed403.code);
check('toFailure carries status', fixed403.failure.status, 403);

const fixedTimeout = toFailure(new Error('idle 60000ms'), { code: 'TIMEOUT' });
check('timeout carries .failure.code', fixedTimeout.failure.code, 'TIMEOUT');
check('timeout .failure.code matches .code', fixedTimeout.failure.code, fixedTimeout.code);
check('no status key invented when absent', Object.prototype.hasOwnProperty.call(fixedTimeout.failure, 'status'), false);
check('timeout message survives', fixedTimeout.failure.message, fixedTimeout.message);

// .failure.message 必須等於 Error.message，否則 core 會因為兩個 own property
// 不一致而整組丟棄（連 .code 一起）——這是最容易寫錯的一點。
check('failure.message mirrors Error.message', fixed403.failure.message, fixed403.message);

const fixed429 = toFailure(new Error('slow'), { ...classifyHttpFailure(429), status: 429 });
check('429 maps to RATE_LIMIT', fixed429.failure.code, 'RATE_LIMIT');

// 429 不一定是限流：上游也用 429 表達「這個模型的端點維護／不可用」。
// 若一律判成 rate-limited，備援不會接手，使用者只會一直撞同一個模型。
// 上游原文是簡體，這裡用 Unicode 轉義表示，避免繁體檢查把測試檔判成混入簡體。
const ENDPOINT_ZH = '\u8be5\u6a21\u578b\u4e0a\u6e38\u7aef\u70b9\u76ee\u524d'
  + '\u7ef4\u62a4/\u4e0d\u53ef\u7528\uff0c\u8bf7\u5207\u6362\u5176\u4ed6\u5728\u7ebf\u6a21\u578b';

const endpoint429 = classifyHttpFailure(429, null, {
  rawText: JSON.stringify({
    error: {
      type: 'unknown_error',
      message: `Upstream request failed: Endpoint is unavailable. (${ENDPOINT_ZH})`
    }
  })
});
check('429 + Chinese endpoint notice (no English) is a transient outage',
  classifyHttpFailure(429, null, { rawText: ENDPOINT_ZH }).reason, 'endpoint-unavailable');
check('429 + endpoint unavailable is a transient outage', endpoint429.reason, 'endpoint-unavailable');
check('endpoint 429 stays retryable (it recovers in seconds)', endpoint429.retryable, true);
check('endpoint 429 keeps a DSH error code', endpoint429.code, 'RATE_LIMIT');
const explicit429 = classifyHttpFailure(429, null, { rawText: '{"error":{"message":"Rate limit exceeded"}}' });
check('explicit Rate limit exceeded is separately classified', explicit429.reason, 'rate-limited-explicit');
check('explicit rate limit remains retryable', explicit429.retryable, true);
const generic429 = classifyHttpFailure(429, null, { rawText: 'upstream error' });
check('unrecognized 429 body remains generic', generic429.reason, 'rate-limited');

// 404 is terminal only when the body or structured error names a missing model.
const generic404 = classifyHttpFailure(404, null);
check('bare 404 is a non-terminal endpoint error', generic404.reason, 'endpoint-not-found');
check('generic endpoint 404 is not a model tombstone', generic404.code, 'SERVER');
const route404 = classifyHttpFailure(404, null, {
  rawText: '{"error":{"message":"Cannot POST /v1/chat/completions"}}'
});
check('generic route 404 stays non-terminal', route404.reason, 'endpoint-not-found');
check('a model endpoint 404 is not mistaken for a missing model',
  classifyHttpFailure(404, null, { rawText: '{"error":{"message":"Model endpoint not found"}}' }).reason,
  'endpoint-not-found');
const bodyModel404 = classifyHttpFailure(404, null, {
  rawText: '{"error":{"message":"Model some-free was not found"}}'
});
check('explicit model-specific 404 is terminal', bodyModel404.reason, 'not-found');
const typeModel404 = classifyHttpFailure(404, 'ModelNotFoundError', {
  rawText: '{"error":{"type":"ModelNotFoundError"}}'
});
check('structured model not-found type is terminal', typeModel404.reason, 'not-found');

// body 解析的容錯：分類本身絕不能成為新的失敗來源。
check('parseErrorType reads nested type', parseErrorType('{"error":{"type":"RegionError"}}'), REGION_ERROR);
check('parseErrorType reads top-level type', parseErrorType('{"type":"FreeTierError"}'), FREE_TIER_ERROR);
check('parseErrorType tolerates non-JSON', parseErrorType('<html>403</html>'), null);
check('parseErrorType tolerates empty', parseErrorType(''), null);
check('detectErrorType finds the marker', detectErrorType('oops FreeTierError here'), FREE_TIER_ERROR);
check('detectErrorType returns null when absent', detectErrorType('generic failure'), null);

if (fail > 0) throw new Error(`Failure classification: ${fail} check(s) failed`);
console.log(`\n✔ Failure classification tests passed (${pass} checks)`);
