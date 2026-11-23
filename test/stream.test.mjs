/**
 * Adapter 串流與備援切換的迴歸測試（離線）。
 *
 * 這份測試原本直接打真實上游，而且**幾乎沒有斷言**——它只把結果印出來，
 * 不論內容對錯都會宣佈通過。所以它既擋不住回歸，又會因為外部服務的狀態
 * （例如本機出口 IP 被風控）而變紅，是兩種問題的合體。
 *
 * 改寫後驗三件事，全部離線：
 *
 *   1. SSE 解析：reasoning、text、tool-call、finish 都真的被轉成 DSH 的 chunk。
 *   2. 備援切換：主模型失敗且失敗屬於「模型自己」時，真的會換下一順位。
 *   3. 備援的煞車：網路被擋、已經吐過內容、使用者取消，都不換。
 *
 * 第 3 點是整個功能最重要的一半——會壞掉的方式不是「沒換」，而是
 * 「不該換的時候也換」，那會把真正的問題藏起來，甚至讓使用者看到
 * 兩段不同模型拼接起來的答案。
 */
import { ModelCatalog } from '../lib/catalog.js';
import { OpenCodeOAuthAdapter, SAFE_RETRY_POLICY } from '../lib/adapter.js';
import { FallbackStore } from '../lib/fallback.js';

console.log('--- Testing Adapter Stream (offline) ---');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ok - ${label}`);
  } else {
    fail++;
    console.log(`  FAIL - ${label}${detail ? `  (${detail})` : ''}`);
  }
}

/* --------------------------------------------------------- 假的 token manager */

const tokenManager = {
  async getValidToken() {
    return 'fake-token';
  },
  async refresh() {
    return 'fake-token';
  }
};

/* ------------------------------------------------------------- 假的 SSE 伺服器 */

function sseResponse(frames, status = 200) {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map([['content-type', 'text/event-stream']]),
    text: async () => body,
    body: {
      getReader: () => {
        let done = false;
        const encoder = new TextEncoder();
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: encoder.encode(body) };
          },
          cancel: async () => {},
          releaseLock: () => {}
        };
      }
    }
  };
}

function errorResponse(status, payload) {
  const body = JSON.stringify(payload);
  return {
    status,
    ok: false,
    headers: new Map([['content-type', 'application/json']]),
    text: async () => body,
    body: { cancel: async () => {}, getReader: () => ({ read: async () => ({ done: true }) }) }
  };
}

/**
 * 依「這次請求的 model」決定回什麼，並記錄呼叫順序。
 *
 * 這是驗備援切換的關鍵：必須看得出「第幾個請求用了哪個模型」。
 */
async function withRoutes(routes, fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    seen.push(payload.model);
    const respond = routes[payload.model] ?? routes.default;
    if (typeof respond === 'function') return respond(payload);
    return respond;
  };
  try {
    const value = await fn(seen);
    return { value, seen };
  } finally {
    globalThis.fetch = original;
  }
}

const catalog = new ModelCatalog();
await catalog.init();

// 用真實存在的模型 id，而不是 `a`／`b` 這種假名字。
//
// 理由是備援會經過 `isAvailable()`：catalog 只認得真實的 model id，
// 用假名字會讓每個順位都被判成「不可用」而整個被濾掉，於是測試看起來
// 像「沒有切換」，實際上是在測一個永遠不可能發生的輸入。
const MODELS = catalog.getModels().map((m) => m.id);
if (MODELS.length < 3) {
  console.log(`! 需要至少 3 個模型才能測備援，目前只有 ${MODELS.length} 個；跳過。`);
  process.exit(0);
}
const [M0, M1, M2] = MODELS;
const M_UNKNOWN = 'a-model-that-does-not-exist-free';

console.log(`使用模型：主=${M0} 順位1=${M1} 順位2=${M2}`);

/** 建一個備援設定全部指向同一份記憶體狀態的 adapter。 */
function makeAdapter(settings, extraConfig = {}, manager = tokenManager) {
  const store = new FallbackStore({ path: 'C:\\Windows\\Temp\\ocoa-stream-test.json' });
  store.set(settings);
  return new OpenCodeOAuthAdapter(catalog, manager, { fallback: store, ...extraConfig });
}

const TEXT_OK = sseResponse([
  { choices: [{ delta: { content: 'hello' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] }
]);

const deprecated410 = errorResponse(410, {
  type: 'error',
  error: { type: 'ModelDeprecated', message: 'Model has been deprecated.' },
  metadata: { replacement: M_UNKNOWN }
});

const unavailable400 = errorResponse(400, {
  error: { type: 'server_error', message: 'Upstream request failed: Model is unavailable.' }
});

const ABUSE = "OpenCode's free models aren't available from your current network because "
  + "we've detected abusive traffic from this IP address. This isn't related to your account.";
const blocked403 = errorResponse(403, { type: 'error', error: { type: 'FreeTierError', message: ABUSE } });

async function drain(adapter, options) {
  const chunks = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

/* --------------------------------------------------------------- 1. SSE 解析 */

console.log('\n[SSE 解析]');

{
  const reasoningFrames = sseResponse([
    { choices: [{ delta: { reasoning_content: 'thinking...' } }] },
    { choices: [{ delta: { content: 'PHOENIX' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] }
  ]);

  const { value } = await withRoutes({ default: reasoningFrames }, () =>
    drain(makeAdapter({ enabled: false, models: [] }), {
      model: M0,
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 32
    })
  );
  const types = value.map((c) => c.type);
  check('reasoning 被轉成 reasoning-delta', types.includes('reasoning-delta'));
  check('text 被轉成 text-delta', types.includes('text-delta'));
  check('finish 有送到', types.includes('finish'));
  check(
    'text 內容正確',
    value.filter((c) => c.type === 'text-delta').map((c) => c.text).join('') === 'PHOENIX'
  );
}

{
  const toolFrames = sseResponse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_current_weather', arguments: '{"city":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Tokyo"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ]);
  const { value } = await withRoutes({ default: toolFrames }, () =>
    drain(makeAdapter({ enabled: false, models: [] }), {
      model: M0,
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_current_weather',
            description: 'Get current weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
          }
        }
      ],
      maxTokens: 64
    })
  );
  const calls = value.filter((c) => c.type === 'tool-call-delta');
  check('tool call 被偵測到', calls.length > 0);
  check('tool 名稱正確', calls.some((c) => c.name === 'get_current_weather'));
  check(
    '參數被完整拼回',
    calls.map((c) => c.argumentsDelta ?? '').join('') === '{"city":"Tokyo"}',
    calls.map((c) => c.argumentsDelta).join('|')
  );
}

// 工具名稱別名雙向映射與還原（防止上游依工具名稱過濾）
{
  let capturedPayload = null;
  const aliasFrames = sseResponse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_alias', function: { name: 'oc_ext_0', arguments: '{"target":"test"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedPayload = JSON.parse(init.body);
    return aliasFrames;
  };
  try {
    const value = await drain(makeAdapter({ enabled: false, models: [] }), {
      model: M0,
      messages: [{ role: 'user', content: 'run subagent' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'subagent_fork',
            description: 'Run subagent',
            parameters: { type: 'object', properties: {} }
          }
        }
      ],
      maxTokens: 128
    });
    const calls = value.filter((c) => c.type === 'tool-call-delta');
    check('出網 payload 使用 max_completion_tokens', capturedPayload?.max_completion_tokens === 128);
    check('出網 payload 包含 stream_options', capturedPayload?.stream_options?.include_usage === true);
    check('出網 payload 有工具時省略 tool_choice', capturedPayload?.tool_choice === undefined);
    check('敏感工具名稱已被映射為別名', capturedPayload?.tools?.some((t) => t.function?.name === 'oc_ext_0'));
    check('官方 12 個基線工具包含在 tools 陣列中', capturedPayload?.tools?.some((t) => t.function?.name === 'read') && capturedPayload?.tools?.some((t) => t.function?.name === 'shell'));
    check('SSE 串流回傳時別名成功還原為原始 DSH 工具名稱', calls.some((c) => c.name === 'subagent_fork'));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/* ------------------------------------------------------------- 2. 備援切換 */

console.log('\n[備援切換]');

// 主模型 400，第一順位可用 → 應該換過去並成功。
{
  const { value, seen } = await withRoutes(
    { [M0]: unavailable400, [M1]: TEXT_OK },
    () => drain(makeAdapter({ enabled: true, models: [M1] }), {
      model: M0,
      messages: [{ role: 'user', content: 'hi' }]
    })
  );
  check('400 之後換了模型', seen.join(',') === `${M0},${M1}`, seen.join(','));
  check('換模型後有拿到內容', value.some((c) => c.type === 'text-delta'));
}

// 備援關閉 → 只試主模型，錯誤直接往外丟。
{
  const { seen } = await withRoutes({ [M0]: unavailable400, [M1]: TEXT_OK }, async () => {
    try {
      await drain(makeAdapter({ enabled: false, models: [M1] }), {
        model: M0,
        messages: [{ role: 'user', content: 'hi' }]
      });
      return 'no-throw';
    } catch (err) {
      return err.reason;
    }
  });
  check('備援關閉時只打一次', seen.join(',') === M0, seen.join(','));
}

// 主模型與唯一一個備援順位都不行 → 兩層都試過，最後把錯誤丟出去。
//
// 這裡刻意只設 1 個順位：備援上限已縮成 1（理由見 lib/fallback.js）。
// 就算使用者硬塞兩個，normalizeModelList 也只會留第一個。
{
  const { value, seen } = await withRoutes(
    { [M0]: unavailable400, [M1]: unavailable400, [M2]: unavailable400 },
    async () =>
      drain(makeAdapter({ enabled: true, models: [M1, M2] }), {
        model: M0,
        messages: [{ role: 'user', content: 'hi' }]
      }).catch((e) => e)
  );
  check('依序嘗試主模型與唯一順位（第三個被上限截掉）', seen.join(',') === `${M0},${M1}`, seen.join(','));
  check('全部失敗時丟出錯誤而非靜默', value instanceof Error, String(value?.reason));
}

/* ------------------------------------------ 2.5 DSH host retry progress */

console.log('\n[DSH host retry progress]');

// 429 只回報一次，重跑由 DSH host 統一接手；LlmFailure.providerRetryAfterMs
// 指定精確等待，讓 UI 顯示「已重試 n/5」且倒數 3/5/7/10/12 秒。
{
  const endpoint429 = errorResponse(429, {
    error: { message: 'Endpoint is unavailable' }
  });
  const options = {
    model: M0,
    sessionId: 'retry-schedule-test-session',
    messages: [{ role: 'user', content: 'hi' }]
  };
  const { value: errors, seen } = await withRoutes({ [M0]: endpoint429 }, async () => {
    const adapter = makeAdapter({ enabled: false, models: [] });
    const failures = [];
    for (let i = 0; i < 7; i++) {
      try {
        await drain(adapter, options);
      } catch (err) {
        failures.push(err);
      }
    }
    return failures;
  });
  const delays = errors.map((err) => err.failure?.providerRetryAfterMs ?? null);
  check('429 每次只送一個 HTTP 請求，交由 host retry', seen.length === 7, String(seen.length));
  check('429 有合法 RATE_LIMIT retry marker', errors[0] instanceof Error && errors[0].failure?.code === 'RATE_LIMIT');
  check('host retry 取得精確 3/5/7/10/12 秒並在新回合重置',
    delays.join(',') === '3000,5000,7000,10000,12000,,3000', delays.join(','));
  check('DSH 顯示五次重試且等待上限為 12 秒',
    SAFE_RETRY_POLICY.maxRetries === 5
      && SAFE_RETRY_POLICY.initialDelayMs === 3000
      && SAFE_RETRY_POLICY.maxDelayMs === 12000
      && SAFE_RETRY_POLICY.jitterRatio === 0
      && SAFE_RETRY_POLICY.retryableCodes.includes('RATE_LIMIT'));
}

/* ----------------------------------------------------------- 3. 備援的煞車 */

console.log('\n[不該換的情況]');

// 網路風控：換模型一點用都沒有，必須直接回報。
{
  const { seen } = await withRoutes({ [M0]: blocked403, [M1]: TEXT_OK }, async () => {
    try {
      await drain(makeAdapter({ enabled: true, models: [M1] }), {
        model: M0,
        messages: [{ role: 'user', content: 'hi' }]
      });
      return 'no-throw';
    } catch (err) {
      return { reason: err.reason, code: err.code };
    }
  });
  check('網路被擋時不換模型', seen.join(',') === M0, seen.join(','));
}

// 風控的錯誤必須帶著正確的 reason，讓上層能給出「關 VPN」的指引。
{
  const captured = await withRoutes({ [M0]: blocked403 }, async () => {
    try {
      await drain(makeAdapter({ enabled: true, models: [] }), {
        model: M0,
        messages: [{ role: 'user', content: 'hi' }]
      });
      return null;
    } catch (err) {
      return err;
    }
  });
  const err = captured.value;
  check('風控錯誤帶 reason=network-blocked', err?.reason === 'network-blocked', String(err?.reason));
  check('風控錯誤帶合法的 DSH 碼', err?.failure?.code === 'AUTH', String(err?.failure?.code));
  check('風控錯誤的訊息有可執行的指引', /VPN/.test(err?.message ?? ''));
}

// 已經吐過內容之後才失敗 → 不可以改用另一個模型重跑，
// 否則使用者會看到兩個模型拼接起來的答案。
{
  let call = 0;
  const partialThenFail = () => {
    call++;
    if (call === 1) {
      const frames = [{ choices: [{ delta: { content: 'partial answer' } }] }];
      const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
      return {
        status: 200,
        ok: true,
        headers: new Map(),
        text: async () => body,
        body: {
          getReader: () => {
            let done = false;
            const enc = new TextEncoder();
            return {
              async read() {
                if (done) throw new Error('connection reset');
                done = true;
                return { done: false, value: enc.encode(body) };
              },
              cancel: async () => {},
              releaseLock: () => {}
            };
          }
        }
      };
    }
    return TEXT_OK;
  };

  const { value, seen } = await withRoutes({ [M0]: partialThenFail, [M1]: TEXT_OK }, async () => {
    try {
      await drain(makeAdapter({ enabled: true, models: [M1] }), {
        model: M0,
        messages: [{ role: 'user', content: 'hi' }]
      });
      return 'no-throw';
    } catch (err) {
      return err;
    }
  });
  check('已吐出內容後不再換模型', seen.join(',') === M0, seen.join(','));
  check('已有部分回答時不附加自動重試標記',
    value instanceof Error && value.failure?.code !== 'TRANSPORT');
}

// 尚未送出任何內容就斷線：附 TRANSPORT，交給 host retry policy 重試，讓本輪保持執行中。
{
  const resetBeforeFirstEvent = {
    status: 200,
    ok: true,
    headers: new Map(),
    body: {
      getReader: () => ({
        async read() { throw new Error('connection reset before first event'); },
        cancel: async () => {},
        releaseLock: () => {}
      })
    }
  };
  const { value } = await withRoutes({ [M0]: resetBeforeFirstEvent }, async () => {
    try {
      await drain(makeAdapter({ enabled: false, models: [] }), {
        model: M0,
        messages: [{ role: 'user', content: 'hi' }]
      });
      return 'no-throw';
    } catch (err) {
      return err;
    }
  });
  check('首個事件前斷線回報 retryable TRANSPORT',
    value instanceof Error && value.failure?.code === 'TRANSPORT');
}

// 410 帶上游建議的替代模型 → 使用者沒排到它時，接到隊尾再試一次。
{
  const { seen } = await withRoutes(
    { [M0]: deprecated410, [M_UNKNOWN]: TEXT_OK },
    () =>
      drain(makeAdapter({ enabled: true, models: [] }), {
        model: M0,
        messages: [{ role: 'user', content: 'hi' }]
      })
  );
  check('410 之後試了上游建議的替代模型',
    seen.join(',') === `${M0},${M_UNKNOWN}`, seen.join(','));
}

// 使用者取消 → 不換模型，直接把取消往外丟。
{
  const controller = new AbortController();
  controller.abort();
  const { seen } = await withRoutes({ [M0]: unavailable400, [M1]: TEXT_OK }, async () => {
    try {
      await drain(makeAdapter({ enabled: true, models: [M1] }), {
        model: M0,
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal
      });
      return 'no-throw';
    } catch {
      return 'threw';
    }
  });
  check('使用者取消後不換模型', seen.join(',') === M0, seen.join(','));
}

// Account rotation is limited to confirmed 401 after refreshing the same saved account.
{
  const unauthorized = errorResponse(401, { error: { message: 'Unauthorized' } });
  let current = { token: 'account-a-token', accountId: 'a', version: 1 };
  let switchCalls = 0;
  const manager = {
    async acquireCredential() { return current; },
    async refreshCredential(snapshot) {
      if (snapshot.accountId !== current.accountId) return { stale: true };
      current = { token: 'account-a-refreshed', accountId: 'a', version: 2 };
      return current;
    },
    async switchToNextAccount(id, { version }) {
      switchCalls++;
      if (id !== 'a' || version !== 2) return null;
      current = { token: 'account-b-token', accountId: 'b', version: 3 };
      return { accountId: 'b', version: 3 };
    }
  };
  let calls = 0;
  const { value } = await withRoutes({ [M0]: () => (++calls < 3 ? unauthorized : TEXT_OK) }, async () => {
    const adapter = makeAdapter({ enabled: false, models: [] }, { autoSwitch: { get: () => ({ enabled: true }) } }, manager);
    return drain(adapter, { model: M0, messages: [{ role: 'user', content: 'hi' }] });
  });
  check('confirmed 401 rotates only after refresh-and-retry', calls === 3 && switchCalls === 1, `${calls} requests/${switchCalls} rotations`);
  check('single retry finishes with streamed content', Array.isArray(value) && value.length > 0);
}

// Auto-switch is opt-in even for a confirmed post-refresh 401.
{
  const unauthorized = errorResponse(401, { error: { message: 'Unauthorized' } });
  let rotations = 0;
  const manager = {
    async acquireCredential() { return { token: 'account-a-token', accountId: 'a', version: 1 }; },
    async refreshCredential() { return { token: 'account-a-refreshed', accountId: 'a', version: 2 }; },
    async switchToNextAccount() { rotations++; return { accountId: 'b', version: 3 }; }
  };
  const { value } = await withRoutes({ [M0]: unauthorized }, async () => {
    try {
      await drain(makeAdapter({ enabled: false, models: [] }, { autoSwitch: { get: () => ({ enabled: false }) } }, manager), {
        model: M0, messages: [{ role: 'user', content: 'hi' }]
      });
    } catch (error) { return error; }
  });
  check('disabled auto-switch preserves post-refresh unauthorized failure', rotations === 0 && value?.reason === 'unauthorized');
}

// Non-401 failures must never rotate even when opt-in is on.
{
  let switchCalls = 0;
  const manager = {
    async acquireCredential() { return { token: 'account-a-token', accountId: 'a', version: 1 }; },
    async refreshCredential() { throw new Error('should not refresh'); },
    async switchToNextAccount() { switchCalls++; return { accountId: 'b', version: 2 }; }
  };
  const { value } = await withRoutes({ [M0]: errorResponse(429, { error: { message: 'Rate limited' } }) }, async () => {
    try {
      await drain(makeAdapter({ enabled: false, models: [] }, { autoSwitch: { get: () => ({ enabled: true }) } }, manager), {
        model: M0, messages: [{ role: 'user', content: 'hi' }]
      });
      return null;
    } catch (error) { return error; }
  });
  check('429 does not rotate accounts', switchCalls === 0 && value?.reason !== 'unauthorized');
}

if (fail > 0) throw new Error(`Adapter stream: ${fail} check(s) failed`);
console.log(`\n✔ All adapter tests passed (${pass} checks, offline)`);
