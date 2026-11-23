/**
 * 語言解析邏輯的驗證。直接從 lib/ui.js 抽出函式來跑，確保測的是真正的實作。
 *
 * lib/ui.js 不是 ESM（外層是 __ModuleLoader__ 封套），不能 import，所以這裡用
 * 「讀原始碼 + 只取需要的函式區段 + 動態建構」的方式，避免複製一份邏輯而在
 * 兩處各自漂移。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const uiPath = process.argv[2]
  || fileURLToPath(new URL('../lib/ui.js', import.meta.url));
const src = readFileSync(uiPath, 'utf8');

let failures = 0;
let checks = 0;
function check(name, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${name}${cond ? '' : `  ${detail}`}`);
}

/** 從原始碼切出一個函式的完整文字（以大括號配對算出結尾）。 */
function sliceFunction(source, name) {
  const startRe = new RegExp(`function ${name}\\(`);
  const m = startRe.exec(source);
  if (!m) throw new Error(`找不到函式 ${name}`);
  let i = source.indexOf('{', m.index);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(m.index, i + 1);
    }
  }
  throw new Error(`函式 ${name} 的大括號沒有配對`);
}

const fnSource = [
  sliceFunction(src, 'localeFromTag'),
  sliceFunction(src, 'resolveLocale')
].join('\n\n');

// SUPPORTED_LOCALES 是 const，一起帶進來。
const supportedMatch = src.match(/const SUPPORTED_LOCALES = (\[[^\]]*\]);/);
if (!supportedMatch) {
  console.error('找不到 SUPPORTED_LOCALES');
  process.exit(2);
}

const factory = new Function(
  `${supportedMatch[0]}\n${fnSource}\nreturn { localeFromTag, resolveLocale };`
);
const { localeFromTag, resolveLocale } = factory();

/* -------------------------------------------------- localeFromTag */
console.log('--- localeFromTag：把系統標籤對應到語言 ---');
const tagCases = [
  ['zh-TW', 'zh-Hant', '台灣繁中'],
  ['zh-Hant', 'zh-Hant', '繁中'],
  ['zh-Hant-TW', 'zh-Hant', '繁中（帶地區）'],
  ['zh-Hant-HK', 'zh-Hant', '香港繁中'],
  ['zh-HK', 'zh-Hant', '香港'],
  ['zh-MO', 'zh-Hant', '澳門'],
  ['zh-CN', 'zh', '中國簡中'],
  ['zh-SG', 'zh', '新加坡簡中'],
  ['zh', 'zh', '單純 zh'],
  ['en-US', 'en', '美國英文'],
  ['en', 'en', '英文'],
  ['en-GB', 'en', '英國英文'],
  ['ja-JP', null, '日文 → null（不支援）'],
  ['de-DE', null, '德文 → null（不支援）'],
  ['', null, '空字串 → null'],
  [null, null, 'null → null']
];
for (const [input, expected, desc] of tagCases) {
  const got = localeFromTag(input);
  check(`${JSON.stringify(input)} → ${expected}（${desc}）`, got === expected, `得到 ${got}`);
}

/* -------------------------------------------------- resolveLocale */
console.log('\n--- resolveLocale：使用者選擇 vs 系統語言 ---');

// 1) 明確選了就一定用它
for (const choice of ['en', 'zh', 'zh-Hant']) {
  const got = resolveLocale(choice, 'zh-TW');
  check(`選了 ${choice}，即使系統是 zh-TW 也用 ${choice}`, got === choice, `得到 ${got}`);
}

// 2) 選 auto → 跟隨系統
check('auto + zh-TW → zh-Hant', resolveLocale('auto', 'zh-TW') === 'zh-Hant');
check('auto + zh-CN → zh', resolveLocale('auto', 'zh-CN') === 'zh');
check('auto + en-US → en', resolveLocale('auto', 'en-US') === 'en');

// 3) 從未選過（null）→ 跟隨系統
check('null + zh-TW → zh-Hant', resolveLocale(null, 'zh-TW') === 'zh-Hant');
check('null + en-US → en', resolveLocale(null, 'en-US') === 'en');

// 4) 系統語言讀不到 → 預設繁中
check('auto + null → zh-Hant（預設繁中）', resolveLocale('auto', null) === 'zh-Hant');
check('null + null → zh-Hant（預設繁中）', resolveLocale(null, null) === 'zh-Hant');
check('auto + 空字串 → zh-Hant', resolveLocale('auto', '') === 'zh-Hant');

// 5) 系統語言是**讀到了但不支援**的語言 → 也退到繁中（見 resolveLocale 的說明）
check('auto + ja-JP → zh-Hant（不支援的語言退繁中）', resolveLocale('auto', 'ja-JP') === 'zh-Hant');
check('auto + de-DE → zh-Hant（不支援的語言退繁中）', resolveLocale('auto', 'de-DE') === 'zh-Hant');

// 6) 不認得的儲存值 → 當成 auto
check('亂七八糟的儲存值當成 auto', resolveLocale('klingon', 'zh-TW') === 'zh-Hant');

/* ------------------------------------------- 三個字典是否真的不同 */
console.log('\n--- 三份字典必須是三個不同的語言 ---');
const lines = src.split(/\r?\n/);
const headers = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s+(en|zh|'zh-Hant'):\s*\{$/);
  if (m) headers.push({ key: m[1].replace(/'/g, ''), line: i });
}
check('找到三個字典表頭', headers.length === 3, `找到 ${headers.length} 個`);

function parseDict(from, to) {
  const map = new Map();
  for (let i = from; i < to; i++) {
    const m = lines[i].match(/^\s{8}'?([A-Za-z0-9_-]+)'?:\s*'((?:[^'\\]|\\.)*)'/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}
const dicts = {};
for (let h = 0; h < headers.length; h++) {
  const from = headers[h].line;
  const to = headers[h + 1]?.line ?? lines.length;
  dicts[headers[h].key] = parseDict(from, to);
}

check('英文與簡中不同', (() => {
  let diff = 0;
  for (const [k, v] of dicts.en ?? []) if (dicts.zh?.get(k) !== v) diff++;
  return diff > 80;
})(), '差異太少');

check('簡中與繁中不同', (() => {
  let diff = 0;
  for (const [k, v] of dicts.zh ?? []) if (dicts['zh-Hant']?.get(k) !== v) diff++;
  return diff > 50;
})(), '差異太少');

// 簡中字典必須含簡體字，繁中字典必須不含。
const SIMP_ONLY = '这个测试资讯网络连线状态为说读请过还开关闭显筛选诊断讯轮询预组据凭验证复时间发与后';
const TRAD_ONLY = '這個測試資訊網路連線狀態為說讀請過還開關閉顯篩選診斷訊輪詢預組據憑驗證複時間發與後';

let zhSimp = 0;
for (const [, v] of dicts.zh ?? []) for (const ch of v) if (SIMP_ONLY.includes(ch)) zhSimp++;
let zhTrad = 0;
for (const [, v] of dicts.zh ?? []) for (const ch of v) if (TRAD_ONLY.includes(ch)) zhTrad++;
check('簡中字典含大量簡體字', zhSimp >= 20, `只有 ${zhSimp} 個`);
check('簡中字典不含繁體字', zhTrad === 0, `混入 ${zhTrad} 個繁體字`);

let hantTrad = 0;
for (const [, v] of dicts['zh-Hant'] ?? []) for (const ch of v) if (TRAD_ONLY.includes(ch)) hantTrad++;
let hantSimp = 0;
for (const [, v] of dicts['zh-Hant'] ?? []) for (const ch of v) if (SIMP_ONLY.includes(ch)) hantSimp++;
check('繁中字典含大量繁體字', hantTrad >= 20, `只有 ${hantTrad} 個`);
check('繁中字典不含簡體字', hantSimp === 0, `混入 ${hantSimp} 個簡體字`);

/* ------------------------------------- 每份字典都有語言切換的文案 */
console.log('\n--- 語言切換鍵的文案必須三語齊備 ---');
const LANG_KEYS = ['languageLabel', 'languageAuto', 'languageEn', 'languageZh', 'languageZhHant',
  'languageOf_en', 'languageOf_zh', 'languageOf_zh-Hant'];
for (const id of ['en', 'zh', 'zh-Hant']) {
  const missing = LANG_KEYS.filter((k) => !dicts[id]?.has(k));
  check(`${id} 字典有全部 ${LANG_KEYS.length} 個語言鍵`, missing.length === 0, `缺 ${missing.join(', ')}`);
}

console.log(`\n${failures === 0 ? `✔ 語言解析測試通過（${checks} 項）` : `❌ ${failures} / ${checks} 項失敗`}`);
if (failures > 0) process.exit(1);
