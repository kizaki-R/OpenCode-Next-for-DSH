/**
 * OpenCode Go 第二階段離線推論測試：文字串流、工具呼叫與隔離不變式。
 *
 * 涵蓋：
 *   1. 固定端點 POST https://opencode.ai/inference/go/openai/v1/chat/completions 與標頭隔離
 *      （Bearer key、自有 User-Agent、redirect: manual；無 CLI 標頭、無 org_id、無 Bun、無工具別名或假工具）。
 *   2. x-opencode-session 嚴格來自 DSH 實際 sessionId：多輪／工具續輪一致，不同會話隔離，缺漏直接拒絕。
 *   3. 文字 SSE、finish reason（stop／max-tokens／tool-calls）、工具參數分段、工具結果續輪。
 *   4. stream_options.include_usage 與 usage.cost / usage.opencode.billing_source / usage.opencode.allowance 分開保留；
 *      未提供維持 null（不當成 0），顯式 0 保留為 0。
 *   5. 取消（AbortSignal）、逾時（watchdog）、斷線與 401/403/429/5xx 錯誤分類，皆不自動重送計費請求、
 *      不自動換帳號、不跨 provider 退回。
 *   6. API key 絕不進日誌、錯誤或狀態；未驗證的圖片／推理不冒充支援。
 */

import assert from 'node:assert/strict';
import { createGoService } from '../lib/go/service.js';
import { GO_NO_RETRY_POLICY, OpenCodeGoAdapter } from '../lib/go/adapter.js';
import { assertOfficialGoUrl } from '../lib/go/client.js';

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

function officialUsagePayload() {
  return {
    usage: {
      rolling: { status: 'ok', percent: 12, resetsAt: '2026-11-07T19:45:51.000Z' },
      weekly: { status: 'ok', percent: 37, resetsAt: '2026-11-09T00:00:00.000Z' },
      monthly: { status: 'ok', percent: 55, resetsAt: '2026-11-24T21:47:15.000Z' }
    }
  };
}

function jsonRes(status, payload, headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const bodyText = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    status,
    ok: status >= 200 && status < 300,
    type: 'basic',
    redirected: false,
    headers: { get: (n) => map.get(String(n).toLowerCase()) ?? null },
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText)
  };
}

function sseRes(events, { chunkBytes = 48, status = 200 } = {}) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkBytes) {
        controller.enqueue(bytes.subarray(i, i + chunkBytes));
      }
      controller.close();
    }
  });
  return {
    status,
    ok: true,
    type: 'basic',
    redirected: false,
    headers: { get: () => 'text/event-stream' },
    body
  };
}

async function setupConnectedAdapter({ key = 'oc_go_stage2_secret_123456', onChatFetch, config = {}, customModels = null } = {}) {
  const models = customModels || [
    {
      id: 'glm-5',
      name: 'GLM-5',
      type: 'chat',
      limit: { context: 200000, output: 16384 },
      capabilities: { reasoning: true, tool_call: true },
      modalities: { input: ['text', 'image'], output: ['text'] }
    },
    {
      id: 'hy4-flash-free',
      name: 'HY4 Flash Free',
      type: 'chat',
      limit: { context: 200000, output: 16384 },
      capabilities: { reasoning: true, tool_call: true },
      modalities: { input: ['text'], output: ['text'] }
    },
    {
      id: 'embed-model',
      name: 'Embed',
      type: 'embedding'
    }
  ];

  const fetchFn = async (url, init) => {
    if (init.method === 'GET' && url.endsWith('/usage')) {
      return jsonRes(200, officialUsagePayload());
    }
    if (init.method === 'GET' && url.endsWith('/models')) {
      return jsonRes(200, { data: models });
    }
    return onChatFetch(url, init);
  };

  const service = createGoService({
    config: { enabled: true, cachePath: null },
    env: { OPENCODE_GO_API_KEY: key },
    version: '0.9.5-stage2-test',
    fetchFn
  });
  await service.refresh();
  const adapter = new OpenCodeGoAdapter(service, config);
  return { service, adapter, key };
}

console.log('--- Destination, headers, and session ID guards ---');

await check('只接受官方 Go Chat Completions 端點並封鎖免費／Zen 路徑', () => {
  assert.equal(
    assertOfficialGoUrl('https://opencode.ai/inference/go/openai/v1/chat/completions', '/inference/go/openai/v1/chat/completions'),
    'https://opencode.ai/inference/go/openai/v1/chat/completions'
  );
  assert.throws(() => assertOfficialGoUrl('https://opencode.ai/inference/openai/v1/chat/completions'));
  assert.throws(() => assertOfficialGoUrl('https://opencode.ai/zen/go/openai/v1/chat/completions'));
});

await check('只接受 options.sessionId；缺漏、無效或使用 session.id／conversationId 代替皆拒絕且不送請求', async () => {
  let chatCalls = 0;
  const { adapter, service } = await setupConnectedAdapter({
    onChatFetch: async () => {
      chatCalls++;
      return sseRes([]);
    }
  });

  for (const badOpts of [
    { model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] },
    { model: 'glm-5', session: { id: 'nested-session-id' }, messages: [{ role: 'user', content: 'hi' }] },
    { model: 'glm-5', conversationId: 'conv-session-id', messages: [{ role: 'user', content: 'hi' }] },
    { model: 'glm-5', sessionId: '', messages: [{ role: 'user', content: 'hi' }] },
    { model: 'glm-5', sessionId: '   ', messages: [{ role: 'user', content: 'hi' }] },
    { model: 'glm-5', sessionId: 'bad\r\nsid', messages: [{ role: 'user', content: 'hi' }] },
    { model: 'glm-5', sessionId: 12345, messages: [{ role: 'user', content: 'hi' }] }
  ]) {
    await assert.rejects(
      async () => {
        for await (const _ of adapter.stream(badOpts)) { /* drain */ }
      },
      (err) => err?.failure?.code === 'INVALID_REQUEST' && err?.reason === 'missing-session-id'
    );
  }

  assert.equal(chatCalls, 0);
  service.dispose();
});

await check('路由、標頭與會話隔離：不帶 CLI 身分、org_id、假工具或別名，同會話穩定、不同會話隔離', async () => {
  const requests = [];
  const { adapter, service, key } = await setupConnectedAdapter({
    onChatFetch: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return sseRes([
        { choices: [{ index: 0, delta: { content: 'OK' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
    }
  });

  for await (const _ of adapter.stream({
    model: 'glm-5',
    sessionId: 'dsh-session-alpha',
    messages: [{ role: 'user', content: 'hello' }]
  })) {}
  for await (const _ of adapter.stream({
    model: 'glm-5',
    sessionId: 'dsh-session-alpha',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'turn 2' }
    ]
  })) {}
  for await (const _ of adapter.stream({
    model: 'glm-5',
    sessionId: 'dsh-session-beta',
    maxTokens: 1024,
    messages: [{ role: 'user', content: 'hello' }]
  })) {}

  assert.equal(requests.length, 3);
  for (const r of requests) {
    assert.equal(r.url, 'https://opencode.ai/inference/go/openai/v1/chat/completions');
    assert.equal(r.init.method, 'POST');
    assert.equal(r.init.redirect, 'manual');
    assert.equal(r.init.headers.Authorization, `Bearer ${key}`);
    assert.ok(String(r.init.headers['User-Agent']).includes('dsh-opencode-oauth/'));
    assert.equal(String(r.init.headers['User-Agent']).includes('opencode-cli'), false);
    assert.equal(r.init.headers['x-opencode-client'], undefined);
    assert.equal(r.init.headers['x-opencode-org-id'], undefined);
    assert.equal(r.init.headers['x-opencode-project'], undefined);
    assert.equal(r.body.model, 'glm-5');
    assert.equal(r.body.stream, true);
    assert.deepEqual(r.body.stream_options, { include_usage: true });
    assert.equal(r.body.tools, undefined);
    assert.equal(r.body.reasoning_effort, undefined);
  }

  // 未傳 options.maxTokens 時不得自填 max_completion_tokens；有傳時才轉送
  assert.equal('max_completion_tokens' in requests[0].body, false);
  assert.equal('max_completion_tokens' in requests[1].body, false);
  assert.equal(requests[2].body.max_completion_tokens, 1024);

  assert.equal(requests[0].init.headers['x-opencode-session'], 'dsh-session-alpha');
  assert.equal(requests[1].init.headers['x-opencode-session'], 'dsh-session-alpha');
  assert.equal(requests[2].init.headers['x-opencode-session'], 'dsh-session-beta');
  assert.notEqual(requests[0].init.headers['x-opencode-session'], requests[2].init.headers['x-opencode-session']);
  service.dispose();
});

console.log('\n--- Text SSE, tool calls, tool continuation, and billing telemetry ---');

await check('文字 SSE 與分段工具參數、finish_reason、工具結果續輪（同 sessionId）', async () => {
  const requests = [];
  let turn = 0;

  const { adapter, service } = await setupConnectedAdapter({
    onChatFetch: async (_url, init) => {
      turn++;
      requests.push({ headers: init.headers, body: JSON.parse(init.body) });
      if (turn === 1) {
        return sseRes([
          { choices: [{ index: 0, delta: { content: 'Let me check. ' } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_read_1', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }] },
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              cost: 0,
              opencode: { billing_source: 'go', allowance: 0.012 }
            }
          }
        ], { chunkBytes: 24 });
      }
      return sseRes([
        { choices: [{ index: 0, delta: { content: 'Done reading.' } }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 140,
            completion_tokens: 10,
            total_tokens: 150
            // 故意省略 cost 與 opencode：必須標成 null（未提供），不可當成 0
          }
        }
      ]);
    }
  });

  const tools = [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  ];

  // 第 1 輪：文字 + 工具呼叫
  const chunks1 = [];
  for await (const c of adapter.stream({
    model: 'glm-5',
    sessionId: 'ses-tool-chain-01',
    system: 'You are concise.',
    tools,
    messages: [{ role: 'user', content: 'Read README.md' }]
  })) {
    chunks1.push(c);
  }

  // 不注入假工具或 oc_ext_* 別名
  assert.equal(requests[0].body.tools.length, 1);
  assert.equal(requests[0].body.tools[0].function.name, 'read_file');

  const toolEnd = chunks1.find((c) => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.ok(toolEnd);
  assert.equal(toolEnd.block.id, 'call_read_1');
  assert.equal(toolEnd.block.name, 'read_file');
  assert.equal(toolEnd.block.arguments, '{"path":"README.md"}');

  const usage1 = chunks1.find((c) => c.type === 'usage')?.usage;
  assert.equal(usage1.cost, 0);
  assert.equal(usage1.opencode.billing_source, 'go');
  assert.equal(usage1.opencode.allowance, 0.012);

  const finish1 = chunks1.find((c) => c.type === 'finish');
  assert.deepEqual(finish1.reason, { kind: 'tool-calls' });

  // 第 2 輪：工具結果續輪（同一個 sessionId）
  const chunks2 = [];
  for await (const c of adapter.stream({
    model: 'glm-5',
    sessionId: 'ses-tool-chain-01',
    system: 'You are concise.',
    tools,
    messages: [
      { role: 'user', content: 'Read README.md' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check. ' },
          { type: 'tool-call', id: 'call_read_1', name: 'read_file', arguments: '{"path":"README.md"}' }
        ]
      },
      { role: 'tool', toolCallId: 'call_read_1', content: 'file content here' }
    ]
  })) {
    chunks2.push(c);
  }

  assert.equal(requests[1].headers['x-opencode-session'], 'ses-tool-chain-01');
  const toolReplyMsg = requests[1].body.messages.find((m) => m.role === 'tool');
  assert.equal(toolReplyMsg.tool_call_id, 'call_read_1');
  assert.equal(toolReplyMsg.content, 'file content here');

  const text2 = chunks2.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.equal(text2, 'Done reading.');

  // 未提供計費欄位時必須是 null，絕不可當成 0
  const usage2 = chunks2.find((c) => c.type === 'usage')?.usage;
  assert.equal(usage2.cost, null);
  assert.equal(usage2.opencode.billing_source, null);
  assert.equal(usage2.opencode.allowance, null);

  const finish2 = chunks2.find((c) => c.type === 'finish');
  assert.deepEqual(finish2.reason, { kind: 'stop' });

  service.dispose();
});

await check('依目錄宣告模態且不主動送 reasoning_effort，但保留上游實際回傳的推理增量（reasoning_content / reasoning / thought）', async () => {
  const sentBodies = [];
  let reqIndex = 0;
  const { adapter, service } = await setupConnectedAdapter({
    onChatFetch: async (_url, init) => {
      reqIndex++;
      sentBodies.push(JSON.parse(init.body));
      if (reqIndex === 1) {
        return sseRes([
          { choices: [{ index: 0, delta: { reasoning_content: 'hidden ', content: '' } }] },
          { choices: [{ index: 0, delta: { reasoning: 'thought ' } }] },
          { choices: [{ index: 0, delta: { thought: 'end', content: 'Visible text' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        ]);
      }
      return sseRes([
        { choices: [{ index: 0, delta: { content: 'Plain answer only.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]);
    }
  });

  // 正式選單不宣稱 reasoning.efforts；圖片能力完全跟隨目錄（glm-5 宣告 image，hy4-flash-free 為純文字）
  const listed = await adapter.listModels('opencode-go-subscription');
  assert.equal(listed.every((m) => m.reasoning === undefined), true);
  assert.deepEqual(listed.find((m) => m.id === 'glm-5')?.inputModalities, ['text', 'image']);
  assert.deepEqual(listed.find((m) => m.id === 'hy4-flash-free')?.inputModalities, ['text']);

  // 純文字模型（目錄未宣告 image）帶圖片送入 adapter 時，必須於送出 HTTP 前明確拒絕，不可靜默丟圖送純文字
  await assert.rejects(
    async () => {
      for await (const _ of adapter.stream({
        model: 'hy4-flash-free',
        sessionId: 'ses-reject-img-01',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look at this' },
              { type: 'image', attachment: { attachmentId: 'sha256:abcdef1234567890' } }
            ]
          }
        ]
      })) {}
    },
    (err) => err?.failure?.code === 'INVALID_REQUEST' && err?.reason === 'image-unsupported'
  );
  assert.equal(reqIndex, 0, '純文字模型附圖不得送出任何 HTTP 請求');

  const chunks = [];
  for await (const c of adapter.stream({
    model: 'glm-5',
    sessionId: 'ses-text-only-01',
    reasoningEffort: 'high',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze reasoning stream' }
        ]
      }
    ]
  })) {
    chunks.push(c);
  }

  const userMsg = sentBodies[0].messages[0];
  assert.equal(userMsg.role, 'user');
  assert.equal('reasoning_effort' in sentBodies[0], false);
  assert.equal(chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join(''), 'hidden thought end');
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'Visible text');

  // 只有 content、沒有推理欄位的一般回應仍正常輸出文字
  const plainChunks = [];
  for await (const c of adapter.stream({
    model: 'glm-5',
    sessionId: 'ses-plain-content-01',
    messages: [{ role: 'user', content: 'Say hi' }]
  })) {
    plainChunks.push(c);
  }
  assert.equal(plainChunks.some((c) => c.type === 'reasoning-delta'), false);
  assert.equal(plainChunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'Plain answer only.');
  assert.deepEqual(plainChunks.find((c) => c.type === 'finish')?.reason, { kind: 'stop' });
  service.dispose();
});

await check('重現 hy4-flash-free max_completion_tokens=16：content 為空、全數為 reasoning_content 與 length 截斷', async () => {
  const sentBodies = [];
  let chatCalls = 0;
  const { adapter, service } = await setupConnectedAdapter({
    onChatFetch: async (_url, init) => {
      chatCalls++;
      sentBodies.push(JSON.parse(init.body));
      return sseRes([
        { choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning_content: 'Step 1: analyze ' } }] },
        { choices: [{ index: 0, delta: { content: '', reasoning_content: 'Step 2: verify.' } }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
          usage: {
            prompt_tokens: 24,
            completion_tokens: 16,
            total_tokens: 40,
            completion_tokens_details: { reasoning_tokens: 16 },
            cost: 0,
            opencode: { billing_source: 'go', allowance: 0 }
          }
        }
      ]);
    }
  });

  const chunks = [];
  for await (const c of adapter.stream({
    model: 'hy4-flash-free',
    sessionId: 'ses-hy4-length-01',
    maxTokens: 16,
    messages: [{ role: 'user', content: 'Think carefully' }]
  })) {
    chunks.push(c);
  }

  // 不重送、不自動提高 max_completion_tokens、不切換其他模型
  assert.equal(chatCalls, 1);
  assert.equal(sentBodies[0].model, 'hy4-flash-free');
  assert.equal(sentBodies[0].max_completion_tokens, 16);
  assert.equal('reasoning_effort' in sentBodies[0], false);

  const reasoningText = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('');
  assert.equal(reasoningText, 'Step 1: analyze Step 2: verify.');
  assert.equal(chunks.some((c) => c.type === 'text-delta'), false);

  const usageChunk = chunks.find((c) => c.type === 'usage')?.usage;
  assert.equal(usageChunk.outputTokens, 16);
  assert.equal(usageChunk.reasoningTokens, 16);
  assert.equal(usageChunk.cost, 0);
  assert.equal(usageChunk.opencode.billing_source, 'go');
  assert.equal(usageChunk.opencode.allowance, 0);

  const finishChunk = chunks.find((c) => c.type === 'finish');
  assert.deepEqual(finishChunk.reason, { kind: 'max-tokens' });
  assert.deepEqual(finishChunk.replayState.blocks, [
    { type: 'reasoning', text: 'Step 1: analyze Step 2: verify.' }
  ]);
  service.dispose();
});

console.log('\n--- Cancel, timeout, no-retry, error classification, and secret redaction ---');

await check('取消（AbortSignal）立即中止且不重送', async () => {
  let calls = 0;
  const controller = new AbortController();
  const { adapter, service } = await setupConnectedAdapter({
    onChatFetch: async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }
  });

  setTimeout(() => controller.abort(new Error('user cancelled')), 20);
  await assert.rejects(async () => {
    for await (const _ of adapter.stream({
      model: 'glm-5',
      sessionId: 'ses-cancel-01',
      signal: controller.signal,
      messages: [{ role: 'user', content: 'hi' }]
    })) {}
  });
  assert.equal(calls, 1);
  service.dispose();
});

await check('首事件逾時（watchdog）中止請求、回報 TIMEOUT 且不重送', async () => {
  let calls = 0;
  let aborted = false;
  const { adapter, service } = await setupConnectedAdapter({
    config: { firstEventTimeoutMs: 40, streamIdleTimeoutMs: 80 },
    onChatFetch: async (_url, init) => {
      calls++;
      init.signal.addEventListener('abort', () => { aborted = true; });
      const silentBody = new ReadableStream({
        start() { /* 永遠不送出事件 */ }
      });
      return {
        status: 200,
        ok: true,
        type: 'basic',
        redirected: false,
        headers: { get: () => 'text/event-stream' },
        body: silentBody
      };
    }
  });

  await assert.rejects(
    async () => {
      for await (const _ of adapter.stream({
        model: 'glm-5',
        sessionId: 'ses-timeout-01',
        messages: [{ role: 'user', content: 'hi' }]
      })) {}
    },
    (err) => err?.failure?.code === 'TIMEOUT'
  );
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  service.dispose();
});

await check('串流中閒置逾時（idle timeout）在吐出部分文字後中止且不重送', async () => {
  let calls = 0;
  let aborted = false;
  const { adapter, service } = await setupConnectedAdapter({
    config: { firstEventTimeoutMs: 100, streamIdleTimeoutMs: 40 },
    onChatFetch: async (_url, init) => {
      calls++;
      init.signal.addEventListener('abort', () => { aborted = true; });
      const stalledBody = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'));
          // 之後刻意沉默直到觸發 idle timeout
        }
      });
      return {
        status: 200,
        ok: true,
        type: 'basic',
        redirected: false,
        headers: { get: () => 'text/event-stream' },
        body: stalledBody
      };
    }
  });

  let sawText = '';
  await assert.rejects(
    async () => {
      for await (const chunk of adapter.stream({
        model: 'glm-5',
        sessionId: 'ses-idle-timeout-01',
        messages: [{ role: 'user', content: 'hi' }]
      })) {
        if (chunk.type === 'text-delta') sawText += chunk.text;
      }
    },
    (err) => err?.failure?.code === 'TIMEOUT' && /idle/.test(err.message)
  );
  assert.equal(sawText, 'partial');
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  service.dispose();
});

await check('推論端點攔截 3xx 重新導向，絕不跟隨或重送', async () => {
  let calls = 0;
  const { adapter, service } = await setupConnectedAdapter({
    onChatFetch: async () => {
      calls++;
      return jsonRes(302, { message: 'redirect' }, { location: 'https://evil.example/steal' });
    }
  });

  await assert.rejects(
    async () => {
      for await (const _ of adapter.stream({
        model: 'glm-5',
        sessionId: 'ses-redirect-01',
        messages: [{ role: 'user', content: 'hi' }]
      })) {}
    },
    (err) => err?.failure?.code === 'TRANSPORT' && err?.reason === 'http-redirect'
  );
  assert.equal(calls, 1);
  service.dispose();
});

await check('401/403/429/500/斷線 皆僅送 1 次請求不重送，且憑證絕不外洩至錯誤與狀態', async () => {
  assert.equal(GO_NO_RETRY_POLICY.mode, 'off');
  assert.equal(GO_NO_RETRY_POLICY.maxRetries, 0);
  assert.deepEqual(GO_NO_RETRY_POLICY.retryableCodes, []);

  const secret = 'oc_go_leak_test_secret_987654';

  const scenarios = [
    {
      name: '401 invalid key echoing secret',
      handler: async () => jsonRes(401, { error: { type: 'AuthenticationError', message: `Invalid key ${secret}` } }),
      assertErr: (e) => e?.failure?.code === 'AUTH' && e?.reason === 'unauthorized'
    },
    {
      name: '403 EntitlementError',
      handler: async () => jsonRes(403, { error: { type: 'EntitlementError', message: 'Not subscribed to Go' } }),
      assertErr: (e) => e?.failure?.code === 'AUTH' && e?.reason === 'entitlement-required'
    },
    {
      name: '403 privacy policy',
      handler: async () => jsonRes(403, { error: { message: 'Blocked by workspace privacy policy' } }),
      assertErr: (e) => e?.failure?.code === 'AUTH' && e?.reason === 'privacy-policy'
    },
    {
      name: '429 quota exceeded without Retry-After',
      handler: async () => jsonRes(429, { error: { message: 'Rolling quota exhausted' } }),
      assertErr: (e) => e?.failure?.code === 'QUOTA' && e?.reason === 'quota-exceeded' && e?.retryAfterMs === undefined
    },
    {
      name: '429 rate limit with Retry-After',
      handler: async () => jsonRes(429, { error: { message: 'Rate limit exceeded' } }, { 'retry-after': '15' }),
      assertErr: (e) => e?.failure?.code === 'RATE_LIMIT' && e?.reason === 'rate-limited' && e?.retryAfterMs === 15000
    },
    {
      name: '500 upstream error (must not retry)',
      handler: async () => jsonRes(500, { error: { message: 'Internal error' } }),
      assertErr: (e) => e?.failure?.code === 'SERVER' && e?.reason === 'upstream-error'
    },
    {
      name: 'mid-stream disconnect (must not replay)',
      handler: async () => ({
        status: 200,
        ok: true,
        type: 'basic',
        redirected: false,
        headers: { get: () => 'text/event-stream' },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'));
            c.error(new Error(`socket reset with Bearer ${secret}`));
          }
        })
      }),
      assertErr: (e) => e?.failure?.code === 'TRANSPORT'
    }
  ];

  for (const s of scenarios) {
    let calls = 0;
    const { adapter, service } = await setupConnectedAdapter({
      key: secret,
      onChatFetch: async () => {
        calls++;
        return s.handler();
      }
    });
    assert.deepEqual(adapter.providerRetryPolicy('opencode-go-subscription'), GO_NO_RETRY_POLICY);

    let caught = null;
    try {
      for await (const _ of adapter.stream({
        model: 'glm-5',
        sessionId: 'ses-err-01',
        messages: [{ role: 'user', content: 'hi' }]
      })) {}
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, `expected error for ${s.name}`);
    assert.ok(s.assertErr(caught), `unexpected failure shape for ${s.name}: ${caught?.failure?.code}/${caught?.reason}`);
    assert.equal(calls, 1, `must not retry for ${s.name}`);
    assert.equal(String(caught.message).includes(secret), false);
    assert.equal(JSON.stringify(service.getStatus()).includes(secret), false);
    service.dispose();
  }
});

console.log('\n--- Catalog-driven Go image support (including future models) & pre-send rejection ---');

await check('依上游目錄自動開放所有宣告 image/* 的 Go 對話模型（含未來新模型），未宣告圖片模型一律拒絕且不送出請求', async () => {
  const pngBytes = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082',
    'hex'
  );
  const customModels = [
    {
      id: 'hy4-flash-free',
      name: 'HY4 Flash Free',
      type: 'chat',
      limit: { context: 200000, output: 16384 },
      capabilities: { reasoning: true, tool_call: true },
      modalities: { input: ['text', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'], output: ['text'] }
    },
    {
      id: 'future-new-vision-model',
      name: 'Future New Vision Model',
      type: 'chat',
      limit: { context: 1000000, output: 32000 },
      capabilities: { reasoning: true, tool_call: true },
      modalities: { input: ['text', 'image'], output: ['text'] }
    },
    {
      id: 'text-only-pro',
      name: 'Text Only Pro',
      type: 'chat',
      limit: { context: 200000, output: 16384 },
      capabilities: { reasoning: true, tool_call: true },
      modalities: { input: ['text'], output: ['text'] }
    },
    {
      id: 'glm-5',
      name: 'GLM-5',
      type: 'chat',
      limit: { context: 200000, output: 16384 },
      capabilities: { reasoning: true, tool_call: true },
      modalities: { input: null, output: ['text'] }
    }
  ];

  const sentBodies = [];
  let fetchCalls = 0;
  const mockAttachments = {
    async readImageRequest(ref) {
      if (ref.attachmentId === 'sha256:brokenimg') return null;
      return { mediaType: 'image/png', data: pngBytes };
    },
    async readImage(ref) {
      if (ref.attachmentId === 'sha256:brokenimg') throw new Error('missing blob');
      return { ref: { mediaType: 'image/png' }, data: pngBytes };
    }
  };

  const { adapter, service } = await setupConnectedAdapter({
    customModels,
    config: { resolveAttachments: () => mockAttachments },
    onChatFetch: async (url, init) => {
      fetchCalls++;
      assert.equal(url, 'https://opencode.ai/inference/go/openai/v1/chat/completions');
      sentBodies.push(JSON.parse(init.body));
      return sseRes([
        { choices: [{ index: 0, delta: { content: '9H52M5' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { usage: { prompt_tokens: 120, completion_tokens: 6, cost: 0, opencode: { billing_source: 'go', allowance: 0 } } }
      ]);
    }
  });

  const listed = await adapter.listModels('opencode-go-subscription');
  const hy4Desc = listed.find((m) => m.id === 'hy4-flash-free');
  const futureDesc = listed.find((m) => m.id === 'future-new-vision-model');
  const textOnlyDesc = listed.find((m) => m.id === 'text-only-pro');
  const glmDesc = listed.find((m) => m.id === 'glm-5');
  assert.deepEqual(hy4Desc?.inputModalities, ['text', 'image']);
  assert.deepEqual(futureDesc?.inputModalities, ['text', 'image']);
  assert.deepEqual(textOnlyDesc?.inputModalities, ['text']);
  assert.deepEqual(glmDesc?.inputModalities, ['text']);

  const futureResolved = await adapter.resolveModel('opencode-go-subscription', 'future-new-vision-model');
  assert.deepEqual(futureResolved.inputModalities, ['text', 'image']);

  // 1. 合成圖片經既有與未來新視覺模型皆正確送入 image_url 並保留 OpenAI 格式與 Go 計費欄位
  for (const visionModel of ['hy4-flash-free', 'future-new-vision-model']) {
    const chunks = [];
    for await (const chunk of adapter.stream({
      model: visionModel,
      sessionId: `ses-go-vision-${visionModel}`,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is the short code shown in this image?' },
            { type: 'image', attachment: { attachmentId: 'sha256:112233445566', mediaType: 'image/png', width: 320, height: 120, bytes: pngBytes.length } }
          ]
        }
      ]
    })) {
      chunks.push(chunk);
    }
    const lastSent = sentBodies[sentBodies.length - 1];
    assert.equal(lastSent.model, visionModel);
    assert.equal(lastSent.messages[0].role, 'user');
    assert.equal(lastSent.messages[0].content[0].type, 'text');
    assert.equal(lastSent.messages[0].content[1].type, 'image_url');
    assert.equal(lastSent.messages[0].content[1].image_url.url, `data:image/png;base64,${pngBytes.toString('base64')}`);
    assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '9H52M5');
  }
  assert.equal(fetchCalls, 2);
  assert.equal(service.getStatus().lastBilling?.billingSource, 'go');

  // 2. 純文字或能力未知模型附圖時必須直接拒絕且不送請求
  for (const blockedModel of ['text-only-pro', 'glm-5']) {
    await assert.rejects(
      async () => {
        for await (const _ of adapter.stream({
          model: blockedModel,
          sessionId: `ses-reject-${blockedModel}`,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Read image' },
                { type: 'image', attachment: { attachmentId: 'sha256:112233445566', mediaType: 'image/png' } }
              ]
            }
          ]
        })) {}
      },
      (err) => err?.failure?.code === 'INVALID_REQUEST' && err?.reason === 'image-unsupported'
    );
  }
  assert.equal(fetchCalls, 2, '純文字或能力未知模型附圖不可送出上游請求');

  // 3. 讀取圖片失敗時不可靜默丟圖送純文字，應明確拒絕
  await assert.rejects(
    async () => {
      for await (const _ of adapter.stream({
        model: 'hy4-flash-free',
        sessionId: 'ses-go-vision-unreadable',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read broken image' },
              { type: 'image', attachment: { attachmentId: 'sha256:brokenimg', mediaType: 'image/png' } }
            ]
          }
        ]
      })) {}
    },
    (err) => err?.failure?.code === 'INVALID_REQUEST' && err?.reason === 'image-unreadable'
  );
  assert.equal(fetchCalls, 2, '讀圖失敗不可退回純文字送出');

  // 4. 缺乏 attachments 服務時同樣拒絕，不可靜默丟圖
  const adapterNoAtt = new OpenCodeGoAdapter(service, {});
  await assert.rejects(
    async () => {
      for await (const _ of adapterNoAtt.stream({
        model: 'hy4-flash-free',
        sessionId: 'ses-go-vision-no-att',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read image without service' },
              { type: 'image', attachment: { attachmentId: 'sha256:112233445566', mediaType: 'image/png' } }
            ]
          }
        ]
      })) {}
    },
    (err) => err?.failure?.code === 'INVALID_REQUEST' && err?.reason === 'attachments-unavailable'
  );
  assert.equal(fetchCalls, 2);
  service.dispose();
});

await check('若目錄將 hy4-flash-free 縮限為純文字或未知模態，不再宣告圖片且拒絕附圖', async () => {
  let fetchCalls = 0;
  const { adapter, service } = await setupConnectedAdapter({
    customModels: [
      {
        id: 'hy4-flash-free',
        name: 'HY4 Flash Free',
        type: 'chat',
        limit: { context: 200000, output: 16384 },
        modalities: { input: ['text'], output: ['text'] }
      }
    ],
    config: {
      resolveAttachments: () => ({
        async readImage() {
          return { ref: { mediaType: 'image/png' }, data: Buffer.from([1, 2, 3]) };
        }
      })
    },
    onChatFetch: async () => {
      fetchCalls++;
      throw new Error('should not fetch');
    }
  });
  const listed = await adapter.listModels('opencode-go-subscription');
  assert.deepEqual(listed[0]?.inputModalities, ['text']);
  await assert.rejects(
    async () => {
      for await (const _ of adapter.stream({
        model: 'hy4-flash-free',
        sessionId: 'ses-go-revoked-img',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read image' },
              { type: 'image', attachment: { attachmentId: 'sha256:112233445566', mediaType: 'image/png' } }
            ]
          }
        ]
      })) {}
    },
    (err) => err?.failure?.code === 'INVALID_REQUEST' && err?.reason === 'image-unsupported'
  );
  assert.equal(fetchCalls, 0);
  service.dispose();
});

console.log(`\n${failures === 0 ? `✔ Go Stage 2 inference tests passed (${checks} checks)` : `❌ ${failures} / ${checks} checks failed`}`);
if (failures > 0) process.exit(1);
