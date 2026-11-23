import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenManager } from '../lib/token-manager.js';
import { saveAccounts, AutoSwitchStore } from '../lib/store.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocoa-switch-'));
const file = path.join(dir, 'accounts.json');
try {
  saveAccounts({ version: 1, activeId: 'a', accounts: [
    { id: 'a', label: 'Alpha', access: 'st_alpha', refresh: 'rt_alpha', expires: 0 },
    { id: 'b', label: 'Beta', access: 'st_beta', refresh: 'rt_beta', expires: 0 }
  ] }, file);
  const autoFile = path.join(dir, 'autoswitch.json');
  const autoSwitch = new AutoSwitchStore({ path: autoFile });
  assert.equal(autoSwitch.get().enabled, false, 'auto-switch defaults off');
  assert.equal(autoSwitch.set({ enabled: true }).enabled, true);
  assert.equal(new AutoSwitchStore({ path: autoFile }).get().enabled, true, 'setting persists');

  const manager = new TokenManager(undefined, file);
  const listed = manager.listAccounts();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].isActive, true);
  assert.equal('access' in listed[0], false);
  assert.equal('refresh' in listed[0], false);
  await manager.switchTo('b');
  assert.equal(await manager.getValidToken(), 'st_beta');
  assert.equal(await manager.switchToNextAccount('b', { version: 0 }), null, 'stale request snapshot cannot rotate after a manual switch');

  const raceFile = path.join(dir, 'race-accounts.json');
  saveAccounts({ version: 1, activeId: 'a', accounts: [
    { id: 'a', label: 'Alpha', access: 'st_a', refresh: 'rt_a', expires: 0 },
    { id: 'b', label: 'Beta', access: 'st_b_old', refresh: 'rt_b_old', expires: 1 }
  ] }, raceFile);
  const racingManager = new TokenManager(undefined, raceFile, {
    async refreshAccessToken() {
      const latest = JSON.parse(fs.readFileSync(raceFile, 'utf8'));
      const b = latest.accounts.find((entry) => entry.id === 'b');
      b.access = 'st_b_new';
      b.refresh = 'rt_b_new';
      b.expires = 0;
      saveAccounts(latest, raceFile);
      return { access_token: 'st_stale_refresh', refresh_token: 'rt_stale_refresh', expires_in: 3600 };
    }
  });
  await racingManager.switchTo('b');
  const raceResult = JSON.parse(fs.readFileSync(raceFile, 'utf8'));
  assert.equal(raceResult.activeId, 'b');
  assert.equal(raceResult.accounts.find((entry) => entry.id === 'b').access, 'st_b_new', 'stale refresh cannot overwrite newer account credential');

  manager.removeAccount('a');
  assert.throws(() => manager.removeAccount('b'), /At least one account/);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log('✔ account switching tests passed');
