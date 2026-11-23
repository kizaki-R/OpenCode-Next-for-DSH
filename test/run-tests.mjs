import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 測試套件絕對不能動到使用者真正的資料。
 *
 * 這條規則來自兩次真實事故：`settings.test.mjs` 用預設路徑建立 catalog 與
 * TokenManager，再打 `/logout` 與 `/refresh`，於是跑一次 `npm test` 就
 * 刪掉 `~/.dsh/opencode-next.models.json`（整份探測紀錄），還會真的向上游
 * 刷新 token 並改寫 `opencode-next.accounts.json`。
 *
 * 使用者的症狀是「打開設定頁，先前的探測紀錄不見了」，而元凶是測試本身。
 * 所以每次執行前後都對這幾個檔做雜湊比對，一有變動就讓整輪失敗並指名檔案。
 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const GUARDED = [
  'opencode-next.models.json',
  'opencode-next.accounts.json',
  'opencode-next.token.json',
  'opencode-next.picker.json',
  'opencode-next.go-picker.json',
  'opencode-next.context.json'
];

function snapshot() {
  const state = new Map();
  for (const name of GUARDED) {
    const file = path.join(DSH_HOME, name);
    state.set(name, existsSync(file)
      ? createHash('sha256').update(readFileSync(file)).digest('hex')
      : null);
  }
  return state;
}

const before = snapshot();

function runTest(testFile) {
  console.log(`\n======================================================`);
  console.log(`Running: ${testFile}`);
  console.log(`======================================================`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, testFile)], {
      encoding: 'utf8',
      stdio: 'inherit'
    });
  } catch (err) {
    console.error(`❌ Test failed: ${testFile}`);
    process.exit(1);
  }
}

console.log('🚀 Running opencode-next Master Test Suite...\n');

runTest('accounts.test.mjs');
runTest('account-switch.test.mjs');
runTest('device-flow.test.mjs');
runTest('login-feedback.test.mjs');
runTest('auth.test.mjs');
runTest('catalog.test.mjs');
runTest('catalog-availability.test.mjs');
runTest('picker.test.mjs');
runTest('context-window.test.mjs');
runTest('probe.test.mjs');
runTest('bun-transport.test.mjs');
runTest('config.test.mjs');
runTest('config-schema.test.mjs');
runTest('config-layers.test.mjs');
runTest('failures.test.mjs');
runTest('fallback.test.mjs');
runTest('entry.test.mjs');
runTest('entry-mutation.test.mjs');
runTest('settings.test.mjs');
runTest('render.test.mjs');
runTest('race.test.mjs');
runTest('race-mutation.test.mjs');
runTest('traditional-chinese.test.mjs');
runTest('locale-structure-mutation.test.mjs');
runTest('content.test.mjs');
runTest('watchdog.test.mjs');
runTest('stream-chunks.test.mjs');
runTest('stream.test.mjs');
runTest('go-credentials.test.mjs');
runTest('go-client.test.mjs');
runTest('go-service-race.test.mjs');
runTest('go-entry-and-ui.test.mjs');
runTest('go-inference.test.mjs');
runTest('package.test.mjs');

const after = snapshot();
const touched = GUARDED.filter((name) => before.get(name) !== after.get(name));
if (touched.length > 0) {
  // 這幾行刻意用英文：守門訊息常常是在 CI 或 `cmd /c ... > file` 之下被讀，
  // 那些環境不一定用 UTF-8 解碼，中文會變成亂碼，反而看不出哪裡壞了。
  console.error('\nFAIL: the test suite modified real user data:');
  for (const name of touched) {
    const was = before.get(name) === null ? 'absent' : 'present';
    const now = after.get(name) === null ? 'absent' : 'present';
    console.error(`   - ${path.join(DSH_HOME, name)} (${was} -> ${now})`);
  }
  console.error('\nTests must use temp paths (probeCachePath, and the TokenManager');
  console.error('storePath/accountsPath). Never rely on the default ~/.dsh paths.');
  process.exit(1);
}
console.log(`\nOK: none of the ${GUARDED.length} user data files were modified by the suite`);

console.log('\n======================================================');
console.log('🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY!');
console.log('======================================================\n');
