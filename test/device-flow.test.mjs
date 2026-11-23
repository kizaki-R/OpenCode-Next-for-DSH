import assert from 'node:assert/strict';

import { pollDeviceToken, requestDeviceCode, refreshAccessToken, classifyDeviceLoginError } from '../lib/device-flow.js';

const originalFetch = globalThis.fetch;
const calls = [];
let pollCount = 0;
let mode = 'pending-then-success';

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
    async text() { return JSON.stringify(data); }
  };
}

globalThis.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url: String(url), body });

  if (String(url).endsWith('/device/code')) {
    return response(200, {
      device_code: 'dev-test',
      user_code: 'ABCD-EFGH',
      verification_uri: '/console/device',
      interval: 0,
      expires_in: 10
    });
  }

  if (String(url).endsWith('/device/token')) {
    pollCount++;
    if (mode === 'terminal-error') return response(400, { error: 'invalid_grant' });
    if (pollCount === 1) return response(400, { error: 'authorization_pending' });
    return response(200, {
      access_token: 'st_access-test',
      refresh_token: 'st_refresh-test',
      expires_in: 3600,
      org_id: 'org-test'
    });
  }

  throw new Error(`unexpected URL: ${url}`);
};

try {
  const device = await requestDeviceCode();
  assert.equal(device.user_code, 'ABCD-EFGH');
  assert.equal(device.verification_url, 'https://opencode.ai/console/device');

  const token = await pollDeviceToken('dev-test', 0, 3);
  assert.equal(token.access_token, 'st_access-test');
  assert.equal(token.refresh_token, 'st_refresh-test');

  const tokenCall = calls.find((call) => call.url.endsWith('/device/token'));
  assert.equal(tokenCall.body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(tokenCall.body.client_id, 'opencode-cli');
  assert.equal(tokenCall.body.device_code, 'dev-test');

  mode = 'terminal-error';
  const started = Date.now();
  await assert.rejects(
    () => pollDeviceToken('dev-bad', 0, 5),
    /Device token polling failed with HTTP 400/
  );
  assert.ok(Date.now() - started < 1000, 'terminal OAuth errors should not wait for timeout');

  // Verification URL security: reject insecure or untrusted domains
  globalThis.fetch = async () => response(200, {
    device_code: 'dev-evil',
    user_code: 'EVIL-CODE',
    verification_uri: 'http://opencode.ai/insecure'
  });
  await assert.rejects(
    () => requestDeviceCode(),
    /Insecure or untrusted verification URL/
  );

  globalThis.fetch = async () => response(200, {
    device_code: 'dev-evil',
    user_code: 'EVIL-CODE',
    verification_uri: 'https://evil.example.com/phish'
  });
  await assert.rejects(
    () => requestDeviceCode(),
    /Insecure or untrusted verification URL/
  );

  // Refresh must carry client_id; the upstream rejects it with HTTP 400
  // {"error":"invalid_request","error_description":"client_id is required"}.
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return response(200, {
      access_token: 'st_refreshed',
      refresh_token: 'st_refresh-new',
      expires_in: 3600
    });
  };
  const refreshed = await refreshAccessToken('st_refresh-old');
  const refreshCall = calls[calls.length - 1];
  assert.equal(refreshCall.body.grant_type, 'refresh_token');
  assert.equal(refreshCall.body.refresh_token, 'st_refresh-old');
  assert.equal(refreshCall.body.client_id, 'opencode-cli', 'refresh must send client_id');
  assert.equal(refreshed.access_token, 'st_refreshed');
  assert.equal(refreshed.refresh_token, 'st_refresh-new');

  // A refresh response without an access token must fail loudly, not silently
  // return undefined and leave the caller with no usable credential.
  globalThis.fetch = async () => response(200, { expires_in: 3600 });
  await assert.rejects(
    () => refreshAccessToken('st_refresh-old'),
    /did not contain an access token/
  );

  function hangUntilAbort(_url, options = {}) {
    return new Promise((_resolve, reject) => {
      const signal = options.signal;
      // 真的 fetch 會佔住事件迴圈，直到逾時把連線中止。這個假實作不會，
      // AbortSignal.timeout 的計時器又可能是 unref，行程會在逾時前先結束。
      const keepAlive = setInterval(() => {}, 20);
      const fail = () => {
        clearInterval(keepAlive);
        const err = new Error('The operation was aborted');
        err.name = signal?.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError';
        reject(err);
      };
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    });
  }

  globalThis.fetch = hangUntilAbort;
  await assert.rejects(
    () => requestDeviceCode(undefined, { timeoutMs: 40 }),
    (err) => err?.name === 'TimeoutError' && /timed out/.test(err.message)
  );
  await assert.rejects(
    () => refreshAccessToken('st_refresh-old', { timeoutMs: 40 }),
    (err) => err?.name === 'TimeoutError'
  );

  const abortController = new AbortController();
  const abortedRequest = requestDeviceCode(abortController.signal, { timeoutMs: 5000 });
  abortController.abort();
  await assert.rejects(abortedRequest, (err) => err?.name !== 'TimeoutError');

  let hungOnce = false;
  globalThis.fetch = (url, options = {}) => {
    if (String(url).endsWith('/device/token') && !hungOnce) {
      hungOnce = true;
      return hangUntilAbort(url, options);
    }
    return response(200, {
      access_token: 'st_after-timeout',
      refresh_token: 'st_refresh-after',
      expires_in: 60
    });
  };
  const recovered = await pollDeviceToken('dev-hang', 0, 8, undefined, { timeoutMs: 30 });
  assert.equal(recovered.access_token, 'st_after-timeout');

  const denied = classifyDeviceLoginError(new Error('Device token polling failed with HTTP 400: {"error":"access_denied"}'));
  assert.equal(denied.code, 'denied');
  assert.equal(classifyDeviceLoginError(Object.assign(new Error('Device login polling aborted'), { name: 'AbortError' })), null);
  assert.equal(classifyDeviceLoginError(new Error('Device login timed out after 600 seconds')).code, 'timeout');
  const leaked = classifyDeviceLoginError(new Error('refresh failed for st_secret-token-value'));
  assert.equal(leaked.message.includes('st_'), false);
  assert.match(leaked.message, /\[redacted\]/);

  console.log('✔ Device flow tests passed');
} finally {
  globalThis.fetch = originalFetch;
}
