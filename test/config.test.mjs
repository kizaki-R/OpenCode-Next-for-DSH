/**
 * 設定解析的契約測試（lib/config.js）。
 *
 * 為什麼要測這個：設定是**靜默失效**的典型。若 `resolveConfig` 少一個欄位或用了
 * `||` 而不是 `??`，外掛不會報錯——它會用一個錯的預設值運作。例如
 * `catalogPollMs: 0`（使用者刻意關閉輪詢）若被 `||` 吞掉，就會變成 900000，
 * 使用者以為關了、其實每 15 分鐘還在打上游。這一支把每個欄位的預設值與覆寫
 * 行為都固定下來，並專門測 `0` 與 `false` 這兩個會被 `||` 吃掉的假值。
 *
 * 另外驗證 schemastery 缺席時的行為：config.js 有內建 stub 作為最後手段，
 * 那條路徑也必須給出正確的預設值。
 */

import { resolveConfig, Config } from '../lib/config.js';
import { readFileSync } from 'node:fs';

let failures = 0;
let checks = 0;
function check(name, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${name}${cond ? '' : `  ${detail}`}`);
}

console.log('--- 預設值 ---');
const d = resolveConfig({});
check('providerId', d.providerId === 'opencode-oauth', d.providerId);
check('providerName 非空', typeof d.providerName === 'string' && d.providerName.length > 0, d.providerName);
check('inferenceUrl 指向 opencode', /opencode/i.test(d.inferenceUrl), d.inferenceUrl);
check('credentialPath 預設為空字串（代表自動偵測）', d.credentialPath === '', JSON.stringify(d.credentialPath));
check('streamIdleTimeoutMs = 60000', d.streamIdleTimeoutMs === 60000, String(d.streamIdleTimeoutMs));
check('autoDetectModels = true', d.autoDetectModels === true, String(d.autoDetectModels));
check('Bun transport 預設關閉（明確 opt-in）', d.bunTransport?.enabled === false, JSON.stringify(d.bunTransport));
check('Bun transport 可由 bundle 設定明確啟用', resolveConfig({ bunTransport: { enabled: true } }).bunTransport?.enabled === true);
check('probeIntervalMs = 21600000（6 小時）', d.probeIntervalMs === 21600000, String(d.probeIntervalMs));
check('catalogPollMs = 900000（15 分）', d.catalogPollMs === 900000, String(d.catalogPollMs));
check('probeCachePath 預設為空字串', d.probeCachePath === '', JSON.stringify(d.probeCachePath));
check('imagePixelBudget = 640000', d.imagePixelBudget === 640000, String(d.imagePixelBudget));
check('imageMaxBytes = 2097152（2 MiB）', d.imageMaxBytes === 2097152, String(d.imageMaxBytes));

console.log('\n--- 呼叫端不傳參數也要能用 ---');
let threw = null;
let d2 = null;
try { d2 = resolveConfig(); } catch (err) { threw = err; }
check('resolveConfig() 不丟例外', threw === null, threw?.message);
check('resolveConfig() 回傳預設值', d2?.providerId === 'opencode-oauth', d2?.providerId);

console.log('\n--- 假的預設值必須被保留（|| 會吃掉的那些）---');
// 這是最容易寫錯的地方：0 與 false 是合法設定值，不是「沒給」。
const zeroPoll = resolveConfig({ catalogPollMs: 0 });
check('catalogPollMs: 0 保留為 0（使用者刻意關閉輪詢）', zeroPoll.catalogPollMs === 0,
  `得到 ${zeroPoll.catalogPollMs}`);

const noDetect = resolveConfig({ autoDetectModels: false });
check('autoDetectModels: false 保留為 false', noDetect.autoDetectModels === false,
  `得到 ${noDetect.autoDetectModels}`);

check('全部欄位都不是 undefined',
  Object.entries(d).every(([, v]) => v !== undefined),
  Object.entries(d).filter(([, v]) => v === undefined).map(([k]) => k).join(','));

console.log('\n--- 覆寫 ---');
check('providerId 可覆寫', resolveConfig({ providerId: 'x' }).providerId === 'x');
check('providerName 可覆寫', resolveConfig({ providerName: 'My Name' }).providerName === 'My Name');
check('inferenceUrl 可覆寫',
  resolveConfig({ inferenceUrl: 'https://example.test/v1' }).inferenceUrl === 'https://example.test/v1');
check('credentialPath 可覆寫',
  resolveConfig({ credentialPath: '/tmp/tok.json' }).credentialPath === '/tmp/tok.json');
check('streamIdleTimeoutMs 可覆寫',
  resolveConfig({ streamIdleTimeoutMs: 120000 }).streamIdleTimeoutMs === 120000);
check('probeIntervalMs 可覆寫',
  resolveConfig({ probeIntervalMs: 60000 }).probeIntervalMs === 60000);
check('imagePixelBudget 可覆寫',
  resolveConfig({ imagePixelBudget: 10000 }).imagePixelBudget === 10000);

console.log('\n--- Config 有暴露給 DSH（不再依賴猜測）---');
check('Config 不是 undefined', Config !== undefined);
// DSH 用 ~standard 驗證；stub 或真的 schemastery 都必須提供這個介面。
check('Config 提供 ~standard.validate',
  typeof Config?.['~standard']?.validate === 'function',
  JSON.stringify(Object.keys(Config ?? {})));

console.log('\n--- schemastery 缺席時的最後手段（stub）也要正確 ---');
// 這一支無法在同一個程序內卸掉已載入的 schemastery，所以改為靜態確認：
// stub 的 validate 必須把 undefined 換成欄位預設值，否則無 schemastery 的環境
// 會拿到一堆 undefined。
const src = readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8');
check('有 stub 作為最後手段', /Fallback stub if schemastery is completely unavailable/.test(src));
check('stub 的 validate 會套用預設值', /value: val === undefined \? defaultValue : val/.test(src));
check('第一層退路是正規的 import（別台安裝走這條）',
  /await import\('@deepseek-ai\/schemastery'\)/.test(src));

// 第二層退路（開發機的 junction 情境）**不得**把開發者的使用者名稱編進出貨的檔案。
// 改用 DSH 執行階段提供的環境變數推導 profile 目錄。
check('第二層退路沒有硬編碼使用者名稱',
  !/[A-Za-z]:[\\/]Users[\\/]/i.test(src),
  '仍含有 C:/Users/<某人>/ 這種絕對路徑');
check('第二層退路使用 DSH_HOME',
  /process\.env\.DSH_HOME/.test(src));
check('第二層退路使用 DSH_PROFILE_DIR',
  /process\.env\.DSH_PROFILE_DIR/.test(src));
check('第二層退路有預設 profile 名稱', /process\.env\.DSH_PROFILE/.test(src));

console.log(`\n${failures === 0 ? `✔ Config tests passed (${checks} checks)` : `❌ ${failures} / ${checks} checks failed`}`);
if (failures > 0) process.exit(1);
