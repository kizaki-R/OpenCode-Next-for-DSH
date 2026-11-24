/**
 * OpenCode Go 憑證解析與隔離測試（離線）。
 *
 * 驗證：
 *   1. Config 預設關閉 `goSubscription.enabled`，且不包含任何明文 API key 欄位。
 *   2. 優先使用 DSH `credentials` 服務，不可用或查無資料時退回環境變數。
 *   3. 拒絕把明文 key（`oc_*`/`sk-*`/`st_*`）直接寫入 `credentialRef`。
 *   4. 拒絕免費 OAuth 憑證（`st_*`）混入 Go 通道，且絕不讀取 OAuth 檔案或 `org_id`。
 *   5. `describeGoCredential` 與 `redactSecret` 絕不外洩任何密鑰本體或片段。
 */

import assert from 'node:assert/strict';
import { Config, resolveConfig } from '../lib/config.js';
import {
  clearGoCredential,
  describeGoCredential,
  fingerprintSecret,
  redactSecret,
  resolveGoCredential,
  saveGoCredential,
  validateCredentialRef
} from '../lib/go/credentials.js';

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

console.log('--- Config defaults & secret-free schema ---');

await check('goSubscription 預設開啟且可明確關閉', () => {
  const cfg = resolveConfig({});
  assert.equal(cfg.goSubscription?.enabled, true);
  assert.equal(cfg.goSubscription?.providerId, 'opencode-go-subscription');
  assert.equal(cfg.goSubscription?.credentialRef, 'OPENCODE_GO_API_KEY');
  assert.equal('apiKey' in cfg.goSubscription, false);
  assert.equal('secret' in cfg.goSubscription, false);
  assert.equal('token' in cfg.goSubscription, false);
  assert.equal(resolveConfig({ goSubscription: { enabled: false } }).goSubscription?.enabled, false);
  assert.ok(Config);
});

await check('validateCredentialRef 拒絕明文密鑰與空白', () => {
  assert.equal(validateCredentialRef('OPENCODE_GO_API_KEY').valid, true);
  assert.equal(validateCredentialRef('opencode.go/personal-key').valid, true);
  assert.equal(validateCredentialRef('').valid, false);
  assert.equal(validateCredentialRef('oc_sk_secret123456').valid, false);
  assert.equal(validateCredentialRef('sk-secret123456').valid, false);
  assert.equal(validateCredentialRef('st_oauth_token_123').valid, false);
  assert.equal(validateCredentialRef('Bearer abcdef').valid, false);
  assert.equal(validateCredentialRef('KEY WITH SPACE').valid, false);
});

console.log('\n--- Credential resolution & isolation ---');

await check('優先使用 DSH 安全憑證服務（ctx.get("credentials").resolve）', async () => {
  const seenRefs = [];
  const ctx = {
    get(name) {
      if (name === 'credentials') {
        return {
          async resolve(ref) {
            seenRefs.push(ref);
            return { value: 'oc_go_dsh_fake_key_998877' };
          }
        };
      }
      return undefined;
    }
  };
  const resolved = await resolveGoCredential({
    ctx,
    credentialRef: 'OPENCODE_GO_API_KEY',
    env: { OPENCODE_GO_API_KEY: 'oc_go_env_fallback_should_not_win' }
  });
  assert.deepEqual(seenRefs, ['OPENCODE_GO_API_KEY']);
  assert.equal(resolved.present, true);
  assert.equal(resolved.source, 'dsh-credentials');
  assert.equal(resolved.key, 'oc_go_dsh_fake_key_998877');
  assert.equal(resolved.dshCredentialsAvailable, true);
  assert.ok(resolved.fingerprint && resolved.fingerprint.length === 16);
});

await check('DSH 憑證服務不可用或無值時，退回環境變數', async () => {
  const ctxEmpty = {
    get() {
      return { async resolve() { return null; } };
    }
  };
  const resolved = await resolveGoCredential({
    ctx: ctxEmpty,
    credentialRef: 'OPENCODE_GO_API_KEY',
    env: { OPENCODE_GO_API_KEY: '  oc_go_env_fake_key_112233  ' }
  });
  assert.equal(resolved.present, true);
  assert.equal(resolved.source, 'env');
  assert.equal(resolved.key, 'oc_go_env_fake_key_112233');
  assert.equal(resolved.dshCredentialsAvailable, true);

  const noService = await resolveGoCredential({
    ctx: null,
    env: { OPENCODE_GO_API_KEY: 'oc_go_env_only_445566' }
  });
  assert.equal(noService.present, true);
  assert.equal(noService.source, 'env');
  assert.equal(noService.dshCredentialsAvailable, false);
});

await check('無憑證時不讀取 OAuth 或 org_id，直接回報未設定', async () => {
  const resolved = await resolveGoCredential({
    ctx: null,
    env: { OPENCODE_ORG_ID: 'org_should_not_be_used' }
  });
  assert.equal(resolved.present, false);
  assert.equal(resolved.key, null);
  assert.equal(resolved.source, null);
  assert.equal(resolved.error, null);
});

await check('拒絕把免費 OAuth st_* token 當成 Go API key', async () => {
  const resolved = await resolveGoCredential({
    ctx: null,
    env: { OPENCODE_GO_API_KEY: 'st_oauth_free_token_should_reject' }
  });
  assert.equal(resolved.present, false);
  assert.equal(resolved.key, null);
  assert.equal(resolved.error, 'invalid-credential-type');
  assert.equal(resolved.message.includes('st_oauth'), false);
});

await check('describeGoCredential 與 redactSecret 絕不外洩任何密鑰', async () => {
  const secret = 'oc_go_top_secret_value_abcdef123456';
  const resolved = await resolveGoCredential({
    ctx: null,
    env: { OPENCODE_GO_API_KEY: secret }
  });
  const described = describeGoCredential(resolved);
  const json = JSON.stringify(described);

  assert.equal(described.present, true);
  assert.equal(described.source, 'env');
  assert.equal(described.ref, 'OPENCODE_GO_API_KEY');
  assert.equal(described.masked, '••••');
  assert.equal('key' in described, false);
  assert.equal('apiKey' in described, false);
  assert.equal(json.includes(secret), false);
  assert.equal(json.includes(secret.slice(0, 8)), false);
  assert.equal(json.includes(secret.slice(-6)), false);
  assert.equal(described.fingerprint, fingerprintSecret(secret));

  const redacted = redactSecret(
    `Request failed with Authorization: Bearer ${secret} and key ${secret}`,
    secret
  );
  assert.equal(redacted.includes(secret), false);
  assert.ok(redacted.includes('[REDACTED]'));
});

console.log('\n--- Save / Clear via DSH credentials service ---');

await check('saveGoCredential 與 clearGoCredential 透過 DSH 憑證服務寫入與清除且優先於環境變數', async () => {
  const store = new Map();
  const ops = [];
  const ctx = {
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

  const savedKey = 'oc_go_saved_via_dsh_11223344';
  const envOnly = { OPENCODE_GO_API_KEY: 'oc_go_env_secondary_55667788' };

  const saveRes = await saveGoCredential({ ctx, credentialRef: 'OPENCODE_GO_API_KEY', key: `  ${savedKey}  ` });
  assert.equal(saveRes.ok, true);
  assert.equal(store.get('OPENCODE_GO_API_KEY'), savedKey);

  const resolvedSaved = await resolveGoCredential({ ctx, credentialRef: 'OPENCODE_GO_API_KEY', env: envOnly });
  assert.equal(resolvedSaved.present, true);
  assert.equal(resolvedSaved.source, 'dsh-credentials');
  assert.equal(resolvedSaved.key, savedKey);
  assert.equal(resolvedSaved.canSave, true);
  assert.equal(resolvedSaved.canClear, true);

  const metaJson = JSON.stringify(describeGoCredential(resolvedSaved));
  assert.equal(metaJson.includes(savedKey), false);
  assert.equal(metaJson.includes('11223344'), false);

  const clearRes = await clearGoCredential({ ctx, credentialRef: 'OPENCODE_GO_API_KEY' });
  assert.equal(clearRes.ok, true);
  assert.equal(store.has('OPENCODE_GO_API_KEY'), false);

  const resolvedFallback = await resolveGoCredential({ ctx, credentialRef: 'OPENCODE_GO_API_KEY', env: envOnly });
  assert.equal(resolvedFallback.present, true);
  assert.equal(resolvedFallback.source, 'env');
  assert.equal(resolvedFallback.key, envOnly.OPENCODE_GO_API_KEY);

  const resolvedEmpty = await resolveGoCredential({ ctx, credentialRef: 'OPENCODE_GO_API_KEY', env: {} });
  assert.equal(resolvedEmpty.present, false);
  assert.equal(resolvedEmpty.source, null);
  assert.ok(ops.some(([op, ref]) => op === 'set' && ref === 'OPENCODE_GO_API_KEY'));
  assert.ok(ops.some(([op, ref]) => op === 'unset' && ref === 'OPENCODE_GO_API_KEY'));
});

await check('saveGoCredential 拒絕把 OAuth st_* token 與空字串存入 Go 憑證', async () => {
  let setCalled = 0;
  const ctx = {
    credentials: {
      async resolve() { return null; },
      async set() { setCalled++; },
      async unset() {}
    }
  };
  const oauthRes = await saveGoCredential({ ctx, credentialRef: 'OPENCODE_GO_API_KEY', key: 'st_oauth_secret_should_reject_1234' });
  assert.equal(oauthRes.ok, false);
  assert.equal(oauthRes.error, 'invalid_credential_type');
  assert.equal(oauthRes.message.includes('st_oauth'), false);

  const emptyRes = await saveGoCredential({ ctx, credentialRef: 'OPENCODE_GO_API_KEY', key: '   ' });
  assert.equal(emptyRes.ok, false);
  assert.equal(emptyRes.error, 'empty_key');
  assert.equal(setCalled, 0);
});

await check('缺少 credentials.set 時明確拒絕儲存，不提供寫盤退回', async () => {
  const ctxReadOnly = {
    credentials: {
      async resolve() { return null; }
    }
  };
  const resolved = await resolveGoCredential({ ctx: ctxReadOnly, env: {} });
  assert.equal(resolved.dshCredentialsAvailable, true);
  assert.equal(resolved.canSave, false);
  assert.equal(resolved.canClear, false);

  const res1 = await saveGoCredential({ ctx: ctxReadOnly, key: 'oc_go_should_not_persist_9988' });
  assert.equal(res1.ok, false);
  assert.equal(res1.error, 'credentials_write_unavailable');
  assert.equal(res1.message.includes('9988'), false);

  const res2 = await saveGoCredential({ ctx: null, key: 'oc_go_should_not_persist_9988' });
  assert.equal(res2.ok, false);
  assert.equal(res2.error, 'credentials_write_unavailable');
});

console.log(`\n${failures === 0 ? `✔ Go credential tests passed (${checks} checks)` : `❌ ${failures} / ${checks} checks failed`}`);
if (failures > 0) process.exit(1);
