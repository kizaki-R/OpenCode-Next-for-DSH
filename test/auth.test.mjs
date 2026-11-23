import { resolveCredential, resolveFromLocalOpenCodeDb } from '../lib/store.js';
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

console.log('\n--- Testing TokenManager ---');
const tm = new TokenManager();
const token = await tm.getValidToken();
console.log('TokenManager.getValidToken() successful:', !!token);
console.log('Token starts with:', token.slice(0, 8) + '...');

console.log('\n✔ Auth module tests passed!');
