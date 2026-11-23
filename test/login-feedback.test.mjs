/**
 * 背景授權失敗必須出現在 /status，不能被靜默吃掉。
 *
 * 使用正式的 web-api.js 與 device-flow.js，只替換 fetch。不連上游、不寫真憑證。
 */
import { registerWebApi } from '../lib/web-api.js';

let failures = 0;
let checks = 0;
function check(name, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${name}${cond ? '' : `  ${detail}`}`);
}

const originalFetch = globalThis.fetch;
let mode = 'deny';

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
    async text() { return JSON.stringify(data); }
  };
}

globalThis.fetch = (url, options = {}) => {
  const target = String(url);
  if (target.endsWith('/device/code')) {
    return Promise.resolve(jsonResponse(200, {
      device_code: 'dev-feedback',
      user_code: 'CODE-1',
      verification_uri: 'https://opencode.ai/device',
      interval: 5,
      expires_in: 900
    }));
  }
  if (target.endsWith('/device/token')) {
    if (mode === 'deny') {
      return Promise.resolve(jsonResponse(400, {
        error: 'access_denied',
        access_token: 'st_should-not-leak'
      }));
    }
    if (mode === 'hang') {
      return new Promise((_resolve, reject) => {
        const fail = () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (options.signal?.aborted) fail();
        else options.signal?.addEventListener('abort', fail, { once: true });
      });
    }
    return Promise.resolve(jsonResponse(200, {
      access_token: 'st_access-test',
      refresh_token: 'st_refresh-test',
      expires_in: 3600,
      org_id: 'org-from-device'
    }));
  }
  return Promise.reject(new Error(`unexpected URL: ${target}`));
};

const added = [];
const tokenManager = {
  listAccounts: () => [],
  addAccount(cred) {
    added.push({ orgId: cred.orgId ?? null, access: cred.access });
    return 'acc-test';
  },
  async switchTo() { return true; },
  clearCache() {},
  async getValidToken() { return 'fake-token'; },
  async refresh() { return { refreshed: true }; },
  describeCredential: () => ({ present: false, source: 'test' })
};
const catalog = {
  invalidateProbe() {},
  getProbeResults: () => [],
  async refreshAvailability() { return { results: [] }; }
};
const statusReporter = {
  buildStatus: () => ({
    health: 'signed-out',
    credential: { present: false },
    models: { models: [] },
    config: {}
  })
};

let handler = null;
registerWebApi(
  {
    inject(_name, fn) {
      fn({
        effect(run) { run(); },
        webServer: { register({ handler: next }) { handler = next; return { dispose() {} }; } }
      });
    },
    effect() {}
  },
  { tokenManager, catalog, statusReporter, config: {} }
);

function makeRes() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    body: '',
    done: false,
    setHeader() {},
    writeHead(code, hdrs) {
      this.statusCode = code;
      this.headersSent = true;
      Object.assign(this.headers, hdrs ?? {});
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.from(String(body)));
      this.body = Buffer.concat(chunks).toString('utf8');
      this.done = true;
    },
    on() {}
  };
}

async function hit(method, route) {
  const res = makeRes();
  await handler({ method, url: `/opencode-next/api${route}`, headers: {}, on() {} }, res);
  for (let i = 0; i < 50 && !res.done; i++) await new Promise((r) => setTimeout(r, 10));
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* 非 JSON 時留給斷言 */ }
  return { status: res.statusCode, json, body: res.body };
}

try {
  console.log('\n--- 授權被拒絕 ---');
  mode = 'deny';
  const deniedLogin = await hit('POST', '/login');
  check('拒絕情境仍立刻回裝置碼', deniedLogin.json?.value?.userCode === 'CODE-1', JSON.stringify(deniedLogin.json));
  await new Promise((r) => setTimeout(r, 40));
  const deniedStatus = await hit('GET', '/status');
  check('拒絕後 pendingLogin 已清掉', deniedStatus.json?.value?.pendingLogin == null);
  check('拒絕寫進 loginError', deniedStatus.json?.value?.loginError?.code === 'denied',
    JSON.stringify(deniedStatus.json?.value?.loginError));
  check('狀態頁沒有帶出權杖', !deniedStatus.body.includes('st_'), deniedStatus.body.slice(0, 240));

  console.log('\n--- 取消不是失敗 ---');
  mode = 'hang';
  await hit('POST', '/login');
  await hit('POST', '/login/cancel');
  await new Promise((r) => setTimeout(r, 40));
  const cancelled = await hit('GET', '/status');
  check('取消後沒有 loginError', cancelled.json?.value?.loginError == null,
    JSON.stringify(cancelled.json?.value?.loginError));
  check('取消後沒有 pendingLogin', cancelled.json?.value?.pendingLogin == null);

  console.log('\n--- 成功時帶上 org id，並清掉舊錯誤 ---');
  mode = 'ok';
  await hit('POST', '/login');
  await new Promise((r) => setTimeout(r, 40));
  const okStatus = await hit('GET', '/status');
  check('成功後沒有 loginError', okStatus.json?.value?.loginError == null,
    JSON.stringify(okStatus.json?.value?.loginError));
  check('成功的帳號帶有 org id', added.at(-1)?.orgId === 'org-from-device', JSON.stringify(added.at(-1)));
  check('成功的帳號沒有把權杖放進狀態頁', !okStatus.body.includes('st_access-test'));
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\n${failures === 0 ? `✔ Login feedback tests passed (${checks} checks)` : `❌ ${failures} / ${checks} checks failed`}`);
if (failures > 0) process.exit(1);
