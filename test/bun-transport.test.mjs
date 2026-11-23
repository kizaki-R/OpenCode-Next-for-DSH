import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { environmentPayload, executeBunFetch, prepareBunRequest } from '../lib/bun-transport.js';
import { probeModel } from '../lib/probe.js';
import { OpenCodeOAuthAdapter } from '../lib/adapter.js';

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn(); pass++; console.log(`  ok - ${name}`);
  } catch (error) {
    fail++; console.error(`  FAIL - ${name}: ${error?.message ?? error}`);
  }
}

console.log('--- Bun transport request preparation (offline) ---');
const payload = {
  model: 'glm-5.3-flash-free',
  stream: true,
  messages: [
    { role: 'system', content: 'You are DSH. Preserve all host instructions.' },
    { role: 'user', content: [{ type: 'text', text: 'Say OK' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,eA==' } }] }
  ],
  tools: [{ type: 'function', function: { name: 'host_tool', parameters: { type: 'object', properties: {} } } }],
  tool_choice: 'auto',
  max_tokens: 128
};
const init = {
  method: 'POST',
  headers: {
    authorization: 'Bearer oauth-secret-must-not-leak',
    'content-type': 'application/json',
    'user-agent': 'Node test',
    'x-opencode-client': 'cli',
    'x-opencode-session': 'ses_test',
    'x-opencode-session-id': 'ses_test',
    'x-opencode-request': 'req_remove',
    'x-opencode-project': 'prj_remove',
    cookie: 'remove-me',
    'x-stainless-runtime': 'node'
  },
  body: JSON.stringify(payload)
};

const prepared = await prepareBunRequest('https://opencode.ai/inference/openai/v1/chat/completions', init, { clientVersion: '2.0.32' });
const headers = new Headers(prepared.headers);
const sentBody = JSON.parse(prepared.body);
await check('uses exact OpenCode v2 chat endpoint', () => assert.equal(prepared.url, 'https://opencode.ai/inference/openai/v1/chat/completions'));
await check('keeps the caller Bearer credential', () => assert.equal(headers.get('authorization'), 'Bearer oauth-secret-must-not-leak'));
await check('sets the installed OpenCode 2.0.32 CLI user agent', () => assert.equal(headers.get('user-agent'), 'opencode/latest/2.0.32/cli'));
await check('preserves caller project ID and drops refused request header', () => {
  assert.equal(headers.get('x-opencode-project'), 'prj_remove');
  assert.equal(headers.get('x-opencode-request'), null);
});
await check('keeps required session id and host affinity headers', () => {
  assert.equal(headers.get('x-opencode-session'), 'ses_test');
  assert.equal(headers.get('x-opencode-session-id'), 'ses_test');
});
await check('strips cookie and Node telemetry headers', () => {
  assert.equal(headers.get('cookie'), null);
  assert.equal(headers.get('x-stainless-runtime'), null);
});
await check('injects env metadata without changing host tool/history/options', () => {
  assert.match(sentBody.messages[0].content, /You are DSH/);
  assert.match(sentBody.messages[0].content, /Workspace root folder:/);
  assert.match(sentBody.messages[0].content, /Is directory a git repo:/);
  assert.deepEqual(sentBody.messages[1], payload.messages[1]);
  assert.deepEqual(sentBody.tools, payload.tools);
  assert.equal(sentBody.tool_choice, payload.tool_choice);
  assert.equal(sentBody.max_tokens, payload.max_tokens);
});
await check('does not mutate the caller body', () => assert.deepEqual(JSON.parse(init.body), payload));
await check('already-present env is not duplicated', () => {
  const body = JSON.stringify({ messages: [{ role: 'system', content: 'Existing\n<env>host</env>' }, { role: 'user', content: 'Hi' }] });
  assert.equal(environmentPayload(body), body);
});
await check('only inference origin and exact allowlisted endpoints are accepted', async () => {
  await assert.rejects(prepareBunRequest('https://opencode.ai/inference/v1/models', init), /non-inference/);
  await assert.rejects(prepareBunRequest('https://example.com/inference/openai/v1/chat/completions', init), /non-inference/);
  await assert.rejects(prepareBunRequest('https://opencode.ai.evil.test/inference/openai/v1/chat/completions', init), /non-inference/);
  await assert.rejects(prepareBunRequest('https://opencode.ai/inference/openai/v1/chat/completions?token=x', init), /non-inference/);
});
await check('only POST is allowed', async () => assert.rejects(prepareBunRequest('https://opencode.ai/inference/openai/v1/chat/completions', { ...init, method: 'GET' }), /POST/));
await check('Responses payload preserves existing instructions and input while adding env', () => {
  const body = JSON.stringify({ instructions: 'Host policy', input: [{ role: 'user', content: 'Hello' }], tools: [{ type: 'function', name: 'tool' }] });
  const result = JSON.parse(environmentPayload(body, 'win32'));
  assert.match(result.instructions, /Host policy/);
  assert.match(result.instructions, /Platform: win32/);
  assert.deepEqual(result.input, [{ role: 'user', content: 'Hello' }]);
  assert.deepEqual(result.tools, [{ type: 'function', name: 'tool' }]);
});

console.log('\n--- Bun worker streaming integration (local fixture; no network) ---');
const temp = mkdtempSync(path.join(tmpdir(), 'ocoa-bun-transport-'));
const fixturePath = path.join(temp, 'worker.mjs');
const bunExe = process.env.BUN_EXE || (process.env.APPDATA
  ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'bun', 'bin', 'bun.exe')
  : 'bun');
const fixture = String.raw`
const chunks=[]; for await (const c of process.stdin) chunks.push(c);
const input=JSON.parse(Buffer.concat(chunks).toString());
const headers=new Headers(input.headers); const body=JSON.parse(input.body);
if (!/^Bearer \S+$/.test(headers.get('authorization')||'')) throw new Error('missing bearer');
if (!/^opencode\/latest\/2\.0\.32\/cli$/.test(headers.get('user-agent')||'')) throw new Error('missing installed UA');
if (!headers.has('x-opencode-project') || headers.has('x-opencode-request')) throw new Error('bad disguise headers');
if (headers.has('cookie') || headers.has('x-stainless-runtime')) throw new Error('noisy headers leaked');
if (!body.messages.some(m=>m.role==='system' && String(m.content).includes('<env>'))) throw new Error('env absent');
if(body.model==='probe-error'||body.model==='adapter-error'){process.stdout.write(JSON.stringify({error:'fixture Bun failure'})+'\\n');process.exit(1)}
const limited=body.model==='probe-rate';
process.stdout.write(JSON.stringify({status:limited?429:200,statusText:limited?'Too Many Requests':'OK',headers:[['content-type',limited?'application/json':'text/event-stream'],['x-fixture','bun'],['retry-after','15']]} )+'\n');
if(limited) process.stdout.write(JSON.stringify({error:{type:'FreeUsageLimitError',message:'Free usage limit reached'}}));
else if(body.model==='adapter-test') {
  const nl=String.fromCharCode(10);
  for(const frame of [
    {id:'test',choices:[{index:0,delta:{content:'bun-adapter-ok'},finish_reason:null}]},
    {id:'test',choices:[{index:0,delta:{},finish_reason:'stop'}]}
  ]) process.stdout.write('data: '+JSON.stringify(frame)+nl+nl);
  process.stdout.write('data: [DONE]'+nl+nl);
} else { process.stdout.write('data: one\\n\\n'); await new Promise(r=>setTimeout(r,5)); process.stdout.write('data: two\\n\\n'); }
`;
writeFileSync(fixturePath, fixture, 'utf8');
try {
  const response = await executeBunFetch('https://opencode.ai/inference/openai/v1/chat/completions', init, {
    bunPath: bunExe,
    workerPath: fixturePath,
    timeoutMs: 5000
  });
  const output = await response.text();
  await check('fixture receives sanitized v2 request, emits real status and stream bytes', () => {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-fixture'), 'bun');
    assert.equal(output, 'data: one\\n\\ndata: two\\n\\n');
  });
  await check('OpenCodeOAuthAdapter inference is sent through configured Bun worker', async () => {
    const fakeModel = { id: 'adapter-test', name: 'Adapter Test', defaultMaxTokens: 128, inputModalities: ['text'] };
    const fakeCatalog = {
      getModel: (id) => id === fakeModel.id ? fakeModel : null,
      getModels: () => [fakeModel],
      isAvailable: () => true
    };
    const fakeTokenManager = {
      async acquireCredential() { return { token: 'oauth-token-never-forwarded' }; },
      async getValidToken() { return 'oauth-token-never-forwarded'; }
    };
    const adapter = new OpenCodeOAuthAdapter(fakeCatalog, fakeTokenManager, {
      bunTransport: { enabled: true, bunPath: bunExe, workerPath: fixturePath, timeoutMs: 5000 }
    });
    try {
      const chunks = [];
      for await (const chunk of adapter.stream({
        provider: 'opencode-next', model: fakeModel.id,
        messages: [{ role: 'user', content: 'Say OK' }],
        tools: [], maxTokens: 32
      })) chunks.push(chunk);
      assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'bun-adapter-ok'));
      assert.ok(chunks.some((chunk) => chunk.type === 'finish' && chunk.reason?.kind === 'stop'));
    } finally { adapter.dispose(); }
  });
  await check('adapter does not hide Bun worker failure behind a Node retry', async () => {
    const fakeModel = { id: 'adapter-error', name: 'Adapter Error', defaultMaxTokens: 128, inputModalities: ['text'] };
    const fakeCatalog = { getModel: () => fakeModel, getModels: () => [fakeModel], isAvailable: () => true };
    const fakeTokenManager = { async acquireCredential() { return { token: 'oauth-token' }; }, async getValidToken() { return 'oauth-token'; } };
    const original = globalThis.fetch;
    let nodeFetchCalled = false;
    globalThis.fetch = async () => { nodeFetchCalled = true; throw new Error('Node fetch must not run'); };
    const adapter = new OpenCodeOAuthAdapter(fakeCatalog, fakeTokenManager, {
      bunTransport: { enabled: true, bunPath: bunExe, workerPath: fixturePath, timeoutMs: 5000 }
    });
    try {
      await assert.rejects(async () => {
        for await (const _chunk of adapter.stream({
          provider: 'opencode-next', model: fakeModel.id,
          messages: [{ role: 'user', content: 'Say OK' }], tools: [], maxTokens: 32
        })) {}
      }, /TRANSPORT|Bun/);
      assert.equal(nodeFetchCalled, false);
    } finally { adapter.dispose(); globalThis.fetch = original; }
  });
  await check('probeModel routes requests through configured Bun worker', async () => {
    const result = await probeModel('test-oauth-token', 'probe-ok', {
      bunTransport: { enabled: true, bunPath: bunExe, workerPath: fixturePath, timeoutMs: 5000 }
    });
    assert.equal(result.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.reachable, true);
  });
  await check('probeModel returns Bun upstream 429 without falling back to Node fetch', async () => {
    const result = await probeModel('test-oauth-token', 'probe-rate', {
      bunTransport: { enabled: true, bunPath: bunExe, workerPath: fixturePath, timeoutMs: 5000 }
    });
    assert.equal(result.status, 429);
    assert.equal(result.ok, false);
    assert.equal(result.reachable, true);
  });
  await check('missing Bun executable becomes transport error instead of crashing the process', async () => {
    const result = await probeModel('test-oauth-token', 'probe-ok', {
      bunTransport: { enabled: true, bunPath: path.join(temp, 'missing-bun.exe'), workerPath: fixturePath, timeoutMs: 1000 }
    });
    assert.equal(result.status, 'ERR');
    assert.equal(result.reason, 'transport');
  });
  await check('probeModel surfaces Bun worker failure and never silently switches to Node fetch', async () => {
    const original = globalThis.fetch;
    let nodeFetchCalled = false;
    globalThis.fetch = async () => { nodeFetchCalled = true; throw new Error('Node fetch should not be used'); };
    try {
      const result = await probeModel('test-oauth-token', 'probe-error', {
        bunTransport: { enabled: true, bunPath: bunExe, workerPath: fixturePath, timeoutMs: 5000 }
      });
      assert.equal(result.status, 'ERR');
      assert.equal(result.reason, 'transport');
      assert.equal(nodeFetchCalled, false);
    } finally { globalThis.fetch = original; }
  });
} catch (error) {
  await check('local Bun worker is available for transport integration', () => { throw error; });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? `✔ Bun transport tests passed (${pass} checks)` : `✘ ${fail}/${pass + fail} checks failed`}`);
if (fail > 0) process.exit(1);
