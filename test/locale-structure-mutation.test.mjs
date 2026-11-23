/**
 * 變異測試：證明 traditional-chinese.test.mjs 的語言結構規則真的抓得到問題。
 *
 * 一條測試全綠有兩種可能：規則有效，或規則根本沒被執行到。這支腳本把
 * lib/ 與測試複製到暫存目錄，故意弄壞其中一種結構，再跑測試，要求它「失敗」。
 *
 * 目前的設計是三份字典各自不同：en（英文）、zh（簡體）、zh-Hant（繁體）。
 * 所以這裡的變異就是三種「讓它們失去差異」的方式：
 *
 *   A. 把 zh 的某個值混入繁體字 → 「zh 不含繁體字形」必須報錯
 *   B. 刪掉 zh-Hant 的一個鍵     → 「zh-Hant 涵蓋 zh 的每一個鍵」必須報錯
 *   C. 把 zh 整段換成 zh-Hant    → 「zh 與 zh-Hant 內容不同」必須報錯
 *
 * 三次都必須讓測試變紅，否則這幾條規則等於裝飾品。
 */
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
let failures = 0;
let checks = 0;
function check(name, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${name}${cond ? '' : `  ${detail}`}`);
}

/** 建立一份可獨立執行測試的複本。 */
function makeCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ocoa-locale-mut-'));
  cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  cpSync(path.join(ROOT, 'test', 'traditional-chinese.test.mjs'),
    path.join(dir, 'test', 'traditional-chinese.test.mjs'), { recursive: true });
  // package.json 讓測試的 ROOT 解析正確（測試用 import.meta.url 推根目錄）。
  writeFileSync(path.join(dir, 'package.json'), '{ "name": "x", "type": "module" }\n', 'utf8');
  return dir;
}

function runTest(dir) {
  const r = spawnSync(process.execPath, [path.join('test', 'traditional-chinese.test.mjs')], {
    cwd: dir, encoding: 'utf8'
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 回傳 zh 與 zh-Hant 兩個區塊的行索引範圍。 */
function blockRanges(lines) {
  const zhStart = lines.findIndex((l) => /^\s+zh:\s*\{$/.test(l));
  const hantStart = lines.findIndex((l) => /^\s+'zh-Hant':\s*\{$/.test(l));
  if (zhStart === -1 || hantStart === -1) return null;
  let hantEnd = lines.length;
  for (let i = hantStart + 1; i < lines.length; i++) {
    if (/^\s{0,6}\};$/.test(lines[i])) { hantEnd = i; break; }
  }
  return { zhStart, hantStart, hantEnd };
}

/* ------------------------------------------------ 基準：未變異必須通過 */
console.log('--- 基準（未變異）---');
{
  const dir = makeCopy();
  try {
    const r = runTest(dir);
    check('未變異時測試通過', r.code === 0, `exit=${r.code}`);
    if (r.code !== 0) console.log(r.out.slice(-1500));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------- 變異 A：把 zh 的某個值混入繁體（字形規則要被觸發） */
console.log('\n--- 變異 A：zh 混入繁體字 ---');
{
  const dir = makeCopy();
  try {
    const uiPath = path.join(dir, 'lib', 'ui.js');
    const lines = readFileSync(uiPath, 'utf8').split(/\r?\n/);
    const r = blockRanges(lines);
    if (!r) {
      check('變異 A 可定位 zh 區塊', false, '找不到表頭');
    } else {
      // 在 zh 區塊找任一行的簡體值，塞進一個繁體專用字。
      let changed = false;
      for (let i = r.zhStart + 1; i < r.hantStart; i++) {
        if (/^\s+colStatus:\s*'状态',/.test(lines[i])) {
          lines[i] = lines[i].replace("'状态'", "'狀態'");
          changed = true;
          break;
        }
      }
      // 找不到就用備援：改 subtitle 的第一個字。
      if (!changed) {
        for (let i = r.zhStart + 1; i < r.hantStart; i++) {
          if (lines[i].includes('subtitle:')) {
            lines[i] = lines[i].replace('登录授权', '登錄授權');
            changed = lines[i].includes('登錄');
            if (changed) break;
          }
        }
      }
      check('變異 A 確實改到檔案', changed);
      if (changed) {
        writeFileSync(uiPath, lines.join('\n'), 'utf8');
        const out = runTest(dir);
        check('變異 A 讓測試變紅（zh 混入繁體被抓到）', out.code !== 0, `exit=${out.code}`);
        check('變異 A 的失敗訊息指出字形規則',
          /zh 字典不含繁體字形|zh 與 zh-Hant 內容不同/.test(out.out), out.out.slice(-800));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------- 變異 B：刪掉 zh-Hant 的一個鍵（涵蓋率要被觸發） */
console.log('\n--- 變異 B：zh-Hant 缺少 zh 的鍵 ---');
{
  const dir = makeCopy();
  try {
    const uiPath = path.join(dir, 'lib', 'ui.js');
    const lines = readFileSync(uiPath, 'utf8').split(/\r?\n/);
    const r = blockRanges(lines);
    if (!r) {
      check('變異 B 可定位 zh-Hant 區塊', false, '找不到表頭');
    } else {
      let removed = false;
      for (let i = r.hantStart + 1; i < r.hantEnd; i++) {
        if (lines[i].trim().startsWith('sectionDetails:')) {
          lines.splice(i, 1);
          removed = true;
          break;
        }
      }
      check('變異 B 確實刪掉一個鍵', removed);
      if (removed) {
        writeFileSync(uiPath, lines.join('\n'), 'utf8');
        const out = runTest(dir);
        check('變異 B 讓測試變紅（缺鍵被抓到）', out.code !== 0, `exit=${out.code}`);
        check('變異 B 的失敗訊息指出缺哪個鍵',
          /zh-Hant 涵蓋 zh 的每一個鍵/.test(out.out), out.out.slice(-800));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------- 變異 C：把 zh 整段換成 zh-Hant 的內容（差異規則要被觸發） */
console.log('\n--- 變異 C：zh 與 zh-Hant 變成相同內容 ---');
{
  const dir = makeCopy();
  try {
    const uiPath = path.join(dir, 'lib', 'ui.js');
    const lines = readFileSync(uiPath, 'utf8').split(/\r?\n/);
    const r = blockRanges(lines);
    if (!r) {
      check('變異 C 可定位區塊', false, '找不到表頭');
    } else {
      const zhBody = lines.slice(r.zhStart + 1, r.hantStart);
      const hantBody = lines.slice(r.hantStart + 1, r.hantEnd);
      const next = [
        ...lines.slice(0, r.zhStart + 1),
        ...hantBody,
        ...lines.slice(r.hantStart)
      ];
      check('變異 C 確實改動檔案',
        next.length !== lines.length || zhBody.join('\n') !== hantBody.join('\n'));
      writeFileSync(uiPath, next.join('\n'), 'utf8');
      const out = runTest(dir);
      check('變異 C 讓測試變紅（兩份字典不再有差異）', out.code !== 0, `exit=${out.code}`);
      check('變異 C 的失敗訊息指出差異規則',
        /zh 與 zh-Hant 內容不同/.test(out.out), out.out.slice(-800));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${failures === 0 ? `✔ 字典結構變異測試通過（${checks} 項）` : `❌ ${failures} / ${checks} 項失敗`}`);
if (failures > 0) process.exit(1);
