import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ModelCatalog } from '../lib/catalog.js';
import { createStatusReporter } from '../lib/status.js';
import { probeModels } from '../lib/probe.js';
import { PROBE_CACHE_TTL_MS, STATIC_FREE_MODELS } from '../lib/constants.js';

console.log('--- Testing Catalog Availability State Machine ---');

const temp = mkdtempSync(path.join(os.tmpdir(), 'opencode-availability-'));
const originalFetch = globalThis.fetch;
const ids = {
  steady: 'steady-model-free',
  flaky: 'flaky-model-free',
  unavailable: 'unavailable-model-free',
  notFound: 'retired-not-found-free',
  deprecated: 'retired-deprecated-free',
  fresh: 'fresh-model-free'
};
const extraModels = Object.values(ids).map((id) => [id, {
  name: id,
  cost: { input: 0, output: 0 },
  limit: { context: 128000, output: 8192 }
}]);
const modelCatalog = Object.fromEntries([
  ...STATIC_FREE_MODELS.map((model) => [model.id, {
    name: model.name,
    cost: { input: 0, output: 0 },
    limit: { context: model.contextWindow, output: model.defaultMaxTokens }
  }]),
  ...extraModels
]);

function ok(id) {
  return { id, ok: true, status: 200, ms: 12, reason: null };
}
function failure(id, status, reason) {
  return { id, ok: false, status, ms: 15, reason, detail: `upstream ${status}` };
}

let inferenceResponder = null;
async function withInferenceResponder(responder, fn) {
  const previous = inferenceResponder;
  inferenceResponder = responder;
  try {
    return await fn();
  } finally {
    inferenceResponder = previous;
  }
}

function statusFor(targetCatalog) {
  return createStatusReporter({
    tokenManager: { describeCredential: () => ({ present: true, expired: false, expiringSoon: false }) },
    catalog: targetCatalog
  }).buildStatus();
}

function assertStatusMatchesPicker(targetCatalog, label) {
  const status = statusFor(targetCatalog);
  const rowAvailable = status.models.models.filter((model) => model.available).length;
  assert.equal(status.models.available, targetCatalog.getModels().length, `${label}: summary matches picker`);
  assert.equal(status.models.available, rowAvailable, `${label}: summary matches diagnostic rows`);
  return status;
}

try {
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).includes('models.opencode.ai')) {
      return {
        ok: true,
        async json() { return { opencode: { models: modelCatalog } }; }
      };
    }
    let requestModel = null;
    try { requestModel = JSON.parse(init.body ?? '{}')?.model ?? null; } catch {}
    const response = inferenceResponder?.(requestModel) ?? {
      status: 402,
      body: JSON.stringify({ error: { message: 'Account quota exceeded' } })
    };
    return {
      status: response.status,
      async text() { return response.body ?? ''; },
      body: { async cancel() {} }
    };
  };

  const cachePath = path.join(temp, 'availability-v2.json');
  const catalog = new ModelCatalog({ probeCachePath: cachePath });
  await catalog.init();

  assert.equal(catalog.getCandidates().some((model) => model.id === ids.fresh), true,
    'the public catalog retains new entries as candidates');
  assert.equal(catalog.getModels().some((model) => model.id === ids.fresh), false,
    'an unprobed new candidate is not yet published to the picker');

  async function sweep(target, errors = {}) {
    return target.refreshAvailability('test-token', async (_token, probeIds) => ({
      results: probeIds.map((id) => errors[id] ?? ok(id)),
      blocked: false,
      tested: probeIds.length,
      total: probeIds.length
    }));
  }

  const first = await sweep(catalog, {
    // 用 400 當「真的失敗」的樣本：429 已經改判為「模型有效、只是排不進去」，
    // 不再是失敗（見下面的 429 斷言）。
    [ids.fresh]: failure(ids.fresh, 400, 'unavailable')
  });
  assert.equal(first.applied, true);
  let pickerIds = new Set(catalog.getModels().map((model) => model.id));
  assert.equal(pickerIds.has(ids.notFound), true, 'successful probing publishes an existing model before retirement checks');
  assert.equal(pickerIds.has(ids.deprecated), true, 'successful probing publishes an existing model before retirement checks');
  assert.equal(pickerIds.has(ids.fresh), false, 'a first 400 is a transient failure and does not yet publish a new model');
  assert.equal(catalog.getCandidates().some((model) => model.id === ids.notFound), true,
    'retired candidates remain in the plugin catalog');
  let diagnostics = new Map(catalog.getProbeResults().map((result) => [result.id, result]));
  assert.equal(diagnostics.get(ids.notFound).status, 200);
  assert.equal(diagnostics.get(ids.notFound).probed, true);
  assert.equal(Number.isFinite(diagnostics.get(ids.notFound).probedAt), true,
    'hidden model diagnostics retain the probe time');

  // A blocked channel may contain partial results, but none of them is a model
  // verdict. Availability, diagnostics, counters, and the persisted cache stay put.
  const beforeBlockedIds = catalog.getModels().map((model) => model.id).sort();
  const beforeBlockedRows = JSON.stringify(catalog.getProbeResults());
  const beforeBlockedCache = readFileSync(cachePath, 'utf8');
  const blocked = await catalog.refreshAvailability('test-token', async (_token, probeIds) => ({
    results: [failure(probeIds[0], 401, 'unauthorized')],
    blocked: true,
    blockedReason: 'unauthorized',
    tested: 1,
    total: probeIds.length
  }));
  assert.equal(blocked.applied, false);
  assert.deepEqual(catalog.getModels().map((model) => model.id).sort(), beforeBlockedIds);
  assert.equal(JSON.stringify(catalog.getProbeResults()), beforeBlockedRows);
  assert.equal(readFileSync(cachePath, 'utf8'), beforeBlockedCache,
    'blocked probes do not write a partial cache');

  const inconclusive = await catalog.refreshAvailability('test-token', async (_token, probeIds) => ({
    results: [ok(probeIds[0])],
    blocked: false,
    tested: 1,
    total: probeIds.length
  }));
  assert.equal(inconclusive.applied, false, 'an incomplete sweep is inconclusive');
  assert.deepEqual(catalog.getModels().map((model) => model.id).sort(), beforeBlockedIds);
  assert.equal(JSON.stringify(catalog.getProbeResults()), beforeBlockedRows);

  const beforeGeneric404Ids = catalog.getModels().map((model) => model.id).sort();
  const beforeGeneric404Rows = JSON.stringify(catalog.getProbeResults());
  const beforeGeneric404Cache = readFileSync(cachePath, 'utf8');
  const genericEndpoint404 = await withInferenceResponder(() => ({
    status: 404,
    body: JSON.stringify({ error: { message: 'Cannot POST /v1/chat/completions' } })
  }), () => catalog.refreshAvailability('test-token', probeModels, { concurrency: 1 }));
  assert.equal(genericEndpoint404.blocked, true, 'generic endpoint 404 is inconclusive for model availability');
  assert.equal(genericEndpoint404.blockedReason, 'endpoint-not-found');
  assert.equal(genericEndpoint404.applied, false);
  assert.deepEqual(catalog.getModels().map((model) => model.id).sort(), beforeGeneric404Ids,
    'generic endpoint 404 cannot hide any published model');
  assert.equal(JSON.stringify(catalog.getProbeResults()), beforeGeneric404Rows,
    'generic endpoint 404 does not create model tombstones or replace diagnostics');
  assert.equal(readFileSync(cachePath, 'utf8'), beforeGeneric404Cache,
    'generic endpoint 404 does not rewrite availability cache');
  assertStatusMatchesPicker(catalog, 'blocked generic 404');

  const candidateCountBefore404 = catalog.getCandidates().length;
  const notFoundSweep = await withInferenceResponder((modelId) => modelId === ids.notFound
    ? {
        status: 404,
        body: JSON.stringify({ error: { type: 'ModelNotFoundError', message: `Model ${modelId} was not found` } })
      }
    : { status: 200 },
  () => catalog.refreshAvailability('test-token', probeModels, { concurrency: 1 }));
  assert.equal(notFoundSweep.applied, true);
  assert.equal(notFoundSweep.tested, candidateCountBefore404,
    'model-specific 404 is probed alongside successful responses for all other candidates');
  pickerIds = new Set(catalog.getModels().map((model) => model.id));
  assert.equal(pickerIds.has(ids.notFound), false, 'a confirmed model-specific 404 hides a previously published model immediately');
  assert.equal(pickerIds.has(ids.deprecated), true, 'the separately tested 410 model remains published');
  diagnostics = new Map(catalog.getProbeResults().map((result) => [result.id, result]));
  assert.equal(diagnostics.get(ids.notFound).reason, 'not-found');
  assert.equal(diagnostics.get(ids.notFound).status, 404);
  assert.match(diagnostics.get(ids.notFound).detail, /Model .* was not found/);
  assert.equal(diagnostics.get(ids.notFound).available, false);
  assert.equal(diagnostics.get(ids.notFound).failureStreak, 0,
    'authoritative model-specific 404 does not accumulate a transient failure streak');
  const notFoundStatus = assertStatusMatchesPicker(catalog, 'terminal not-found');
  assert.equal(notFoundStatus.models.models.find((model) => model.id === ids.notFound).detail,
    diagnostics.get(ids.notFound).detail, 'status diagnostics retain the model-specific 404 body');

  const candidateCountBefore410 = catalog.getCandidates().length;
  const deprecatedSweep = await withInferenceResponder((modelId) => modelId === ids.deprecated
    ? {
        status: 410,
        body: JSON.stringify({ error: { type: 'ModelDeprecated', message: `Model ${modelId} has been deprecated` } })
      }
    : { status: 200 },
  () => catalog.refreshAvailability('test-token', probeModels, { concurrency: 1 }));
  assert.equal(deprecatedSweep.applied, true);
  assert.equal(deprecatedSweep.tested, candidateCountBefore410);
  pickerIds = new Set(catalog.getModels().map((model) => model.id));
  assert.equal(pickerIds.has(ids.deprecated), false, 'an already-published model leaves after one 410');
  assert.equal(pickerIds.has(ids.notFound), true,
    'the 410 verdict is tested separately from the 404 verdict');
  diagnostics = new Map(catalog.getProbeResults().map((result) => [result.id, result]));
  assert.equal(diagnostics.get(ids.deprecated).reason, 'deprecated');
  assert.equal(diagnostics.get(ids.deprecated).status, 410);
  assert.match(diagnostics.get(ids.deprecated).detail, /has been deprecated/);
  assert.equal(diagnostics.get(ids.deprecated).failureStreak, 0,
    'authoritative 410 does not advance a transient failure streak');
  const deprecatedStatus = assertStatusMatchesPicker(catalog, 'terminal deprecated');
  assert.equal(deprecatedStatus.models.models.find((model) => model.id === ids.deprecated).detail,
    diagnostics.get(ids.deprecated).detail, 'status diagnostics retain the 410 response body');

  const firstTransient = await sweep(catalog, {
    [ids.notFound]: failure(ids.notFound, 404, 'not-found'),
    [ids.deprecated]: failure(ids.deprecated, 410, 'deprecated'),
    [ids.flaky]: failure(ids.flaky, 429, 'rate-limited'),
    [ids.unavailable]: failure(ids.unavailable, 400, 'unavailable'),
    [ids.fresh]: failure(ids.fresh, 429, 'rate-limited')
  });
  assert.equal(firstTransient.applied, true);
  pickerIds = new Set(catalog.getModels().map((model) => model.id));
  assert.equal(pickerIds.has(ids.flaky), true, 'a rate-limited model stays published: the model is valid, only the request was throttled');
  assert.equal(pickerIds.has(ids.unavailable), true, '400 unavailable is not authoritative retirement');
  assert.equal(pickerIds.has(ids.fresh), true, 'a first 429 validates and publishes a new candidate');
  assert.equal(pickerIds.has(ids.steady), true,
    'one model failure does not clear availability for other models');
  assert.equal(pickerIds.has(ids.notFound), false);
  assert.equal(pickerIds.has(ids.deprecated), false);
  diagnostics = new Map(catalog.getProbeResults().map((result) => [result.id, result]));
  // 429 不算失敗次數：模型有效，只是這次排不進去。
  assert.equal(diagnostics.get(ids.flaky).failureStreak, 0,
    'a rate-limited model does not accumulate failure streaks');
  assert.equal(diagnostics.get(ids.fresh).valid, true,
    'a 429 result for a new candidate proves upstream recognizes it');
  assert.equal(diagnostics.get(ids.flaky).valid, true,
    'a rate-limited model is still reported as upstream-valid');
  assert.equal(diagnostics.get(ids.unavailable).failureStreak, 1);
  assert.equal(diagnostics.get(ids.notFound).failureStreak, 0);
  assert.equal(diagnostics.get(ids.deprecated).failureStreak, 0);
  const transientStatus = assertStatusMatchesPicker(catalog, 'first transient failure');
  const flakyStatusRow = transientStatus.models.models.find((model) => model.id === ids.flaky);
  assert.equal(flakyStatusRow.ok, false, 'status diagnostics retain the latest transient throttle');
  assert.equal(flakyStatusRow.valid, true, 'the throttled model is still upstream-valid');
  assert.equal(flakyStatusRow.available, true, 'a rate-limited model stays published');
  assert.equal(flakyStatusRow.detail, 'upstream 429', 'status diagnostics retain the transient failure detail');

  const savedV2 = JSON.parse(readFileSync(cachePath, 'utf8'));
  assert.equal(savedV2.version, 2);
  // 用 400 的模型驗持久化：429 已不再累積失敗次數。
  assert.equal(savedV2.failureStreaks[ids.unavailable], 1,
    'the one-failure hysteresis state is persisted');
  assert.equal(savedV2.failureStreaks[ids.flaky], undefined,
    'a rate-limited model never enters the failure-streak cache');
  assert.equal(savedV2.fullProbedAt, savedV2.probedAt,
    'a full sweep updates both diagnostic and freshness timestamps');

  // A real 402 quota response is channel/account-wide. Two consecutive rounds
  // must not apply partial model failures or change any persisted state.
  const beforeQuotaIds = catalog.getModels().map((model) => model.id).sort();
  const beforeQuotaRows = JSON.stringify(catalog.getProbeResults());
  const beforeQuotaCache = readFileSync(cachePath, 'utf8');
  for (let round = 0; round < 2; round++) {
    const quota = await catalog.refreshAvailability('test-token', probeModels, { concurrency: 1 });
    assert.equal(quota.applied, false, `402 round ${round + 1} stays inconclusive`);
    assert.equal(quota.blocked, true, `402 round ${round + 1} is classified as a blocked lane`);
    assert.equal(quota.blockedReason, 'quota-exceeded');
    assert.deepEqual(catalog.getModels().map((model) => model.id).sort(), beforeQuotaIds);
    assert.equal(JSON.stringify(catalog.getProbeResults()), beforeQuotaRows,
      'quota blocks do not replace diagnostics or increment streaks');
    assert.equal(readFileSync(cachePath, 'utf8'), beforeQuotaCache,
      'quota blocks do not rewrite the availability cache');
  }
  assertStatusMatchesPicker(catalog, 'blocked quota');

  // Restart from the persisted v2 state: ordinary model-specific failures keep
  // their hysteresis, while HTTP 429 remains upstream-valid and does not count.
  const restarted = new ModelCatalog({ probeCachePath: cachePath });
  await restarted.init();
  pickerIds = new Set(restarted.getModels().map((model) => model.id));
  assert.equal(pickerIds.has(ids.flaky), true, 'restart preserves current picker availability');
  diagnostics = new Map(restarted.getProbeResults().map((result) => [result.id, result]));
  assert.equal(diagnostics.get(ids.flaky).failureStreak, 0,
    'a throttled model never accumulates a failure streak across a restart');

  const third = await sweep(restarted, {
    [ids.notFound]: failure(ids.notFound, 404, 'not-found'),
    [ids.deprecated]: failure(ids.deprecated, 410, 'deprecated'),
    [ids.flaky]: failure(ids.flaky, 429, 'rate-limited'),
    [ids.unavailable]: failure(ids.unavailable, 400, 'unavailable'),
    [ids.fresh]: failure(ids.fresh, 429, 'rate-limited')
  });
  assert.equal(third.applied, true);
  pickerIds = new Set(restarted.getModels().map((model) => model.id));
  // 兩次 429 之後仍然發佈：限流不是退役，模型在上游依然有效。
  assert.equal(pickerIds.has(ids.flaky), true,
    'repeated rate limiting never hides a model: the model is valid, only the request was throttled');
  assert.equal(pickerIds.has(ids.unavailable), false, 'ambiguous 400 is hidden only after the second consecutive failure');
  assert.equal(pickerIds.has(ids.fresh), true, 'a first 429 immediately publishes a new upstream-valid model');
  assert.equal(pickerIds.has(ids.steady), true, 'other successful models remain available');
  assert.equal(pickerIds.has(ids.notFound), false);
  assert.equal(pickerIds.has(ids.deprecated), false);
  diagnostics = new Map(restarted.getProbeResults().map((result) => [result.id, result]));
  assert.equal(diagnostics.get(ids.flaky).available, true);
  assert.equal(diagnostics.get(ids.flaky).valid, true);
  assert.equal(diagnostics.get(ids.flaky).failureStreak, 0);
  assert.equal(diagnostics.get(ids.unavailable).failureStreak, 2,
    'the ambiguous 400 model is the one that reaches the hysteresis threshold');
  assert.equal(diagnostics.get(ids.notFound).probed, true,
    'hidden retired candidates remain in diagnostics');
  assert.equal(diagnostics.get(ids.notFound).failureStreak, 0);
  assert.equal(diagnostics.get(ids.deprecated).reason, 'deprecated');
  assert.equal(diagnostics.get(ids.deprecated).failureStreak, 0,
    'authoritative 410 removes immediately without advancing a transient streak');

  const fourth = await sweep(restarted, {
    [ids.notFound]: failure(ids.notFound, 404, 'not-found'),
    [ids.deprecated]: failure(ids.deprecated, 410, 'deprecated'),
    [ids.flaky]: ok(ids.flaky),
    [ids.unavailable]: ok(ids.unavailable),
    [ids.fresh]: ok(ids.fresh)
  });
  assert.equal(fourth.applied, true);
  pickerIds = new Set(restarted.getModels().map((model) => model.id));
  assert.equal(pickerIds.has(ids.flaky), true, 'a successful probe immediately restores a hidden model');
  assert.equal(pickerIds.has(ids.unavailable), true, 'a successful probe restores an ambiguous-400 model');
  diagnostics = new Map(restarted.getProbeResults().map((result) => [result.id, result]));
  assert.equal(diagnostics.get(ids.flaky).failureStreak, 0, 'success clears the consecutive failure state');
  assert.equal(diagnostics.get(ids.unavailable).failureStreak, 0);

  // Incremental results update diagnostics and availability, but do not move
  // the full-sweep clock used by startup freshness checks.
  assert.equal(restarted.isProbeFresh(60_000), true);
  const fullSweepAt = JSON.parse(readFileSync(cachePath, 'utf8')).fullProbedAt;
  const incrementalId = 'incremental-only-free';
  restarted.setModels([...restarted.getCandidates(), { id: incrementalId, name: incrementalId }]);
  const incremental = await restarted.refreshAvailability('test-token', async (_token, probeIds) => ({
    results: probeIds.map((id) => ok(id)),
    blocked: false,
    tested: probeIds.length,
    total: probeIds.length
  }), { incremental: true });
  assert.equal(incremental.applied, true);
  assert.equal(incremental.added.includes(incrementalId), true,
    'incremental success publishes the candidate');
  const afterIncrementalCache = JSON.parse(readFileSync(cachePath, 'utf8'));
  assert.equal(afterIncrementalCache.fullProbedAt, fullSweepAt,
    'incremental probe does not advance the full-sweep freshness timestamp');
  assert.equal(afterIncrementalCache.probedAt >= fullSweepAt, true,
    'the latest result timestamp still advances for diagnostics');

  // A full sweep requested during an incremental sweep must queue rather than
  // inheriting its narrower promise. The blocked incremental result stays inert;
  // the queued full sweep then probes every current candidate.
  const queuedCachePath = path.join(temp, 'queued-full-sweep-cache.json');
  writeFileSync(queuedCachePath, JSON.stringify(afterIncrementalCache), 'utf8');
  const scheduledCatalog = new ModelCatalog({ probeCachePath: queuedCachePath });
  await scheduledCatalog.init();
  const queuedCandidateId = 'queued-full-sweep-candidate';
  scheduledCatalog.setModels([...scheduledCatalog.getCandidates(), { id: queuedCandidateId, name: queuedCandidateId }]);
  const beforeQueuedSweepModels = scheduledCatalog.getModels().map((model) => model.id).sort();
  const beforeQueuedSweepRows = JSON.stringify(scheduledCatalog.getProbeResults());
  const beforeQueuedSweepCache = readFileSync(queuedCachePath, 'utf8');
  let finishQueuedIncremental;
  let finishQueuedFull;
  let signalQueuedIncremental;
  let signalQueuedFull;
  const queuedIncrementalStarted = new Promise((resolve) => { signalQueuedIncremental = resolve; });
  const queuedFullStarted = new Promise((resolve) => { signalQueuedFull = resolve; });
  let incrementalCalls = 0;
  let incrementalIds = [];
  const queuedIncremental = scheduledCatalog.refreshAvailability('test-token', async (_token, probeIds) => {
    incrementalCalls++;
    incrementalIds = probeIds;
    signalQueuedIncremental();
    return new Promise((resolve) => { finishQueuedIncremental = resolve; });
  }, { incremental: true });
  const joinedIncremental = scheduledCatalog.refreshAvailability('test-token', async () => {
    throw new Error('same-mode incremental call should share the pending probe');
  }, { incremental: true });
  await queuedIncrementalStarted;
  assert.deepEqual(incrementalIds, [queuedCandidateId], 'incremental mode only selects the unseen candidate');
  assert.equal(incrementalCalls, 1, 'same-mode incremental callers share one probe');

  let fullCalls = 0;
  let fullIds = [];
  let duplicateFullCalls = 0;
  const queuedFull = scheduledCatalog.refreshAvailability('test-token', async (_token, probeIds) => {
    fullCalls++;
    fullIds = probeIds;
    signalQueuedFull();
    return new Promise((resolve) => { finishQueuedFull = resolve; });
  });
  const joinedFull = scheduledCatalog.refreshAvailability('test-token', async () => {
    duplicateFullCalls++;
    throw new Error('same-mode full call should share the queued sweep');
  });
  assert.equal(fullCalls, 0, 'a full request waits for the active incremental sweep');
  assert.equal(duplicateFullCalls, 0, 'same-mode full callers join the queued full sweep');

  finishQueuedIncremental({
    results: [failure(queuedCandidateId, 402, 'quota-exceeded')],
    blocked: true,
    blockedReason: 'quota-exceeded',
    tested: 1,
    total: 1
  });
  const [blockedIncrementalResult, joinedIncrementalResult] = await Promise.all([queuedIncremental, joinedIncremental]);
  assert.equal(blockedIncrementalResult.blocked, true);
  assert.equal(blockedIncrementalResult.applied, false);
  assert.equal(joinedIncrementalResult.blocked, true);
  assert.deepEqual(scheduledCatalog.getModels().map((model) => model.id).sort(), beforeQueuedSweepModels,
    'a blocked incremental result cannot mutate picker availability while full is queued');
  assert.equal(JSON.stringify(scheduledCatalog.getProbeResults()), beforeQueuedSweepRows,
    'a blocked incremental result cannot update diagnostics or streaks');
  assert.equal(readFileSync(queuedCachePath, 'utf8'), beforeQueuedSweepCache,
    'a blocked incremental result cannot write the cache');

  await queuedFullStarted;
  const fullCandidateIds = scheduledCatalog.getCandidates().map((model) => model.id);
  assert.equal(fullCalls, 1, 'the queued full probe actually runs after incremental completion');
  assert.deepEqual(new Set(fullIds), new Set(fullCandidateIds),
    'full probe ids cover all current candidates, not only unseen ones');
  assert.equal(fullIds.length > incrementalIds.length, true,
    'full probe tests the old available catalog in addition to the new candidate');
  assert.equal(fullIds.includes(ids.steady), true, 'full sweep re-probes a previously available model');
  assert.equal(fullIds.includes(queuedCandidateId), true, 'full sweep includes the new candidate');
  finishQueuedFull({
    results: fullIds.map((id) => ok(id)),
    blocked: false,
    tested: fullIds.length,
    total: fullIds.length
  });
  const [fullSweepResult, joinedFullResult] = await Promise.all([queuedFull, joinedFull]);
  assert.equal(fullSweepResult.applied, true);
  assert.equal(joinedFullResult.applied, true);
  assert.equal(fullSweepResult.tested, fullCandidateIds.length,
    'full sweep result reports all candidates as tested');
  assert.equal(duplicateFullCalls, 0);
  assert.equal(scheduledCatalog.getModels().some((model) => model.id === queuedCandidateId), true,
    'the successful full sweep publishes the queued candidate');

  // A recent incremental timestamp cannot make an old full sweep fresh after
  // restart, even though the diagnostic timestamp is recent.
  const staleFreshnessPath = path.join(temp, 'stale-full-freshness.json');
  const staleFreshnessCache = { ...afterIncrementalCache,
    fullProbedAt: Date.now() - 10 * 60_000,
    probedAt: Date.now()
  };
  writeFileSync(staleFreshnessPath, JSON.stringify(staleFreshnessCache), 'utf8');
  const staleFreshnessCatalog = new ModelCatalog({ probeCachePath: staleFreshnessPath });
  await staleFreshnessCatalog.init();
  assert.equal(staleFreshnessCatalog.isProbeFresh(60_000), false,
    'startup freshness is calculated from the full sweep, not the incremental result');

  // Account invalidation deletes persisted state and starts a new generation.
  // The new token must probe immediately rather than joining the old promise;
  // an old finally handler must not clear the new promise from the in-flight slot.
  const beforeInvalidation = new ModelCatalog({ probeCachePath: cachePath });
  await beforeInvalidation.init();
  assert.equal(beforeInvalidation.isProbeFresh(60_000), true);
  let finishOldProbe;
  let finishNewProbe;
  let oldProbeIds = [];
  let newProbeIds = [];
  let signalOldStarted;
  let signalNewStarted;
  const oldStarted = new Promise((resolve) => { signalOldStarted = resolve; });
  const newStarted = new Promise((resolve) => { signalNewStarted = resolve; });
  const oldProbe = beforeInvalidation.refreshAvailability('old-account-token', async (_token, probeIds) => {
    oldProbeIds = probeIds;
    signalOldStarted();
    return new Promise((resolve) => { finishOldProbe = resolve; });
  });
  await oldStarted;
  beforeInvalidation.invalidateProbe();
  assert.equal(existsSync(cachePath), false, 'invalidation removes the durable cache');

  let newProbeCalls = 0;
  const newProbe = beforeInvalidation.refreshAvailability('new-account-token', async (token, probeIds) => {
    assert.equal(token, 'new-account-token');
    newProbeCalls++;
    newProbeIds = probeIds;
    signalNewStarted();
    return new Promise((resolve) => { finishNewProbe = resolve; });
  });
  await newStarted;
  assert.equal(newProbeCalls, 1, 'a new generation starts its own probe before the old one settles');

  finishOldProbe({
    results: oldProbeIds.map((id) => failure(id, 429, 'rate-limited')),
    blocked: false,
    tested: oldProbeIds.length,
    total: oldProbeIds.length
  });
  const discardedProbe = await oldProbe;
  assert.equal(discardedProbe.applied, false,
    'an in-flight result from the previous account cannot be committed');
  assert.equal(existsSync(cachePath), false, 'the discarded stale probe cannot recreate the cache');

  let duplicateProbeCalls = 0;
  const mergedNewProbe = beforeInvalidation.refreshAvailability('new-account-token', async () => {
    duplicateProbeCalls++;
    throw new Error('same-generation probe should join the pending new-token probe');
  });
  assert.equal(duplicateProbeCalls, 0,
    'the current generation still merges its own pending probe after the old finally runs');
  finishNewProbe({
    results: newProbeIds.map((id) => ok(id)),
    blocked: false,
    tested: newProbeIds.length,
    total: newProbeIds.length
  });
  const [newResult, mergedResult] = await Promise.all([newProbe, mergedNewProbe]);
  assert.equal(newResult.applied, true, 'the new-token probe can commit');
  assert.equal(mergedResult.applied, true, 'a same-generation caller receives the committed new result');
  assert.equal(newProbeCalls, 1);
  assert.equal(duplicateProbeCalls, 0);
  assert.equal(beforeInvalidation.getModels().length > 0, true);
  assert.equal(existsSync(cachePath), true, 'the new-token probe persists its own cache');

  beforeInvalidation.invalidateProbe();
  const afterInvalidation = new ModelCatalog({ probeCachePath: cachePath });
  await afterInvalidation.init();
  assert.equal(afterInvalidation.isProbeFresh(60_000), false,
    'a rebuilt catalog requires a fresh probe after invalidation');

  // 換帳號／重新登入只把結果標成不新鮮，不能把整份探測紀錄刪掉。
  // 開機不自動探測，刪掉就再也補不回來，使用者只會看到「0 筆探測、整張表空白」。
  const switchPath = path.join(temp, 'availability-account-switch.json');
  writeFileSync(switchPath, JSON.stringify({
    version: 2,
    probedAt: Date.now(),
    fullProbedAt: Date.now(),
    available: [ids.steady],
    knownIds: [ids.steady, ids.notFound],
    failureStreaks: { [ids.notFound]: 2 },
    results: [
      { id: ids.steady, ok: true, status: 200, ms: 20, reason: 'http-200', probedAt: Date.now() },
      { id: ids.notFound, ok: false, status: 404, ms: 30, reason: 'not-found', probedAt: Date.now() }
    ]
  }), 'utf8');
  const switched = new ModelCatalog({ probeCachePath: switchPath });
  await switched.init();
  assert.equal(switched.isProbeFresh(60_000), true, 'the switch fixture starts fresh');
  switched.markProbeStale();
  assert.equal(existsSync(switchPath), true,
    'marking another account must not delete the persisted probe cache');
  assert.equal(switched.isProbeFresh(60_000), false,
    'another account still forces a re-verification');
  assert.equal(switched.getModels().some((model) => model.id === ids.steady), true,
    'known availability survives the account switch');
  diagnostics = new Map(switched.getProbeResults().map((result) => [result.id, result]));
  assert.equal(diagnostics.get(ids.notFound)?.probed, true,
    'per-model history survives the account switch');
  const reloadedAfterSwitch = new ModelCatalog({ probeCachePath: switchPath });
  await reloadedAfterSwitch.init();
  assert.equal(reloadedAfterSwitch.getModels().some((model) => model.id === ids.steady), true,
    'a restart after switching accounts still sees the probe history');

  // Previous v2 caches may have a recent `probedAt` from an incremental run,
  // but no fullProbedAt. Preserve their availability/streak while treating the
  // full-sweep freshness as unknown until one full probe completes.
  const oldV2Path = path.join(temp, 'availability-v2-before-full-clock.json');
  const recentLegacyProbeAt = Date.now();
  writeFileSync(oldV2Path, JSON.stringify({
    version: 2,
    probedAt: recentLegacyProbeAt,
    available: [ids.steady],
    knownIds: [ids.steady],
    failureStreaks: { [ids.steady]: 1 },
    results: [{ id: ids.steady, ok: false, status: 429, ms: 30, reason: 'rate-limited', probedAt: recentLegacyProbeAt }]
  }), 'utf8');
  const oldV2 = new ModelCatalog({ probeCachePath: oldV2Path });
  await oldV2.init();
  assert.equal(oldV2.getModels().some((model) => model.id === ids.steady), true,
    'old v2 cache availability remains readable');
  assert.equal(oldV2.isProbeFresh(60_000), false,
    'a recent legacy v2 result without fullProbedAt cannot skip a full startup probe');
  diagnostics = new Map(oldV2.getProbeResults().map((result) => [result.id, result]));
  assert.equal(diagnostics.get(ids.steady).failureStreak, 1,
    'legacy v2 streak remains compatible while freshness is unknown');
  assert.equal(diagnostics.get(ids.steady).probedAt, recentLegacyProbeAt,
    'legacy v2 diagnostics retain their recent incremental timestamp');

  // v1 caches had no streak field and previously expired caches were discarded.
  // They remain readable even when stale, and a full re-probe is still due.
  const v1Path = path.join(temp, 'availability-v1.json');
  writeFileSync(v1Path, JSON.stringify({
    probedAt: Date.now() - PROBE_CACHE_TTL_MS - 1000,
    available: [ids.steady],
    knownIds: [ids.steady],
    results: [{ id: ids.steady, ok: false, status: 503, ms: 30, reason: 'upstream-error' }]
  }), 'utf8');
  const migrated = new ModelCatalog({ probeCachePath: v1Path });
  await migrated.init();
  assert.equal(migrated.getModels().some((model) => model.id === ids.steady), true,
    'v1 availability remains compatible while stale state awaits re-verification');
  assert.equal(migrated.isProbeFresh(60_000), false, 'stale v1 results still require a fresh probe');
  diagnostics = new Map(migrated.getProbeResults().map((result) => [result.id, result]));
  assert.equal(diagnostics.get(ids.steady).reason, 'upstream-error');
  assert.equal(Number.isFinite(diagnostics.get(ids.steady).probedAt), true,
    'v1 diagnostics inherit the cache sweep time');

  // Scoped probing: probing only a specific subset of models (e.g. available list)
  // updates only those model results, preserves the other models' previous probe history,
  // and does not wipe un-probed models from availability.
  const scopedCatalog = new ModelCatalog({ probeCachePath: path.join(temp, 'scoped-cache.json') });
  await scopedCatalog.init();
  await scopedCatalog.refreshAvailability('token', async (_token, probeIds) => ({
    results: probeIds.map((id) => ok(id)),
    blocked: false,
    tested: probeIds.length,
    total: probeIds.length
  }), { modelIds: [ids.steady, ids.flaky] });
  assert.equal(scopedCatalog.isAvailable(ids.steady), true);
  assert.equal(scopedCatalog.isAvailable(ids.flaky), true);

  let scopedProbedIds = [];
  await scopedCatalog.refreshAvailability('token', async (_token, probeIds) => {
    scopedProbedIds = probeIds;
    return {
      results: probeIds.map((id) => ({ ...ok(id), ms: 42 })),
      blocked: false,
      tested: probeIds.length,
      total: probeIds.length
    };
  }, { modelIds: [ids.steady] });
  assert.deepEqual(scopedProbedIds, [ids.steady]);
  assert.equal(scopedCatalog.isAvailable(ids.flaky), true, 'un-probed models must remain available in scoped runs');
  const scopedDiagnostics = new Map(scopedCatalog.getProbeResults().map((r) => [r.id, r]));
  assert.equal(scopedDiagnostics.get(ids.steady).ms, 42);

  // 熔斷必須被記錄下來，而且要跨重啟保留。
  // 沒有這段的話，「可用 13、但只驗了 4 個」在重啟後就變成「46 個都驗過」，
  // 使用者永遠不知道那次探測其實提早收手了。
  const truncPath = path.join(temp, 'availability-truncated.json');
  const truncCatalog = new ModelCatalog({ probeCachePath: truncPath });
  await truncCatalog.init();
  const expectedRetryAt = Date.now() + 5_397_000;
  await truncCatalog.refreshAvailability('token', async (_token, probeIds) => ({
    // 第一個模型撞到 429 就熔斷，只回一筆結果。
    results: [failure(probeIds[0], 429, 'rate-limited')],
    blocked: false,
    tested: 1,
    total: probeIds.length,
    stopped: 'rate-limited',
    stoppedBy: { id: probeIds[0], status: 429, reason: 'rate-limited' },
    retryAt: expectedRetryAt,
    untested: probeIds.slice(1)
  }), {});
  const truncSummary = truncCatalog.availabilitySummary();
  assert.equal(truncSummary.truncation?.stopped, 'rate-limited',
    'a rate-limited bail-out is recorded on the summary');
  assert.equal(truncSummary.truncation.tested, 1);
  assert.equal(truncSummary.truncation.total > 1, true,
    'the truncation records how many candidates the run intended to cover');
  assert.equal(truncSummary.truncation.retryAt, expectedRetryAt,
    'the upstream retry-after deadline is carried into the summary');

  const reloadedTrunc = new ModelCatalog({ probeCachePath: truncPath });
  await reloadedTrunc.init();
  assert.equal(reloadedTrunc.availabilitySummary().truncation?.stopped, 'rate-limited',
    'the truncation survives a restart');
  assert.equal(reloadedTrunc.availabilitySummary().truncation.tested, 1);
  assert.equal(reloadedTrunc.availabilitySummary().truncation.retryAt, expectedRetryAt,
    'the quota reset deadline survives a restart');

  // 完整跑完的一輪要把舊的熔斷標記清掉，否則畫面會一直說「只驗了一部分」。
  await truncCatalog.refreshAvailability('token', async (_token, probeIds) => ({
    results: probeIds.map((id) => ok(id)),
    blocked: false,
    tested: probeIds.length,
    total: probeIds.length,
    stopped: null,
    untested: []
  }), {});
  assert.equal(truncCatalog.availabilitySummary().truncation, null,
    'a complete run clears the previous truncation marker');

  console.log('✔ Catalog availability tests passed');
} finally {
  globalThis.fetch = originalFetch;
  rmSync(temp, { recursive: true, force: true });
}
