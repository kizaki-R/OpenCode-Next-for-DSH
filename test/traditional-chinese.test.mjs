/**
 * 繁體字檢查：確認專案裡的繁體中文沒有混入簡體專用字。
 *
 * 為什麼需要自動檢查：這個外掛的註解、錯誤訊息與設定頁文案全部以繁體撰寫，
 * 但只要有一次編輯（或上游模型）傾向簡體，就會混入幾個簡體字，而且很容易在
 * 覆核時被忽略——尤其當整段文字讀起來仍然通順時。
 *
 * 只收「簡體專用、繁體正常不會出現」的字。刻意排除簡繁同形、或在繁體中另有
 * 合法用法者（例如「只」「什」「后」「据」「存」「于」「于」），因為那些會製造
 * 假紅燈，而假紅燈比漏報更浪費時間——被誤報幾次之後，真正的問題也會被忽略。
 *
 * 最後會用一個塞了簡體字的暫時檔反向驗證掃描器本身有效。沒有這一步的話，這支
 * 測試可能只是「掃描器壞掉了、什麼都沒掃到」而永遠全綠。
 */
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let checks = 0;
function check(name, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${name}${cond ? '' : `  ${detail}`}`);
}

const SIMPLIFIED_ONLY = new Set([
  // 言部：簡體一律用「讠」
  ...'说读讲论议请谢识让记训词语谁谈讨认订',
  // 糸部：簡體用「纟」
  ...'线级纪统计结',
  // 金部：簡體用「钅」
  ...'钢错锁银钱',
  // 車部：簡體用「车」
  ...'车轮转较载',
  // 見／貝／頁／風／飛／馬／鳥／魚／龍
  ...'见规观贝负页项顺须题风飞马鸟鱼龙',
  // 門部：簡體用「门」
  ...'门问间闲',
  // 食／飠：簡體用「饣」
  ...'饭饮馆',
  // 動物
  ...'鸡鸭',
  // 網／軟／盤／傳／連／體
  ...'网软盘传连体',
  // 狀態／資訊／品質／專案／檔案／路徑
  ...'态资讯质项设档径检测启',
  // 高頻獨立簡體字
  ...'东书与写军农决况冻净凉减备权类',
  ...'为么应开关闭运还这样种样达边过',
  ...'电脑学习',
  ...'众亿仅从仓伞伟伤价优会侠'
]);

/** 掃描一個字串，回傳所有可疑字的所在行。 */
function scan(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    // 語言選單的顯示名稱一律用該語言自己的寫法（'简体中文'、'繁體中文'），
    // 這是國際慣例：看不懂目前介面語言的人，才能在自己的語言裡找到它。
    // 所以這一行整行跳過——它是資料，不是內文。
    if (/language(Zh|Of_zh)?:\s*'简体中文'/.test(line)) return;
    for (const ch of line) {
      if (SIMPLIFIED_ONLY.has(ch)) hits.push({ line: i + 1, ch });
    }
  });
  return hits;
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 遞迴收集要掃描的檔案：程式碼、測試與說明文件。 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collect(full, out);
    } else if (/\.(js|mjs|md)$/.test(entry)) {
      // 跳過自己：這個檔案必須列出簡體字才能檢查別人，那些字是資料不是內文。
      if (path.resolve(full) === path.resolve(fileURLToPath(import.meta.url))) continue;
      out.push(full);
    }
  }
  return out;
}

/* ------------------------------------------- 先確認掃描器本身抓得到東西 */

console.log('--- 掃描器自我驗證 ---');
const canaryDir = mkdtempSync(path.join(tmpdir(), 'ocoa-canary-'));
try {
  const canaryFile = path.join(canaryDir, 'canary.js');
  // 每個字都必須是清單裡真正的簡體專用字。
  writeFileSync(canaryFile, 'const a = "这个测试的资讯与网路连线状态";\n', 'utf8');
  const canaryHits = scan(readFileSync(canaryFile, 'utf8'));
  check('掃描器抓得到簡體字（金絲雀檔）', canaryHits.length >= 6,
    `只抓到 ${canaryHits.length} 個：${canaryHits.map((h) => h.ch).join('')}`);
} finally {
  rmSync(canaryDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------ 掃描專案 */

/**
 * 把 `zh`（簡體）字典區塊的行換成空行，其餘原封不動。
 *
 * 為什麼要挖：這個外掛現在真的有三個語言，而 `zh` 字典**本來就該是簡體**。
 * 若照樣掃它，會命中一兩百個「可疑字」，把真正的問題淹沒掉。
 *
 * 為什麼換成空行而不是刪掉：刪行會讓後續行號全部前移，錯誤訊息指到的行就
 * 不是真正有問題的那一行（我第一次就因此看到「第 268 行：登入」這種假警報）。
 * 保留空行，行號就完全對得上。
 */
function blankOutSimplifiedDictionary(source) {
  const lines = source.split(/\r?\n/);
  const zhStart = lines.findIndex((l) => /^\s+zh:\s*\{$/.test(l));
  const hantStart = lines.findIndex((l) => /^\s+'zh-Hant':\s*\{$/.test(l));
  if (zhStart === -1 || hantStart === -1 || hantStart <= zhStart) return lines;
  return lines.map((line, i) => (i > zhStart && i < hantStart ? '' : line));
}

console.log('\n--- 掃描專案檔案 ---');
const files = collect(ROOT);
check('掃描到檔案（不是 0 個）', files.length > 5, `只找到 ${files.length} 個檔案`);

/** 語言解析與渲染測試刻意含有簡體範例字串，掃它們沒有意義。 */
const ALLOW_SIMPLIFIED = new Set(
  [
    'test/language.test.mjs',
    'test/render.test.mjs',
    // 變異測試要「找出簡體字串並改壞它」，本身就必須寫出那幾個字。
    'test/locale-structure-mutation.test.mjs'
  ].map((p) => path.normalize(p))
);

let total = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file);
  if (ALLOW_SIMPLIFIED.has(path.normalize(rel))) continue;

  let text = readFileSync(file, 'utf8');
  // ui.js 的 zh 字典是簡體，屬預期內容；把那幾行換成空行以保留行號。
  if (path.normalize(rel) === path.normalize('lib/ui.js')) {
    text = blankOutSimplifiedDictionary(text).join('\n');
  }

  const hits = scan(text);
  if (hits.length === 0) continue;
  total += hits.length;
  console.log(`  FAIL - ${rel}：${hits.length} 個可疑字`);
  for (const h of hits.slice(0, 8)) console.log(`         第 ${h.line} 行：「${h.ch}」`);
}
check('沒有任何檔案混入簡體專用字（zh 字典本身除外）', total === 0, `共 ${total} 處`);
console.log(`        （掃描 ${files.length} 個檔案）`);

/* ------------------------------------------------ 語言字典的結構關係

   DSH 只內建 zh（簡體）與 en 兩個語言 id，繁中要靠 addLanguage 自己宣告。
   本外掛三份字典現在是：

     en       ← 英文
     zh       ← 簡體中文（真正的簡體）
     zh-Hant  ← 繁體中文

   驗的是「三份真的不同」。歷史上這裡曾經是 zh 與 zh-Hant 完全相同（zh 裡放的
   其實是繁體），那時「簡體中文」名不符實；這幾條檢查就是防止那種情況回來。 */

console.log('\n--- 語言字典結構 ---');

const uiPath = path.join(ROOT, 'lib', 'ui.js');
const uiLines = readFileSync(uiPath, 'utf8').split(/\r?\n/);

/** 以表頭行號為界抽出字典，避免 indexOf('zh: {') 誤命中 'zh-Hant'。 */
const headerRows = [];
for (let i = 0; i < uiLines.length; i++) {
  const m = uiLines[i].match(/^\s+(en|zh|'zh-Hant'):\s*\{$/);
  if (m) headerRows.push({ key: m[1].replace(/'/g, ''), line: i });
}
check('找到三個語言字典的表頭', headerRows.length === 3,
  `找到 ${headerRows.map((h) => h.key).join(', ') || '無'}`);

function parseDict(text) {
  const map = new Map();
  const re = /^\s{4,}'?([A-Za-z0-9_-]+)'?:\s*'((?:[^'\\]|\\.)*)'/gm;
  let m;
  while ((m = re.exec(text))) map.set(m[1], m[2]);
  return map;
}

const dicts = {};
for (let h = 0; h < headerRows.length; h++) {
  const from = headerRows[h].line;
  // 最後一個字典的結尾不能算到檔案盡頭：那會把後面的註解也吞進來，
  // 註解裡剛好提到「简体中文」時就會被誤判成字典內容（我就被騙過一次）。
  // COPY 區塊的結尾是 `    };`（四個空格縮排），找到它才停。
  let to = headerRows[h + 1]?.line;
  if (to === undefined) {
    for (let i = from + 1; i < uiLines.length; i++) {
      if (/^\s{0,6}\};$/.test(uiLines[i])) { to = i; break; }
    }
  }
  if (to === undefined) to = uiLines.length;
  dicts[headerRows[h].key] = parseDict(uiLines.slice(from + 1, to).join('\n'));
}

for (const id of ['en', 'zh', 'zh-Hant']) {
  check(`字典 ${id} 有一批字串`, (dicts[id]?.size ?? 0) > 50,
    `只有 ${dicts[id]?.size ?? 0} 個鍵`);
}

const zhKeys = [...(dicts.zh?.keys() ?? [])];
const hantMap = dicts['zh-Hant'] ?? new Map();
const missing = zhKeys.filter((k) => !hantMap.has(k));
check('zh-Hant 涵蓋 zh 的每一個鍵', missing.length === 0, `缺 ${missing.join(', ')}`);

const enKeys = [...(dicts.en?.keys() ?? [])];
const zhMinusEn = enKeys.filter((k) => !dicts.zh.has(k));
check('zh 涵蓋 en 的每一個鍵', zhMinusEn.length === 0, `缺 ${zhMinusEn.join(', ')}`);

// 兩份中文字典必須真的不同。歷史上它們曾經逐鍵相同（zh 裡放的是繁體），
// 那時「簡體中文」名不符實；這條就是防止那種情況回來。
const differing = zhKeys.filter((k) => hantMap.get(k) !== dicts.zh.get(k));
check('zh 與 zh-Hant 內容不同（真正的繁簡分工）', differing.length >= 50,
  `只有 ${differing.length} 個鍵不同`);

// 字形要對：zh 必須是簡體、zh-Hant 必須是繁體。
//
// 兩份清單都只收「繁簡字形真的不同」的字。「制」刻意不在清單裡：它在
// 「限制」「控制」等詞中繁簡同形，把它算成簡體就會在 zh-Hant 的
// 「此模型受地區限制」上報假紅燈。
const TRAD_ONLY = '態驗證憑據間輪詢預組說顯診斷訊篩選開關閉過請讀認識問題複製時發與後線連狀權';
const SIMP_ONLY = '态验证凭据间轮询预组说显诊断讯筛选开关闭过请读认识问题复时发与后线连状权';

/** 語言選單的顯示名稱，不論在哪份字典都允許（國際慣例）。 */
const LANGUAGE_DISPLAY_NAMES = new Set(['简体中文', '繁體中文', 'English']);

let zhTrad = 0;
for (const [, v] of dicts.zh ?? []) {
  if (LANGUAGE_DISPLAY_NAMES.has(v)) continue;
  for (const ch of v) if (TRAD_ONLY.includes(ch)) zhTrad++;
}
let zhSimp = 0;
for (const [, v] of dicts.zh ?? []) for (const ch of v) if (SIMP_ONLY.includes(ch)) zhSimp++;
check('zh 字典是簡體（含大量簡體字形）', zhSimp >= 20, `只有 ${zhSimp} 個`);
check('zh 字典不含繁體字形', zhTrad === 0, `混入 ${zhTrad} 個`);

let hantTrad = 0;
for (const [, v] of dicts['zh-Hant'] ?? []) for (const ch of v) if (TRAD_ONLY.includes(ch)) hantTrad++;
let hantSimp = 0;
for (const [, v] of dicts['zh-Hant'] ?? []) {
  if (LANGUAGE_DISPLAY_NAMES.has(v)) continue;
  for (const ch of v) if (SIMP_ONLY.includes(ch)) hantSimp++;
}
check('zh-Hant 字典是繁體（含大量繁體字形）', hantTrad >= 20, `只有 ${hantTrad} 個`);
check('zh-Hant 字典不含簡體字形（語言名稱除外）', hantSimp === 0, `混入 ${hantSimp} 個`);

console.log(`\n${failures === 0 ? `✔ Traditional Chinese check passed (${checks} checks)` : `❌ ${failures} / ${checks} checks failed`}`);
if (failures > 0) process.exit(1);
