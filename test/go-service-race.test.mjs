/**
 * OpenCode Go 服務狀態隔離、快取清除與競態測試（全 mock，使用暫存目錄）。
 *
 * 驗證：
 *   1. 預設停用時拒絕打上游、不寫快取、狀態固定為 `disabled`。
 *   2. 先打 `/usage` 驗證資格，失敗時絕不繼續打 `/models`。
 *   3. 空或不符合官方 `/usage` 合約的回應不可標記已連線，也不可繼續查 `/models`。
 *   4. 換 key 時立即清除舊快取並隔離指紋；新實例重啟也不得讀回舊 key 的模型清單。
 *   5. 換 key 競態與停用／清除競態（包含非同步憑證解析期間與 HTTP 請求期間）：
 *      過期操作不送 HTTP、不覆寫狀態或快取。
 *   6. 完整狀態 JSON 永不含 API key 明文或片段。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGoService } from '../lib/go/service.js';
import { fingerprintSecret } from '../lib/go/credentials.js';
import { GoCacheStore } from '../lib/go/catalog.js';

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

function officialUsagePayload({ rollingPercent = 12, weeklyPercent = 37, monthlyPercent = 55 } = {}) {
  return {
    usage: {
      rolling: { status: 'ok', percent: rollingPercent, resetsAt: '2026-11-07T19:45:51.000Z' },
      weekly: { status: 'ok', percent: weeklyPercent, resetsAt: '2026-11-09T00:00:00.000Z' },
      monthly: { status: 'ok', percent: monthlyPercent, resetsAt: '2026-11-24T21:47:15.000Z' }
    }
  };
}

function mockRes({ status = 200, json = {} } = {}) {
  const body = JSON.stringify(json);
  return {
    status,
    ok: status >= 200 && status < 300,
    type: 'basic',
    redirected: false,
    headers: { get: () => null },
    text: async () => body,
    json: async () => json
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const work = mkdtempSync(path.join(tmpdir(), 'ocoa-go-race-'));
try {
  await check('預設停用時不呼叫網路且狀態為 disabled', async () => {
    let called = 0;
    const cachePath = path.join(work, 'disabled.cache.json');
    const service = createGoService({
      config: { enabled: false, cachePath },
      env: { OPENCODE_GO_API_KEY: 'oc_go_should_not_be_used' },
      fetchFn: async () => {
        called++;
        throw new Error('must not fetch when disabled');
      }
    });
    const st = await service.refresh();
    assert.equal(called, 0);
    assert.equal(st.enabled, false);
    assert.equal(st.connectionState, 'disabled');
    assert.deepEqual(st.previewModels, []);
    assert.equal(existsSync(cachePath), false);
    service.dispose();
  });

  await check('/usage 回傳無權益（403 EntitlementError）時，絕不呼叫 /models', async () => {
    const urls = [];
    const cachePath = path.join(work, 'no-entitlement.cache.json');
    const service = createGoService({
      config: { enabled: true, cachePath },
      env: { OPENCODE_GO_API_KEY: 'oc_go_no_plan_key_123456' },
      fetchFn: async (url) => {
        urls.push(url);
        return mockRes({
          status: 403,
          json: { error: { type: 'EntitlementError', message: 'Subscribe to OpenCode Go first' } }
        });
      }
    });
    const st = await service.refresh();
    assert.deepEqual(urls, ['https://opencode.ai/inference/go/v1/usage']);
    assert.equal(st.connectionState, 'no-entitlement');
    assert.equal(st.usage, null);
    assert.deepEqual(st.previewModels, []);
    assert.equal(st.error?.category, 'no-entitlement');
    assert.equal(existsSync(cachePath), false);
    service.dispose();
  });

  await check('/usage 回傳空或非合約 JSON 時，不可標記已連線且不可繼續查 /models', async () => {
    const cachePath = path.join(work, 'non-contract.cache.json');
    for (const badPayload of [{}, { ok: true }, { usage: {} }, { usage: { rolling: { status: 'ok', percent: 12 } } }]) {
      const urls = [];
      const service = createGoService({
        config: { enabled: true, cachePath },
        env: { OPENCODE_GO_API_KEY: 'oc_go_bad_usage_key_123456' },
        fetchFn: async (url) => {
          urls.push(url);
          return mockRes({ status: 200, json: badPayload });
        }
      });
      const st = await service.refresh();
      assert.deepEqual(urls, ['https://opencode.ai/inference/go/v1/usage']);
      assert.notEqual(st.connectionState, 'connected');
      assert.equal(st.connectionState, 'invalid-response');
      assert.equal(st.usage, null);
      assert.deepEqual(st.previewModels, []);
      assert.equal(existsSync(cachePath), false);
      service.dispose();
    }
  });

  await check('換 key 時隔離並清除舊快取，且磁碟快取不含明文 key', async () => {
    const cachePath = path.join(work, 'isolate.cache.json');
    const env = { OPENCODE_GO_API_KEY: 'oc_go_key_alpha_secret_999' };
    const fetchFn = async (url, init) => {
      const auth = init.headers.Authorization;
      const isAlpha = auth.includes('alpha');
      if (url.endsWith('/usage')) {
        return mockRes({
          status: 200,
          json: officialUsagePayload({
            rollingPercent: isAlpha ? 10 : 2,
            weeklyPercent: isAlpha ? 20 : 4,
            monthlyPercent: isAlpha ? 30 : 6
          })
        });
      }
      return mockRes({
        status: 200,
        json: {
          data: [{ id: isAlpha ? 'alpha-model' : 'beta-model', name: isAlpha ? 'Alpha' : 'Beta' }]
        }
      });
    };

    const service = createGoService({ config: { enabled: true, cachePath }, env, fetchFn });
    const stA = await service.refresh();
    assert.equal(stA.connectionState, 'connected');
    assert.deepEqual(stA.previewModels.map((m) => m.id), ['alpha-model']);
    assert.equal(stA.usage?.windows?.rolling?.percent, 10);
    assert.equal(existsSync(cachePath), true);

    const diskRaw = readFileSync(cachePath, 'utf8');
    assert.equal(diskRaw.includes('oc_go_key_alpha_secret_999'), false);
    assert.equal(JSON.stringify(stA).includes('oc_go_key_alpha_secret_999'), false);

    // 模擬重啟並換成新 key，但尚未重新連線：舊快取不得沿用，且會被清除。
    env.OPENCODE_GO_API_KEY = 'oc_go_key_beta_secret_888';
    const restarted = createGoService({ config: { enabled: true, cachePath }, env, fetchFn });
    const stInit = await restarted.init();
    assert.equal(stInit.connectionState, 'unconfigured');
    assert.deepEqual(stInit.previewModels, []);
    assert.equal(existsSync(cachePath), false);

    const stB = await restarted.refresh();
    assert.equal(stB.connectionState, 'connected');
    assert.deepEqual(stB.previewModels.map((m) => m.id), ['beta-model']);
    assert.equal(stB.usage?.windows?.rolling?.percent, 2);

    service.dispose();
    restarted.dispose();
  });

  await check('換 key 競態（HTTP 期間）：舊 key 請求較晚完成時不得回寫狀態或快取', async () => {
    const cachePath = path.join(work, 'race-key.cache.json');
    const env = { OPENCODE_GO_API_KEY: 'oc_go_key_old_111111' };
    const gateOldUsage = deferred();

    const fetchFn = async (url, init) => {
      const auth = init.headers.Authorization;
      if (auth.includes('old')) {
        if (url.endsWith('/usage')) {
          await gateOldUsage.promise;
          return mockRes({ status: 200, json: officialUsagePayload({ rollingPercent: 88 }) });
        }
        return mockRes({ status: 200, json: { data: [{ id: 'stale-old-model', name: 'Stale Old' }] } });
      }
      if (url.endsWith('/usage')) {
        return mockRes({ status: 200, json: officialUsagePayload({ rollingPercent: 5 }) });
      }
      return mockRes({ status: 200, json: { data: [{ id: 'fresh-new-model', name: 'Fresh New' }] } });
    };

    const service = createGoService({ config: { enabled: true, cachePath }, env, fetchFn });
    const oldPromise = service.refresh();
    await new Promise((r) => setTimeout(r, 15));

    // 在舊請求仍在等待期間換 key 並完成新請求
    env.OPENCODE_GO_API_KEY = 'oc_go_key_new_222222';
    const newStatus = await service.refresh();
    assert.equal(newStatus.connectionState, 'connected');
    assert.deepEqual(newStatus.previewModels.map((m) => m.id), ['fresh-new-model']);
    assert.equal(newStatus.usage?.windows?.rolling?.percent, 5);

    // 放行舊請求的回應，驗證不會污染現有狀態或磁碟快取
    gateOldUsage.resolve();
    await oldPromise;

    const finalStatus = service.getStatus();
    assert.equal(finalStatus.connectionState, 'connected');
    assert.deepEqual(finalStatus.previewModels.map((m) => m.id), ['fresh-new-model']);
    assert.equal(finalStatus.usage?.windows?.rolling?.percent, 5);
    const disk = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.deepEqual(disk.previewModels.map((m) => m.id), ['fresh-new-model']);

    service.dispose();
  });

  await check('停用／清除競態（HTTP 期間）：進行中停用後，舊請求回傳不得寫回快取', async () => {
    const cachePath = path.join(work, 'race-disable.cache.json');
    const env = { OPENCODE_GO_API_KEY: 'oc_go_key_inflight_333333' };
    const gateUsage = deferred();

    const service = createGoService({
      config: { enabled: true, cachePath },
      env,
      fetchFn: async (url) => {
        if (url.endsWith('/usage')) {
          await gateUsage.promise;
          return mockRes({ status: 200, json: officialUsagePayload({ rollingPercent: 15 }) });
        }
        return mockRes({ status: 200, json: { data: [{ id: 'ghost-model', name: 'Ghost' }] } });
      }
    });

    const inflight = service.refresh();
    await new Promise((r) => setTimeout(r, 15));

    const disabledStatus = service.setEnabled(false);
    assert.equal(disabledStatus.connectionState, 'disabled');
    assert.deepEqual(disabledStatus.previewModels, []);

    gateUsage.resolve();
    await inflight;

    const after = service.getStatus();
    assert.equal(after.enabled, false);
    assert.equal(after.connectionState, 'disabled');
    assert.deepEqual(after.previewModels, []);
    assert.equal(after.usage, null);
    assert.equal(existsSync(cachePath), false);

    service.dispose();
  });

  console.log('\n--- Async credential resolution races ---');

  await check('非同步憑證解析期間呼叫 clear()：過期解析不送 HTTP、不覆寫狀態或快取', async () => {
    const cachePath = path.join(work, 'cred-race-clear.cache.json');
    const resolveGate = deferred();
    let fetchCalls = 0;

    const ctx = {
      get(name) {
        if (name === 'credentials') {
          return { resolve: () => resolveGate.promise };
        }
        return undefined;
      }
    };

    const service = createGoService({
      ctx,
      config: { enabled: true, cachePath },
      env: {},
      fetchFn: async () => {
        fetchCalls++;
        return mockRes({ status: 200, json: officialUsagePayload() });
      }
    });

    const inflight = service.refresh();
    await new Promise((r) => setTimeout(r, 15));

    const cleared = service.clear();
    assert.equal(cleared.connectionState, 'unconfigured');
    assert.equal(cleared.credential.present, false);

    resolveGate.resolve({ value: 'oc_go_late_resolved_after_clear' });
    await inflight;

    const after = service.getStatus();
    assert.equal(fetchCalls, 0);
    assert.equal(after.connectionState, 'unconfigured');
    assert.equal(after.credential.present, false);
    assert.deepEqual(after.previewModels, []);
    assert.equal(existsSync(cachePath), false);
    service.dispose();
  });

  await check('非同步憑證解析期間停用（setEnabled(false)）：過期解析不送 HTTP、不覆寫狀態或快取', async () => {
    const cachePath = path.join(work, 'cred-race-disable.cache.json');
    const resolveGate = deferred();
    let fetchCalls = 0;

    const ctx = {
      get(name) {
        if (name === 'credentials') {
          return { resolve: () => resolveGate.promise };
        }
        return undefined;
      }
    };

    const service = createGoService({
      ctx,
      config: { enabled: true, cachePath },
      env: {},
      fetchFn: async () => {
        fetchCalls++;
        return mockRes({ status: 200, json: officialUsagePayload() });
      }
    });

    const inflight = service.refresh();
    await new Promise((r) => setTimeout(r, 15));

    const disabled = service.setEnabled(false);
    assert.equal(disabled.connectionState, 'disabled');

    resolveGate.resolve({ value: 'oc_go_late_resolved_after_disable' });
    await inflight;

    const after = service.getStatus();
    assert.equal(fetchCalls, 0);
    assert.equal(after.enabled, false);
    assert.equal(after.connectionState, 'disabled');
    assert.equal(after.credential.present, false);
    assert.deepEqual(after.previewModels, []);
    assert.equal(existsSync(cachePath), false);
    service.dispose();
  });

  await check('非同步憑證解析期間換 key：舊解析較晚完成時不送 HTTP、不覆寫新 key 狀態與快取', async () => {
    const cachePath = path.join(work, 'cred-race-switch.cache.json');
    const oldCredGate = deferred();
    let resolveCount = 0;
    const seenAuthHeaders = [];

    const ctx = {
      get(name) {
        if (name === 'credentials') {
          return {
            resolve: () => {
              resolveCount++;
              if (resolveCount === 1) return oldCredGate.promise;
              return Promise.resolve({ value: 'oc_go_fresh_key_B_999' });
            }
          };
        }
        return undefined;
      }
    };

    const service = createGoService({
      ctx,
      config: { enabled: true, cachePath },
      env: {},
      fetchFn: async (url, init) => {
        seenAuthHeaders.push(init.headers.Authorization);
        if (url.endsWith('/usage')) {
          return mockRes({ status: 200, json: officialUsagePayload({ rollingPercent: 9 }) });
        }
        return mockRes({ status: 200, json: { data: [{ id: 'model-from-key-b', name: 'Model B' }] } });
      }
    });

    const firstRefresh = service.refresh();
    await new Promise((r) => setTimeout(r, 15));

    // 第一次仍卡在憑證解析時，使用者換 key 並完成第二次連線
    const secondStatus = await service.refresh();
    assert.equal(secondStatus.connectionState, 'connected');
    assert.deepEqual(secondStatus.previewModels.map((m) => m.id), ['model-from-key-b']);
    assert.equal(seenAuthHeaders.length, 2);
    assert.ok(seenAuthHeaders.every((h) => h === 'Bearer oc_go_fresh_key_B_999'));

    // 放行第一次慢速憑證解析（回傳舊 key A）
    oldCredGate.resolve({ value: 'oc_go_stale_key_A_111' });
    await firstRefresh;

    const finalStatus = service.getStatus();
    assert.equal(seenAuthHeaders.length, 2);
    assert.equal(seenAuthHeaders.some((h) => h.includes('stale_key_A')), false);
    assert.equal(finalStatus.connectionState, 'connected');
    assert.deepEqual(finalStatus.previewModels.map((m) => m.id), ['model-from-key-b']);
    assert.equal(finalStatus.usage?.windows?.rolling?.percent, 9);
    const disk = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.deepEqual(disk.previewModels.map((m) => m.id), ['model-from-key-b']);

    service.dispose();
  });

  await check('init() 非同步憑證解析期間呼叫 clear()：不得改狀態、憑證中繼資料或恢復快取', async () => {
    const cachePath = path.join(work, 'init-race-clear.cache.json');
    const key = 'oc_go_init_clear_secret_123';
    const seedStore = new GoCacheStore(cachePath);
    seedStore.write({
      credentialFingerprint: fingerprintSecret(key),
      checkedAt: Date.now() - 1000,
      usage: officialUsagePayload({ rollingPercent: 33 }),
      previewModels: [{ id: 'cached-before-clear', name: 'Cached Before Clear' }]
    });

    const resolveGate = deferred();
    const ctx = {
      get(name) {
        if (name === 'credentials') {
          return { resolve: () => resolveGate.promise };
        }
        return undefined;
      }
    };

    const service = createGoService({
      ctx,
      config: { enabled: true, cachePath },
      env: {},
      fetchFn: async () => {
        throw new Error('init must not call fetch');
      }
    });

    const inflightInit = service.init();
    await new Promise((r) => setTimeout(r, 15));

    const cleared = service.clear();
    assert.equal(cleared.connectionState, 'unconfigured');
    assert.equal(cleared.credential.present, false);
    assert.equal(existsSync(cachePath), false);

    resolveGate.resolve({ value: key });
    await inflightInit;

    const after = service.getStatus();
    assert.equal(after.connectionState, 'unconfigured');
    assert.equal(after.credential.present, false);
    assert.equal(after.credential.source, null);
    assert.equal(after.credential.fingerprint, null);
    assert.deepEqual(after.previewModels, []);
    assert.equal(after.usage, null);
    assert.equal(existsSync(cachePath), false);
    service.dispose();
  });

  await check('init() 非同步憑證解析期間停用（setEnabled(false)）：不得改狀態、憑證中繼資料或恢復快取', async () => {
    const cachePath = path.join(work, 'init-race-disable.cache.json');
    const key = 'oc_go_init_disable_secret_456';
    const seedStore = new GoCacheStore(cachePath);
    seedStore.write({
      credentialFingerprint: fingerprintSecret(key),
      checkedAt: Date.now() - 1000,
      usage: officialUsagePayload({ rollingPercent: 44 }),
      previewModels: [{ id: 'cached-before-disable', name: 'Cached Before Disable' }]
    });

    const resolveGate = deferred();
    const ctx = {
      get(name) {
        if (name === 'credentials') {
          return { resolve: () => resolveGate.promise };
        }
        return undefined;
      }
    };

    const service = createGoService({
      ctx,
      config: { enabled: true, cachePath },
      env: {},
      fetchFn: async () => {
        throw new Error('init must not call fetch');
      }
    });

    const inflightInit = service.init();
    await new Promise((r) => setTimeout(r, 15));

    const disabled = service.setEnabled(false);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.connectionState, 'disabled');
    assert.equal(existsSync(cachePath), false);

    resolveGate.resolve({ value: key });
    await inflightInit;

    const after = service.getStatus();
    assert.equal(after.enabled, false);
    assert.equal(after.connectionState, 'disabled');
    assert.equal(after.credential.present, false);
    assert.equal(after.credential.source, null);
    assert.equal(after.credential.fingerprint, null);
    assert.deepEqual(after.previewModels, []);
    assert.equal(after.usage, null);
    assert.equal(existsSync(cachePath), false);
    service.dispose();
  });

  await check('init() 非同步憑證解析期間呼叫 dispose() 或被較新 refresh() 取代：不得覆寫狀態、中繼資料或快取', async () => {
    const cachePath = path.join(work, 'init-race-dispose-and-refresh.cache.json');
    const staleKey = 'oc_go_init_stale_key_789';
    const freshKey = 'oc_go_fresh_refresh_key_999';

    // 情境 A：init() 解析期間被 dispose()
    {
      const resolveGate = deferred();
      const serviceA = createGoService({
        ctx: { get: (n) => (n === 'credentials' ? { resolve: () => resolveGate.promise } : undefined) },
        config: { enabled: true, cachePath },
        env: {}
      });
      const pendingInit = serviceA.init();
      await new Promise((r) => setTimeout(r, 15));
      serviceA.dispose();
      resolveGate.resolve({ value: staleKey });
      await pendingInit;
      const stA = serviceA.getStatus();
      assert.equal(stA.connectionState, 'unconfigured');
      assert.equal(stA.credential.present, false);
      assert.equal(stA.credential.fingerprint, null);
    }

    // 情境 B：init() 解析期間有較新的 refresh() 完成並寫入新快取
    {
      const initGate = deferred();
      let calls = 0;
      const serviceB = createGoService({
        ctx: {
          get: (n) => (n === 'credentials'
            ? {
                resolve: () => {
                  calls++;
                  if (calls === 1) return initGate.promise;
                  return Promise.resolve({ value: freshKey });
                }
              }
            : undefined)
        },
        config: { enabled: true, cachePath },
        env: {},
        fetchFn: async (url) => {
          if (url.endsWith('/usage')) {
            return mockRes({ status: 200, json: officialUsagePayload({ rollingPercent: 7 }) });
          }
          return mockRes({ status: 200, json: { data: [{ id: 'fresh-after-init', name: 'Fresh' }] } });
        }
      });

      const pendingInit = serviceB.init();
      await new Promise((r) => setTimeout(r, 15));
      const refreshed = await serviceB.refresh();
      assert.equal(refreshed.connectionState, 'connected');
      assert.equal(refreshed.credential.fingerprint, fingerprintSecret(freshKey));

      // 較晚完成的過期 init()（回傳空憑證）不可清除或覆寫 refresh() 狀態與快取
      initGate.resolve(null);
      await pendingInit;

      const finalSt = serviceB.getStatus();
      assert.equal(finalSt.connectionState, 'connected');
      assert.equal(finalSt.credential.present, true);
      assert.equal(finalSt.credential.fingerprint, fingerprintSecret(freshKey));
      assert.deepEqual(finalSt.previewModels.map((m) => m.id), ['fresh-after-init']);
      assert.equal(existsSync(cachePath), true);
      const disk = JSON.parse(readFileSync(cachePath, 'utf8'));
      assert.equal(disk.credentialFingerprint, fingerprintSecret(freshKey));
      serviceB.dispose();
    }
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? `✔ Go service & race tests passed (${checks} checks)` : `❌ ${failures} / ${checks} checks failed`}`);
if (failures > 0) process.exit(1);
