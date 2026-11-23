/**
 * 模型備援（前三順位）的迴歸測試。
 *
 * 這份測試守的是一個很容易寫錯、而且錯了你會很晚才發現的判斷：
 * **什麼時候該換模型，什麼時候絕對不該換。**
 *
 * 會壞掉的方式很具體：
 *
 *   - 對每個錯誤都換模型 → IP 被風控時會對 30 個模型各送一次注定失敗的請求，
 *     讓這個 IP 的評分更差，而且真正該處理的問題（關 VPN）完全看不到。
 *   - 永遠不換模型 → 使用者要的功能等於沒做。
 *   - 已經吐了內容才換 → 使用者看到兩段拼接的答案。
 *
 * 所以以下每一條都是「這個判斷錯了就會有人踩到」的行為。
 */
import {
  MAX_FALLBACK_MODELS,
  buildAttemptChain,
  canFallback,
  isChannelLevelFailure,
  normalizeModelList
} from '../lib/fallback.js';
import { classifyHttpFailure, detectErrorType, toFailure, NETWORK_BLOCKED_ERROR } from '../lib/failures.js';

console.log('--- Testing Model Fallback ---');

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

/* --------------------------------------------------- 哪些失敗該換模型 */

console.log('\n[模型層級 → 可以換]');
for (const reason of ['unavailable', 'deprecated', 'not-found', 'region-restricted', 'timeout', 'transport']) {
  check(`${reason} 可以換模型`, canFallback(reason), true);
}

console.log('\n[通道層級 → 不可以換]');
for (const reason of ['network-blocked', 'free-lane-blocked', 'unauthorized', 'forbidden', 'quota-exceeded']) {
  check(`${reason} 不可以換模型`, canFallback(reason), false);
  check(`${reason} 被視為通道層級`, isChannelLevelFailure(reason), true);
}

// 5xx 是閘道本身出問題，換模型不會好；而且它已在 SAFE_RETRY_POLICY 裡，
// 上層會自己重試同一個模型。兩邊都重試只會讓請求量翻倍。
check('upstream-error 不換模型（交給上層重試）', canFallback('upstream-error'), false);

// 未知／缺值必須保守：寧可不換，也不要亂換。
check('null reason 不換', canFallback(null), false);
check('undefined reason 不換', canFallback(undefined), false);
check('自創 reason 不換', canFallback('something-new'), false);

/* --------------------------------------------- 風控訊息的分類與傳遞 */

console.log('\n[IP 風控訊息]');
const ABUSE = "OpenCode's free models aren't available from your current network because "
  + "we've detected abusive traffic from this IP address. This isn't related to your "
  + "account. If you're on a VPN or proxy, turn it off and try again, or subscribe to "
  + "OpenCode Go at https://opencode.ai/go to keep building.";

check('從自由文字認出網路風控', detectErrorType(ABUSE), NETWORK_BLOCKED_ERROR);
// 上游改字時仍要認得出來：這三個片段分別出現在句首、句中、括號裡。
check('認得 current network 片段', detectErrorType('unavailable from your current network'), NETWORK_BLOCKED_ERROR);
check('認得 from this ip address 片段', detectErrorType('requests from this IP address are limited'), NETWORK_BLOCKED_ERROR);
check('認得大小寫不同的版本', detectErrorType('Abusive Traffic detected'), NETWORK_BLOCKED_ERROR);

const blocked403 = classifyHttpFailure(403, NETWORK_BLOCKED_ERROR);
check('403 風控 → reason network-blocked', blocked403.reason, 'network-blocked');
check('403 風控 → 不可重試', blocked403.retryable, false);
check('403 風控 → 錯誤碼仍合法（AUTH）', blocked403.code, 'AUTH');
check('403 風控的提示提到關 VPN', /VPN/.test(blocked403.hint), true);
check('403 風控的提示附上訂閱網址', /opencode\.ai\/go/.test(blocked403.hint), true);
// 上游明確說「與帳號無關」，所以提示不可以叫人重新登入。
check('403 風控的提示不叫人重新登入', /重新登入|重新授權/.test(blocked403.hint), false);

// 429 帶同一段文字時也必須判成風控，而不是「被限流、可以重試」。
// 這是實測看過的上游行為，弄錯就會自動重試一個永遠不會成功的請求。
const blocked429 = classifyHttpFailure(429, NETWORK_BLOCKED_ERROR);
check('429 風控優先於限流判斷', blocked429.reason, 'network-blocked');
check('429 風控也不可重試', blocked429.retryable, false);

// 風控優先於 FreeTierError：上游有時把這段話包在 FreeTierError 的 body 裡。
check(
  'body 同時含 FreeTierError 與風控文字時，判為風控',
  detectErrorType(`${ABUSE} (FreeTierError)`),
  NETWORK_BLOCKED_ERROR
);

console.log('\n[reason 要傳到 Error 上，備援迴圈才讀得到]');
// 沒有附 rawText 的 400 屬於「上游沒說原因」那一支。
// 這是刻意的：400 不再是「一律模型下線」，沒有文字線索時我們不猜原因。
const failed = toFailure(new Error('boom'), classifyHttpFailure(400, null));
check('toFailure 掛上 .reason', failed.reason, 'bad-request');
check('toFailure 的 .code 不受影響', failed.code, 'INVALID_REQUEST');
check('toFailure 仍設定 .failure.code', failed.failure.code, failed.code);
check('toFailure 不把 reason 塞進 .failure（DSH 不認得它）', 'reason' in failed.failure, false);
check('toFailure 的「無說明 400」不可重試（重打同一模型沒用）', failed.reason !== 'unavailable', true);

console.log('\n[400 要分成三種：上下文超限 / 模型不可用 / 上游沒說]');
// 這三種共用 400，但處置完全相反。以前一律標成「模型下線」，
// 於是上下文超限的人會去換模型（換到的上下文更小），
// 只回 `{"model":"..."}` 的人也會去換模型（其實是帳號權限）。
const overflow = classifyHttpFailure(400, null, {
  rawText: 'Your request resulted in more tokens than this model\'s maximum context length allows. '
    + 'Please reduce the length of the messages or run compaction.'
});
check('上下文超限 → reason=context-overflow', overflow.reason, 'context-overflow');
check('上下文超限 → code=INVALID_REQUEST', overflow.code, 'INVALID_REQUEST');
check('上下文超限 → 不可重試', overflow.retryable, false);
check('上下文超限 → 提示要叫人壓縮，不是換模型', /壓縮|縮短/.test(overflow.hint), true);

const unavail = classifyHttpFailure(400, null, { rawText: '{"error":{"message":"Model is unavailable."}}' });
check('明說模型不可用 → reason=unavailable', unavail.reason, 'unavailable');

const bare = classifyHttpFailure(400, null, { rawText: '{"model":"deepseek-v4.1-flash-free"}' });
check('只有模型名稱 → reason=bad-request', bare.reason, 'bad-request');
check('只有模型名稱 → 提示承認上游沒說明', /沒有附上可讀/.test(bare.hint), true);

// 「模型不可用」與「沒說」都要能被備援接手，否則使用者卡死在壞模型上。
check('unavailable 可以備援', canFallback('unavailable'), true);
check('bad-request 可以備援', canFallback('bad-request'), true);
// 上下文超限不該備援：換模型只會更糟（其他模型上下文更小）。
check('context-overflow 不備援（換模型只會更嚴重）', canFallback('context-overflow'), false);

/* ---------------------------------------------------------- 順序計算 */

console.log('\n[嘗試順序]');
const allAvailable = () => true;
const settingsOn = (models) => ({ enabled: true, models });

check(
  '備援關閉時只試主模型',
  buildAttemptChain({ primary: 'a', settings: { enabled: false, models: ['b'] }, isAvailable: allAvailable }),
  ['a']
);
check(
  '主模型永遠排第一',
  buildAttemptChain({ primary: 'a', settings: settingsOn(['b', 'c']), isAvailable: allAvailable }),
  ['a', 'b', 'c']
);
check(
  '主模型也在順位裡時不重複',
  buildAttemptChain({ primary: 'b', settings: settingsOn(['b', 'c']), isAvailable: allAvailable }),
  ['b', 'c']
);
check(
  '已判定不可用的模型不放進順位',
  buildAttemptChain({
    primary: 'a',
    settings: settingsOn(['b', 'c']),
    isAvailable: (id) => id !== 'b'
  }),
  ['a', 'c']
);
// catalog 還沒探測完（isAvailable 一律 true）時仍要能用，否則「剛裝好就勾選備援」
// 看起來會完全沒作用。
check(
  '未探測的模型仍然列入',
  buildAttemptChain({ primary: 'a', settings: settingsOn(['b']), isAvailable: () => true }),
  ['a', 'b']
);
// isAvailable 回 null 代表「不知道」；不知道就不該排除，理由同上一條。
check(
  '可用性未知（null）時不排除',
  buildAttemptChain({ primary: 'a', settings: settingsOn(['b']), isAvailable: () => null }),
  ['a', 'b']
);
check(
  '設定物件壞掉時只留主模型',
  buildAttemptChain({ primary: 'a', settings: null, isAvailable: allAvailable }),
  ['a']
);
check(
  '空字串不會進到順位',
  buildAttemptChain({ primary: 'a', settings: settingsOn(['', 'b']), isAvailable: allAvailable }),
  ['a', 'b']
);

// 410 的上游建議（metadata.replacement）排在隊尾：使用者排的順位是他明確
// 表達的偏好，靜默擠掉會讓人以為設定沒生效；但都失敗時它值得一試。
console.log('\n[上游建議的替代模型]');
check(
  '替代模型接在使用者順位之後',
  buildAttemptChain({
    primary: 'space-bunny-free',
    settings: settingsOn(['b']),
    isAvailable: allAvailable,
    replacement: 'minimax-m3.1-flash-free'
  }),
  ['space-bunny-free', 'b', 'minimax-m3.1-flash-free']
);
check(
  '替代模型就是主模型時不重複',
  buildAttemptChain({
    primary: 'a',
    settings: settingsOn(['b']),
    isAvailable: allAvailable,
    replacement: 'a'
  }),
  ['a', 'b']
);
check(
  '備援關閉時不採用替代模型',
  buildAttemptChain({
    primary: 'a',
    settings: { enabled: false, models: [] },
    isAvailable: allAvailable,
    replacement: 'x'
  }),
  ['a']
);
check(
  '替代模型已判定不可用時不加入',
  buildAttemptChain({
    primary: 'a',
    settings: settingsOn(['b']),
    isAvailable: (id) => id !== 'x',
    replacement: 'x'
  }),
  ['a', 'b']
);

const deprecated410 = classifyHttpFailure(410, 'ModelDeprecated', { replacement: 'minimax-m3.1-flash-free' });
check('410 帶出上游建議的替代模型', deprecated410.replacement, 'minimax-m3.1-flash-free');
check('410 的提示直接寫出替代模型', /minimax-m3\.1-flash-free/.test(deprecated410.hint), true);
check('410 沒有建議時提示照舊', classifyHttpFailure(410, 'ModelDeprecated').hint, '這個模型已下架（410）。');
check('410 沒有建議時不帶替代模型', classifyHttpFailure(410, 'ModelDeprecated').replacement, null);

/* -------------------------------------------------------- 清單正規化 */

console.log('\n[儲存前的正規化]');
check('去掉空白', normalizeModelList(['  a  ']), ['a']);
check('去掉重複（保留先出現的）', normalizeModelList(['a', 'a']), ['a']);
check('非字串一律丟掉', normalizeModelList([3, null, 'a']), ['a']);
check('去掉空字串', normalizeModelList(['', 'a']), ['a']);
// 上限現在是 1：多加的順位會被截掉。
check(`截到 ${MAX_FALLBACK_MODELS} 個`, normalizeModelList(['a', 'b', 'c', 'd']), ['a']);
check('上限確實是 1（縮減後的行為鎖住，避免又悄悄變回 3）', MAX_FALLBACK_MODELS, 1);
check('非陣列輸入回空清單', normalizeModelList('a,b'), []);
check('undefined 回空清單', normalizeModelList(undefined), []);

if (fail > 0) throw new Error(`Model fallback: ${fail} check(s) failed`);
console.log(`\n✔ Model fallback tests passed (${pass} checks)`);
