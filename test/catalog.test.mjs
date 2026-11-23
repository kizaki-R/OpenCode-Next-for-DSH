import { ModelCatalog, fetchLiveCatalog } from '../lib/catalog.js';

console.log('--- Testing Catalog ---');
const catalog = new ModelCatalog();
const models = await catalog.init();

console.log(`Loaded ${models.length} active free models:`);
for (const m of models) {
  console.log(` - ${m.id.padEnd(30)} [${m.name}] modalities: ${m.inputModalities.join(',')} reasoning: ${m.efforts.length > 0}`);
}

const desc = catalog.describe('opencode-oauth', 'deepseek-v4.1-flash-free');
console.log('\nDescriptor for deepseek-v4.1-flash-free:');
console.log(JSON.stringify(desc, null, 2));

console.log('\n✔ Catalog module tests passed!');
