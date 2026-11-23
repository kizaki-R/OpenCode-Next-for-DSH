/**
 * Settings-page regression tests: the status reporter, the HTTP routes, and the
 * browser half's module envelope.
 *
 * These three pieces fail in ways that are invisible to the other tests:
 *
 *   - a leaked secret in /status is never an error, just a quietly dangerous
 *     response;
 *   - a broken route returns a 404 the page renders as "unknown error";
 *   - a malformed client envelope makes the whole section silently not appear,
 *     because the host simply never finds a plugin to register.
 *
 * The browser half is exercised inside `node:vm` with a fake document, so the
 * test proves the envelope, the dependency list, the slot registration and the
 * style teardown without needing a running GUI.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { ModelCatalog } from '../lib/catalog.js';
import { TokenManager } from '../lib/token-manager.js';
import { createStatusReporter } from '../lib/status.js';
import { registerWebApi } from '../lib/web-api.js';

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

/* ------------------------------------------------------------------ status */

console.log('\nstatus reporter');

// 這支測試會打真實的 /logout、/refresh 與 /accounts/switch 路由。若用預設路徑，
// 跑一次 npm test 就會：
//   1. 刪掉使用者真正的 ~/.dsh/opencode-next.models.json（/logout → invalidateProbe）
//   2. 真的向上游刷新 token 並寫回 ~/.dsh/opencode-next.accounts.json
// 兩者都是測試不該有的副作用。所以憑證、帳號清單與探測快取一律指向暫存檔，
// 刷新函式也換成假的：這支測試驗的是路由與畫面，不是 OAuth。
const sandboxDir = mkdtempSync(path.join(tmpdir(), 'ocoa-settings-'));
const tokenStorePath = path.join(sandboxDir, 'opencode-next.token.json');
const accountsPath = path.join(sandboxDir, 'opencode-next.accounts.json');
const probeCachePath = path.join(sandboxDir, 'probe-cache.json');

const tokenManager = new TokenManager(tokenStorePath, accountsPath, {
  refreshAccessToken: async () => ({
    access_token: 'st_sandbox-refreshed',
    refresh_token: 'st_sandbox-refresh',
    expires_in: 3600
  })
});
const contextOverrides = {};
const contextWindowStore = {
  getOverride(modelId) { return contextOverrides[modelId] ?? null; },
  set(modelId, value) {
    if (!Number.isSafeInteger(value) || value < 1024 || value > 100000000) throw new RangeError('invalid contextWindow');
    contextOverrides[modelId] = value;
    return value;
  },
  reset(modelId) {
    const existed = Object.hasOwn(contextOverrides, modelId);
    delete contextOverrides[modelId];
    return existed;
  }
};
// 這支測試會打真實的 /logout 路由，而該路由會清掉探測快取。若用預設路徑，
// 跑一次 npm test 就會刪掉使用者真正的 ~/.dsh/opencode-next.models.json。
// 所以 catalog 一律指向暫存檔：測試只驗行為，不碰使用者的資料。
const catalog = new ModelCatalog({ contextStore: contextWindowStore, probeCachePath });
await catalog.init();

const autoSwitchSettings = { enabled: false, get() { return { enabled: this.enabled }; }, set(patch) { this.enabled = patch.enabled === true; return this.get(); } };
const reporter = createStatusReporter({
  tokenManager,
  catalog,
  autoSwitch: autoSwitchSettings,
  config: {
    providerId: 'opencode-next',
    providerName: 'OpenCode (OAuth)',
    autoDetectModels: true,
    probeIntervalMs: 21600000,
    catalogPollMs: 900000,
    imagePixelBudget: 640000,
    imageMaxBytes: 2097152
  },
  version: '0.0.0-test'
});

const status = reporter.buildStatus();

check('buildStatus returns an object', status && typeof status === 'object');
check('health is a known state',
  ['ready', 'expiring', 'unprobed', 'signed-out', 'expired', 'no-models', 'degraded'].includes(status.health),
  status.health);
check('healthMessage is a non-empty string',
  typeof status.healthMessage === 'string' && status.healthMessage.length > 0);
check('provider id is reported', status.provider.id === 'opencode-next');
check('version is echoed back', status.version === '0.0.0-test');
check('config snapshot is present',
  status.config.imagePixelBudget === 640000 && status.config.catalogPollMs === 900000);
check('generatedAt is a timestamp', Number.isFinite(status.generatedAt));
check('auto-switch status defaults off without credential fields', status.autoSwitch?.enabled === false && !('access' in status.autoSwitch) && !('refresh' in status.autoSwitch));

// The probe roster is what the page renders per row; without a label the row
// would be a bare status code, which is exactly what the page exists to avoid.
check('models list is populated', Array.isArray(status.models.models));
check('every model row carries a human label',
  status.models.models.every((m) => typeof m.label === 'string' && m.label.length > 0));
check('every model row reports whether it was probed',
  status.models.models.every((m) => typeof m.probed === 'boolean'));
check('every model row reports default and effective context values',
  status.models.models.every((m) => Number.isSafeInteger(m.contextWindow) && Number.isSafeInteger(m.catalogContextWindow)));
check('available count matches the published picker set',
  status.models.available === catalog.getModels().length,
  `${status.models.available} !== ${catalog.getModels().length}`);
check('available count matches diagnostic row availability',
  status.models.available === status.models.models.filter((model) => model.available).length,
  `${status.models.available} !== ${status.models.models.filter((model) => model.available).length}`);

// Probe rows must be copies: an HTTP handler that mutates the array it was
// handed would corrupt the cache for the next request.
const rows = catalog.getProbeResults();
if (rows.length > 0) {
  const original = rows[0].id;
  rows[0].id = 'mutated-by-caller';
  check('getProbeResults hands out copies, not internal state',
    catalog.getProbeResults()[0].id === original);
} else {
  check('getProbeResults hands out copies, not internal state', true);
}

// describeProbe is the mapping the page relies on; an unmapped reason would
// fall through to a bare HTTP status, which is exactly what the page exists to
// avoid. Assert the distinct reasons produce distinct, non-empty text.
const freeLane = reporter.describeProbe({ probed: true, ok: false, reason: 'free-lane-blocked' });
const region = reporter.describeProbe({ probed: true, ok: false, reason: 'region-restricted' });
check('describeProbe explains a free-lane block',
  typeof freeLane === 'string' && freeLane.length > 0, JSON.stringify(freeLane));
check('describeProbe distinguishes a region block from a free-lane block',
  freeLane !== region, `${freeLane} / ${region}`);
check('describeProbe reports an unprobed model',
  reporter.describeProbe({ probed: false, ok: false }).length > 0);
check('describeProbe reports a healthy model',
  reporter.describeProbe({ probed: true, ok: true }).length > 0);
check('describeProbe distinguishes healthy from a failure',
  reporter.describeProbe({ probed: true, ok: true }) !== freeLane);

/* ------------------------------------------------------------- secret safety */

console.log('\nstatus response must never carry a credential');

await tokenManager.getValidToken().catch(() => null);
const cred = tokenManager.getCached();
const serialized = JSON.stringify(status);

if (cred?.access) {
  const fragments = [cred.access, cred.access.slice(0, 24), cred.access.slice(-24)]
    .filter((s) => s && s.length >= 8);
  check('no access-token fragment appears in the status payload',
    fragments.every((f) => !serialized.includes(f)));
  check('no refresh token appears in the status payload',
    !cred.refresh || !serialized.includes(cred.refresh));
} else {
  // No credential on this machine: assert the shape that makes the claim
  // meaningful rather than silently skipping the check.
  check('credential description exposes only presence and expiry',
    !('access' in status.credential) && !('refresh' in status.credential));
}

check('credential description never contains the word "access" as a key',
  !Object.keys(status.credential).includes('access'));
check('credential description never contains a "refresh" value',
  !Object.keys(status.credential).includes('refresh'));

const described = tokenManager.describeCredential();
check('describeCredential reports presence', typeof described.present === 'boolean');
check('describeCredential reports the source', 'source' in described);
check('describeCredential reports expiry as a countdown', 'expiresInSeconds' in described);
check('describeCredential omits the token value', !('access' in described) && !('refresh' in described));

/* ------------------------------------------------------------- the routes */

console.log('\nHTTP routes');

let registered = null;
let adapterUpdates = 0;
const fakeCtx = {
  inject(deps, fn) {
    check('web api injects the webServer service', deps.includes('webServer'));
    fn({
      effect: (fn2) => fn2(),
      webServer: { register: (opts) => { registered = opts; } }
    });
  }
};

registerWebApi(fakeCtx, {
  tokenManager,
  catalog,
  statusReporter: reporter,
  autoSwitch: autoSwitchSettings,
  contextWindowStore,
  onAdaptersUpdated: () => { adapterUpdates++; },
  // /logout 會刪掉 config.credentialPath 指到的檔案。留空會退回預設的
  // ~/.dsh/opencode-next.token.json，那就會刪到使用者的真憑證。
  config: { credentialPath: tokenStorePath }
});

check('a route was registered', registered !== null);
check('registered as a prefix route', registered?.kind === 'prefix');
check('prefix is namespaced to this plugin',
  registered?.path === '/opencode-next/api', registered?.path);

async function call(method, path, body = '', headers = null) {
  const res = {
    status: null,
    headers: null,
    body: null,
    writeHead(s, h) { this.status = s; this.headers = h; },
    end(b) { this.body = b; }
  };
  const request = {
    method,
    url: path,
    ...(headers ? { headers } : {}),
    on(event, callback) {
      if (event === 'data' && body) callback(Buffer.from(body));
      if (event === 'end') callback();
      return this;
    }
  };
  await registered.handler(request, res);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = res.body; }
  return { status: res.status, headers: res.headers, parsed };
}

const okStatus = await call('GET', '/opencode-next/api/status');
check('GET status returns 200', okStatus.status === 200, String(okStatus.status));
check('GET status returns ok:true', okStatus.parsed?.ok === true);
check('GET status sets a JSON content type',
  /application\/json/.test(okStatus.headers?.['content-type'] ?? ''));
check('GET status forbids caching', okStatus.headers?.['cache-control'] === 'no-store');
check('GET status carries the health state', typeof okStatus.parsed?.value?.health === 'string');
check('GET status carries a resolvable version',
  typeof okStatus.parsed?.value?.version === 'string',
  String(okStatus.parsed?.value?.version));

const autoSwitchOn = await call('POST', '/opencode-next/api/auto-switch', JSON.stringify({ enabled: true }));
check('POST auto-switch enables opt-in setting', autoSwitchOn.parsed?.value?.enabled === true);
check('status reports auto-switch without secrets', (await call('GET', '/opencode-next/api/status')).parsed?.value?.autoSwitch?.enabled === true);
const autoSwitchOff = await call('POST', '/opencode-next/api/auto-switch', JSON.stringify({ enabled: false }));
check('POST auto-switch can disable setting', autoSwitchOff.parsed?.value?.enabled === false);

const contextModel = catalog.getCandidates()[0];
const contextDefault = contextModel.contextWindow;
const contextSaved = await call('POST', '/opencode-next/api/context', JSON.stringify({
  modelId: contextModel.id,
  contextWindow: 300000
}));
check('POST context saves a model-specific override',
  contextSaved.parsed?.ok === true && contextSaved.parsed.value.contextWindow === 300000);
check('saving a context override notifies DSH to refresh model metadata', adapterUpdates === 1);
const contextStatus = await call('GET', '/opencode-next/api/status');
const contextRow = contextStatus.parsed?.value?.models?.models?.find((m) => m.id === contextModel.id);
check('status exposes effective and catalog context values',
  contextRow?.contextWindow === 300000 && contextRow?.catalogContextWindow === contextDefault && contextRow?.contextSource === 'custom');
const badContext = await call('POST', '/opencode-next/api/context', JSON.stringify({
  modelId: contextModel.id,
  contextWindow: 1.5
}));
check('POST context rejects non-integer values', badContext.parsed?.error === 'invalid_context_window');
const unknownContext = await call('POST', '/opencode-next/api/context', JSON.stringify({
  modelId: 'not-in-catalog',
  contextWindow: 300000
}));
check('POST context rejects unknown model ids', unknownContext.parsed?.error === 'unknown_model');
const contextReset = await call('POST', '/opencode-next/api/context', JSON.stringify({
  modelId: contextModel.id,
  contextWindow: null
}));
check('POST context null restores the provider default',
  contextReset.parsed?.ok === true && contextReset.parsed.value.contextWindow === contextDefault);
check('restoring default notifies DSH to refresh model metadata', adapterUpdates === 2);

const bare = await call('GET', '/opencode-next/api');
check('the bare prefix also serves status', bare.parsed?.ok === true);

const wrongMethod = await call('POST', '/opencode-next/api/status');
check('a wrong method is rejected with 405', wrongMethod.status === 405, String(wrongMethod.status));
check('the 405 body names the reason', wrongMethod.parsed?.error === 'method_not_allowed');

const missing = await call('GET', '/opencode-next/api/nope');
check('an unknown route returns 404', missing.status === 404, String(missing.status));
check('the 404 body is structured', missing.parsed?.ok === false && missing.parsed?.error === 'not_found');

// A POST route must never echo a secret either.
const logout = await call('POST', '/opencode-next/api/logout');
check('POST logout is handled', logout.parsed?.ok === true, JSON.stringify(logout.parsed)?.slice(0, 120));
check('POST logout explains what it did',
  typeof logout.parsed?.value?.note === 'string' && logout.parsed.value.note.length > 0);
check('POST logout never echoes a token',
  !JSON.stringify(logout.parsed).includes('st_'));

const refresh = await call('POST', '/opencode-next/api/refresh');
check('POST refresh is structured',
  refresh.parsed?.ok === true || refresh.parsed?.error === 'refresh_failed',
  JSON.stringify(refresh.parsed)?.slice(0, 140));
check('POST refresh never echoes a token', !JSON.stringify(refresh.parsed).includes('st_'));

// Cross-origin and CSRF protection
const crossOriginForbidden = await call('POST', '/opencode-next/api/auto-switch', JSON.stringify({ enabled: true }), { origin: 'https://evil.example.com' });
check('cross-origin request is rejected with 403', crossOriginForbidden.status === 403 && crossOriginForbidden.parsed?.error === 'forbidden_origin');

const crossSiteFetchForbidden = await call('POST', '/opencode-next/api/auto-switch', JSON.stringify({ enabled: true }), { 'sec-fetch-site': 'cross-site' });
check('cross-site sec-fetch-site is rejected with 403', crossSiteFetchForbidden.status === 403 && crossSiteFetchForbidden.parsed?.error === 'forbidden_origin');

const crossPortForbidden = await call('POST', '/opencode-next/api/auto-switch', JSON.stringify({ enabled: true }), { host: '127.0.0.1:8428', origin: 'http://127.0.0.1:3000' });
check('cross-port loopback origin is rejected with 403', crossPortForbidden.status === 403 && crossPortForbidden.parsed?.error === 'forbidden_origin');

const localOriginAllowed = await call('POST', '/opencode-next/api/auto-switch', JSON.stringify({ enabled: true }), { host: '127.0.0.1:8428', origin: 'http://127.0.0.1:8428' });
check('local 127.0.0.1 matching-port origin is allowed', localOriginAllowed.status === 200 && localOriginAllowed.parsed?.ok === true);

// An internal throw must come back as a readable message, not a bare 500: the
// page has nowhere else to learn why login cannot proceed.
const brokenReporter = {
  buildStatus() { throw new Error('synthetic failure'); }
};
let brokenRegistered = null;
registerWebApi(
  {
    inject(deps, fn) {
      fn({ effect: (fn2) => fn2(), webServer: {
        register: (opts) => { brokenRegistered = opts; }
      } });
    }
  },
  { tokenManager, catalog, statusReporter: brokenReporter, config: {} }
);

const res = {
  status: null, headers: null, body: null,
  writeHead(s, h) { this.status = s; this.headers = h; },
  end(b) { this.body = b; }
};
await brokenRegistered.handler({ method: 'GET', url: '/opencode-next/api/status' }, res);
let brokenBody = null;
try { brokenBody = JSON.parse(res.body); } catch { brokenBody = res.body; }
check('an internal error is reported as ok:false', brokenBody?.ok === false, String(res.body));
check('an internal error keeps its message', /synthetic failure/.test(brokenBody?.message ?? ''),
  JSON.stringify(brokenBody)?.slice(0, 140));
check('an internal error does not surface as a bare 500', res.status !== 500, String(res.status));

/* ------------------------------------------------------- the browser half */

console.log('\nbrowser module envelope');

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
  createElement: () => ({ tag: '', id: '', textContent: '', parentNode: null }),
  getElementById: (id) => headChildren.find((el) => el.id === id) ?? null
};

const React = {
  // 真實的 React.createElement(type, props, ...children) 會把第 3 個參數之後
  // 全部收成 props.children。這裡必須照做，否則整棵子樹都會消失——本頁用的是
  // `h('div', { className }, childA, childB, …)` 這種寫法，children 全在
  // args[2] 之後。只留 args[0] 與 args[1] 的假 React 會讓任何「向下走訪」
  // 的斷言永遠看不到東西（一個假紅燈，而不是真的缺陷）。
  createElement: (...args) => {
    const [type, props, ...children] = args;
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { __el: type, props: merged };
  },
  useState: (v) => [v, () => {}],
  // useRef 必須真的回傳一個有 .current 的物件：元件在渲染時會寫
  // `tRef.current = t`，假物件若回 undefined，就抓不到這個錯誤。
  useRef: (v) => ({ current: v }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {}
};

let envelope = null;
const sandbox = {
  window: {
    __ModuleLoader__: { load: (mod) => { envelope = mod; } },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
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

check('the client file registers through __ModuleLoader__.load', envelope !== null);
check('the client module declares this plugin id', envelope?.id === 'opencode-next');
check('the client module exposes a factory', typeof envelope?.factory === 'function');

const requires = [];
const plugin = envelope.factory((name) => {
  requires.push(name);
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});

// Only react is allowed: anything else would need the host to resolve a peer
// package, and a miss there takes the whole section down without a message.
check('the factory requires only react',
  requires.length > 0 && requires.every((n) => n === 'react'), JSON.stringify(requires));

check('the plugin declares inject', Array.isArray(plugin?.inject));
check('the plugin injects slots', plugin?.inject?.includes('slots'));
// locale is not optional: the dictionary has to be registered through it, and
// touching an uninjected Cordis service fails activation outright.
check('the plugin injects locale', plugin?.inject?.includes('locale'));
check('the plugin exposes apply', typeof plugin?.apply === 'function');

let section = null;
let injectTarget = null;
const effects = [];
const languages = [];
const dictionaries = [];

plugin.apply({
  effect: (fn, label) => effects.push({ fn, label }),
  locale: {
    getLocale: () => ({ active: 'zh-Hant', locales: ['zh', 'en'], revision: 1 }),
    addLanguage: (def) => languages.push(def),
    register: (ns, copy) => dictionaries.push({ ns, copy }),
    bind: (ns) => (key) => `[${ns}:${key}]`
  },
  slots: {
    inject: (name, fn) => { injectTarget = name; return fn(); },
    register: (meta, render) => { section = { meta, render }; return () => {}; }
  }
});

check('the plugin registers into settings.section', injectTarget === 'settings.section', String(injectTarget));
check('the section is registered', section !== null);
check('the section id is this plugin', section?.meta?.id === 'opencode-next');
check('the section has a numeric order', Number.isFinite(section?.meta?.order));
// 12 and 13 are taken by antigravity and agy-next, and 15+ by others.
check('the section order does not collide with neighbours', section?.meta?.order === 14,
  String(section?.meta?.order));
check('the section declares its locale namespace',
  section?.meta?.locale === 'opencode-next');
check('the section provides a label',
  typeof section?.meta?.label?.() === 'string' && section.meta.label().length > 0);

// 這裡刻意**不**注入宿主 translator：那會讓本頁語言綁在 DSH 全域語言上，
// 切換語言時連帶換掉整個介面。頁面自己解析語言（可在分頁內切換），
// 所以 inject 不該存在、或至少不該提供 t。
check('the section does not bind a host translator into the page',
  typeof section?.meta?.inject !== 'function' || typeof section.meta.inject()?.t !== 'function');

let renderError = null;
let rendered = null;
try {
  rendered = section.render({});
} catch (err) {
  renderError = err;
}
check('rendering with no status loaded does not throw', renderError === null, renderError?.message);
check('rendering returns an element', rendered?.__el !== undefined);

// 語言切換鍵必須真的出現在畫面上，而不是只存在於原始碼裡。
//
// 這裡有個容易踩的坑：假 React 的 createElement 是
// `(...args) => ({ __el: args[0], props: args[1] })`，而本頁的寫法是
// `h('div', { className }, childA, childB, …)`——children 在 **args[2] 之後**，
// 不在 props 裡。只看 props.children 會什麼都找不到（我一開始就卡在這裡）。
// 所以改用 args（createElement 的完整參數）來展開。
function collectTree(node, acc = { classes: new Set(), options: [] }, depth = 0) {
  if (node === null || node === undefined || depth > 25) return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectTree(item, acc, depth + 1);
    return acc;
  }
  if (typeof node !== 'object') return acc;
  if (node.__el === undefined) return acc;

  const props = node.props ?? {};
  // createElement 的第 3 個參數起才是 children。
  const children = node.args !== undefined ? node.args.slice(2) : props.children;

  // 函式元件：呼叫它，繼續走它回傳的樹。Chip 與 LanguageSwitcher 都是自訂元件，
  // 不呼叫就看不到它們內部真正產生的 DOM。
  if (typeof node.__el === 'function') {
    let child;
    try {
      child = node.__el(props);
    } catch {
      return acc; // 元件需要外部資源而失敗時跳過，不讓整棵樹掛掉。
    }
    collectTree(child, acc, depth + 1);
    return acc;
  }

  if (typeof props.className === 'string') {
    for (const cls of props.className.split(/\s+/)) if (cls) acc.classes.add(cls);
  }
  // <option value=…> 的 value 就是語言選項 id。
  if (node.__el === 'option' && typeof props.value === 'string') acc.options.push(props.value);

  collectTree(children, acc, depth + 1);
  return acc;
}

const tree = collectTree(rendered);
check('the page renders a language switcher', tree.classes.has('ocoa-lang-select'),
  `classes: ${[...tree.classes].filter((c) => c.startsWith('ocoa-lang')).join(', ') || '（沒有 cocoa-lang-*）'}`);
check('the switcher offers a follow-system option', tree.options.includes('auto'),
  `options: ${tree.options.join(', ') || '（沒有 option）'}`);
check('the switcher offers all three languages',
  ['auto', 'en', 'zh', 'zh-Hant'].every((id) => tree.options.includes(id)),
  `options: ${tree.options.join(', ')}`);

check('a Traditional Chinese language is declared',
  languages.some((l) => l.id === 'zh-Hant'), JSON.stringify(languages));
check('the language is labelled 繁體中文',
  languages.find((l) => l.id === 'zh-Hant')?.label === '繁體中文');
// Falling back to zh rather than en means an untranslated key shows Simplified
// instead of dropping the whole page to English.
check('the language falls back to zh',
  languages.find((l) => l.id === 'zh-Hant')?.fallback === 'zh');
check('a dictionary is registered', dictionaries.length === 1);
const copy = dictionaries[0]?.copy ?? {};
check('the dictionary covers all three languages',
  ['en', 'zh', 'zh-Hant'].every((k) => k in copy), JSON.stringify(Object.keys(copy)));

const styleEl = headChildren.find((el) => el.id === 'opencode-next-settings-style');
check('a style element is installed', styleEl !== undefined);
check('the style element carries rules', (styleEl?.textContent ?? '').length > 500);
// Theme tokens only: a hard-coded colour would ignore light/dark switching.
check('the stylesheet uses host theme tokens',
  (styleEl?.textContent ?? '').includes('--dsw-alias-label-primary'));
// 驗證「四欄」這個結構，而不是鎖死像素值。
//
// 原本這裡寫死 `108px 84px 64px`，於是「到期欄太窄導致折行」這種真實的版面
// 問題被測試保護住、無法修正。欄寬是設計細節，會隨字型與語系調整；該守住的
// 是「名稱可壓縮 + 三個固定欄」這個意圖。
check('account rows use one fixed four-track grid',
  /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+\d+px\s+\d+px\s+\d+px/.test(styleEl?.textContent ?? ''));
check('the account grid keeps the name track shrinkable',
  /\.ocoa-account-row\s*\{[^}]*minmax\(0,\s*1fr\)/.test(styleEl?.textContent ?? ''));
check('the account grid degrades to three tracks on a narrow panel',
  /@media\s*\(max-width:\s*720px\)\s*\{[^}]*\.ocoa-account-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+auto/.test(styleEl?.textContent ?? ''));
check('the account switch track centers both active state and switch action',
  /\.ocoa-account-row\s*>\s*:nth-child\(3\)\s*\{\s*justify-self:\s*center/.test(styleEl?.textContent ?? ''));
check('expiry and removal cells stay anchored to their fixed tracks',
  /\.ocoa-account-row\s*>\s*:nth-child\(2\)\s*\{\s*justify-self:\s*start/.test(styleEl?.textContent ?? '')
    && /\.ocoa-account-row\s*>\s*:nth-child\(4\)\s*\{\s*justify-self:\s*end/.test(styleEl?.textContent ?? ''));
check('active account state is rendered as a span, not a button',
  /h\(\s*'span'\s*,\s*\{\s*className:\s*'ocoa-account-active'/.test(uiSource));
check('a teardown effect is registered', effects.length >= 1);

let disposeError = null;
for (const e of effects) {
  try {
    const dispose = e.fn();
    if (typeof dispose === 'function') dispose();
  } catch (err) {
    disposeError = err;
  }
}
check('teardown does not throw', disposeError === null, disposeError?.message);
check('the style element is removed on teardown', !headChildren.includes(styleEl));

/* -------------------------------------------------------- dictionary parity */

console.log('\ndictionary parity');

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

const tables = eval(`(${literalAfter(uiSource, 'const COPY = {')})`);
const base = Object.keys(tables.en);

for (const locale of Object.keys(tables)) {
  const keys = Object.keys(tables[locale]);
  const missing = base.filter((k) => !(k in tables[locale]));
  const extra = keys.filter((k) => !(k in tables.en));
  check(`${locale} has no missing keys`, missing.length === 0, missing.join(', '));
  check(`${locale} has no stray keys`, extra.length === 0, extra.join(', '));
}

for (const key of base) {
  const enVars = (String(tables.en[key]).match(/\{(\w+)\}/g) ?? []).sort().join(',');
  for (const locale of Object.keys(tables)) {
    if (locale === 'en') continue;
    const vars = (String(tables[locale][key]).match(/\{(\w+)\}/g) ?? []).sort().join(',');
    if (enVars !== vars) {
      check(`${locale}.${key} keeps the same placeholders`, false, `${enVars} vs ${vars}`);
      break;
    }
  }
}

// Every t('key') call must resolve, or the page shows a raw key name.
const used = new Set();
for (const m of uiSource.matchAll(/\bt\(\s*'([A-Za-z][\w.]*)'/g)) used.add(m[1]);
for (const m of uiSource.matchAll(/key:\s*'([A-Za-z][\w.]*)'/g)) used.add(m[1]);
for (const id of ['en', 'zh', 'zh-Hant']) used.delete(id);
const unknown = [...used].filter((k) => !(k in tables.en));
check('every translation key referenced in code exists', unknown.length === 0, unknown.join(', '));

/* --------------------------------------------------- polling stability */

// The page polls /status on a timer. If the host-provided `t` is captured as a
// useEffect dependency, and that function is identity-unstable across renders,
// the interval is torn down and rebuilt on every render — a request storm that
// looks like a hung settings page. Guard the shape that prevents it.
console.log('\npolling stability');

check('the translator is held in a ref',
  /useRef\(t\)/.test(uiSource) && /tRef\.current\s*=\s*t/.test(uiSource));
check('the fetch callback does not depend on the translator',
  /useCallback\(async[\s\S]{0,400}?\},\s*\[\s*\]\s*\)/.test(uiSource),
  'useCallback still lists a dependency that can change every render');
check('the polling effect does not depend on the translator',
  /\[load,\s*pending\]/.test(uiSource));

// The interval must actually be cleared, or a fast-polling login state would
// keep ticking after the user navigates away.
check('the polling interval is cleared on teardown',
  /clearInterval\(timer\)/.test(uiSource));

console.log(`\n${failures === 0 ? `✔ Settings tests passed (${checks} checks)` : `❌ ${failures} of ${checks} checks failed`}`);
if (failures > 0) process.exit(1);
