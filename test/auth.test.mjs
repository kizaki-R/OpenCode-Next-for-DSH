import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCredential, resolveFromLocalOpenCodeDb, saveAccounts, saveDshTokenFile } from '../lib/store.js';
import { TokenManager } from '../lib/token-manager.js';

console.log('--- Testing Store ---');
const localCred = resolveFromLocalOpenCodeDb();
console.log('Local DB credential resolved:', !!localCred);
if (localCred) {
  console.log('  Source:', localCred.source);
  console.log('  Access token length:', localCred.access?.length);
  console.log('  Refresh token length:', localCred.refresh?.length);
}

const resolved = resolveCredential();
console.log('Resolved credential from master resolver:', !!resolved);

console.log('\n--- Testing TokenManager (isolated fixture) ---');
const sandbox = mkdtempSync(join(tmpdir(), 'opencode-next-auth-'));
try {
  const tokenPath = join(sandbox, 'token.json');
  const accountsPath = join(sandbox, 'accounts.json');
  const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
  saveDshTokenFile(
    {
      access: 'st_test_offline_access_token_0001',
      refresh: 'rt_test_offline_refresh_token_0001',
      expires: futureExpiry
    },
    tokenPath
  );
  saveAccounts(
    {
      version: 1,
      activeId: 'acc-test-1',
      accounts: [
        {
          id: 'acc-test-1',
          label: 'Test Account',
          access: 'st_test_offline_access_token_0001',
          refresh: 'rt_test_offline_refresh_token_0001',
          expires: futureExpiry,
          addedAt: Date.now(),
          lastUsedAt: Date.now()
        }
      ]
    },
    accountsPath
  );

  const tm = new TokenManager(tokenPath, accountsPath);
  const token = await tm.getValidToken();
  assert.equal(token, 'st_test_offline_access_token_0001');
  console.log('TokenManager.getValidToken() successful:', !!token);
  console.log('Token starts with:', token.slice(0, 8) + '...');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('\n✔ Auth module tests passed!');
