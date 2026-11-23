import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ModelCatalog } from '../lib/catalog.js';
import { ContextWindowStore, MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW } from '../lib/context-window.js';

const temp = mkdtempSync(join(tmpdir(), 'ocoa-context-window-'));
const settingsPath = join(temp, 'context.json');
const cachePath = join(temp, 'models.json');
let checks = 0;

function check(name, condition) {
  checks++;
  assert.ok(condition, name);
  console.log(`  ok - ${name}`);
}

try {
  console.log('--- Context-window settings ---');
  const store = new ContextWindowStore({ path: settingsPath });
  check('an unset model follows the catalog', store.getOverride('deepseek-v4.1-flash-free') === null);

  store.set('deepseek-v4.1-flash-free', 300000);
  check('manual context value is persisted', JSON.parse(readFileSync(settingsPath, 'utf8')).overrides['deepseek-v4.1-flash-free'] === 300000);
  check('only model ids and numeric overrides are stored', Object.keys(JSON.parse(readFileSync(settingsPath, 'utf8'))).join(',') === 'version,overrides');

  const reloaded = new ContextWindowStore({ path: settingsPath });
  check('manual override survives store recreation', reloaded.getOverride('deepseek-v4.1-flash-free') === 300000);

  const catalog = new ModelCatalog({ probeCachePath: cachePath, contextStore: reloaded });
  catalog.setModels([{
    id: 'deepseek-v4.1-flash-free',
    name: 'DeepSeek V4.1 Flash Free',
    contextWindow: 200000,
    catalogContextWindow: 200000,
    contextSource: 'opencode',
    defaultMaxTokens: 32000,
    inputModalities: ['text'],
    efforts: []
  }]);
  const overridden = catalog.describe('opencode-next', 'deepseek-v4.1-flash-free');
  check('provider descriptor uses manual context override', overridden.context.contextWindow === 300000);
  check('model list uses the same effective context value', catalog.getModels()[0].contextWindow === 300000);
  check('provider descriptor leaves output limit unchanged', overridden.defaultMaxTokens === 32000);
  check('catalog reports the override and original catalog value separately',
    catalog.getCandidates()[0].contextOverride === 300000
      && catalog.getCandidates()[0].catalogContextWindow === 200000
      && catalog.getCandidates()[0].contextSource === 'custom');
  check('status probe row includes effective and default values',
    catalog.getProbeResults()[0].contextWindow === 300000
      && catalog.getProbeResults()[0].catalogContextWindow === 200000);
  // 上游目錄的 `limit.output` 要送到狀態頁，否則使用者問「最大值是多少」
  // 時只能猜——這個欄位以前只活在 describe() 裡。
  check('status probe row exposes the upstream output limit',
    catalog.getProbeResults()[0].maxOutputTokens === 32000,
    String(catalog.getProbeResults()[0].maxOutputTokens));

  reloaded.set('deepseek-v4.1-flash-free', 310000);
  check('a changed override takes effect without rebuilding the catalog',
    catalog.describe('opencode-next', 'deepseek-v4.1-flash-free').context.contextWindow === 310000);
  check('setting one model does not affect another', reloaded.getOverride('some-other-model') === null);

  check('reset reports that an override was removed', reloaded.reset('deepseek-v4.1-flash-free') === true);
  const restored = catalog.describe('opencode-next', 'deepseek-v4.1-flash-free');
  check('reset immediately restores the catalog capacity', restored.context.contextWindow === 200000);
  check('reset removes custom source metadata', catalog.getModel('deepseek-v4.1-flash-free').contextSource === 'opencode');
  check('reset persists an empty override map', Object.keys(JSON.parse(readFileSync(settingsPath, 'utf8')).overrides).length === 0);
  check('resetting a model twice is harmless', reloaded.reset('deepseek-v4.1-flash-free') === false);

  for (const bad of [0, -1, 1.5, '300000', Number.MAX_SAFE_INTEGER, MIN_CONTEXT_WINDOW - 1, MAX_CONTEXT_WINDOW + 1]) {
    assert.throws(() => reloaded.set('bad-model', bad));
  }
  check('invalid and out-of-range values are rejected', reloaded.getOverride('bad-model') === null);
  assert.throws(() => reloaded.set('', 300000));
  check('empty model ids are rejected', true);

  writeFileSync(settingsPath, JSON.stringify({
    version: 1,
    overrides: { valid: 250000, invalid: 0, fractional: 1.5 }
  }));
  const sanitized = new ContextWindowStore({ path: settingsPath });
  check('valid persisted entries load while malformed entries are ignored',
    sanitized.getOverride('valid') === 250000
      && sanitized.getOverride('invalid') === null
      && sanitized.getOverride('fractional') === null);

  writeFileSync(settingsPath, JSON.stringify({ version: 2, overrides: { stale: 123456 } }));
  const oldVersion = new ContextWindowStore({ path: settingsPath });
  check('unknown settings versions safely fall back to catalog defaults', oldVersion.getOverride('stale') === null);
  check('settings file remains a local optional value', existsSync(settingsPath));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`✔ Context-window tests passed (${checks} checks)`);
