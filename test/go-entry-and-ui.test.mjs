/**
 * OpenCode Go 入口接點、選單防護、HTTP 路由與設定頁整合測試（全離線）。
 *
 * 驗證：
 *   1. 預設停用時，`apply()` 僅註冊一個 `opencode-next` provider，既有 OAuth 行為不變。
 *   2. 明確啟用 `goSubscription.enabled: true` 時，註冊獨立 `opencode-go-subscription` adapter；
 *      Stage 1 下 `listModels()` 固定回傳 `[]`（正式選單不出現不能推論的模型），
 *      呼叫 `prepareCall()` / `stream()` 會清楚回報 Stage 1 未支援推論。
 *   3. `GET /status`、`POST /go/refresh`、`POST /go/clear` 含 CSRF 防護且絕不外洩 key。
 *   4. 設定頁進階頁籤在繁中、簡中、英文皆正確渲染 Go 連線狀態與模型預覽，不影響既有分頁結構。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import * as entryMod from '../lib/index.js';
import { ModelCatalog } from '../lib/catalog.js';
import { TokenManager } from '../lib/token-manager.js';
import { createStatusReporter } from '../lib/status.js';
import { registerWebApi } from '../lib/web-api.js';
import { createGoService } from '../lib/go/service.js';
import { classifyGoPickerModel } from '../lib/go/catalog.js';
import { OpenCodeGoAdapter } from '../lib/go/adapter.js';

let checks = 0;
let failures = 0;
async function check(name, fn) {
  checks++;
  try {
    await fn();
    console.log(`  ok   - ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL - ${name}  (${err.message})`);
  }
}

function makeFakeCtx() {
  const record = {
    adapters: [],
    emitted: [],
    disposeHandlers: [],
    webHandler: null
  };
  const ctx = {
    llm: {
      registerAdapter(ids, adapter) {
        record.adapters.push({ ids, adapter });
      }
    },
    get() { return undefined; },
    inject(deps, fn) {
      if (Array.isArray(deps) && deps.includes('webServer')) {
        fn({
          effect: (cb) => cb(),
          webServer: {
            register(opts) { record.webHandler = opts; }
          }
        });
      }
    },
    on(event, handler) {
      if (event === 'dispose') record.disposeHandlers.push(handler);
    },
    emit(event) {
      record.emitted.push(event);
    },
    logger: { info() {}, warn() {}, error() {} }
  };
  return { ctx, record };
}

async function callRoute(registered, method, url, body = '', headers = null) {
  const res = {
    status: null,
    headers: null,
    body: null,
    writeHead(s, h) { this.status = s; this.headers = h; },
    end(b) { this.body = b; }
  };
  const req = {
    method,
    url,
    ...(headers ? { headers } : {}),
    on(event, cb) {
      if (event === 'data' && body) cb(Buffer.from(body));
      if (event === 'end') cb();
      return this;
    }
  };
  await registered.handler(req, res);
  return { status: res.status, headers: res.headers, parsed: JSON.parse(res.body) };
}

const work = mkdtempSync(path.join(tmpdir(), 'ocoa-go-entry-'));
try {
  const credentialPath = path.join(work, 'absent-token.json');
  const probeCachePath = path.join(work, 'absent-cache.json');
  const goCachePath = path.join(work, 'go-cache.json');

  console.log('--- Entry hook & Stage 1 picker guard ---');

  await check('預設設定僅註冊 opencode-next，不註冊 opencode-go-subscription', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ opencode: { models: {} } })
    });
    try {
      const { ctx, record } = makeFakeCtx();
      entryMod.apply(ctx, {
        credentialPath,
        probeCachePath,
        autoDetectModels: false,
        goSubscription: {
          enabled: false
        }
      });
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(record.adapters.length, 1);
      assert.deepEqual(record.adapters[0].ids, ['opencode-next']);
      for (const h of record.disposeHandlers) h();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await check('啟用 goSubscription 時註冊 opencode-go-subscription，且不影響 OAuth', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ opencode: { models: {} } })
    });
    try {
      const { ctx, record } = makeFakeCtx();
      entryMod.apply(ctx, {
        credentialPath,
        probeCachePath,
        autoDetectModels: false,
        goSubscription: {
          enabled: true,
          cachePath: goCachePath
        }
      });
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(record.adapters.length, 2);
      assert.deepEqual(record.adapters[0].ids, ['opencode-next']);
      assert.deepEqual(record.adapters[1].ids, ['opencode-go-subscription']);
      assert.deepEqual(record.adapters[1].adapter.providerInfo('opencode-go-subscription'), {
        id: 'opencode-go-subscription',
        name: 'OpenCode Go (Subscription)'
      });
      assert.deepEqual(await record.adapters[1].adapter.listModels('opencode-go-subscription'), []);
      for (const h of record.disposeHandlers) h();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await check('已啟用且連線驗證通過時，合格對話模型依目錄模態進入正式選單（不冒充推理）；不合格者僅作預覽', async () => {
    const secret = 'oc_go_picker_guard_secret_555';
    const goService = createGoService({
      config: { enabled: true, cachePath: null },
      env: { OPENCODE_GO_API_KEY: secret },
      fetchFn: async (url) => {
        if (url.endsWith('/usage')) {
          return {
            status: 200,
            ok: true,
            type: 'basic',
            redirected: false,
            headers: { get: () => null },
            json: async () => ({
              usage: {
                rolling: { status: 'ok', percent: 12, resetsAt: '2026-11-07T19:45:51.000Z' },
                weekly: { status: 'ok', percent: 37, resetsAt: '2026-11-09T00:00:00.000Z' },
                monthly: { status: 'ok', percent: 55, resetsAt: '2026-11-24T21:47:15.000Z' }
              }
            })
          };
        }
        return {
          status: 200,
          ok: true,
          type: 'basic',
          redirected: false,
          headers: { get: () => null },
          json: async () => ({
            data: [
              {
                id: 'glm-5',
                name: 'GLM-5',
                type: 'chat',
                limit: { context: 200000, output: 32000 },
                capabilities: { reasoning: true, tool_call: true },
                modalities: { input: ['text', 'image'], output: ['text'] }
              },
              {
                id: 'missing-type-model',
                name: 'Missing Type',
                limit: { context: 100000, output: 16000 }
              },
              {
                id: 'missing-context-model',
                name: 'Missing Context',
                type: 'chat',
                limit: { output: 16000 }
              },
              {
                id: 'missing-output-model',
                name: 'Missing Output',
                type: 'text',
                limit: { context: 100000 }
              },
              {
                id: 'legacy-retired',
                name: 'Legacy Retired',
                type: 'chat',
                limit: { context: 100000, output: 16000 },
                status: 'deprecated'
              },
              {
                id: 'text-embed-1',
                name: 'Embed 1',
                type: 'embedding',
                limit: { context: 8192, output: 1024 }
              },
              {
                id: 'responses-only-1',
                name: 'Responses Only',
                type: 'responses',
                limit: { context: 100000, output: 16000 }
              }
            ]
          })
        };
      }
    });
    const goAdapter = new OpenCodeGoAdapter(goService);
    // 連線驗證通過前：正式選單必須為空
    assert.deepEqual(await goAdapter.listModels('opencode-go-subscription'), []);

    await goService.refresh();
    // 預覽保留全部 7 筆，正式選單僅收錄 1 筆具備明確 type 與 limit 的文字模型
    assert.equal(goService.getPreviewModels().length, 7);
    const published = await goAdapter.listModels('opencode-go-subscription');
    assert.equal(published.length, 1);
    assert.equal(published[0].id, 'glm-5');
    assert.deepEqual(published[0].inputModalities, ['text', 'image']);
    assert.equal(published[0].reasoning, undefined);
    assert.deepEqual(published[0].context, { contextWindow: 200000 });
    assert.equal(published[0].defaultMaxTokens, 32000);

    // 缺 type、缺 limit 或非文字模型只留在預覽，不可被 resolveModel 當成推論目標
    for (const blockedId of [
      'missing-type-model',
      'missing-context-model',
      'missing-output-model',
      'legacy-retired',
      'text-embed-1',
      'responses-only-1'
    ]) {
      await assert.rejects(
        () => goAdapter.resolveModel('opencode-go-subscription', blockedId),
        (err) => err?.failure?.code === 'MODEL_UNAVAILABLE'
      );
    }
    // 已入選的模型可正常 prepareCall（但仍不送出無 sessionId 的請求）
    const prepared = await goAdapter.prepareCall('opencode-go-subscription', 'glm-5');
    assert.equal(prepared.model.id, 'glm-5');
    assert.equal(typeof prepared.stream, 'function');

    // OpenCodeGoAdapter.dispose() 不得釋放共用的 Go service
    goAdapter.dispose();
    assert.equal(goService.getStatus().connectionState, 'connected');
    assert.equal(goService.getPickerModels().length, 1);
    assert.ok(await goService.getInferenceContext('glm-5'));

    // 只有外掛卸載路徑呼叫 goService.dispose() 才會釋放共用服務
    goService.dispose();
    await assert.rejects(() => goService.getInferenceContext('glm-5'));
  });

  console.log('\n--- Web API routes & secret safety ---');

  await check('/status、/go/refresh、/go/clear 正確運作、具 CSRF 防護且不外洩密鑰', async () => {
    const secret = 'oc_go_webapi_secret_777888';
    const tokenManager = new TokenManager(credentialPath, path.join(work, 'accounts.json'));
    const catalog = new ModelCatalog({ probeCachePath });
    const goService = createGoService({
      config: { enabled: true, cachePath: path.join(work, 'web-go.cache.json') },
      env: { OPENCODE_GO_API_KEY: secret },
      fetchFn: async (url) => {
        const payload = url.endsWith('/usage')
          ? {
              usage: {
                rolling: { status: 'ok', percent: 12, resetsAt: '2026-11-07T19:45:51.000Z' },
                weekly: { status: 'ok', percent: 37, resetsAt: '2026-11-09T00:00:00.000Z' },
                monthly: { status: 'ok', percent: 55, resetsAt: '2026-11-24T21:47:15.000Z' }
              }
            }
          : {
              data: [
                {
                  id: 'glm-5',
                  name: 'GLM-5',
                  type: 'chat',
                  limit: { context: 200000, output: 32000 },
                  capabilities: { reasoning: true, tool_call: true },
                  modalities: { input: ['text', 'image'], output: ['text'] }
                }
              ]
            };
        return {
          status: 200,
          ok: true,
          type: 'basic',
          redirected: false,
          headers: { get: () => null },
          json: async () => payload
        };
      }
    });
    const reporter = createStatusReporter({ tokenManager, catalog, go: goService, version: '0.9.5-test' });
    let registered = null;
    let adapterUpdates = 0;
    registerWebApi(
      {
        inject(_deps, fn) {
          fn({ effect: (cb) => cb(), webServer: { register: (opts) => { registered = opts; } } });
        }
      },
      { tokenManager, catalog, statusReporter: reporter, goService, onAdaptersUpdated: () => { adapterUpdates++; } }
    );

    const crossOrigin = await callRoute(registered, 'POST', '/opencode-next/api/go/refresh', '', {
      origin: 'https://evil.example.com'
    });
    assert.equal(crossOrigin.status, 403);

    const refreshed = await callRoute(registered, 'POST', '/opencode-next/api/go/refresh');
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.parsed.ok, true);
    assert.equal(refreshed.parsed.value.go.connectionState, 'connected');
    assert.equal(refreshed.parsed.value.go.previewModels.length, 1);
    assert.equal(refreshed.parsed.value.go.pickerPublishedCount, 1);
    assert.equal(adapterUpdates, 1);
    assert.equal(JSON.stringify(refreshed.parsed).includes(secret), false);
    assert.equal(JSON.stringify(refreshed.parsed).includes(secret.slice(0, 8)), false);

    const statusRes = await callRoute(registered, 'GET', '/opencode-next/api/status');
    assert.equal(statusRes.parsed.value.go.connectionState, 'connected');
    assert.equal(JSON.stringify(statusRes.parsed).includes(secret), false);

    const cleared = await callRoute(registered, 'POST', '/opencode-next/api/go/clear');
    assert.equal(cleared.parsed.ok, true);
    assert.equal(cleared.parsed.value.go.connectionState, 'unconfigured');
    assert.deepEqual(cleared.parsed.value.go.previewModels, []);
    goService.dispose();
  });

  console.log('\n--- Settings UI Go section rendering ---');

  await check('設定頁頂部應有獨立 OpenCode Go 分頁（進階右側），且進階頁不重複顯示 Go 區塊（zh-Hant / en）', () => {
    const uiSource = readFileSync(new URL('../lib/ui.js', import.meta.url), 'utf8');
    const headChildren = [];
    let envelope = null;
    const sandbox = {
      window: {
        __ModuleLoader__: { load: (m) => { envelope = m; } },
        setInterval: () => 0, clearInterval: () => {},
        setTimeout: () => 0, clearTimeout: () => {},
        open: () => null
      },
      document: {
        head: { appendChild: (el) => headChildren.push(el), removeChild: () => {} },
        createElement: () => ({ id: '', textContent: '', parentNode: null }),
        getElementById: () => null
      },
      navigator: { language: 'zh-TW', clipboard: { writeText: async () => {} } },
      console, Intl, Date, JSON, Math, String, Number, Boolean, Array, Object, Symbol,
      RegExp, Error, Promise, isFinite,
      fetch: async () => { throw new Error('offline'); }
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(uiSource, sandbox, { filename: 'ui.js' });

    const renderTab = (locale, goStatus, tabId = 'go') => {
      const status = {
        health: 'signed-out',
        healthMessage: '',
        provider: { id: 'opencode-next', name: 'OpenCode (OAuth)' },
        version: '0.9.5-test',
        credential: { present: false, source: null },
        models: { total: 0, probed: 0, available: 0, models: [] },
        config: { autoDetectModels: true, probeIntervalMs: 21600000, catalogPollMs: 900000, imagePixelBudget: 640000, imageMaxBytes: 2097152 },
        fallback: { enabled: false, models: [], maxModels: 3 },
        autoSwitch: { enabled: false },
        bun: { installed: false, enabled: false },
        anonymousChannel: { enabled: false },
        accounts: [],
        go: goStatus,
        systemLocale: locale === 'en' ? 'en-US' : locale === 'zh' ? 'zh-CN' : 'zh-TW',
        generatedAt: Date.now()
      };
      const seeds = ['auto', status, '', null, '', true, tabId, null, null, '', true];
      let idx = 0;
      const React = {
        createElement(type, props, ...children) {
          const flat = [];
          const push = (c) => {
            if (c === null || c === undefined || c === false || c === true) return;
            if (Array.isArray(c)) { c.forEach(push); return; }
            flat.push(c);
          };
          children.forEach(push);
          if (typeof type === 'function') {
            return type({ ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat });
          }
          return { type, props: props ?? {}, children: flat };
        },
        useState(init) {
          const v = seeds[idx] === undefined ? init : seeds[idx];
          idx++;
          return [v, () => {}];
        },
        useRef: (v) => ({ current: v }),
        useMemo: (fn) => fn(),
        useCallback: (fn) => fn,
        useEffect: () => {}
      };
      const plugin = envelope.factory((n) => {
        if (n === 'react') return React;
        throw new Error(`unexpected require: ${n}`);
      });
      let section = null;
      plugin.apply({
        effect: () => {},
        locale: { addLanguage: () => {}, register: () => {} },
        slots: { inject: (_n, fn) => fn(), register: (_m, render) => { section = render; } }
      });
      const tree = section({});
      const texts = [];
      const tabIds = [];
      const classes = [];
      const walk = (n) => {
        if (n === null || n === undefined) return;
        if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return; }
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (typeof n === 'object') {
          if (n.props?.role === 'tab' && n.props?.['data-tab']) tabIds.push(n.props['data-tab']);
          if (n.props?.className) classes.push(String(n.props.className));
          walk(n.children);
        }
      };
      walk(tree);
      return { text: texts.join('\n'), tabIds, classes };
    };

    const connectedGo = {
      enabled: true,
      providerId: 'opencode-go-subscription',
      providerName: 'OpenCode Go (Subscription)',
      connectionState: 'connected',
      inferenceSupported: true,
      pickerPublishedCount: 1,
      credential: { present: true, source: 'env', ref: 'OPENCODE_GO_API_KEY', masked: '••••' },
      usage: {
        entitled: true,
        windows: {
          rolling: { status: 'ok', percent: 12, resetsAt: '2026-11-07T19:45:51.000Z' },
          weekly: { status: 'ok', percent: 37, resetsAt: '2026-11-09T00:00:00.000Z' },
          monthly: { status: 'ok', percent: 55, resetsAt: '2026-11-24T21:47:15.000Z' }
        }
      },
      previewModels: [
        {
          id: 'glm-5',
          name: 'GLM-5',
          type: 'chat',
          limit: { context: 200000, output: 32000, input: null },
          capabilities: { reasoning: true, toolCall: true, attachment: false },
          modalities: { input: ['text', 'image'], output: ['text'] },
          pickerEligible: true,
          pickerPublished: true,
          pickerReasons: []
        }
      ],
      checkedAt: Date.now(),
      error: null
    };

    // 頂部分頁列：go 緊接在進階（advanced）右側
    const advRendered = renderTab('zh-Hant', connectedGo, 'advanced');
    assert.deepEqual(advRendered.tabIds, ['account', 'models', 'advanced', 'go']);
    // 進階頁不得重複出現 Go 區塊、Go 用量或 Go 表格
    assert.equal(advRendered.text.includes('opencode-go-subscription'), false);
    assert.equal(advRendered.text.includes('Extra Usage'), false);
    assert.equal(advRendered.text.includes('glm-5'), false);
    assert.equal(advRendered.classes.some((c) => c.includes('ocoa-go-section')), false);

    // 切到 OpenCode Go 分頁才渲染完整 Go 訂閱頁面
    const hantGo = renderTab('zh-Hant', connectedGo, 'go');
    const hantText = hantGo.text;
    assert.ok(hantText.includes('OpenCode Go'));
    assert.ok(hantText.includes('已連線'));
    assert.ok(hantText.includes('12%'));
    assert.ok(hantText.includes('37%'));
    assert.ok(hantText.includes('55%'));
    assert.ok(hantText.includes('5h Limit'));
    assert.ok(hantText.includes('7D Limit'));
    assert.ok(hantText.includes('1M Limit'));
    assert.ok(hantText.includes('GLM-5'));
    assert.ok(hantText.includes('金鑰'));
    assert.equal(hantText.includes('«MISSING:'), false);

    const enGo = renderTab('en', connectedGo, 'go');
    const enText = enGo.text;
    assert.ok(enText.includes('OpenCode Go'));
    assert.ok(enText.includes('Connected'));
    assert.ok(enText.includes('12%'));
    assert.ok(enText.includes('37%'));
    assert.ok(enText.includes('55%'));
    assert.ok(enText.includes('GLM-5'));
    assert.equal(enText.includes('«MISSING:'), false);
    const LANG_SELF = new Set(['繁', '\u7b80', '\u7b80\u4f53\u4e2d\u6587', '繁體中文']);
    const nonLangHan = enText.split('\n').filter((line) => /[\u4e00-\u9fff]/.test(line) && !LANG_SELF.has(line));
    assert.deepEqual(nonLangHan, []);
  });

  console.log('\n--- HTTP routes: /go/credential save, clear & fail-closed UI ---');

  await check('POST /go/credential 與清除路由使用 DSH 憑證服務、優先於環境變數、不送上游請求且不外洩 key', async () => {
    const store = new Map();
    const ops = [];
    let fetchCalls = 0;
    const goCredWork = mkdtempSync(path.join(work, 'cred-route-'));
    const fakeCredCtx = {
      credentials: {
        async resolve(ref) {
          ops.push(['resolve', ref]);
          return store.has(ref) ? { value: store.get(ref) } : null;
        },
        async set(ref, value) {
          ops.push(['set', ref]);
          store.set(ref, value);
        },
        async unset(ref) {
          ops.push(['unset', ref]);
          store.delete(ref);
        },
        async describe(ref) {
          ops.push(['describe', ref]);
          return { present: store.has(ref), ref };
        }
      }
    };

    const { ctx: webCtx, record } = makeFakeCtx();
    const tokenManager = new TokenManager({
      credentialPath,
      clientId: 'test-client-id',
      oauthOrigin: 'http://localhost',
      log: () => {}
    });
    const catalog = new ModelCatalog({
      cachePath: probeCachePath,
      tokenManager,
      log: () => {}
    });
    const envWithFallback = { OPENCODE_GO_API_KEY: 'oc_go_env_fallback_99990000' };
    const goService = createGoService({
      ctx: fakeCredCtx,
      config: { enabled: true, cachePath: path.join(goCredWork, 'go-cache.json') },
      version: '0.9.5',
      env: envWithFallback,
      fetchFn: async () => {
        fetchCalls++;
        throw new Error('must not call upstream on credential save/clear');
      }
    });
    const statusReporter = createStatusReporter({
      tokenManager,
      catalog,
      go: goService,
      config: { goEnabled: true },
      version: '0.9.5'
    });
    registerWebApi(webCtx, {
      tokenManager,
      catalog,
      statusReporter,
      goService,
      config: { goEnabled: true }
    });

    // CSRF 防護：跨站請求必須回 403 且不可寫入憑證
    const csrfSave = await callRoute(
      record.webHandler,
      'POST',
      '/opencode-next/api/go/credential',
      JSON.stringify({ key: 'oc_go_evil_key_000' }),
      { host: '127.0.0.1:5140', origin: 'https://evil.example' }
    );
    assert.equal(csrfSave.status, 403);
    assert.equal(store.size, 0);

    // 拒絕 OAuth st_* token
    const badToken = 'st_oauth_secret_must_be_rejected_8888';
    const rejectOauth = await callRoute(
      record.webHandler,
      'POST',
      '/opencode-next/api/go/credential',
      JSON.stringify({ key: badToken })
    );
    assert.equal(rejectOauth.status, 200);
    assert.equal(rejectOauth.parsed.ok, false);
    assert.equal(rejectOauth.parsed.error, 'invalid_credential_type');
    assert.equal(JSON.stringify(rejectOauth.parsed).includes(badToken), false);
    assert.equal(store.size, 0);

    // 儲存有效 key：必須透過 DSH credentials.set，優先於環境變數，且狀態完全不外洩明文
    const savedKey = 'oc_go_saved_from_settings_ui_77665544';
    const saveRes = await callRoute(
      record.webHandler,
      'POST',
      '/opencode-next/api/go/credential',
      JSON.stringify({ key: savedKey })
    );
    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.parsed.ok, true);
    assert.equal(store.get('OPENCODE_GO_API_KEY'), savedKey);
    assert.equal(fetchCalls, 0);

    const statusAfterSave = await callRoute(record.webHandler, 'GET', '/opencode-next/api/status');
    const serializedStatus = JSON.stringify(statusAfterSave.parsed);
    assert.equal(statusAfterSave.parsed.value.go.credential.present, true);
    assert.equal(statusAfterSave.parsed.value.go.credential.source, 'dsh-credentials');
    assert.equal(statusAfterSave.parsed.value.go.credential.canSave, true);
    assert.equal(statusAfterSave.parsed.value.go.credential.canClear, true);
    assert.equal(serializedStatus.includes(savedKey), false);
    assert.equal(serializedStatus.includes('77665544'), false);
    assert.equal(serializedStatus.includes('oc_go_'), false);

    // 清除 key：呼叫 unset 後應退回環境變數（若存在），仍不打上游 HTTP
    const clearRes = await callRoute(
      record.webHandler,
      'POST',
      '/opencode-next/api/go/credential/clear',
      '{}'
    );
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.parsed.ok, true);
    assert.equal(store.has('OPENCODE_GO_API_KEY'), false);
    assert.equal(clearRes.parsed.value.go.credential.present, true);
    assert.equal(clearRes.parsed.value.go.credential.source, 'env');
    assert.equal(fetchCalls, 0);

    // 確認整個過程沒有把 key 寫進任何本機檔案
    const entries = readdirSync(goCredWork);
    assert.deepEqual(entries, []);
    assert.ok(ops.some(([op, ref]) => op === 'set' && ref === 'OPENCODE_GO_API_KEY'));
    assert.ok(ops.some(([op, ref]) => op === 'unset' && ref === 'OPENCODE_GO_API_KEY'));
  });

  await check('缺少 credentials.set 時 POST /go/credential 失敗但不寫盤、不外洩 key', async () => {
    const noSetWork = mkdtempSync(path.join(work, 'no-set-'));
    const readOnlyCtx = {
      credentials: {
        async resolve() { return null; }
      }
    };
    const { ctx: webCtx, record } = makeFakeCtx();
    const tokenManager = new TokenManager({
      credentialPath,
      clientId: 'test-client-id',
      oauthOrigin: 'http://localhost',
      log: () => {}
    });
    const catalog = new ModelCatalog({
      cachePath: probeCachePath,
      tokenManager,
      log: () => {}
    });
    const goService = createGoService({
      ctx: readOnlyCtx,
      config: { enabled: false, cachePath: path.join(noSetWork, 'go-cache.json') },
      version: '0.9.5',
      env: {}
    });
    const statusReporter = createStatusReporter({
      tokenManager,
      catalog,
      go: goService,
      config: { goEnabled: false },
      version: '0.9.5'
    });
    registerWebApi(webCtx, {
      tokenManager,
      catalog,
      statusReporter,
      goService,
      config: { goEnabled: false }
    });

    const unsavedKey = 'oc_go_must_not_touch_disk_334455';
    const res = await callRoute(
      record.webHandler,
      'POST',
      '/opencode-next/api/go/credential',
      JSON.stringify({ key: unsavedKey })
    );
    assert.equal(res.status, 200);
    assert.equal(res.parsed.ok, false);
    assert.equal(res.parsed.error, 'credentials_write_unavailable');
    assert.equal(res.parsed.value.go.credential.canSave, false);
    assert.equal(res.parsed.value.go.credential.present, false);
    assert.equal(JSON.stringify(res.parsed).includes(unsavedKey), false);
    assert.deepEqual(readdirSync(noSetWork), []);
  });

  await check('設定頁 OpenCode Go key 欄位僅用密碼欄（不預填明文）、顯示已儲存／未設定與不可用狀態', () => {
    const uiSrc = readFileSync(new URL('../lib/ui.js', import.meta.url), 'utf8');
    const renderNodes = (lang, go) => {
      const headChildren = [];
      let envelope = null;
      const sandbox = {
        window: {
          __ModuleLoader__: { load: (m) => { envelope = m; } },
          setInterval: () => 0, clearInterval: () => {},
          setTimeout: () => 0, clearTimeout: () => {},
          open: () => null
        },
        document: {
          head: { appendChild: (el) => headChildren.push(el), removeChild: () => {} },
          createElement: () => ({ id: '', textContent: '', parentNode: null }),
          getElementById: () => null
        },
        navigator: { language: 'zh-TW', clipboard: { writeText: async () => {} } },
        console, Intl, Date, JSON, Math, String, Number, Boolean, Array, Object, Symbol,
        RegExp, Error, Promise, isFinite,
        fetch: async () => { throw new Error('offline'); }
      };
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(uiSrc, sandbox, { filename: 'ui.js' });

      const fakeStatus = {
        health: 'signed-out',
        healthMessage: '',
        provider: { id: 'opencode-next', name: 'OpenCode (OAuth)' },
        version: '0.9.5-test',
        credential: { present: false, source: null },
        models: { total: 0, probed: 0, available: 0, models: [] },
        config: { autoDetectModels: true, probeIntervalMs: 21600000, catalogPollMs: 900000, imagePixelBudget: 640000, imageMaxBytes: 2097152 },
        fallback: { enabled: false, models: [], maxModels: 3 },
        autoSwitch: { enabled: false },
        bun: { installed: false, enabled: false },
        anonymousChannel: { enabled: false },
        accounts: [],
        go,
        systemLocale: lang === 'en' ? 'en-US' : lang === 'zh' ? 'zh-CN' : 'zh-TW',
        generatedAt: Date.now()
      };
      const seeds = ['auto', fakeStatus, '', null, '', true, 'go', null, null, '', true];
      let idx = 0;
      const React = {
        createElement(type, props, ...children) {
          const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true);
          if (typeof type === 'function') {
            return type({ ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat });
          }
          return { type, props: props ?? {}, children: flat };
        },
        useState(init) {
          const v = seeds[idx] === undefined ? init : seeds[idx];
          idx++;
          return [v, () => {}];
        },
        useRef: (v) => ({ current: v }),
        useMemo: (fn) => fn(),
        useCallback: (fn) => fn,
        useEffect: () => {}
      };
      const plugin = envelope.factory((n) => {
        if (n === 'react') return React;
        throw new Error(`unexpected require: ${n}`);
      });
      let section = null;
      plugin.apply({
        effect: () => {},
        locale: { addLanguage: () => {}, register: () => {} },
        slots: { inject: (_n, fn) => fn(), register: (_m, render) => { section = render; } }
      });
      const tree = section({});
      const inputs = [];
      const buttons = [];
      const texts = [];
      const walk = (n) => {
        if (n === null || n === undefined) return;
        if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return; }
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (typeof n === 'object') {
          if (n.type === 'input') inputs.push(n);
          if (n.type === 'button') buttons.push(n);
          walk(n.children);
        }
      };
      walk(tree);
      return { inputs, buttons, text: texts.join('\n') };
    };

    const savedTree = renderNodes('zh-Hant', {
      enabled: true,
      providerId: 'opencode-go-subscription',
      connectionState: 'connected',
      credential: { present: true, source: 'dsh-credentials', ref: 'OPENCODE_GO_API_KEY', canSave: true, canClear: true },
      previewModels: [],
      checkedAt: null,
      error: null
    });
    const drawerBtnSaved = savedTree.buttons.find((b) => (b.children || []).includes('金鑰'));
    assert.ok(drawerBtnSaved);
    assert.equal(drawerBtnSaved.props.disabled, false);
    assert.equal(drawerBtnSaved.props['aria-expanded'], false);
    assert.equal(savedTree.inputs.some((el) => el.props?.type === 'password'), false);

    const noWriteTree = renderNodes('zh-Hant', {
      enabled: false,
      providerId: 'opencode-go-subscription',
      connectionState: 'disabled',
      credential: { present: false, source: null, ref: 'OPENCODE_GO_API_KEY', canSave: false, canClear: false },
      previewModels: [],
      checkedAt: null,
      error: null
    });
    const pwInputNoWrite = noWriteTree.inputs.find((el) => el.props?.type === 'password');
    assert.ok(pwInputNoWrite);
    assert.equal(pwInputNoWrite.props.disabled, true);
    assert.ok(noWriteTree.text.includes('未設定'));
    assert.ok(noWriteTree.text.includes('credentials.set'));
    const saveBtnNoWrite = noWriteTree.buttons.find((b) => (b.children || []).includes('儲存'));
    assert.ok(saveBtnNoWrite);
    assert.equal(saveBtnNoWrite.props.disabled, true);
  });

  await check('OpenCode Go 模型清單表格：共用視覺結構、分類篩選、搜尋、展開詳情、收合與禁止偽造探測／延遲', () => {
    const uiSrc = readFileSync(new URL('../lib/ui.js', import.meta.url), 'utf8');
    const sampleModels = [
      {
        id: 'glm-5',
        name: 'GLM-5',
        type: 'chat',
        status: 'active',
        ownedBy: 'zhipu',
        limit: { context: 200000, output: 32000, input: 168000 },
        capabilities: { reasoning: true, toolCall: true, attachment: false },
        modalities: { input: ['text', 'image'], output: ['text'] }
      },
      {
        id: 'go-no-type',
        name: 'No Type Model',
        type: null,
        limit: { context: 128000, output: 8192, input: null },
        capabilities: { reasoning: false, toolCall: false, attachment: false },
        modalities: { input: ['text'], output: ['text'] }
      },
      {
        id: 'go-no-limit',
        name: 'No Limit Model',
        type: 'chat',
        limit: { context: null, output: 8192, input: null },
        capabilities: { reasoning: false, toolCall: true, attachment: false },
        modalities: { input: ['text'], output: ['text'] }
      },
      {
        id: 'go-responses-only',
        name: 'Responses Protocol',
        type: 'responses',
        limit: { context: 128000, output: 16000, input: null },
        capabilities: { reasoning: true, toolCall: true, attachment: false },
        modalities: { input: ['text'], output: ['text'] }
      },
      {
        id: 'go-deprecated',
        name: 'Retired Model',
        type: 'chat',
        status: 'deprecated',
        limit: { context: 64000, output: 4096, input: null },
        capabilities: { reasoning: false, toolCall: false, attachment: false },
        modalities: { input: ['text'], output: ['text'] }
      },
      {
        id: 'go-image-only',
        name: 'Image Only Model',
        type: 'chat',
        limit: { context: 32000, output: 2048, input: null },
        capabilities: { reasoning: false, toolCall: false, attachment: true },
        modalities: { input: ['image'], output: ['image'] }
      },
      { id: 'go-extra-1', name: 'Go Extra 1', type: 'chat', limit: { context: 64000, output: 4096 }, capabilities: { reasoning: false, toolCall: true, attachment: false }, modalities: { input: ['text'], output: ['text'] } },
      { id: 'go-extra-2', name: 'Go Extra 2', type: 'chat', limit: { context: 64000, output: 4096 }, capabilities: { reasoning: false, toolCall: false, attachment: false }, modalities: { input: ['text'], output: ['text'] } },
      { id: 'go-extra-3', name: 'Go Extra 3', type: 'chat', limit: { context: 64000, output: 4096 }, capabilities: { reasoning: true, toolCall: false, attachment: false }, modalities: { input: ['text'], output: ['text'] } },
      { id: 'go-extra-4', name: 'Go Extra 4', type: 'chat', limit: { context: 64000, output: 4096 }, capabilities: { reasoning: false, toolCall: false, attachment: false }, modalities: { input: ['text'], output: ['text'] } }
    ];

    const annotateFor = (list, connected) => list.map((m) => {
      const cls = classifyGoPickerModel(m);
      return {
        ...m,
        pickerEligible: cls.eligible,
        pickerPublished: Boolean(connected && cls.eligible),
        pickerReasons: cls.reasons
      };
    });

    const mountInteractive = (locale, previewModels, { connectionState = 'connected', enabled = true } = {}) => {
      let envelope = null;
      const sandbox = {
        window: {
          __ModuleLoader__: { load: (m) => { envelope = m; } },
          setInterval: () => 0, clearInterval: () => {},
          setTimeout: () => 0, clearTimeout: () => {},
          open: () => null
        },
        document: {
          head: { appendChild: () => {}, removeChild: () => {} },
          createElement: () => ({ id: '', textContent: '', parentNode: null }),
          getElementById: () => null
        },
        navigator: { language: 'zh-TW', clipboard: { writeText: async () => {} } },
        console, Intl, Date, JSON, Math, String, Number, Boolean, Array, Object, Symbol,
        RegExp, Error, Promise, isFinite,
        fetch: async () => { throw new Error('offline'); }
      };
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(uiSrc, sandbox, { filename: 'ui.js' });

      const fakeStatus = {
        health: 'signed-out',
        healthMessage: '',
        provider: { id: 'opencode-next', name: 'OpenCode (OAuth)' },
        version: '0.9.5-test',
        credential: { present: false, source: null },
        models: { total: 0, probed: 0, available: 0, models: [] },
        config: { autoDetectModels: true, probeIntervalMs: 21600000, catalogPollMs: 900000, imagePixelBudget: 640000, imageMaxBytes: 2097152 },
        fallback: { enabled: false, models: [], maxModels: 3 },
        autoSwitch: { enabled: false },
        bun: { installed: false, enabled: false },
        anonymousChannel: { enabled: false },
        accounts: [],
        go: {
          enabled,
          providerId: 'opencode-go-subscription',
          providerName: 'OpenCode Go (Subscription)',
          connectionState,
          inferenceSupported: true,
          pickerPublishedCount: previewModels.filter((m) => m.pickerPublished).length,
          credential: { present: true, source: 'env', ref: 'OPENCODE_GO_API_KEY', canSave: false, canClear: false },
          usage: null,
          previewModels,
          checkedAt: Date.now(),
          error: null
        },
        systemLocale: locale === 'en' ? 'en-US' : locale === 'zh' ? 'zh-CN' : 'zh-TW',
        generatedAt: Date.now()
      };

      const initialSeeds = ['auto', fakeStatus, '', null, '', true, 'go', null, null, '', true];
      const states = [];
      let hookIdx = 0;

      const React = {
        createElement(type, props, ...children) {
          const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true);
          if (typeof type === 'function') {
            return type({ ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat });
          }
          return { type, props: props ?? {}, children: flat };
        },
        useState(init) {
          const i = hookIdx++;
          if (!(i in states)) {
            if (initialSeeds[i] !== undefined) states[i] = initialSeeds[i];
            else states[i] = typeof init === 'function' ? init() : init;
          }
          const setter = (next) => {
            states[i] = typeof next === 'function' ? next(states[i]) : next;
          };
          return [states[i], setter];
        },
        useRef: (v) => ({ current: v }),
        useMemo: (fn) => fn(),
        useCallback: (fn) => fn,
        useEffect: () => {}
      };

      const plugin = envelope.factory((n) => {
        if (n === 'react') return React;
        throw new Error(`unexpected require: ${n}`);
      });
      let section = null;
      plugin.apply({
        effect: () => {},
        locale: { addLanguage: () => {}, register: () => {} },
        slots: { inject: (_n, fn) => fn(), register: (_m, render) => { section = render; } }
      });

      const inspect = () => {
        hookIdx = 0;
        const tree = section({});
        const elements = [];
        const texts = [];
        const walk = (n) => {
          if (n === null || n === undefined) return;
          if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return; }
          if (Array.isArray(n)) { n.forEach(walk); return; }
          if (typeof n === 'object') {
            elements.push(n);
            walk(n.children);
          }
        };
        walk(tree);
        const textOf = (node) => {
          const buf = [];
          const w = (x) => {
            if (x === null || x === undefined) return;
            if (typeof x === 'string' || typeof x === 'number') { buf.push(String(x)); return; }
            if (Array.isArray(x)) { x.forEach(w); return; }
            if (typeof x === 'object') w(x.children);
          };
          w(node);
          return buf.join(' ');
        };
        return { elements, text: texts.join('\n'), textOf };
      };

      return { inspect };
    };

    const collectSubtree = (root) => {
      const subElements = [];
      const walkSub = (n) => {
        if (n === null || n === undefined) return;
        if (Array.isArray(n)) { n.forEach(walkSub); return; }
        if (typeof n === 'object') {
          subElements.push(n);
          walkSub(n.children);
        }
      };
      walkSub(root);
      return subElements;
    };

    const app = mountInteractive('zh-Hant', annotateFor(sampleModels, true));
    let snap = app.inspect();

    // 1. 共用視覺語言：分段控制、搜尋框、表格、徽章，且 Go 清單區塊不含勾選框、延遲欄、context 編輯器或備援
    const goCatalog = snap.elements.find((e) => String(e.props?.className || '').includes('ocoa-go-catalog'));
    assert.ok(goCatalog, '應渲染 ocoa-go-catalog');
    const goCatalogEls = collectSubtree(goCatalog);
    const goCatalogText = snap.textOf(goCatalog);
    const goScrollWrap = goCatalogEls.find((e) => String(e.props?.className || '').includes('ocoa-go-table-scroll'));
    assert.ok(goScrollWrap, '應渲染 ocoa-go-table-scroll 水平捲動包裹層');
    const goTable = goCatalogEls.find((e) => e.type === 'table' && String(e.props?.className || '').includes('ocoa-go-table'));
    assert.ok(goTable, '應渲染 ocoa-table ocoa-go-table');
    assert.ok(String(goTable.props.className).includes('ocoa-table'));
    assert.equal(goCatalogEls.some((e) => e.type === 'input' && e.props?.type === 'checkbox'), true, 'Go 表格應包含顯示勾選框');
    assert.equal(goCatalogEls.some((e) => String(e.props?.className || '').includes('ocoa-context-editor')), false, 'Go 表格不得有 context 編輯器');
    assert.equal(goCatalogEls.some((e) => String(e.props?.className || '').includes('ocoa-context-btn')), false, 'Go 表格不得有 context 編輯按鈕');
    assert.equal(goCatalogEls.some((e) => String(e.props?.className || '').includes('ocoa-fallback-select')), false, 'Go 表格不得偽造備援欄位');

    const headers = goCatalogEls.filter((e) => e.type === 'th').map((th) => snap.textOf(th));
    assert.deepEqual(headers, ['顯示', '模型', '上下文', '輸出上限']);
    assert.equal(headers.some((h) => h.includes('延遲') || h.includes('ms')), false, '不得出現假的延遲欄位');
    assert.equal(/\d+\s*ms\b/.test(goCatalogText), false, '不得渲染假的 ms 延遲數值');

    // 2. 分類分段數量與動態計算：10 筆中 5 筆可用於選單、5 筆僅預覽
    const segButtons = snap.elements.filter((e) => e.type === 'button' && e.props?.['data-go-filter']);
    assert.equal(segButtons.length, 3);
    assert.ok(snap.textOf(segButtons[0]).includes('10'));
    assert.ok(snap.textOf(segButtons[0]).includes('全部'));
    assert.ok(snap.textOf(segButtons[1]).includes('5'));
    assert.ok(snap.textOf(segButtons[1]).includes('可用於選單'));
    assert.ok(snap.textOf(segButtons[2]).includes('5'));
    assert.ok(snap.textOf(segButtons[2]).includes('僅預覽'));

    // 3. 預設收合 8 列並顯示「顯示其餘 2 個（共 10 個）」按鈕
    let modelRows = snap.elements.filter((e) => e.type === 'tr' && String(e.props?.className || '').includes('ocoa-model-row'));
    assert.equal(modelRows.length, 8);
    const showAllBtn = snap.elements.find((e) => e.type === 'button' && snap.textOf(e).includes('顯示其餘 2 個'));
    assert.ok(showAllBtn);
    showAllBtn.props.onClick();
    snap = app.inspect();
    modelRows = snap.elements.filter((e) => e.type === 'tr' && String(e.props?.className || '').includes('ocoa-model-row'));
    assert.equal(modelRows.length, 10);

    // 4. 確認「僅預覽」模型絕對不會被標成「已進入選單」
    for (const previewId of ['go-no-type', 'go-no-limit', 'go-responses-only', 'go-deprecated', 'go-image-only']) {
      const row = modelRows.find((r) => collectSubtree(r).some((e) => e.type === 'input' && e.props?.['aria-label'] === previewId));
      assert.ok(row, `找不到僅預覽列 ${previewId}`);
      const rowText = snap.textOf(row);
      assert.ok(rowText.includes('僅預覽'), `${previewId} 必須標為僅預覽`);
      assert.equal(rowText.includes('已進入選單'), false, `${previewId} 不得標為已進入選單`);
    }

    // 5. 切換「僅預覽」分段篩選與搜尋框，並點開列驗證展開詳情
    const previewSeg = snap.elements.find((e) => e.type === 'button' && e.props?.['data-go-filter'] === 'preview');
    previewSeg.props.onClick();
    snap = app.inspect();
    modelRows = snap.elements.filter((e) => e.type === 'tr' && String(e.props?.className || '').includes('ocoa-model-row'));
    assert.equal(modelRows.length, 5);
    assert.equal(modelRows.some((r) => snap.textOf(r).includes('已進入選單')), false);

    const searchInput = collectSubtree(snap.elements.find((e) => String(e.props?.className || '').includes('ocoa-go-catalog')))
      .find((e) => e.type === 'input' && e.props?.type === 'search');
    assert.ok(searchInput);
    searchInput.props.onChange({ target: { value: 'responses' } });
    snap = app.inspect();
    modelRows = snap.elements.filter((e) => e.type === 'tr' && String(e.props?.className || '').includes('ocoa-model-row'));
    assert.equal(modelRows.length, 1);
    assert.ok(collectSubtree(modelRows[0]).some((e) => e.type === 'input' && e.props?.['aria-label'] === 'go-responses-only'));

    // 展開 go-responses-only 看原因詳情
    const toggleBtn = snap.elements.find((e) => e.type === 'button' && String(e.props?.className || '').includes('ocoa-go-model-btn'));
    assert.ok(toggleBtn);
    toggleBtn.props.onClick({ stopPropagation() {} });
    snap = app.inspect();
    const expandRow = snap.elements.find((e) => e.type === 'tr' && String(e.props?.className || '').includes('ocoa-model-expand'));
    assert.ok(expandRow, '點擊後應出現 ocoa-model-expand 展開列');
    assert.ok(snap.textOf(expandRow).includes('non-chat') || snap.textOf(expandRow).includes('非對話類型 (responses)'));

    // 切回「可用於選單」並清空搜尋，展開 glm-5 看詳細資訊與能力標籤
    searchInput.props.onChange({ target: { value: '' } });
    const pickerSeg = snap.elements.find((e) => e.type === 'button' && e.props?.['data-go-filter'] === 'picker');
    pickerSeg.props.onClick();
    snap = app.inspect();
    modelRows = snap.elements.filter((e) => e.type === 'tr' && String(e.props?.className || '').includes('ocoa-model-row'));
    assert.equal(modelRows.length, 5);
    const glmBtn = snap.elements.find((e) => e.type === 'button' && String(e.props?.className || '').includes('ocoa-go-model-btn') && snap.textOf(e).includes('GLM-5'));
    assert.ok(glmBtn);
    const glmConnectedRow = modelRows.find((r) => collectSubtree(r).some((e) => e.type === 'input' && e.props?.['aria-label'] === 'glm-5'));
    assert.ok(glmConnectedRow);
    const glmCheckbox = collectSubtree(glmConnectedRow).find((e) => e.type === 'input' && e.props?.type === 'checkbox');
    assert.equal(glmCheckbox?.props?.checked, true);
    assert.equal(glmCheckbox?.props?.disabled, false);
    assert.equal(snap.textOf(glmConnectedRow).includes('僅預覽'), false);
    glmBtn.props.onClick({ stopPropagation() {} });
    snap = app.inspect();
    const glmExpand = snap.elements.find((e) => e.type === 'tr' && String(e.props?.className || '').includes('ocoa-model-expand'));
    assert.ok(glmExpand);
    const glmExpandText = snap.textOf(glmExpand);
    assert.ok(glmExpandText.includes('200,000'));
    assert.ok(glmExpandText.includes('32,000'));
    assert.ok(glmExpandText.includes('168,000'));
    assert.ok(glmExpandText.includes('zhipu'));
    assert.ok(glmExpandText.includes('無即時探測或延遲測量'));
    assert.ok(glmExpandText.includes('本外掛實際支援：僅文字對話與工具呼叫'));
    assert.ok(glmExpandText.includes('目錄宣告：'));

    // 確認上游宣告圖片模態的模型（例如新模型或 hy4-flash-free）在展開列清楚顯示自動支援圖片的「本外掛實際支援」說明
    const hy4Models = annotateFor([
      {
        id: 'hy4-flash-free',
        name: 'HY4 Flash Free',
        type: 'chat',
        status: 'active',
        limit: { context: 200000, output: 16384 },
        capabilities: { reasoning: true, toolCall: true, attachment: false },
        modalities: { input: ['text', 'image/png', 'image/jpeg'], output: ['text'] }
      }
    ], true).map((m) => ({ ...m, pickerImageSupported: m.id === 'hy4-flash-free' }));
    const hy4App = mountInteractive('zh-Hant', hy4Models);
    let hy4Snap = hy4App.inspect();
    const hy4Btn = hy4Snap.elements.find((e) => e.type === 'button' && String(e.props?.className || '').includes('ocoa-go-model-btn') && hy4Snap.textOf(e).includes('HY4 Flash Free'));
    assert.ok(hy4Btn);
    hy4Btn.props.onClick({ stopPropagation() {} });
    hy4Snap = hy4App.inspect();
    const hy4Expand = hy4Snap.elements.find((e) => e.type === 'tr' && String(e.props?.className || '').includes('ocoa-model-expand'));
    assert.ok(hy4Expand);
    assert.ok(hy4Snap.textOf(hy4Expand).includes('本外掛實際支援：文字對話、工具呼叫與圖片輸入（依上游目錄 image 宣告自動開放'));

    // 6. 未連線回歸測試：enabled: true 但 connectionState 為 transient-error，且目錄仍帶有舊的 pickerEligible: true 與過期 pickerPublished: true
    //    不得先將 pickerPublished 清成 false，確保前端收到過期標記時仍不誤報「已進入選單」
    const stalePublishedModels = annotateFor(sampleModels, true);
    assert.equal(stalePublishedModels.find((m) => m.id === 'glm-5')?.pickerEligible, true);
    assert.equal(stalePublishedModels.find((m) => m.id === 'glm-5')?.pickerPublished, true);

    const disconnectedApp = mountInteractive('zh-Hant', stalePublishedModels, {
      connectionState: 'transient-error',
      enabled: true
    });
    const disconnectedSnap = disconnectedApp.inspect();
    const discSegs = disconnectedSnap.elements.filter((e) => e.type === 'button' && e.props?.['data-go-filter']);
    assert.ok(disconnectedSnap.textOf(discSegs[1]).includes('0'));
    assert.ok(disconnectedSnap.textOf(discSegs[1]).includes('可用於選單'));
    assert.ok(disconnectedSnap.textOf(discSegs[2]).includes('10'));
    assert.ok(disconnectedSnap.textOf(discSegs[2]).includes('僅預覽'));

    const discCatalog = disconnectedSnap.elements.find((e) => String(e.props?.className || '').includes('ocoa-go-catalog'));
    const discRows = collectSubtree(discCatalog).filter((e) => e.type === 'tr' && String(e.props?.className || '').includes('ocoa-model-row'));
    const glmStaleRow = discRows.find((r) => collectSubtree(r).some((e) => e.type === 'input' && e.props?.['aria-label'] === 'glm-5'));
    assert.ok(glmStaleRow, '未連線時 glm-5 仍應留在目錄預覽清單中');
    const glmStaleRowText = disconnectedSnap.textOf(glmStaleRow);
    const glmStaleCheckbox = collectSubtree(glmStaleRow).find((e) => e.type === 'input' && e.props?.type === 'checkbox');
    assert.equal(glmStaleCheckbox?.props?.checked, false);
    assert.equal(glmStaleCheckbox?.props?.disabled, true);
    assert.ok(glmStaleRowText.includes('僅預覽'));
    assert.equal(glmStaleRowText.includes('已進入選單'), false);

    const discCatalogText = disconnectedSnap.textOf(discCatalog);
    assert.equal(discCatalogText.includes('已進入選單'), false);
    assert.ok(String(glmStaleCheckbox?.props?.title || '').includes('訂閱未連線'));

    // 7. 英文語系下無缺鍵、無中文字滲漏
    const enApp = mountInteractive('en', annotateFor(sampleModels.slice(0, 3), true));
    const enSnap = enApp.inspect();
    assert.equal(enSnap.text.includes('«MISSING:'), false);
    assert.ok(enSnap.text.includes('In picker'));
    assert.ok(enSnap.text.includes('Preview only'));
    const LANG_SELF = new Set(['繁', '\u7b80', '\u7b80\u4f53\u4e2d\u6587', '繁體中文']);
    const nonLangHan = enSnap.text.split('\n').filter((line) => /[\u4e00-\u9fff]/.test(line) && !LANG_SELF.has(line));
    assert.deepEqual(nonLangHan, []);
  });

  await check('前後端一致性：goService.getStatus() 與 adapter.listModels()／UI 清單資格判斷完全一致', async () => {
    const cacheDir = mkdtempSync(path.join(work, 'go-consistency-'));
    const goSvc = createGoService({
      config: {
        enabled: true,
        cachePath: path.join(cacheDir, 'cache.json'),
        pickerPath: path.join(cacheDir, 'go-picker.json')
      },
      version: '0.9.5',
      env: { OPENCODE_GO_API_KEY: 'oc_go_consistency_fake_key_9988' },
      fetchFn: async (url) => {
        const u = String(url);
        if (u.endsWith('/usage')) {
          return new Response(JSON.stringify({
            usage: {
              rolling: { status: 'ok', percent: 10, resetsAt: '2026-11-07T19:45:51.000Z' },
              weekly: { status: 'ok', percent: 25, resetsAt: '2026-11-09T00:00:00.000Z' },
              monthly: { status: 'ok', percent: 40, resetsAt: '2026-11-24T21:47:15.000Z' }
            }
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (u.endsWith('/models')) {
          return new Response(JSON.stringify({
            data: [
              { id: 'deepseek-v4.1-long-id-for-ui', name: 'DeepSeek V4.1 Go', type: 'chat', limit: { context: 200000, output: 16384 }, modalities: { input: ['text', 'image/png'], output: ['text'] } },
              { id: 'hy4-flash-free', name: 'HY4 Flash Free', type: 'chat', limit: { context: 200000, output: 16384 }, modalities: { input: ['text'], output: ['text'] } },
              { id: 'missing-limits-model', name: 'Missing Limits', type: 'chat' },
              { id: 'legacy-responses', name: 'Responses Only', type: 'responses', limit: { context: 128000, output: 8192 } }
            ]
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`unexpected fetch ${u}`);
      }
    });

    const adapter = new OpenCodeGoAdapter(goSvc);
    await goSvc.refresh({ force: true });
    const backendStatus = goSvc.getStatus();
    assert.equal(backendStatus.connectionState, 'connected');
    const publishedDescriptors = await adapter.listModels();
    const publishedIds = publishedDescriptors.map((m) => m.id);
    assert.deepEqual(publishedIds, ['deepseek-v4.1-long-id-for-ui', 'hy4-flash-free']);
    assert.deepEqual(publishedDescriptors.find((m) => m.id === 'deepseek-v4.1-long-id-for-ui')?.inputModalities, ['text', 'image']);
    assert.deepEqual(publishedDescriptors.find((m) => m.id === 'hy4-flash-free')?.inputModalities, ['text']);
    assert.equal(backendStatus.previewModels.find((m) => m.id === 'deepseek-v4.1-long-id-for-ui')?.pickerImageSupported, true);
    assert.equal(backendStatus.previewModels.find((m) => m.id === 'hy4-flash-free')?.pickerImageSupported, false);
    assert.deepEqual(
      backendStatus.previewModels.filter((m) => m.pickerPublished).map((m) => m.id),
      publishedIds
    );
    assert.equal(backendStatus.previewModels.find((m) => m.id === 'missing-limits-model')?.pickerReasons.includes('missing-limits'), true);
    assert.equal(backendStatus.previewModels.find((m) => m.id === 'legacy-responses')?.pickerReasons.includes('unsupported-type'), true);

    // Go 自訂選單勾選（manual / auto）應正確過濾 adapter.listModels()，且不允許勾選不合格模型
    assert.equal(goSvc.setPickerShown('legacy-responses', true), null);
    const manualState = goSvc.setPickerShown('hy4-flash-free', false);
    assert.equal(manualState?.mode, 'manual');
    assert.deepEqual((await adapter.listModels()).map((m) => m.id), ['deepseek-v4.1-long-id-for-ui']);
    assert.equal(goSvc.getStatus().picker?.mode, 'manual');
    assert.equal(goSvc.getStatus().pickerPublishedCount, 1);

    const autoState = goSvc.resetPicker();
    assert.equal(autoState?.mode, 'auto');
    assert.deepEqual((await adapter.listModels()).map((m) => m.id), publishedIds);

    goSvc.setEnabled(false);
    assert.deepEqual(await adapter.listModels(), []);
    assert.equal(goSvc.getStatus().pickerPublishedCount, 0);
    goSvc.dispose();
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? `✔ Go entry & UI tests passed (${checks} checks)` : `❌ ${failures} / ${checks} checks failed`}`);
if (failures > 0) process.exit(1);
