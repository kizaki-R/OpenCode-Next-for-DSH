/**
 * 模型勾選（選擇器顯示名單）的迴歸測試。
 *
 * 這份測試守的是一個很容易寫壞的地方：**發佈名單是「探測可用 ∩ 使用者勾選」**。
 *
 * 會壞掉的方式很具體：
 *
 *   - 勾選取代了探測 → 使用者把明知不通的模型留在選擇器頂端，每次選到都失敗。
 *   - 第一次勾選把其他模型都清掉 → 使用者只改了一個，其他十幾個卻突然消失。
 *   - 手動模式下新探測通過的模型自動冒出來 → 使用者以為勾選功能壞了。
 *   - 復原後仍停在手動模式 → 「顯示全部」按了沒反應。
 *   - 設定檔壞掉就整頁掛掉 → 該退回自動模式照常運作。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ModelCatalog } from '../lib/catalog.js';
import { PickerStore, normalizeShownList } from '../lib/picker.js';
import { STATIC_FREE_MODELS } from '../lib/constants.js';

console.log('--- Testing Picker Curation ---');

const temp = mkdtempSync(path.join(os.tmpdir(), 'opencode-picker-'));
const originalFetch = globalThis.fetch;

const ids = {
  keep: 'keep-model-free',
  drop: 'drop-model-free',
  retired: 'retired-model-free',
  fresh: 'fresh-model-free'
};

const modelCatalog = Object.fromEntries(
  [...STATIC_FREE_MODELS, ...Object.values(ids).map((id) => ({ id, name: id, contextWindow: 128000, defaultMaxTokens: 8192 }))]
    .map((model) => [model.id, {
      name: model.name,
      cost: { input: 0, output: 0 },
      limit: { context: model.contextWindow, output: model.defaultMaxTokens }
    }])
);

let responder = null;

function ok(id) {
  return { id, ok: true, status: 200, ms: 10, reason: null };
}
function failure(id, status, reason) {
  return { id, ok: false, status, ms: 10, reason, detail: `upstream ${status}` };
}

async function sweep(catalog, errors = {}) {
  // retired 永久 410：它的狀態不該被後續 sweep 的預設 ok 洗回來。
  const merged = { [ids.retired]: failure(ids.retired, 410, 'deprecated'), ...errors };
  return catalog.refreshAvailability('test-token', async (_token, probeIds) => ({
    results: probeIds.map((id) => merged[id] ?? ok(id)),
    blocked: false,
    tested: probeIds.length,
    total: probeIds.length
  }));
}

const pickerIds = (catalog) => catalog.getModels().map((model) => model.id).sort();

try {
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).includes('models.opencode.ai')) {
      return { ok: true, async json() { return { opencode: { models: modelCatalog } }; } };
    }
    let requestModel = null;
    try { requestModel = JSON.parse(init.body ?? '{}')?.model ?? null; } catch {}
    const response = responder?.(requestModel) ?? { status: 200, body: '{}' };
    return {
      status: response.status,
      async text() { return response.body ?? ''; },
      async json() { return JSON.parse(response.body ?? '{}'); }
    };
  };

  // ---------------------------------------------------------------- normalize
  assert.deepEqual(normalizeShownList(null), [], 'non-array input becomes an empty list');
  assert.deepEqual(normalizeShownList([' a ', 'a', '', 3, null, 'b']), ['a', 'b'],
    'normalization trims, de-duplicates, and drops non-strings');
  assert.equal(normalizeShownList(Array.from({ length: 600 }, (_, i) => `m${i}`)).length, 500,
    'the shown list is capped');

  // ---------------------------------------------------------------- 舊行為
  {
    const catalog = new ModelCatalog({
      probeCachePath: path.join(temp, 'no-store.json'),
      pickerStore: null
    });
    await catalog.init();
    await sweep(catalog);
    // 沒接勾選 store 的 catalog 行為必須與舊版完全相同：探測可用就發佈。
    assert.equal(catalog.pickerState(), null, 'a catalog without a picker store reports no picker state');
    assert.equal(catalog.getModels().length > 0, true, 'availability still publishes without a picker store');
    assert.equal(catalog.setPickerShown(ids.keep, false), null, 'no store means no curation');
    console.log('  ok - a catalog without a picker store behaves exactly as before');
  }

  // ---------------------------------------------------------------- auto 模式
  const store = new PickerStore({ path: path.join(temp, 'picker.json') });
  const catalog = new ModelCatalog({
    probeCachePath: path.join(temp, 'cache.json'),
    pickerStore: store
  });
  await catalog.init();
    // fresh 先是失敗候選，手動模式下才被修好；retired 由 sweep() 固定 410。
  await sweep(catalog, {
    [ids.fresh]: failure(ids.fresh, 400, 'unavailable')
  });

  {
    const state = catalog.pickerState();
    assert.equal(state.mode, 'auto', 'a fresh store starts in auto mode');
    assert.equal(pickerIds(catalog).includes(ids.keep), true, 'auto mode publishes verified models');
    assert.equal(pickerIds(catalog).includes(ids.drop), true, 'auto mode publishes every verified model');
    assert.equal(pickerIds(catalog).includes(ids.retired), false, 'auto mode still hides retired models');
    // auto 模式下 shown 帶的是「現在會顯示的名單」，讓第一次勾選時狀態不跳動。
    assert.equal(state.shown.includes(ids.keep), true, 'auto mode reports the currently shown list');
    assert.equal(state.shown.includes(ids.retired), false, 'auto mode does not claim a retired model is shown');
    console.log('  ok - auto mode publishes every verified model');
  }

  // ---------------------------------------------------------------- 第一次勾選
  {
    const before = pickerIds(catalog);
    const state = catalog.setPickerShown(ids.drop, false);
    assert.equal(state.mode, 'manual', 'the first toggle switches to manual mode');
    const after = pickerIds(catalog);
    assert.equal(after.includes(ids.drop), false, 'an unchecked model leaves the picker');
    assert.deepEqual(after, before.filter((id) => id !== ids.drop),
      'the first toggle only removes that one model, keeping the rest of the list');

    const row = new Map(catalog.getProbeResults().map((r) => [r.id, r]));
    assert.equal(row.get(ids.drop).shown, false, 'diagnostics report the unchecked row as not shown');
    assert.equal(row.get(ids.keep).shown, true, 'diagnostics keep the checked row shown');
    assert.equal(row.get(ids.drop).available, true,
      'an unchecked model is still available — hiding it is a preference, not a verdict');
    console.log('  ok - the first toggle snapshots the visible list into manual mode');
  }

  // ---------------------------------------------------------------- 手動模式下新模型
  {
    // 手動模式下探測才通過的新候選（本來是失敗的），不該自動放進選擇器。
    // 這裡用 fresh：它在第一次全量探測時是「不可用」，手動模式後才被修好。
    await sweep(catalog, { [ids.fresh]: ok(ids.fresh) });
    assert.equal(pickerIds(catalog).includes(ids.fresh), false,
      'a newly verified model stays out of the picker in manual mode');
    const row = new Map(catalog.getProbeResults().map((r) => [r.id, r]));
    assert.equal(row.get(ids.fresh).ok, true, 'the new model is recorded as available');
    assert.equal(row.get(ids.fresh).shown, false, 'but it is reported as not shown');

    const state = catalog.setPickerShown(ids.fresh, true);
    assert.equal(pickerIds(catalog).includes(ids.fresh), true, 'checking it publishes it');
    assert.equal(state.shown.includes(ids.fresh), true, 'the state reports it as shown');
    console.log('  ok - manual mode does not auto-publish newly verified models');
  }

  // ---------------------------------------------------------------- 勾選不改探測
  {
    // 先用兩次失敗把 keep 從可用名單剔除（遲滯規則：連續失敗兩次才退場）。
    await sweep(catalog, { [ids.keep]: failure(ids.keep, 400, 'unavailable') });
    await sweep(catalog, { [ids.keep]: failure(ids.keep, 400, 'unavailable') });
    assert.equal(catalog.isAvailable(ids.keep), false, 'two consecutive failures retire a model');

    const state = catalog.setPickerShown(ids.keep, true);
    assert.equal(state !== null, true, 'a known candidate can still be checked');
    assert.equal(pickerIds(catalog).includes(ids.keep), false,
      'checking an unavailable model does not force it into the picker');
    assert.equal(new Map(catalog.getProbeResults().map((r) => [r.id, r])).get(ids.keep).shown, false,
      'an unavailable model is reported as not shown even when checked');

    assert.equal(catalog.setPickerShown('no-such-model', true), null, 'unknown ids are rejected');
    console.log('  ok - curation never overrides availability');
  }

  // ---------------------------------------------------------------- 429 仍算有效
  {
    // 使用者明確要求：可用＝上游有效，不是當下問得到。
    // 429（額度用完／被限流）代表上游認得這個模型，不能把它踢出清單。
    const rateCatalog = new ModelCatalog({
      probeCachePath: path.join(temp, 'rate-cache.json'),
      pickerStore: new PickerStore({ path: path.join(temp, 'rate-picker.json') })
    });
    await rateCatalog.init();
    await sweep(rateCatalog, {
      [ids.keep]: failure(ids.keep, 429, 'rate-limited'),
      [ids.drop]: failure(ids.drop, 429, 'rate-limited'),
      [ids.fresh]: failure(ids.fresh, 429, 'rate-limited')
    });

    const rows = new Map(rateCatalog.getProbeResults().map((r) => [r.id, r]));
    assert.equal(rows.get(ids.keep).ok, false, 'a throttled probe is not a success');
    assert.equal(rows.get(ids.keep).valid, true, 'but it is upstream-valid');
    assert.equal(rows.get(ids.keep).available, true, 'a throttled model stays in the published set');
    assert.equal(rows.get(ids.keep).failureStreak, 0, 'throttling does not count as a failure');

    const published = rateCatalog.getModels().map((m) => m.id);
    assert.equal(published.includes(ids.keep), true, 'a throttled model is published to the picker');
    assert.equal(published.includes(ids.fresh), true,
      'a brand-new candidate that answers 429 is valid upstream, so it is published');

    // 連續多輪限流都不該把模型踢掉。
    for (let i = 0; i < 3; i++) {
      await sweep(rateCatalog, { [ids.keep]: failure(ids.keep, 429, 'rate-limited') });
    }
    assert.equal(rateCatalog.isAvailable(ids.keep), true,
      'repeated throttling never retires a valid model');

    // 勾選框仍可操作：使用者有權決定要不要留著它。
    const state = rateCatalog.setPickerShown(ids.keep, false);
    assert.equal(state !== null, true, 'a throttled model can still be unchecked');
    assert.equal(rateCatalog.getModels().some((m) => m.id === ids.keep), false,
      'unchecking a throttled model removes it from the picker');

    // 但真正的下架（410）仍然立即移除。
    await sweep(rateCatalog, { [ids.drop]: failure(ids.drop, 410, 'deprecated') });
    const after410 = new Map(rateCatalog.getProbeResults().map((r) => [r.id, r]));
    assert.equal(after410.get(ids.drop).valid, false, 'a 410 model is not valid');
    assert.equal(rateCatalog.getModels().some((m) => m.id === ids.drop), false,
      'a 410 model is removed even when checked');

    console.log('  ok - rate limiting never retires a valid model');
  }

  // ---------------------------------------------------------------- 持久化
  {
    const saved = JSON.parse(readFileSync(path.join(temp, 'picker.json'), 'utf8'));
    assert.equal(saved.mode, 'manual', 'manual mode is persisted');
    assert.equal(saved.version, 1, 'the file carries a version');

    const reopened = new PickerStore({ path: path.join(temp, 'picker.json') });
    const state = reopened.get();
    assert.equal(state.mode, 'manual', 'the store reopens in manual mode');
    assert.equal(state.shown.includes(ids.drop), false, 'the unchecked model stays unchecked after a restart');
    assert.equal(state.shown.includes(ids.fresh), true, 'the checked model stays checked after a restart');
    console.log('  ok - curation survives a restart');
  }

  // ---------------------------------------------------------------- 復原
  {
    const state = catalog.resetPicker();
    assert.equal(state.mode, 'auto', 'reset returns to auto mode');
    assert.equal(pickerIds(catalog).includes(ids.drop), true, 'reset restores every available model');
    assert.equal(pickerIds(catalog).includes(ids.fresh), true, 'reset restores models checked in manual mode');
    assert.equal(pickerIds(catalog).includes(ids.retired), false, 'reset never restores a retired model');
    console.log('  ok - reset restores auto mode');
  }

  // ---------------------------------------------------------------- 壞檔
  {
    const brokenPath = path.join(temp, 'broken.json');
    writeFileSync(brokenPath, '{ not json', 'utf8');
    const broken = new PickerStore({ path: brokenPath });
    assert.deepEqual(broken.get(), { mode: 'auto', shown: [] },
      'a corrupt file falls back to auto mode instead of throwing');
    const written = broken.set({ mode: 'manual', shown: ['x'] });
    assert.deepEqual(written, { mode: 'manual', shown: ['x'] }, 'a corrupt file is replaced on the next write');
    console.log('  ok - a corrupt file degrades to auto mode');
  }
} finally {
  globalThis.fetch = originalFetch;
  rmSync(temp, { recursive: true, force: true });
}

console.log('\n✔ Picker tests passed');
