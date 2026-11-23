/**
 * 變異測試：確認 entry.test.mjs 的檢查真的抓得到缺陷。
 *
 * 一支永遠全綠的測試可能什麼都沒測。這裡把 index.js 的三個關鍵防護逐一拿掉，
 * 每次都要讓 entry.test.mjs 失敗才算通過。
 *
 * 三個防護：
 *   A. 設定頁註冊的 try/catch —— 拿掉後，設定頁出錯會拖垮整個 provider
 *   B. 沒有 export default —— 加上後，載入器的 unwrapExports 會折疊 namespace
 *   C. dispose 清理 —— 拿掉後，卸載的外掛仍會持續打上游
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../', import.meta.url));
let failures = 0;

/** 把 lib/ + test/ 複製到暫存目錄，套用一個變異，然後跑 entry.test.mjs。 */
function runMutant(name, mutate) {
  const work = mkdtempSync(path.join(tmpdir(), 'ocoa-entry-mut-'));
  try {
    mkdirSync(path.join(work, 'lib'), { recursive: true });
    mkdirSync(path.join(work, 'test'), { recursive: true });
    cpSync(path.join(SRC, 'lib'), path.join(work, 'lib'), { recursive: true });
    cpSync(path.join(SRC, 'test', 'entry.test.mjs'), path.join(work, 'test', 'entry.test.mjs'));
    // config.js 會嘗試解析 schemastery；複製一份 package.json 讓型別判定一致。
    cpSync(path.join(SRC, 'package.json'), path.join(work, 'package.json'));

    const indexPath = path.join(work, 'lib', 'index.js');
    const original = readFileSync(indexPath, 'utf8');
    const mutated = mutate(original);
    if (mutated === original) {
      console.log(`  FAIL - ${name}：變異沒有實際改到檔案（比對失敗）`);
      failures++;
      return;
    }
    writeFileSync(indexPath, mutated, 'utf8');

    const res = spawnSync(process.execPath, [path.join(work, 'test', 'entry.test.mjs')], {
      encoding: 'utf8',
      cwd: work
    });
    // 預期：非 0 離開碼（測試抓到缺陷）。
    if (res.status === 0) {
      console.log(`  FAIL - ${name}：拿掉防護後測試仍然全綠（檢查是空轉的）`);
      failures++;
    } else {
      // 找出是哪幾項變紅，證明抓對了地方。
      const red = (res.stdout + res.stderr)
        .split(/\r?\n/)
        .filter((l) => l.includes('FAIL -'))
        .map((l) => l.trim().replace(/^FAIL - /, '').replace(/\s+\(.*$/, ''));
      console.log(`  ok   - ${name}：如預期變紅（${red.length} 項）`);
      for (const r of red.slice(0, 4)) console.log(`           ${r}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

console.log('--- 變異 A：拿掉設定頁的 try/catch ---');
runMutant('設定頁失敗不再被攔截', (src) => {
  // 「拿掉保護」等價於讓 catch 重新拋出。這比整段刪除更可靠：只要那行 catch
  // 還在，單一字串替換就成立，不必猜縮排或跨行結構。
  const marker = '  } catch (err) {\n    ctx.logger?.warn?.(';
  if (!src.includes(marker)) return src;
  return src.replace(marker, '  } catch (err) {\n    throw err;\n    ctx.logger?.warn?.(');
});

console.log('\n--- 變異 B：加上 export default ---');
runMutant('出現 export default', (src) => {
  return src.replace(
    'export {',
    'export default { name, inject, Config, apply };\nexport {'
  );
});

console.log('\n--- 變異 C：dispose 不再清計時器 ---');
runMutant('dispose 不清計時器', (src) => {
  return src.replace(
    /  if \(typeof ctx\.on === 'function'\) \{[\s\S]*?\n  \}/,
    '  // 變異：刻意不註冊 dispose 處理器。'
  );
});

console.log(`\n${failures === 0 ? 'ok - 進入點檢查能抓到缺陷' : `❌ ${failures} 個變異沒有被偵測到`}`);
if (failures === 0) console.log('      三個防護各自被拿掉後，entry.test.mjs 都如預期失敗。');
if (failures > 0) process.exit(1);
