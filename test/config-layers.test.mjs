/**
 * 證明 config.js 的第二層退路在「開發機 junction 情境」下真的被用到且有效。
 *
 * 背景：外掛以 junction 掛進 profile 時，Node 用 realpath 解析，載入起點是**原始碼
 * 目錄**，往上是使用者的專案資料夾——找不到 profile 的 node_modules，所以第一層
 * `import('@deepseek-ai/schemastery')` 必然失敗。這台開發機就是靠第二層在活。
 *
 * 為什麼要單獨證明這件事：三層退路都不會報錯。如果第二層壞掉，外掛照樣載入、
 * 預設值照樣正確，只有欄位驗證（min/max）靜默消失。所以必須明確驗證：
 *
 *   1. 從原始碼目錄載入時，第一層確實失敗（否則這個測試沒測到第二層）；
 *   2. 帶 DSH_PROFILE_DIR 時，第二層成功拿到**真的** schemastery；
 *   3. 拿掉所有 DSH 環境變數時，安全落到 stub（不丟例外，預設值仍正確）。
 *
 * 第 2 與第 3 點用子程序跑，才能乾淨地控制環境變數。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   - ${name}`);
  else { failures++; console.log(`  FAIL - ${name}  (${detail})`); }
}

const srcRoot = fileURLToPath(new URL('../', import.meta.url));

/** 在一個乾淨的臨時目錄（沒有 node_modules）複製 lib/，模擬 junction 的載入起點。 */
const work = mkdtempSync(path.join(tmpdir(), 'ocoa-layer-'));
try {
  mkdirSync(path.join(work, 'lib'), { recursive: true });
  cpSync(path.join(srcRoot, 'lib'), path.join(work, 'lib'), { recursive: true });
  cpSync(path.join(srcRoot, 'package.json'), path.join(work, 'package.json'));

  const cfgPath = path.join(work, 'lib', 'config.js').replace(/\\/g, '/');
  const cfgUrl = `file:///${cfgPath}`;

  console.log('--- 1. 第一層在這裡確實會失敗（確認測試有測到第二層）---');
  const probeScript = path.join(work, 'probe.mjs');
  writeFileSync(probeScript, `
    let first = 'ok';
    try { await import('@deepseek-ai/schemastery'); } catch (e) { first = e.code; }
    console.log(JSON.stringify({ first }));
  `, 'utf8');
  const probeOut = JSON.parse(execFileSync(process.execPath, [probeScript], {
    encoding: 'utf8',
    // 刻意清掉 DSH 變數，只測第一層的解析能力。
    env: { ...process.env, DSH_HOME: '', DSH_PROFILE_DIR: '', DSH_PROFILE: '' }
  }).trim());
  check('從無 node_modules 的位置，第一層 import 失敗', probeOut.first !== 'ok', probeOut.first);

  console.log('\n--- 2. 帶 DSH_PROFILE_DIR 時第二層拿到真的 schemastery ---');
  // 用真實的 profile 目錄（本機或 CI 環境存在 schemastery）。
  const dshHome = process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  const realProfile = process.env.DSH_PROFILE_DIR
    || path.join(dshHome, 'profiles', 'desktop');

  const layerScript = path.join(work, 'layer.mjs');
  writeFileSync(layerScript, `
    const mod = await import(${JSON.stringify(cfgUrl)});
    // 真的 schemastery 會擋下低於 min 的值；stub 會放行。這是分辨的辦法。
    let realSchema = false, msg = '';
    try { mod.resolveConfig({ streamIdleTimeoutMs: 1 }); }
    catch (e) { realSchema = true; msg = e.message; }
    const cfg = mod.resolveConfig({});
    console.log(JSON.stringify({ realSchema, msg: msg.slice(0, 80), providerId: cfg.providerId,
      idle: cfg.streamIdleTimeoutMs }));
  `, 'utf8');

  const withEnv = JSON.parse(execFileSync(process.execPath, [layerScript], {
    encoding: 'utf8',
    env: { ...process.env, DSH_PROFILE_DIR: realProfile, DSH_HOME: process.env.DSH_HOME || '' }
  }).trim());
  check('第二層載入成功並套用真實驗證（min 生效）', withEnv.realSchema,
    `msg=${withEnv.msg} → 目前是 stub`);
  check('預設值仍正確（providerId）', withEnv.providerId === 'opencode-next', withEnv.providerId);
  check('預設值仍正確（streamIdleTimeoutMs）', withEnv.idle === 60000, String(withEnv.idle));
  if (withEnv.realSchema) console.log(`         驗證器訊息：${withEnv.msg}`);

  console.log('\n--- 3. 完全沒有 DSH 環境變數時，安全落到 stub ---');
  const noEnv = JSON.parse(execFileSync(process.execPath, [layerScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: '', DSH_PROFILE_DIR: '', DSH_PROFILE: '',
      USERPROFILE: path.join(tmpdir(), '__no_such_home__'),
      HOME: path.join(tmpdir(), '__no_such_home__')
    }
  }).trim());
  check('沒有環境變數時不丟例外（安全退到 stub）', noEnv.providerId === 'opencode-next',
    noEnv.providerId);
  check('退到 stub 時驗證放行（確認真的是 stub，不是意外成功）', noEnv.realSchema === false,
    '仍是真驗證器，此情境沒有測到第三層');
  check('退到 stub 時預設值仍全部正確', noEnv.idle === 60000, String(noEnv.idle));

  console.log('\n--- 4. DSH_HOME 推導也成立（沒有 DSH_PROFILE_DIR 時）---');
  // 從 DSH_HOME 推出 <home>/profiles/<name>/ 應該也能解析。
  const derived = JSON.parse(execFileSync(process.execPath, [layerScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_PROFILE_DIR: '',                       // 刻意拿掉，逼它從 DSH_HOME 推
      DSH_HOME: dshHome,
      DSH_PROFILE: 'desktop'
    }
  }).trim());
  check('只用 DSH_HOME + DSH_PROFILE 也能解析到 schemastery', derived.realSchema,
    '推導路徑失敗 → 會落到 stub');
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '✔ schemastery 三層退路全部驗證通過' : `❌ ${failures} 項失敗`}`);
if (failures > 0) process.exit(1);
