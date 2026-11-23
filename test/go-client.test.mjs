/**
 * OpenCode Go 官方唯讀端點與模型正規化測試（全 mock，不連外）。
 *
 * 驗證：
 *   1. 固定目的地 `https://opencode.ai/inference/go/v1/{usage,models}`，拒絕非官方網址。
 *   2. 送出 `GET`、`redirect: 'manual'`、`Authorization: Bearer <key>`，不帶 `org_id` 或 OAuth 標頭。
 *   3. 攔截 HTTP 3xx 與 `opaqueredirect`，絕不跟隨重新導向。
 *   4. 精確區分無效 key、無 Go 權益、權限／政策錯誤與暫時故障（含 `Retry-After`）。
 *   5. 正規化模型 `id`、`type`、`limit`、`capabilities`、`modalities`；缺欄位不冒稱支援。
 *   6. 錯誤訊息脫敏，不回顯密鑰。
 */

import assert from 'node:assert/strict';
import {
  assertOfficialGoUrl,
  classifyGoHttpFailure,
  fetchGoModels,
  fetchGoUsage,
  normalizeUsagePayload
} from '../lib/go/client.js';
import { normalizeGoModel, normalizeGoModelsPayload } from '../lib/go/catalog.js';

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

function mockRes({ status = 200, json = null, text = null, headers = {}, type = 'basic', redirected = false } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const bodyText = text !== null ? text : (json !== null ? JSON.stringify(json) : '');
  return {
    status,
    ok: status >= 200 && status < 300,
    type,
    redirected,
    headers: {
      get: (name) => headerMap.get(String(name).toLowerCase()) ?? null
    },
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText)
  };
}

console.log('--- Destination & redirect guards ---');

await check('assertOfficialGoUrl 只接受官方 https://opencode.ai 唯讀路徑', () => {
  assert.equal(
    assertOfficialGoUrl('https://opencode.ai/inference/go/v1/usage', '/inference/go/v1/usage'),
    'https://opencode.ai/inference/go/v1/usage'
  );
  assert.throws(() => assertOfficialGoUrl('http://opencode.ai/inference/go/v1/usage'));
  assert.throws(() => assertOfficialGoUrl('https://evil.example.com/inference/go/v1/usage'));
  assert.throws(() => assertOfficialGoUrl('https://opencode.ai/zen/go/v1/usage'));
  assert.throws(() => assertOfficialGoUrl('https://opencode.ai/inference/openai/v1/chat/completions'));
  assert.throws(() => assertOfficialGoUrl('https://opencode.ai/inference/go/v1/usage?leak=1'));
});

await check('fetchGoUsage 送出正確端點、GET、redirect:manual 與 Bearer key，且無 OAuth 標頭', async () => {
  const seen = [];
  const officialUsageFixture = {
    usage: {
      rolling: {
        status: 'ok',
        percent: 12,
        resetsAt: '2026-11-07T19:45:51.000Z'
      },
      weekly: {
        status: 'ok',
        percent: 37,
        resetsAt: '2026-11-09T00:00:00.000Z'
      },
      monthly: {
        status: 'ok',
        percent: 55,
        resetsAt: '2026-11-24T21:47:15.000Z'
      }
    },
    // 未公開欄位：不可用來推定方案或 Extra Usage 已關閉
    plan: 'go-plus',
    extraUsage: false
  };
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    return mockRes({
      status: 200,
      json: officialUsageFixture
    });
  };
  const usage = await fetchGoUsage({ key: 'oc_go_fake_123', fetchFn });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://opencode.ai/inference/go/v1/usage');
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].init.redirect, 'manual');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer oc_go_fake_123');
  assert.equal(seen[0].init.headers['x-opencode-org-id'], undefined);
  assert.equal(String(seen[0].init.headers['User-Agent']).includes('opencode-cli'), false);
  assert.equal(usage.entitled, true);
  assert.equal('plan' in usage, false);
  assert.equal('extraUsage' in usage, false);
  assert.deepEqual(usage.windows.rolling, {
    status: 'ok',
    percent: 12,
    resetsAt: '2026-11-07T19:45:51.000Z'
  });
  assert.deepEqual(usage.windows.weekly, {
    status: 'ok',
    percent: 37,
    resetsAt: '2026-11-09T00:00:00.000Z'
  });
  assert.deepEqual(usage.windows.monthly, {
    status: 'ok',
    percent: 55,
    resetsAt: '2026-11-24T21:47:15.000Z'
  });
});

await check('攔截 301/302/307/opaqueredirect，絕不跟隨重新導向', async () => {
  for (const status of [301, 302, 307, 308]) {
    await assert.rejects(
      () => fetchGoUsage({
        key: 'oc_go_fake_123',
        fetchFn: async () => mockRes({ status, headers: { location: 'https://evil.example/steal' } })
      }),
      (err) => err.category === 'redirect-blocked' && err.retryable === false
    );
  }
  await assert.rejects(
    () => fetchGoModels({
      key: 'oc_go_fake_123',
      fetchFn: async () => mockRes({ status: 0, type: 'opaqueredirect' })
    }),
    (err) => err.category === 'redirect-blocked' && err.retryable === false
  );
});

console.log('\n--- Error classification & secret redaction ---');

await check('區分無效 key、無 Go 權益、權限／政策錯誤與暫時故障', () => {
  const e401 = classifyGoHttpFailure(401, '{"error":{"type":"AuthenticationError","message":"Invalid API key oc_secret_echo"}}', null, 'oc_secret_echo');
  assert.equal(e401.category, 'invalid-key');
  assert.equal(e401.retryable, false);
  assert.equal(e401.message.includes('oc_secret_echo'), false);

  const eNoSub = classifyGoHttpFailure(403, '{"error":{"type":"EntitlementError","message":"No active OpenCode Go subscription"}}');
  assert.equal(eNoSub.category, 'no-entitlement');
  assert.equal(eNoSub.retryable, false);

  const ePolicy = classifyGoHttpFailure(403, '{"error":{"type":"PermissionError","message":"Missing Models Read scope"}}');
  assert.equal(ePolicy.category, 'permission-policy');
  assert.equal(ePolicy.subCategory, 'scope-denied');
  assert.equal(ePolicy.retryable, false);

  const eRegion = classifyGoHttpFailure(403, '{"error":{"type":"RegionError","message":"Region not supported"}}');
  assert.equal(eRegion.category, 'permission-policy');
  assert.equal(eRegion.subCategory, 'region-restricted');

  const e429 = classifyGoHttpFailure(429, '{"error":{"message":"Rate limit exceeded"}}', { 'retry-after': '120' });
  assert.equal(e429.category, 'transient');
  assert.equal(e429.subCategory, 'rate-limited');
  assert.equal(e429.retryable, true);
  assert.equal(e429.retryAfterMs, 120000);

  const e503 = classifyGoHttpFailure(503, 'Service Unavailable');
  assert.equal(e503.category, 'transient');
  assert.equal(e503.subCategory, 'upstream-error');
  assert.equal(e503.retryable, true);
});

await check('usage 明確回報未訂閱時視為 no-entitlement；空或非合約回應拒絕為 invalid-response', () => {
  assert.throws(
    () => normalizeUsagePayload({ subscribed: false, active: false }),
    (err) => err.category === 'no-entitlement'
  );
  for (const invalidPayload of [
    {},
    { ok: true },
    { usage: {} },
    { usage: { rolling: { status: 'ok', percent: 12, resetsAt: '2026-11-07T19:45:51.000Z' } } },
    {
      usage: {
        rolling: { percent: 12, resetsAt: '2026-11-07T19:45:51.000Z' },
        weekly: { status: 'ok', percent: 37, resetsAt: '2026-11-09T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 55, resetsAt: '2026-11-24T21:47:15.000Z' }
      }
    },
    {
      usage: {
        rolling: { status: 'ok', percent: 12, resetsAt: 'not-a-date' },
        weekly: { status: 'ok', percent: 37, resetsAt: '2026-11-09T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 55, resetsAt: '2026-11-24T21:47:15.000Z' }
      }
    }
  ]) {
    assert.throws(
      () => normalizeUsagePayload(invalidPayload),
      (err) => err.category === 'invalid-response' && err.retryable === false
    );
  }
});

console.log('\n--- Model catalog normalization ---');

await check('正規化 id、type、limit、capabilities 與 modalities，缺欄位不冒稱支援', async () => {
  const models = await fetchGoModels({
    key: 'oc_go_fake_123',
    fetchFn: async (url, init) => {
      assert.equal(url, 'https://opencode.ai/inference/go/v1/models');
      assert.equal(init.redirect, 'manual');
      return mockRes({
        status: 200,
        json: {
          data: [
            {
              id: 'glm-5',
              name: 'GLM-5',
              type: 'chat',
              limit: { context: 200000, output: 32000 },
              capabilities: { reasoning: true, tool_call: true, attachment: false },
              modalities: { input: ['text', 'image'], output: ['text'] }
            },
            {
              id: 'kimi-k2.5'
              // 刻意省略 limit / capabilities / modalities / type
            }
          ]
        }
      });
    }
  });

  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'glm-5');
  assert.equal(models[0].type, 'chat');
  assert.deepEqual(models[0].limit, { context: 200000, output: 32000, input: null });
  assert.equal(models[0].capabilities.reasoning, true);
  assert.equal(models[0].capabilities.toolCall, true);
  assert.equal(models[0].capabilities.attachment, false);
  assert.equal(models[0].capabilities.structuredOutput, null);
  assert.deepEqual(models[0].modalities, { input: ['text', 'image'], output: ['text'] });

  // 缺欄位時保留 null，絕不假裝支援 image / reasoning / context
  assert.equal(models[1].id, 'kimi-k2.5');
  assert.equal(models[1].type, null);
  assert.deepEqual(models[1].limit, { context: null, output: null, input: null });
  assert.equal(models[1].capabilities.reasoning, null);
  assert.equal(models[1].capabilities.toolCall, null);
  assert.deepEqual(models[1].modalities, { input: null, output: null });

  const keyed = normalizeGoModelsPayload({
    models: {
      'deepseek-v3.2': { name: 'DeepSeek V3.2', limit: { context: 131072 } }
    }
  });
  assert.equal(keyed.length, 1);
  assert.equal(keyed[0].id, 'deepseek-v3.2');
  assert.equal(keyed[0].limit.context, 131072);
  assert.equal(normalizeGoModel({}), null);
});

console.log(`\n${failures === 0 ? `✔ Go client tests passed (${checks} checks)` : `❌ ${failures} / ${checks} checks failed`}`);
if (failures > 0) process.exit(1);
