/**
 * 確認 config.js 改寫後，開發機（junction 情境）仍然拿到**真的** schemastery，
 * 而不是靜默掉到 stub。
 *
 * 為什麼需要這支：config.js 有三層退路，而且第二、三層都不會報錯。如果第二層
 * 改壞了，外掛照樣載入、照樣用正確的預設值——只是欄位層級的驗證（min/max）
 * 悄悄消失。例如 streamIdleTimeoutMs 設成 1 毫秒就不再被擋下來。
 *
 * 分辨真假 schemastery 的辦法：真的會套用 .min()，所以超出範圍的值會產生
 * issues 並讓 resolveConfig 丟出錯誤；stub 的 min() 是空操作，會直接放行。
 */
import { resolveConfig } from '../lib/config.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   - ${name}`);
  else { failures++; console.log(`  FAIL - ${name}  (${detail})`); }
}

console.log('--- 辨識目前載入的是真的 schemastery 還是 stub ---');
check('auto-switch 預設關閉', resolveConfig({}).autoSwitchAccounts === false);
check('auto-switch 可由設定明確啟用', resolveConfig({ autoSwitchAccounts: true }).autoSwitchAccounts === true);

// 真的 schemastery：streamIdleTimeoutMs 有 .min(1000)，設 1 應該產生驗證錯誤。
let threwOnTooSmall = false;
let msg = '';
try {
  resolveConfig({ streamIdleTimeoutMs: 1 });
} catch (err) {
  threwOnTooSmall = true;
  msg = err.message;
}

check('超出下限的值會被擋下來（代表是真的 schemastery，不是 stub）',
  threwOnTooSmall, '沒有丟出錯誤 → 目前是 stub，欄位驗證已靜默失效');
if (threwOnTooSmall) console.log(`         錯誤訊息：${msg.slice(0, 100)}`);

// 對照組：合法值必須正常通過。
let okOnValid = false;
try {
  const c = resolveConfig({ streamIdleTimeoutMs: 5000 });
  okOnValid = c.streamIdleTimeoutMs === 5000;
} catch { /* fall through */ }
check('合法值正常通過', okOnValid);

// imageMaxBytes 有 .min(65536)，同樣用來交叉確認驗證是活的。
let threwOnSmallBytes = false;
try { resolveConfig({ imageMaxBytes: 1024 }); } catch { threwOnSmallBytes = true; }
check('imageMaxBytes 下限也有效（交叉確認）', threwOnSmallBytes);

console.log(`\n${failures === 0 ? '✔ 真實 schemastery 生效中' : `❌ ${failures} 項失敗`}`);
if (failures > 0) process.exit(1);
