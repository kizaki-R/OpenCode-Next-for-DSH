/**
 * 變異測試：確認 race.test.mjs 的競態檢查真的抓得到缺陷。
 *
 * 為什麼要這一支：「測試全綠」只證明測試跑得完，不證明它測到了東西。一支
 * 寫錯的檢查可能永遠通過，於是缺陷回來了也沒人知道。這裡刻意把修正拿掉，
 * 再跑同一套競態檢查——若仍然全綠，代表那些檢查是空轉的。
 *
 * 做法是把 lib/ 複製一份，針對副本做兩處還原（都只在副本上，原檔不受影響）：
 *   1. 移除「另一個請求正在索取時共用同一組代碼」的分支
 *   2. 移除世代比對（登出後仍把 pendingLogin 寫回去）
 */
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SRC = fileURLToPath(new URL('../', import.meta.url));
const HERE = fileURLToPath(new URL('.', import.meta.url));

const work = mkdtempSync(path.join(tmpdir(), 'ocoa-mutant-'));
let ok = false;
let detail = '';

try {
  mkdirSync(path.join(work, 'lib'), { recursive: true });
  cpSync(path.join(SRC, 'lib'), path.join(work, 'lib'), { recursive: true });
  cpSync(path.join(SRC, 'package.json'), path.join(work, 'package.json'));

  const target = path.join(work, 'lib', 'web-api.js');
  const original = readFileSync(target, 'utf8');
  let text = original;

  // 變異 1：拿掉「共用索取中的代碼」分支。
  text = text.replace(/\n\s*\/\/ 另一個請求正在索取代碼[\s\S]*?\n {14}\}\n/, '\n');
  // 變異 2：拿掉世代比對。
  text = text.replace(/\n\s*\/\/ 索取期間發生了登出[\s\S]*?\n {14}\}\n/, '\n');

  if (text === original) {
    detail = '變異沒套用成功——web-api.js 的結構可能變了，請更新這支測試的比對樣式。';
  } else {
    writeFileSync(target, text, 'utf8');
    const run = spawnSync(process.execPath, [path.join(HERE, 'race.test.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, OCOA_RACE_SRC: work }
    });
    if (run.error) {
      detail = `無法啟動競態測試：${run.error.message}`;
    } else if (run.status === 0) {
      detail = '把修正拿掉之後競態測試仍然全綠——那些檢查並沒有真的在驗證競態。';
    } else {
      ok = true;
      detail = `修正拿掉後競態測試如預期失敗（exit ${run.status}）。`;
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`  ${ok ? 'ok  ' : 'FAIL'} - 競態檢查能抓到缺陷${ok ? '' : `  ${detail}`}`);
if (ok) console.log(`        ${detail}`);
else process.exit(1);
