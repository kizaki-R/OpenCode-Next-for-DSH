/**
 * 看門狗回歸測試：驗證「上游 200 之後完全沉默」會變成可重試的 TIMEOUT，
 * 而不是把整個回合吊死。
 *
 * 這是先前「跑一下就掛、卻沒有任何錯誤訊息」的成因之一：`streamIdleTimeoutMs`
 * 一直是個沒有消費者的空設定。
 */
import assert from 'node:assert/strict';
import { OpenCodeOAuthAdapter, SAFE_RETRY_POLICY } from '../lib/adapter.js';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS - ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${error.message}`);
  }
}

/**
 * 假的 fetch：回傳指定 SSE 內容。
 *
 * 必須忠實模擬真實 fetch 對 `signal` 的行為 —— abort 之後 body 的 read 立刻以
 * AbortError 失敗。若假替身不理 signal，看門狗就會「看起來」卡死，而那是替身
 * 失真，不是實作問題。
 */
function installFetch(behaviour) {
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => ({
    ok: true,
    status: 200,
    async text() {
      return '';
    },
    body: behaviour(init?.signal)
  });
  return () => {
    globalThis.fetch = real;
  };
}

function sseStream(parts, { neverClose = false } = {}) {
  return (signal) =>
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        if (!neverClose) {
          controller.close();
          return;
        }
        // 連線就一直掛著直到 abort —— 這正是真實上游沉默時的樣子。
        signal?.addEventListener(
          'abort',
          () => {
            try {
              controller.error(signal.reason ?? new Error('aborted'));
            } catch {
              /* 已關閉 */
            }
          },
          { once: true }
        );
      }
    });
}

const catalogStub = {
  async init() {},
  getModel: () => ({ id: 'test-model', name: 'test', defaultMaxTokens: 1024, inputModalities: ['text'] }),
  describeAll: () => [],
  async describe(_provider, id) {
    return { provider: 'opencode-oauth', id, name: id, inputModalities: ['text'] };
  }
};
const tokenStub = {
  async getValidToken() {
    return 'token';
  },
  async refresh() {
    return 'token';
  }
};

function makeAdapter(config) {
  return new OpenCodeOAuthAdapter(catalogStub, tokenStub, config);
}

const baseOptions = {
  provider: 'opencode-oauth',
  model: 'test-model',
  messages: [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'hi' }] }]
};

async function drain(adapter, signal) {
  const chunks = [];
  for await (const chunk of adapter.stream({ ...baseOptions, signal })) chunks.push(chunk);
  return chunks;
}

console.log('\n[dsh-opencode-oauth] stream watchdog\n');

await check('a silent upstream fails with a retryable TIMEOUT', async () => {
  const restore = installFetch(sseStream([], { neverClose: true }));
  try {
    const adapter = makeAdapter({ streamIdleTimeoutMs: 1000 });
    await assert.rejects(drain(adapter), (error) => {
      assert.equal(error.code, 'TIMEOUT', `expected TIMEOUT, got ${error.code}`);
      assert.match(error.message, /no first event/);
      return true;
    });
  } finally {
    restore();
  }
});

await check('host retry policy shows five retries with exact 3/5/7/10/12 waits', () => {
  assert.equal(SAFE_RETRY_POLICY.maxRetries, 5);
  assert.equal(SAFE_RETRY_POLICY.initialDelayMs, 3000);
  assert.equal(SAFE_RETRY_POLICY.maxDelayMs, 12000);
  assert.equal(SAFE_RETRY_POLICY.jitterRatio, 0);
  for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    assert.ok(SAFE_RETRY_POLICY.retryableCodes.includes(code), `${code} must be retryable`);
  }
});

await check('a stalled mid-stream after output is not replay-retryable', async () => {
  const restore = installFetch(
    sseStream(['data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'], { neverClose: true })
  );
  try {
    const adapter = makeAdapter({ streamIdleTimeoutMs: 1000 });
    let sawText = false;
    await assert.rejects(
      (async () => {
        for await (const chunk of adapter.stream(baseOptions)) {
          if (chunk.type === 'text-delta') sawText = true;
        }
      })(),
      (error) => {
        assert.notEqual(error.failure?.code, 'TIMEOUT');
        assert.match(error.message, /idle/);
        return true;
      }
    );
    assert.ok(sawText, 'the text that did arrive must still be yielded before the failure');
  } finally {
    restore();
  }
});

await check('a healthy stream is not disturbed by the watchdog', async () => {
  const restore = installFetch(
    sseStream([
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ])
  );
  try {
    const adapter = makeAdapter({ streamIdleTimeoutMs: 5000 });
    const chunks = await drain(adapter);
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk.text)
      .join('');
    assert.equal(text, 'ok');
    assert.equal(chunks.at(-1).type, 'finish');
  } finally {
    restore();
  }
});

await check('caller abort is not reported as a timeout', async () => {
  const restore = installFetch(sseStream([], { neverClose: true }));
  try {
    const controller = new AbortController();
    const adapter = makeAdapter({ streamIdleTimeoutMs: 30000 });
    const promise = drain(adapter, controller.signal);
    setTimeout(() => controller.abort(new Error('user cancelled')), 50);
    await assert.rejects(promise, (error) => {
      assert.notEqual(error.code, 'TIMEOUT', 'abort must keep its own identity');
      return true;
    });
  } finally {
    restore();
  }
});

console.log('');
if (failures > 0) {
  console.error(`❌ ${failures} watchdog check(s) failed`);
  process.exit(1);
}
console.log('✅ All stream watchdog checks passed');
