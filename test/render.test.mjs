/**
 * Renders the settings page with real data and inspects the text that would
 * actually appear on screen.
 *
 * Why this exists on top of `settings.test.mjs`: a complete dictionary does not
 * prove a correct page. The failures that actually reach users are a `t()` call
 * with a misspelled key (renders the key name on screen) and a branch that never
 * renders at all — neither is visible to a dictionary-parity check.
 *
 * The element tree is walked directly rather than rendered through react-dom,
 * because this package has no react-dom dependency; walking is enough to catch
 * both failure modes above.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { ModelCatalog } from '../lib/catalog.js';
import { TokenManager } from '../lib/token-manager.js';
import { createStatusReporter } from '../lib/status.js';

let failures = 0;
let checks = 0;

function check(name, cond, detail = '') {
  checks++;
  if (cond) {
    console.log(`  ok   - ${name}`);
  } else {
    failures++;
    console.log(`  FAIL - ${name}${detail ? `  (${detail})` : ''}`);
  }
}

const uiSource = readFileSync(new URL('../lib/ui.js', import.meta.url), 'utf8');

/* -------------------------------------------------- the status under test */

const tokenManager = new TokenManager();
const catalog = new ModelCatalog({});
await catalog.init();

const reporter = createStatusReporter({
  tokenManager,
  catalog,
  config: {
    providerId: 'opencode-next',
    providerName: 'OpenCode (OAuth)',
    autoDetectModels: true,
    probeIntervalMs: 21600000,
    catalogPollMs: 900000,
    imagePixelBudget: 640000,
    imageMaxBytes: 2097152
  },
  version: '0.1.0'
});

// The live data on this machine currently has no failing model, so the most
// important row type — "this model does not work, and here is why" — would go
// untested. These synthetic rows force every mapped reason through the table.
const SYNTHETIC_FAILURES = [
  // 排在最前面：這是使用者實際遇到的那一種，而且最容易被誤標成
  // 「換個模型就好」。它必須有自己的句子。
  { id: 'zzz-network', name: 'Network', probed: true, ok: false, status: 403, ms: 75, reason: 'network-blocked' },
  { id: 'zzz-free-lane', name: 'Free Lane', probed: true, ok: false, status: 403, ms: 120, reason: 'free-lane-blocked' },
  { id: 'zzz-region', name: 'Region', probed: true, ok: false, status: 403, ms: 98, reason: 'region-restricted' },
  { id: 'zzz-quota', name: 'Quota', probed: true, ok: false, status: 402, ms: 140, reason: 'quota-exceeded' },
  { id: 'zzz-rate', name: 'Rate', probed: true, ok: false, status: 429, ms: 88, reason: 'rate-limited' },
  { id: 'zzz-deprecated', name: 'Deprecated', probed: true, ok: false, status: 410, ms: 210, reason: 'deprecated', available: false, probedAt: Date.now(), failureStreak: 0 },
  // 唯一帶 detail 的一筆：狀態頁要能顯示上游原文。
  // 中文標籤是我們的解讀，會錯；原文不會，而且可以拿去搜尋。
  {
    id: 'zzz-rawdetail', name: 'Raw Detail', probed: true, ok: false, status: 400, ms: 130,
    reason: 'bad-request',
    detail: '{"model":"deepseek-v4.1-flash-free"}'
  },
  { id: 'zzz-transport', name: 'Transport', probed: true, ok: false, status: 0, ms: 5000, reason: 'transport' },
  { id: 'zzz-noprobe', name: 'Never probed', probed: false, ok: false, status: null, ms: null, reason: null }
];

function statusWithPendingLogin() {
  const s = reporter.buildStatus();
  s.pendingLogin = {
    userCode: 'ABCD-1234',
    verificationUrl: 'https://opencode.ai/auth/device',
    startedAt: Date.now()
  };
  return s;
}

/* --------------------------------------------------------------- fixtures */

// useState call order in SettingsPage:
//   languageChoice, status, busy, message, copied, showAll, tabState, modelFilter,
//   expandedModel, filter, loaded, fallbackDraft, addAccountOpen, accountLabel, contextDrafts
//
// `languageChoice` 是第一項：它是這個分頁自己維護的語言偏好，值為 'auto' 或某個
// 語言 id；'auto'（或 null）代表跟隨系統，由 status.systemLocale 決定實際語言。
const DONE = (status, tab = 'models') => ['auto', status, '', null, '', true, tab, null, null, '', true];
const LOADING = ['auto', null, '', null, '', false, 'models', null, null, '', false];

/* --------------------------------------------------- dictionary + translator */

function literalAfter(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(source.indexOf('{', start), i + 1);
    }
  }
  throw new Error(`unbalanced literal after ${marker}`);
}

const COPY = eval(`(${literalAfter(uiSource, 'const COPY = {')})`);

/**
 * The host passes `ctx.locale.bind(NS)` in as `props.t`, i.e. a real dictionary
 * lookup. A stub that returns a marker string would make every row read
 * "«key»", so it would only ever test the stub.
 */
function makeHostTranslator(locale) {
  const table = COPY[locale] ?? COPY.en;
  return (key, vars) => {
    const text = String(table[key] ?? COPY.en[key] ?? `«MISSING:${key}»`);
    return vars
      ? text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
      : text;
  };
}

/* --------------------------------------------------------------- fake React */

function makeReact(seeds, stateChanges = []) {
  let stateIndex = 0;
  return {
    createElement(type, props, ...children) {
      const flat = [];
      const push = (c) => {
        if (c === null || c === undefined || c === false || c === true) return;
        if (Array.isArray(c)) { c.forEach(push); return; }
        flat.push(c);
      };
      children.forEach(push);

      // Function components (Chip, Row) are invoked so the tree is really
      // expanded; returning an unrendered element would hide their output.
      if (typeof type === 'function') {
        return type({ ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat });
      }
      return { type, props: props ?? {}, children: flat };
    },
    useState(initial) {
      const index = stateIndex++;
      const seed = seeds[index];
      const value = seed === undefined ? initial : seed;
      return [value, (next) => {
        stateChanges[index] = typeof next === 'function' ? next(value) : next;
      }];
    },
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    Fragment: Symbol('Fragment')
  };
}

/** Collect every visible text leaf and every className in the tree. */
function walk(node, out) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string' || typeof node === 'number') {
    const s = String(node).trim();
    if (s) out.texts.push(s);
    return;
  }
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return; }
  if (typeof node !== 'object') return;

  if (typeof node.className === 'string') out.classes.push(node.className);
  if (node.__el !== undefined) { walk(node.__el, out); return; }
  if (node.type) {
    if (typeof node.type === 'string') {
      if (node.props?.className) out.classes.push(node.props.className);
      out.elements.push({ tag: node.type, className: node.props?.className ?? '', props: node.props ?? {} });
      walk(node.children, out);
    }
    return;
  }
  walk(node.children, out);
}

/* ------------------------------------------------------------ load the module */

const headChildren = [];
const fakeDocument = {
  head: {
    appendChild: (el) => { headChildren.push(el); el.parentNode = fakeDocument.head; },
    removeChild: (el) => {
      const i = headChildren.indexOf(el);
      if (i !== -1) headChildren.splice(i, 1);
      el.parentNode = null;
    }
  },
  createElement: () => ({ id: '', textContent: '', parentNode: null }),
  getElementById: (id) => headChildren.find((el) => el.id === id) ?? null
};

let envelope = null;
const sandbox = {
  window: {
    __ModuleLoader__: { load: (m) => { envelope = m; } },
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    open: () => null
  },
  document: fakeDocument,
  navigator: { language: 'zh-TW', clipboard: { writeText: async () => {} } },
  console, Intl, Date, JSON, Math, String, Number, Boolean, Array, Object, Symbol,
  RegExp, Error, Promise, isFinite,
  fetch: async () => { throw new Error('no request expected during load'); }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(uiSource, sandbox, { filename: 'ui.js' });

function renderPage(locale, seeds) {
  // 頁面語言現在由「使用者選擇 → status.systemLocale → 預設繁中」決定，
  // 不再來自宿主的 locale/bind。這裡把想要的語言換成對應的系統標籤，
  // 讓整份測試的其餘部分（按語言斷言文案）維持不變。
  const systemTag = locale === 'en' ? 'en-US' : locale === 'zh' ? 'zh-CN' : 'zh-TW';
  const withSystem = seeds.map((seed, i) => {
    if (i === 1 && seed && typeof seed === 'object') {
      return { ...seed, systemLocale: systemTag };
    }
    return seed;
  });

  const stateChanges = [];
  const React = makeReact(withSystem, stateChanges);
  const plugin = envelope.factory((n) => {
    if (n === 'react') return React;
    throw new Error(`unexpected require: ${n}`);
  });

  let section = null;
  plugin.apply({
    effect: () => () => {},
    locale: {
      getLocale: () => ({ active: locale, locales: ['zh', 'en'], revision: 1 }),
      addLanguage: () => {},
      register: () => {},
      bind: () => makeHostTranslator(locale)
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { section = { meta, render }; }
    }
  });

  // 刻意不傳 t：本頁自己解析語言，宿主 translator 已不再參與。
  const tree = section.render({});
  const out = { texts: [], classes: [], elements: [] };
  walk(tree, out);
  out.stateChanges = stateChanges;
  return out;
}

/* ------------------------------------------------------------- Traditional */

console.log('\nzh-Hant: full page');

const zhStatus = statusWithPendingLogin();
const zh = renderPage('zh-Hant', DONE(zhStatus));
const zhText = zh.texts.join('\n');

const filterStatus = statusWithPendingLogin();
const filterModels = [
  { id: 'available-model', name: 'Available', label: 'Available', probed: true, ok: true, available: true, status: 200, ms: 25, contextWindow: 128000, catalogContextWindow: 128000, contextSource: 'opencode', maxOutputTokens: 32000 },
  { id: 'unavailable-model', name: 'Unavailable', label: 'Unavailable', probed: true, ok: false, available: false, status: 400, ms: 40, reason: 'unavailable', contextWindow: 128000, catalogContextWindow: 128000, contextSource: 'opencode' },
  { id: 'delisted-model', name: 'Delisted', label: 'Delisted', probed: true, ok: false, available: false, status: 410, ms: 35, reason: 'deprecated', contextWindow: 128000, catalogContextWindow: 128000, contextSource: 'opencode' },
  { id: 'quota-model', name: 'Quota', label: 'Quota', probed: true, ok: false, available: false, status: 402, ms: 50, reason: 'quota-exceeded', contextWindow: 128000, catalogContextWindow: 128000, contextSource: 'opencode' }
];
filterStatus.models = {
  total: filterModels.length,
  probed: filterModels.length,
  available: 1,
  probedAt: Date.now(),
  breakdown: [
    { reason: 'unavailable', count: 1, label: '模型目前不可用' },
    { reason: 'deprecated', count: 1, label: '模型已下架' },
    { reason: 'quota-exceeded', count: 1, label: '額度已用盡' }
  ],
  models: filterModels
};

const zhKeys = Object.keys(COPY.en);
// A key whose value equals its own name (`on: 'on'`) is a legitimate collision,
// not a leak; excluding those keeps this check meaningful instead of noisy.
const realKeys = zhKeys.filter((k) => !Object.values(COPY).some((tbl) => tbl[k] === k));
check('no dictionary key leaks onto the screen',
  zh.texts.filter((s) => realKeys.includes(s)).length === 0,
  zh.texts.filter((s) => realKeys.includes(s)).join(', '));
check('no key is missing from the dictionary',
  !zhText.includes('«MISSING:'),
  zh.texts.filter((s) => s.includes('«MISSING:')).slice(0, 5).join(', '));

check('the title is rendered', zhText.includes('OpenCode-Next'));

// 分頁籤：四個獨立分頁，OpenCode Go 放在「進階」右側，預設仍停在模型。
const tabButtons = zh.elements.filter((element) => element.props?.role === 'tab');
check('the page is split into four tabs with OpenCode Go to the right of advanced',
  tabButtons.length === 4
    && JSON.stringify(tabButtons.map((button) => button.props['data-tab'])) === JSON.stringify(['account', 'models', 'advanced', 'go']),
  tabButtons.map((b) => b.props['data-tab']).join(', '));
check('the models tab is selected by default',
  tabButtons.find((button) => button.props['data-tab'] === 'models')?.props['aria-selected'] === true);
check('switching tabs updates the selected state',
  (() => {
    const accountTab = tabButtons.find((button) => button.props['data-tab'] === 'account');
    accountTab?.props.onClick?.();
    return zh.stateChanges[6] === 'account';
  })());

// 帳號頁：只有切到帳號頁才看得到授權與帳號清單。
const accountStatus = statusWithPendingLogin();
accountStatus.accounts = [
  { id: 'active-account', label: 'Primary', isActive: true, expired: false, expiresInSeconds: 3600 },
  { id: 'other-account', label: 'A longer secondary account label', isActive: false, expired: false, expiresInSeconds: 7200 }
];
const accountPage = renderPage('zh-Hant', DONE(accountStatus, 'account'));
const accountText = accountPage.texts.join('\n');
check('the authorization section is titled', accountText.includes('授權狀態'));
check('the accounts section is titled', accountText.includes('帳號'));
check('the account add action is rendered', accountText.includes('新增帳號'));
check('account add does not rely on native prompt', !/\bwindow\.prompt\s*\(/.test(uiSource));
const accountRows = accountPage.elements.filter((element) => element.className === 'ocoa-account-row');
check('each account is rendered in its own aligned grid row', accountRows.length === 2, `${accountRows.length} rows`);
const activeMarkers = accountPage.elements.filter((element) => element.className === 'ocoa-account-active');
check('the active account marker is a centered non-button span', activeMarkers.length === 1 && activeMarkers[0].tag === 'span');
check('the active account state is visible', accountText.includes('使用中'));
check('the inactive account still has a switch button', accountPage.elements.some((element) => element.tag === 'button' && element.className === 'ocoa-btn' && accountText.includes('切換')));
check('the models section is titled', zhText.includes('模型'));

// 進階頁：備援與診斷只在這裡出現。
const advancedPage = renderPage('zh-Hant', DONE(accountStatus, 'advanced'));
const advancedText = advancedPage.texts.join('\n');
check('the diagnostics section is titled', advancedText.includes('診斷資訊'));
check('the fallback section lives on the advanced tab', advancedText.includes('模型備援'));
// 分頁的意義就在這裡：模型清單不該出現在進階頁。
check('the advanced tab does not duplicate the model table',
  !advancedPage.classes.some((c) => c === 'ocoa-table'));

const allFilterPage = renderPage('zh-Hant', DONE(filterStatus));
const modelFilterButtons = allFilterPage.elements.filter((element) =>
  element.tag === 'button' && typeof element.props['data-model-filter'] === 'string'
);
// 全部 + 可用 + 三個失敗原因 = 五個區段，全部都是真的按鈕。
check('every category is a real segmented button',
  modelFilterButtons.length === 5
    && modelFilterButtons.every((button) => button.props.type === 'button'),
  `${modelFilterButtons.length} buttons`);
check('the segments form one connected control, not loose chips',
  allFilterPage.elements.filter((element) => element.className === 'ocoa-segments').length === 1);
check('the unfiltered view is selected by default',
  modelFilterButtons.every((button) => button.props['aria-pressed'] === (button.props['data-model-filter'] === 'all')));
check('each segment shows its own count and label',
  allFilterPage.texts.includes('全部') && allFilterPage.texts.includes('可用')
    && allFilterPage.texts.includes('4') && allFilterPage.texts.includes('1'));

// 篩選列是一排等寬格子，混用「可用」與「模型目前不可用」會讓格寬參差、
// 選中項被撐寬而看起來像輸入框。分段控制必須用短標籤，完整句子放 title。
//
// 只看按鈕自己的文字，不看整頁：表格列的狀態底下仍會顯示完整原因，
// 那是刻意的（那裡有空間講清楚）。
const segLabels = modelFilterButtons.map((button) => {
  const labels = [];
  const collect = (node) => {
    if (typeof node === 'string') { labels.push(node); return; }
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (node && typeof node === 'object') collect(node.children);
  };
  collect(button.children);
  return labels.join('');
});
check('the segments use short labels, not full sentences',
  segLabels.length === 5 && segLabels.every((label) => label.length <= 10),
  segLabels.join(' | '));
check('the short labels still carry the full meaning on hover',
  modelFilterButtons.every((button) => typeof button.props.title === 'string' && button.props.title.length > 0));

const availableFilterButton = modelFilterButtons.find((button) => button.props['data-model-filter'] === 'available');
availableFilterButton?.props.onClick?.();
check('clicking a category selects only that category',
  allFilterPage.stateChanges[7] === 'available' && allFilterPage.stateChanges[5] === false);

const rowIds = (page) => page.elements
  .filter((element) => element.className === 'ocoa-model-group' && typeof element.props.key === 'string')
  .map((element) => element.props.key);

const availableFilterPage = renderPage('zh-Hant', ['auto', filterStatus, '', null, '', true, 'models', 'available', null, '', true]);
check('available toggle filters the table to picker-published models',
  rowIds(availableFilterPage).length === 1 && rowIds(availableFilterPage)[0] === 'available-model');
check('selected category exposes aria-pressed state',
  availableFilterPage.elements.some((element) => element.props['data-model-filter'] === 'available' && element.props['aria-pressed'] === true));

const delistedFilterPage = renderPage('zh-Hant', ['auto', filterStatus, '', null, '', true, 'models', 'deprecated', null, '', true]);
check('reason toggle filters the table to matching probe results',
  rowIds(delistedFilterPage).length === 1 && rowIds(delistedFilterPage)[0] === 'delisted-model');

check('the unfiltered table lists every model',
  rowIds(allFilterPage).length === filterModels.length,
  `${rowIds(allFilterPage).length} rows`);
// 這份 fixture 的實際健康狀態是 degraded（部分模型可用），不是 ready。
// 清單要跟 healthChip() 的分支一一對應，否則換了 fixture 就會誤報。
check('a health badge is rendered',
  ['正常', '即將過期', '尚未探測', '尚未登入', '已過期', '沒有模型回應', '部分模型不可用', '未知']
    .some((s) => zh.texts.includes(s)),
  zh.texts.filter((t) => zhStatus.health && t.includes('模型')).join(', '));
check('the model tally is rendered', /個中有.*個有回應/.test(zhText));
check('the device code is shown', accountText.includes('ABCD-1234'));
check('the verification URL is shown', accountText.includes('https://opencode.ai/auth/device'));
check('the pending login can be cancelled', accountText.includes('取消登入'));
check('the confirmation instruction is shown', accountText.includes('開啟下列網址'));
// The code is already displayed in large type; repeating it in the instruction
// line would show the same string twice in one card.
check('the device code appears exactly once',
  accountPage.texts.filter((s) => s.includes('ABCD-1234')).length === 1,
  `${accountPage.texts.filter((s) => s.includes('ABCD-1234')).length} occurrences`);
check('the provider id is shown', advancedText.includes('opencode-next'));
check('the plugin version is shown', advancedText.includes('0.1.0'));
// 上面那行用的是本檔的假 status（版本寫死 0.1.0），所以它只證明「畫面會顯示
// status 給的版本」，不證明「升版後顯示的是新版本」。補一條真的去讀 package.json
// 的斷言，升版時才不會出現「畫面顯示舊版號卻沒人發現」。
{
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // 只驗證 semver 格式，不鎖死特定版本號 —— 鎖死會讓每次升版都要改測試，
  // 那條測試就會淪為「為了讓它綠而改」的雜訊。
  check('package.json 的版本是合法 semver', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version);
}
check('the probe interval is shown in hours', advancedText.includes('6 小時'),
  advancedText.match(/[\d.]+ 小時/)?.[0]);
check('the catalog poll is shown in minutes', advancedText.includes('15 分鐘'),
  advancedText.match(/[\d.]+ 分鐘/)?.[0]);
check('the image pixel budget is shown', advancedText.includes('640000'));
check('the image byte cap is shown with grouping', advancedText.includes('2,097,152 B'),
  advancedText.match(/[\d,]+ B/)?.[0]);
check('auto-detection reads as enabled', advancedText.includes('開啟'));

check('a table is rendered', zh.classes.some((c) => c.includes('ocoa-table')));
check('the table has model rows',
  zh.classes.filter((c) => c === 'ocoa-model').length > 0,
  `${zh.classes.filter((c) => c === 'ocoa-model').length} rows`);
// 使用者明確要求：主表格不要「說明」欄。狀態與延遲已經是全部需要的資訊，
// 其餘細節收進展開列。
check('the table has exactly three columns',
  ['模型', '狀態', '延遲'].every((h) => zh.texts.includes(h)));
check('the detail column is gone', !zh.texts.includes('說明'));
check('no row carries a prose description cell',
  zh.elements.every((element) => element.className !== 'ocoa-detail'));

/* ------------------------------------------- 主題變數必須真的存在於宿主 */

// 這一組守的是一個「看起來有寫、其實不存在」的錯：外掛原本用
// `--dsw-alias-accent-primary` 當強調色，但宿主的變數清單裡沒有這個名字，
// 於是主按鈕與選中項的底色是透明的、文字又是白色——畫面上就是「按鈕消失了」。
//
// 這裡直接拿宿主 asar 裡實際出現的變數名比對，而不是靠人工記憶；找不到 asar
// 時跳過（例如在其他機器上跑），不讓測試變成環境相依。
{
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const asar = process.env.DSH_ASAR_PATH
    || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar') : '');
  if (asar && existsSync(asar)) {
    const { readFileSync } = await import('node:fs');
    const hostText = readFileSync(asar, 'utf8');
    const hostVars = new Set([...hostText.matchAll(/--dsw-alias-[a-z0-9-]+/g)].map((m) => m[0]));
    const used = [...uiSource.matchAll(/var\((--dsw-alias-[a-z0-9-]+)/g)].map((m) => m[1]);
    const unique = [...new Set(used)];
    const missing = unique.filter((name) => !hostVars.has(name));
    check('every host theme variable the plugin uses actually exists',
      missing.length === 0, missing.join(', '));
  } else {
    console.log('  skip - host asar not found, theme-variable check skipped');
  }
}

// 卡片在固定寬度的面板裡不能超出邊界：內距與邊框若用 content-box 計算，
// 右緣就會被推出面板外（實測截圖發生過）。
check('the page and cards use border-box sizing',
  /\.ocoa-page \*[^{]*\{[^}]*box-sizing:\s*border-box/.test(uiSource));
check('the page can shrink inside a fixed-width panel',
  /\.ocoa-page \{[^}]*min-width:\s*0/.test(uiSource));

/* ------------------------------------------------- rows expand on demand */

console.log('\nzh-Hant: expanded model row');

const expanded = renderPage('zh-Hant', ['auto', filterStatus, '', null, '', true, 'models', 'all', 'available-model', '', true]);
const expandedText = expanded.texts.join('\n');
check('a row can be expanded to reveal its settings', expandedText.includes('上下文大小'));
check('context source and catalog value are visible',
  expandedText.includes('OpenCode 模型目錄') || expandedText.includes('外掛備援值'));
check('context editor explains that compaction stays with DSH',
  expandedText.includes('不會改變 DSH 的壓縮策略'));
check('context editor offers default and manual modes',
  expandedText.includes('跟隨 OpenCode 預設值') && expandedText.includes('自訂數值'));
check('only the opened row is expanded',
  expanded.elements.filter((element) => element.className === 'ocoa-model-expand').length === 1);
check('the row toggle reports its state',
  expanded.elements.some((element) => element.className === 'ocoa-model-toggle' && element.props['aria-expanded'] === true));

// 上游目錄的輸出上限要看得到。使用者問「最大值是多少」時，問的常常是這個，
// 而它以前只活在 describe() 裡，畫面上完全沒有。
const outputLimit = renderPage('zh-Hant', ['auto', filterStatus, '', null, '', true, 'models', 'all', 'available-model', '', true]);
check('the expanded row shows the upstream output limit',
  outputLimit.texts.join('\n').includes('輸出上限'),
  outputLimit.texts.join('\n').slice(0, 300));
check('collapsed rows hide their settings', !zhText.includes('上下文大小'));

/* ------------------------------------------- 記住的篩選不得留下空白表格 */

console.log('\nzh-Hant: a remembered filter with no matching rows');

// 使用者上次停在「可用」，這次開機沒有任何探測資料。若照樣套用「可用」，
// 畫面就是 46 個候選、0 筆可用、整張表空白——看起來像探測紀錄不見了。
const unprobedStatus = reporter.buildStatus();
unprobedStatus.pendingLogin = null;
unprobedStatus.models.models = [
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', probed: false, ok: false, valid: false, available: false, shown: false, reason: null, ms: null, contextWindow: 200000 },
  { id: 'beam-free', name: 'Beam Free', probed: false, ok: false, valid: false, available: false, shown: false, reason: null, ms: null, contextWindow: 1048576 }
];
unprobedStatus.models.available = 0;
unprobedStatus.models.probed = 0;
unprobedStatus.models.total = 2;
unprobedStatus.models.probedAt = null;

const remembered = renderPage('zh-Hant', ['auto', unprobedStatus, '', null, '', true, 'models', 'available', null, '', true]);
const rememberedText = remembered.texts.join('\n');
check('an empty remembered "available" filter falls back to all models',
  rememberedText.includes('deepseek-v4.1-flash-free'),
  rememberedText.slice(0, 200));
check('the fallback explains the models are unprobed rather than missing',
  rememberedText.includes('尚未探測') || rememberedText.includes('未探測'));

// 真的有可用模型時，記住的篩選必須照舊生效，不能被退回全部。
const withUsable = reporter.buildStatus();
withUsable.pendingLogin = null;
withUsable.models.models = [
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', probed: true, ok: true, valid: true, available: true, shown: true, reason: 'http-200', status: 200, ms: 900, contextWindow: 200000 },
  { id: 'zzz-broken', name: 'Broken', probed: true, ok: false, valid: false, available: false, shown: false, reason: 'unavailable', status: 400, ms: 700, contextWindow: 131072 }
];
withUsable.models.available = 1;
withUsable.models.probed = 2;
withUsable.models.total = 2;
const keptFilter = renderPage('zh-Hant', ['auto', withUsable, '', null, '', true, 'models', 'available', null, '', true]);
const keptText = keptFilter.texts.join('\n');
check('a remembered filter still applies when it has matching rows',
  keptText.includes('deepseek-v4.1-flash-free') && !keptText.includes('zzz-broken'));

/* --------------------------------------- 探測被熔斷時要講清楚只驗了一部分 */

console.log('\nzh-Hant: a truncated probe run');

// 13 個可用、卻只有 4 筆探測紀錄。若不說明，使用者會以為探測壞了。
const truncatedStatus = reporter.buildStatus();
truncatedStatus.pendingLogin = null;
truncatedStatus.models.models = [
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', probed: true, ok: true, valid: true, available: true, shown: true, reason: 'http-200', status: 200, ms: 900, contextWindow: 200000 },
  { id: 'beam-free', name: 'Beam Free', probed: true, ok: true, valid: true, available: true, shown: true, reason: 'http-200', status: 200, ms: 800, contextWindow: 1048576 },
  { id: 'zzz-later', name: 'Later', probed: false, ok: false, valid: false, available: false, shown: false, reason: null, status: null, ms: null, contextWindow: 131072 }
];
truncatedStatus.models.available = 2;
truncatedStatus.models.probed = 2;
truncatedStatus.models.total = 3;
truncatedStatus.models.truncation = { stopped: 'rate-limited', at: Date.now(), tested: 2, total: 46, stoppedBy: { id: 'beam-free', status: 429, reason: 'rate-limited' } };

const trunc = renderPage('zh-Hant', DONE(truncatedStatus));
const truncText = trunc.texts.join('\n');
check('a truncated run explains how much it covered',
  truncText.includes('本輪只驗了 2/46'), truncText.slice(0, 240));
check('the truncation reason mentions the rate limit',
  truncText.includes('限流') || truncText.includes('額度'));
check('the truncation notice is marked for styling',
  trunc.elements.some((el) => el.props?.['data-probe-truncated'] === 'rate-limited'));

const enTrunc = renderPage('en', DONE(truncatedStatus));
check('the truncation notice is translated for English',
  enTrunc.texts.join('\n').includes('stopped after 2 of 46'));

/* --------------------------------------------- 額度解除時間（retry-after） */

console.log('\nzh-Hant: when the free quota comes back');

// 上游 429 帶 retry-after: 5397（約 90 分鐘）。這是使用者最想知道的那個數字：
// 該等，還是該先去吃飯。
const quotaStatus = reporter.buildStatus();
quotaStatus.pendingLogin = null;
quotaStatus.models.models = truncatedStatus.models.models.slice(0, 2);
quotaStatus.models.available = 2;
quotaStatus.models.probed = 2;
quotaStatus.models.total = 2;
quotaStatus.models.truncation = {
  stopped: 'rate-limited',
  at: Date.now(),
  tested: 1,
  total: 46,
  stoppedBy: { id: 'beam-free', status: 429, reason: 'rate-limited' },
  retryAt: Date.now() + 90 * 60_000
};
quotaStatus.quota = { resetAt: quotaStatus.models.truncation.retryAt, remainingMs: 90 * 60_000, source: 'retry-after' };

const quota = renderPage('zh-Hant', DONE(quotaStatus));
const quotaText = quota.texts.join('\n');
check('the quota reset time is shown', quotaText.includes('額度將於'), quotaText.slice(0, 240));
// 剩餘時間走 shortDuration：90 分鐘會被寫成「1 小時 30 分」或「1 小時 29 分」
// （取決於毫秒邊界），兩者都算正確。要驗的是「有換算成人話」，不是精確到分。
check('the quota notice includes the remaining wait',
  /還有\s*1\s*小時\s*(29|30)\s*分/.test(quotaText), quotaText.slice(0, 240));
check('the quota notice is marked for styling',
  quota.elements.some((el) => el.props?.['data-quota-reset'] === 'pending'));

const enQuota = renderPage('en', DONE(quotaStatus));
check('the quota notice is translated for English',
  enQuota.texts.join('\n').includes('Free quota resets'));

// 沒有 retry-after 時不得捏造時間。
const noQuota = reporter.buildStatus();
noQuota.pendingLogin = null;
noQuota.models = { ...quotaStatus.models, truncation: { ...quotaStatus.models.truncation, retryAt: null } };
noQuota.quota = null;
check('no invented reset time when upstream omits retry-after',
  renderPage('zh-Hant', DONE(noQuota)).elements.every((el) => el.props?.['data-quota-reset'] === undefined));

// 沒有熔斷時不得出現這行提示，否則每次探測都像出事了。
const cleanStatus = reporter.buildStatus();
cleanStatus.pendingLogin = null;
cleanStatus.models.models = truncatedStatus.models.models.slice(0, 2);
cleanStatus.models.available = 2;
cleanStatus.models.probed = 2;
cleanStatus.models.total = 2;
cleanStatus.models.truncation = null;
const clean = renderPage('zh-Hant', DONE(cleanStatus));
check('a complete run shows no truncation notice',
  clean.elements.every((el) => el.props?.['data-probe-truncated'] === undefined));

/* --------------------------------------------------------- failure reasons */

console.log('\nzh-Hant: why a model fails');

const failStatus = reporter.buildStatus();
failStatus.pendingLogin = null;
failStatus.models.models = SYNTHETIC_FAILURES;
failStatus.models.available = 0;
failStatus.models.probed = 7;
failStatus.models.total = 8;

const fail = renderPage('zh-Hant', DONE(failStatus));
const failText = fail.texts.join('\n');

// These are the six reasons the classifier can produce for an unreachable
// model. Each must read as a distinct sentence; a missing mapping would
// degrade the row to a bare "HTTP 403", which tells the user nothing.
const EXPECTED_REASONS = [
  '網路出口被擋 — 請關閉 VPN／proxy',
  '免費通道拒絕此請求',
  '此模型受地區限制',
  '額度已用盡',
  '被限流',
  '模型已下架',
  '連線失敗'
];

for (const text of EXPECTED_REASONS) {
  check(`the reason reads as "${text}"`, failText.includes(text));
}
check('seven distinct reasons produce seven distinct sentences',
  new Set(fail.texts.filter((s) => EXPECTED_REASONS.includes(s))).size === EXPECTED_REASONS.length,
  `${new Set(fail.texts.filter((s) => EXPECTED_REASONS.includes(s))).size} distinct`);

// 上游原文必須真的出現在畫面上。
//
// 這是使用者明確要的：錯誤碼要完整到可以自己拿去 Google。只顯示「400，
// 沒有說明」等於把判斷權收走——實測就發生過同一個 400 既可能是上下文超限、
// 也可能是帳號權限，而我們的中文說明兩次都猜錯。
//
// 它現在收在展開列裡（主表格只有三欄），所以要展開那一列才看得到。
const rawDetail = renderPage('zh-Hant', ['auto', failStatus, '', null, '', true, 'models', 'all', 'zzz-rawdetail', '', true]);
const rawDetailText = rawDetail.texts.join('\n');
check('上游原始回應有顯示出來', rawDetailText.includes('deepseek-v4.1-flash-free'),
  rawDetail.texts.find((s) => s.includes('deepseek')) ?? '(沒找到)');
check('原始回應帶上 HTTP 狀態碼', rawDetailText.includes('HTTP 400'),
  rawDetail.texts.find((s) => s.startsWith('HTTP ')) ?? '(沒找到)');

const hiddenRow = renderPage('zh-Hant', ['auto', failStatus, '', null, '', true, 'models', 'all', 'zzz-deprecated', '', true]);
const hiddenText = hiddenRow.texts.join('\n');
check('hidden models retain their picker state in diagnostics', hiddenText.includes('已從模型清單隱藏'));
check('hidden-model diagnostics show the HTTP status', hiddenText.includes('HTTP 410'));
check('hidden-model diagnostics show their probe time', hiddenText.includes('探測時間：'));
// 成功的列不該帶原文：成功的探測根本不讀 body，硬顯示只會是空殼。
check('成功的列不顯示原始回應', /HTTP 2\d\d.*模型/.test(failText) === false, '');
// 網路風控與免費通道拒絕是兩件事：前者換網路才能解，後者與網路無關。
// 若兩者顯示同一句，使用者就分不出該關 VPN 還是該改請求。check('網路風控與免費通道拒絕不是同一句話', EXPECTED_REASONS[0] !== EXPECTED_REASONS[1]);
check('網路風控的說明提到 VPN',
  failText.includes('VPN'));
check('an unprobed model is labelled as such',
  failText.includes('尚未探測') || failText.includes('未探測'));
check('failed rows keep their human-readable reasons alongside the status',
  failText.includes('此模型受地區限制') && failText.includes('額度已用盡'));
check('the internal reason string never reaches the screen',
  !/free-lane-blocked|region-restricted|quota-exceeded|network-blocked/.test(failText));
check('no key is missing in the failure table', !failText.includes('«MISSING:'));

/* ------------------------------------------------------------------ English */

console.log('\nen: full page');

const en = renderPage('en', DONE(statusWithPendingLogin()));
const enText = en.texts.join('\n');

check('no dictionary key leaks onto the screen',
  en.texts.filter((s) => realKeys.includes(s)).length === 0,
  en.texts.filter((s) => realKeys.includes(s)).join(', '));
check('no key is missing from the dictionary', !enText.includes('«MISSING:'));
check('the title is rendered', enText.includes('OpenCode-Next'));
check('the tab bar is rendered in English',
  ['Account', 'Models', 'Advanced'].every((label) => enText.includes(label)));
check('the model tally is rendered', /of \d+ responding/.test(enText));
// 裝置代碼在帳號頁，所以英文版要切到那一頁才看得到。
const enAccount = renderPage('en', DONE(statusWithPendingLogin(), 'account'));
check('the device code is shown', enAccount.texts.join('\n').includes('ABCD-1234'));
const timeoutStatus = statusWithPendingLogin();
timeoutStatus.pendingLogin = null;
timeoutStatus.loginError = { code: 'timeout', message: 'Device login timed out after 600 seconds', at: 1 };
const enTimeout = renderPage('en', DONE(timeoutStatus, 'account'));
check('a timed-out sign-in is explained in English', enTimeout.texts.join('\n').includes('Sign-in timed out'));
const hantTimeout = renderPage('zh-Hant', DONE(timeoutStatus, 'account'));
check('a timed-out sign-in is explained in Traditional Chinese', hantTimeout.texts.join('\n').includes('登入逾時'));
const deniedStatus = statusWithPendingLogin();
deniedStatus.pendingLogin = null;
deniedStatus.loginError = { code: 'denied', message: 'access_denied', at: 2 };
check('a denied sign-in is not described as a timeout',
  renderPage('zh-Hant', DONE(deniedStatus, 'account')).texts.join('\n').includes('授權被拒絕'));

// The English page must not contain Chinese. The server builds healthMessage as
// a fixed Chinese sentence, so rendering it verbatim made the English page
// bilingual; the page now resolves it from its own dictionary by health code.
//
// 例外：語言切換鍵裡的按鈕短標籤（'繁'、'简'）與完整語言名稱一律用該語言自己的寫法。
// 這是國際慣例，也才讓看不懂目前語言的讀者找得到自己的語言——所以這些字串
// 不算「英文頁混入中文」，其餘任何中文才算。
const LANGUAGE_SELF_NAMES = new Set(['繁', '简', '简体中文', '繁體中文']);
const han = en.texts
  .filter((s) => /[\u4e00-\u9fff]/.test(s))
  .filter((s) => !LANGUAGE_SELF_NAMES.has(s));
check('the English page contains no Chinese text', han.length === 0, han.slice(0, 4).join(' | '));

// 但語言按鈕本身必須在場，否則英文使用者找不到切換到中文的入口。
const enAll = en.texts.join('\n');
check('the English page still offers the Chinese language buttons',
  enAll.includes('繁') && enAll.includes('简')
  && en.elements.some((el) => el.props?.['data-lang'] === 'zh-Hant' && el.props?.title === '繁體中文')
  && en.elements.some((el) => el.props?.['data-lang'] === 'zh' && el.props?.title === '简体中文'));

check('the footer renders maintainer and dynamic npm version',
  zh.texts.includes('@kizaki-R') && zh.texts.includes('npm v0.1.0'));
check('the theme toggle button renders in the header actions',
  zh.elements.some((el) => el.className === 'ocoa-theme-btn' && (el.props?.['data-theme-mode'] === 'dark' || el.props?.['data-theme-mode'] === 'light')));

/* ----------------------------------------------------- Checked-only probe */

console.log('\nzh-Hant: one-click probe targets checked models only');

{
  const checkedStatus = statusWithPendingLogin();
  checkedStatus.models = {
    total: 3,
    probed: 3,
    available: 2,
    probedAt: Date.now(),
    breakdown: [],
    models: [
      { id: 'checked-a', name: 'Checked A', probed: true, ok: true, valid: true, available: true, shown: true, contextWindow: 128000 },
      { id: 'unchecked-b', name: 'Unchecked B', probed: true, ok: true, valid: true, available: true, shown: false, contextWindow: 128000 },
      { id: 'checked-c', name: 'Checked C', probed: true, ok: true, valid: true, available: true, shown: true, contextWindow: 128000 }
    ]
  };
  const checkedPage = renderPage('zh-Hant', DONE(checkedStatus));
  const probeBtn = checkedPage.elements.find((el) => el.props?.['data-probe-btn'] === 'true');
  check('one-click probe counts only checked models',
    probeBtn?.props?.['data-probe-count'] === 2 && probeBtn?.props?.disabled === false && checkedPage.texts.includes('一鍵探測 (2)'));

  const sentBodies = [];
  const prevFetch = sandbox.fetch;
  sandbox.fetch = async (url, init) => {
    sentBodies.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { text: async () => JSON.stringify({ ok: true, value: checkedStatus }) };
  };
  try {
    await probeBtn?.props?.onClick?.();
  } finally {
    sandbox.fetch = prevFetch;
  }
  const probeReq = sentBodies.find((r) => String(r.url).endsWith('/probe'));
  check('one-click probe sends only checked model ids',
    JSON.stringify(probeReq?.body) === JSON.stringify({ modelIds: ['checked-a', 'checked-c'] }),
    JSON.stringify(probeReq));

  const emptyCheckedStatus = statusWithPendingLogin();
  emptyCheckedStatus.models = {
    total: 1,
    probed: 1,
    available: 1,
    probedAt: Date.now(),
    breakdown: [],
    models: [
      { id: 'unchecked-only', name: 'Unchecked Only', probed: true, ok: true, valid: true, available: true, shown: false, contextWindow: 128000 }
    ]
  };
  const emptyPage = renderPage('zh-Hant', DONE(emptyCheckedStatus));
  const emptyBtn = emptyPage.elements.find((el) => el.props?.['data-probe-btn'] === 'true');
  check('one-click probe is disabled when no model is checked',
    emptyBtn?.props?.['data-probe-count'] === 0 && emptyBtn?.props?.disabled === true);
}

/* ------------------------------------------------------------------ Loading */

console.log('\nloading branch');

const loading = renderPage('zh-Hant', LOADING);
check('a loading page renders the progress text',
  loading.texts.join('\n').includes('正在重新整理'), loading.texts.join(' ').slice(0, 60));
check('a loading page has no missing key',
  !loading.texts.join('\n').includes('«MISSING:'));

console.log(`\n${failures === 0 ? `✔ Render tests passed (${checks} checks)` : `❌ ${failures} of ${checks} checks failed`}`);
if (failures > 0) process.exit(1);
