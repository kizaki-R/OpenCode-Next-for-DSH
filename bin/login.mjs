#!/usr/bin/env node

import { requestDeviceCode, pollDeviceToken } from '../lib/device-flow.js';
import { appendAccountCredential, saveDshTokenFile } from '../lib/store.js';
import { spawn } from 'node:child_process';
import os from 'node:os';

async function openBrowser(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
    const platform = os.platform();
    let child;
    if (platform === 'win32') {
      child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', parsed.href], { detached: true, stdio: 'ignore', windowsHide: true });
    } else if (platform === 'darwin') {
      child = spawn('open', [parsed.href], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [parsed.href], { detached: true, stdio: 'ignore' });
    }
    child?.on('error', () => {});
    child?.unref?.();
  } catch {}
}

async function main() {
  console.log('=== OpenCode Console Device Login (dsh-opencode-oauth) ===\n');
  console.log('Requesting device authorization code...');

  try {
    const device = await requestDeviceCode();
    console.log('\n-----------------------------------------------------------');
    console.log('1. Open this URL in your browser:');
    console.log(`   \x1b[36m\x1b[4m${device.verification_url}\x1b[0m`);
    console.log('\n2. Confirm the user code matches:');
    console.log(`   \x1b[32m\x1b[1m${device.user_code}\x1b[0m`);
    console.log('-----------------------------------------------------------\n');

    console.log('Attempting to open browser automatically...');
    await openBrowser(device.verification_url);

    console.log('Waiting for approval in browser (press Ctrl+C to cancel)...');

    const token = await pollDeviceToken(device.device_code, device.interval, device.expires_in);

    const orgId = typeof token.org_id === 'string' ? token.org_id.trim() : '';
    const cred = {
      access: token.access_token,
      refresh: token.refresh_token,
      expires: Math.floor(Date.now() / 1000) + (token.expires_in || 3600),
      ...(orgId ? { orgId } : {})
    };
    const savedPath = saveDshTokenFile(cred);
    // 帳號清單存在時會蓋過舊版單一憑證檔。登入成功必須同步寫進去，
    // 否則 DSH 仍用清單裡的舊帳號，這次授權等於沒發生。
    const account = appendAccountCredential(cred, { label: 'CLI 登入' });

    console.log('\n\x1b[32m✔ Login successful!\x1b[0m');
    console.log(`OAuth credentials saved to: ${savedPath}`);
    console.log(account.alreadyPresent
      ? 'This sign-in was already in the account list; it is now the active account.'
      : 'Account added to the account list and set as active.');
    console.log(`Account list: ${account.path}`);
    console.log('DeepSeek Harness can now use OpenCode models without OpenCode Desktop running.');
  } catch (err) {
    console.error('\n\x1b[31m✖ Login failed:\x1b[0m', err.message);
    process.exit(1);
  }
}

main();
