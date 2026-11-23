import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAccounts, saveAccounts, resolveFromAccounts, resolveFromDshTokenFile, appendAccountCredential, saveDshTokenFile } from '../lib/store.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocoa-accounts-'));
const file = path.join(dir, 'accounts.json');
try {
  assert.equal(loadAccounts(file), null);
  fs.writeFileSync(file, ''); assert.equal(loadAccounts(file), null);
  fs.writeFileSync(file, '{'); assert.equal(loadAccounts(file), null);
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: [] })); assert.equal(loadAccounts(file), null);
  const data = { version: 1, activeId: 'a', accounts: [{ id: 'a', label: 'A', access: 'st_token-a', refresh: 'rt-a', expires: 0 }, { id: 'b', access: 'st_token-b' }] };
  saveAccounts(data, file);
  assert.deepEqual(loadAccounts(file), data);
  assert.deepEqual(resolveFromAccounts(file), { access: 'st_token-a', refresh: 'rt-a', expires: 0, source: 'accounts', accountId: 'a', label: 'A' });
  data.accounts[0].access = 'sk-key'; saveAccounts(data, file); assert.equal(resolveFromAccounts(file), null);
  // The standard resolver remains compatible with the original single-token file.
  const legacy = path.join(dir, 'legacy.json'); fs.writeFileSync(legacy, JSON.stringify({ access: 'st_legacy' }));
  assert.equal(resolveFromDshTokenFile(legacy)?.source, 'dsh-token-file');

  const accountsPath = path.join(dir, 'cli-accounts.json');
  const first = appendAccountCredential(
    { access: 'st_cli', refresh: 'rt', expires: 10, orgId: 'org-1' },
    { accountsPath, label: 'CLI 登入' }
  );
  assert.equal(first.created, true);
  assert.equal(first.alreadyPresent, false);
  const again = appendAccountCredential(
    { access: 'st_cli', refresh: 'rt2', expires: 20, orgId: 'org-1' },
    { accountsPath, label: 'CLI 登入' }
  );
  assert.equal(again.alreadyPresent, true);
  assert.equal(again.accountId, first.accountId);
  const listed = loadAccounts(accountsPath);
  assert.equal(listed.accounts.length, 1);
  assert.equal(listed.activeId, first.accountId);
  assert.equal(listed.accounts[0].refresh, 'rt2');
  assert.equal(listed.accounts[0].orgId, 'org-1');
  assert.equal(listed.accounts[0].label, 'CLI 登入');
  const second = appendAccountCredential(
    { access: 'st_other', refresh: 'rt3', expires: 30 },
    { accountsPath, label: 'CLI 登入' }
  );
  assert.equal(loadAccounts(accountsPath).accounts.length, 2);
  assert.equal(loadAccounts(accountsPath).activeId, second.accountId);
  assert.throws(() => appendAccountCredential({ access: 'sk-nope' }, { accountsPath }), /OAuth token/);
  fs.writeFileSync(path.join(dir, 'broken-accounts.json'), '{');
  assert.throws(
    () => appendAccountCredential({ access: 'st_new' }, { accountsPath: path.join(dir, 'broken-accounts.json') }),
    /refusing to overwrite/
  );
  const tokenFile = path.join(dir, 'with-org.json');
  saveDshTokenFile({ access: 'st_org', refresh: 'rt-org', expires: 9, orgId: 'org-file' }, tokenFile);
  assert.equal(resolveFromDshTokenFile(tokenFile)?.orgId, 'org-file');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log('✔ accounts store tests passed');
