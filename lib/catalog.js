import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  OPENCODE_MODELS_URL,
  STATIC_FREE_MODELS
} from './constants.js';

let lastFetchTime = 0;
/**
 * Shared across catalog instances in this process. Without it, a second
 * instance would see a fresh `lastFetchTime`, skip the fetch, and silently
 * fall back to the much smaller static list.
 */
let sharedCatalog = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CHANNEL_BLOCKED_REASONS = new Set([
  'transport',
  'unauthorized',
  'upstream-error',
  'free-lane-blocked',
  'forbidden',
  'network-blocked',
  'quota-exceeded',
  'endpoint-not-found'
]);

/**
 * The catalog marks dropped models as `status: "deprecated"`, but that flag is
 * unreliable in both directions: some deprecated entries still answer 200
 * while some unmarked ones are gone. It is still a useful *hint*, so a
 * deprecated model is never advertised unless probing confirms it works.
 */
export function isFreeCandidate(id, raw) {
  const lower = String(id).toLowerCase();
  if (lower.includes('-free')) return true;
  if (lower === 'big-pickle') return true;
  const cost = raw?.cost;
  return Boolean(cost && cost.input === 0 && cost.output === 0);
}

/**
 * Normalizes an OpenCode raw model metadata object into a DSH model descriptor.
 */
export function normalizeModel(id, raw) {
  const name = raw?.name || id;
  const rawContext = raw?.limit?.context;
  const context = rawContext || 128000;
  const contextSource = Number.isSafeInteger(rawContext) && rawContext > 0 ? 'opencode' : 'fallback';
  const output = raw?.limit?.output || 8192;

  let inputModalities = ['text'];
  if (raw?.modalities?.input && Array.isArray(raw.modalities.input)) {
    inputModalities = raw.modalities.input.filter((m) => m === 'text' || m === 'image');
  } else if (raw?.attachment === true) {
    inputModalities = ['text', 'image'];
  }
  if (inputModalities.length === 0) inputModalities = ['text'];

  // OpenCode reports the exact effort values the upstream accepts. They vary
  // per model and are authoritative: inventing values (e.g. adding "off"
  // everywhere) makes the upstream reject the request with 400
  // `[unsupported_value]`. Upstream spells "no reasoning" as "none"; DSH
  // spells it "off", and adapter.js maps it back on the wire.
  const effortValues = raw?.reasoning_options?.find?.((o) => o?.type === 'effort')?.values;
  let efforts = [];
  if (Array.isArray(effortValues) && effortValues.length > 0) {
    efforts = [...new Set(effortValues.map((v) => (v === 'none' ? 'off' : String(v))))];
  } else if (raw?.reasoning) {
    // Reasoning is on but no effort list was published. These four are the
    // values every such model has accepted in live probes.
    efforts = ['off', 'low', 'medium', 'high'];
  }

  // DSH requires defaultEffort to be one of the advertised ids.
  const defaultEffort = efforts.includes('medium')
    ? 'medium'
    : efforts.includes('high')
      ? 'high'
      : efforts[0];

  return {
    id,
    name,
    contextWindow: context,
    catalogContextWindow: context,
    contextSource,
    defaultMaxTokens: output,
    inputModalities,
    efforts,
    defaultEffort: efforts.length ? defaultEffort : undefined,
    deprecated: raw?.status === 'deprecated',
    status: raw?.status || 'active'
  };
}

/**
 * Fetches the public catalog and returns every free-lane candidate, including
 * deprecated ones — availability is decided later by live probing.
 */
export async function fetchLiveCatalog() {
  try {
    const res = await fetch(OPENCODE_MODELS_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const opencodeModels = data.opencode?.models || {};

    const candidates = [];
    for (const [id, raw] of Object.entries(opencodeModels)) {
      if (isFreeCandidate(id, raw)) candidates.push(normalizeModel(id, raw));
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        const aDep = a.deprecated ? 1 : 0;
        const bDep = b.deprecated ? 1 : 0;
        if (aDep !== bDep) return aDep - bDep;
        if (a.id.includes('deepseek') !== b.id.includes('deepseek')) {
          return a.id.includes('deepseek') ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      return candidates;
    }
  } catch (err) {
    console.warn(
      '[opencode-next] Failed to fetch live catalog, using static fallback:',
      err.message
    );
  }

  return STATIC_FREE_MODELS;
}

/** Default location of the persisted availability cache. */
export function defaultProbeCachePath() {
  return path.join(os.homedir(), '.dsh', 'opencode-next.models.json');
}

function readProbeCache(cachePath) {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.available)) return null;
    // Keep durable availability and failure streaks even when the results need
    // re-verification. `isProbeFresh()` controls whether a fresh probe is due;
    // discarding a stale cache here would reset hysteresis on every restart.
    return parsed;
  } catch {
    return null;
  }
}

function writeProbeCache(cachePath, payload) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.warn('[opencode-next] Could not persist availability cache:', err.message);
  }
}

/**
 * Model catalog with live availability tracking.
 *
 * `getModels()` returns picker-published models only. Before the first probe,
 * the curated static subset is the only pre-verified set; new candidates remain hidden.
 */
export class ModelCatalog {
  #models = [...STATIC_FREE_MODELS];
  #available = null; // Set of confirmed ids, or null when unprobed
  #knownIds = new Set(); // Every id we have ever probed or seen in the catalog
  #failureStreaks = new Map(); // Consecutive model-specific failures; persisted across restarts
  #lastProbe = 0; // Most recent complete or incremental result time, for diagnostics
  #lastFullProbe = 0; // Only a complete sweep can make the startup cache fresh
  #lastTruncation = null; // Last run that bailed out early (rate limit / blocked lane)
  #probeResults = []; // Latest per-model verdicts (incremental runs preserve earlier rows)
  #probeGeneration = 0; // Invalidates in-flight results after credential/account changes
  #probeRuns = new Map(); // Per-generation active probe plus queued opposite-mode work
  #cachePath;
  #contextStore;
  #pickerStore;

  constructor(options = {}) {
    this.#cachePath = options.probeCachePath || defaultProbeCachePath();
    this.#contextStore = options.contextStore || null;
    // 勾選名單：null 表示這個 catalog 沒接勾選功能，行為與舊版完全相同。
    // 既有測試與 headless 用法不傳它，就不會被改變語意。
    this.#pickerStore = options.pickerStore || null;
    const cached = readProbeCache(this.#cachePath);
    if (cached) {
      this.#available = new Set(cached.available.filter((id) => typeof id === 'string'));
      this.#lastProbe = Number.isFinite(cached.probedAt) ? cached.probedAt : 0;
      // Legacy caches (including the previous v2 format) cannot tell whether
      // `probedAt` came from a full or incremental sweep. Preserve availability,
      // streaks, and row diagnostics, but force one full re-verification.
      this.#lastFullProbe = Number.isFinite(cached.fullProbedAt) ? cached.fullProbedAt : 0;
      if (Array.isArray(cached.results)) {
        // v1 stored only the latest probe results. Use its sweep timestamp as
        // the row timestamp while migrating; v2 stores it per model.
        this.#probeResults = cached.results
          .filter((r) => r && typeof r.id === 'string')
          .map((r) => ({ ...r, probedAt: Number.isFinite(r.probedAt) ? r.probedAt : this.#lastProbe }));
      }
      if (Array.isArray(cached.knownIds)) {
        this.#knownIds = new Set(cached.knownIds.filter((id) => typeof id === 'string'));
      } else if (Array.isArray(cached.results)) {
        // v1 already recorded one result per probed model. Recover the set so
        // upgrading does not force an unnecessary incremental re-probe.
        this.#knownIds = new Set(cached.results.map((r) => r?.id).filter((id) => typeof id === 'string'));
      }
      if (cached.failureStreaks && typeof cached.failureStreaks === 'object' && !Array.isArray(cached.failureStreaks)) {
        for (const [id, count] of Object.entries(cached.failureStreaks)) {
          if (Number.isSafeInteger(count) && count > 0) this.#failureStreaks.set(id, count);
        }
      }
      // 「上次探測只驗了一部分」也要跨重啟保留，否則畫面會以為整份都驗過。
      if (cached.truncation && typeof cached.truncation === 'object') {
        this.#lastTruncation = {
          stopped: typeof cached.truncation.stopped === 'string' ? cached.truncation.stopped : 'unknown',
          at: Number.isFinite(cached.truncation.at) ? cached.truncation.at : 0,
          tested: Number.isFinite(cached.truncation.tested) ? cached.truncation.tested : 0,
          total: Number.isFinite(cached.truncation.total) ? cached.truncation.total : 0,
          stoppedBy: cached.truncation.stoppedBy ?? null,
          retryAt: Number.isFinite(cached.truncation.retryAt) ? cached.truncation.retryAt : null
        };
      }
    }
  }

  #withContext(model) {
    const catalogContextWindow = model.catalogContextWindow ?? model.contextWindow;
    const override = this.#contextStore?.getOverride?.(model.id) ?? null;
    return {
      ...model,
      catalogContextWindow,
      contextWindow: override ?? catalogContextWindow,
      contextOverride: override,
      contextSource: override === null ? (model.contextSource || 'fallback') : 'custom'
    };
  }

  async init() {
    // Reuse the process-wide fetch so every instance sees the full candidate
    // list instead of a truncated static fallback.
    if (sharedCatalog && Date.now() - lastFetchTime < CACHE_TTL_MS) {
      if (this.#models.length < sharedCatalog.length) this.#models = sharedCatalog;
      return this.getModels();
    }

    const live = await fetchLiveCatalog();
    if (live?.length) {
      this.#models = live;
      sharedCatalog = live;
      lastFetchTime = Date.now();
    }
    return this.getModels();
  }

  /**
   * Re-fetches the catalog and reports which candidate ids are new.
   *
   * This is the mechanism that surfaces brand-new free models: the catalog is
   * cheap to fetch, so a scheduled refresh can spot an addition immediately
   * and probe just that one model instead of the whole list.
   */
  async refreshCatalog() {
    const before = new Set(this.#models.map((m) => m.id));
    const live = await fetchLiveCatalog();

    if (!live?.length) return { added: [], removed: [], total: this.#models.length };

    this.#models = live;
    sharedCatalog = live;
    lastFetchTime = Date.now();

    const after = new Set(live.map((m) => m.id));
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));

    return { added, removed, total: live.length };
  }

  /** Candidate ids never yet probed in any run. */
  unseenCandidates() {
    return this.#models.map((m) => m.id).filter((id) => !this.#knownIds.has(id));
  }

  /**
   * Merges live catalog metadata into the current list without a refetch.
   */
  setModels(models) {
    if (Array.isArray(models) && models.length > 0) this.#models = models;
  }

  /** Every free candidate, regardless of probed availability. */
  getCandidates() {
    return this.#models.map((model) => this.#withContext(model));
  }

  /**
   * Models safe to advertise in the picker.
   *
   * Before the first completed probe, only the statically verified candidates
   * may be shown. New catalog entries must earn their way into the picker with
   * a successful probe. An empty confirmed set stays empty: falling back to all
   * candidates here would re-publish models explicitly hidden as unavailable.
   *
   * 勾選（manual 模式）是在「探測判定可用」之上再加一層使用者意願：
   * 兩者都通過才發佈。勾選不取代探測——探測判定不可用的模型就算勾了也
   * 不會出現，否則使用者會把明知不通的模型留在選擇器頂端。
   */
  getModels() {
    const byId = new Map(this.#models.map((m) => [m.id, m]));
    let ids = this.#available
      ? this.#available
      : new Set(STATIC_FREE_MODELS.filter((m) => byId.has(m.id)).map((m) => m.id));
    const picker = this.#pickerStore?.get?.();
    if (picker?.mode === 'manual') {
      const shown = new Set(picker.shown);
      ids = [...ids].filter((id) => shown.has(id));
    }
    const out = [];
    for (const id of ids) {
      const model = byId.get(id);
      if (model) out.push(this.#withContext(model));
    }
    return out;
  }

  /**
   * 這個模型「現在」會不會出現在選擇器。
   *
   * getProbeResults() 的每一列都要帶上這個值，讓表格的勾選框反映事實，
   * 而不是讓前端自己重複推導（推導錯了就會與發佈名單不一致）。
   */
  willShow(modelId) {
    if (!this.isAvailable(modelId)) return false;
    const picker = this.#pickerStore?.get?.();
    if (picker?.mode === 'manual') return picker.shown.includes(modelId);
    return true;
  }

  /**
   * 勾選功能的現狀，供狀態頁畫模式提示與按鈕。
   * 沒接勾選功能時回傳 null，前端據此直接不畫這一欄也不會報錯。
   */
  pickerState() {
    if (!this.#pickerStore?.get) return null;
    try {
      const saved = this.#pickerStore.get();
      // auto 模式下的 shown 沒有實質意義（顯示與否由探測決定），
      // 帶出 auto 名單讓前端在第一次勾選的瞬間不會看到勾選狀態跳動。
      const autoIds = this.#available
        ? [...this.#available]
        : STATIC_FREE_MODELS.filter((m) => this.#models.some((c) => c.id === m.id)).map((m) => m.id);
      return {
        mode: saved.mode,
        shown: saved.mode === 'manual' ? [...saved.shown] : autoIds
      };
    } catch {
      return null;
    }
  }

  /**
   * 設定單一模型的勾選意願。
   *
   * 第一次勾選會把 auto 名單整份快照成 shown 並切入手動模式：使用者看到
   * 的勾選狀態不變，只是從今以後新模型不再自動加入。
   *
   * @returns {object|null} 勾選功能的最新狀態；id 不存在時回傳 null。
   */
  setPickerShown(modelId, shown) {
    if (!this.#pickerStore?.set) return null;
    if (!this.getModel(modelId)) return null;
    const saved = this.#pickerStore.get();
    const base = saved.mode === 'manual'
      ? saved.shown
      // auto → manual 的轉換快照：目前會顯示的整份名單。
      : (this.#available
        ? [...this.#available]
        : STATIC_FREE_MODELS.filter((m) => this.#models.some((c) => c.id === m.id)).map((m) => m.id));
    const set = new Set(base);
    if (shown) set.add(modelId);
    else set.delete(modelId);
    // 先寫入再讀狀態：pickerState() 讀的是 store 的現值，
    // 若先讀後寫，回傳的會是舊名單。
    this.#pickerStore.set({ mode: 'manual', shown: [...set] });
    return this.pickerState();
  }

  /** 恢復自動管理模式：探測判定可用就顯示，新模型照舊自動加入。 */
  resetPicker() {
    if (!this.#pickerStore?.set) return null;
    this.#pickerStore.set({ mode: 'auto', shown: [] });
    return this.pickerState();
  }

  getModel(id) {
    const model = this.#models.find((m) => m.id === id)
      || STATIC_FREE_MODELS.find((m) => m.id === id)
      || null;
    return model ? this.#withContext(model) : null;
  }

  isAvailable(id) {
    if (this.#available) return this.#available.has(id);
    return STATIC_FREE_MODELS.some((model) => model.id === id && this.#models.some((candidate) => candidate.id === id));
  }

  /**
   * True when the last complete sweep is recent enough to skip a full probe.
   * Incremental checks refresh per-model diagnostics but cannot postpone it.
   */
  isProbeFresh(maxAgeMs) {
    if (!this.#available || !this.#lastFullProbe) return false;
    return Date.now() - this.#lastFullProbe < maxAgeMs;
  }

  /**
   * Mark probe state as belonging to another account, without deleting it.
   *
   * 切換帳號或重新登入時原本呼叫 invalidateProbe()，那會把
   * ~/.dsh/opencode-next.models.json 直接刪掉。但開機不再自動探測（見
   * index.js），刪掉之後沒有任何東西會把它補回來——使用者下次打開設定頁
   * 看到的就是「46 個候選、0 筆探測、整張表空白」，而且每次切帳號都重演。
   *
   * 探測結果記的是「這個模型 id 在免費通道上能不能用」，不是「這個帳號的
   * 私有配額」。換帳號後重驗一次是合理的，把歷史紀錄整份丟掉則不是。
   * 所以這裡只讓快取看起來不新鮮（強制下一輪重新驗證），資料留著。
   */
  markProbeStale() {
    this.#probeGeneration++;
    this.#lastFullProbe = 0;
    // 仍在跑的那一輪是舊帳號的結果，不能讓它寫回快取。
    for (const [generation, state] of this.#probeRuns) {
      if (generation === this.#probeGeneration) continue;
      for (const queued of state.queue.splice(0)) {
        queued.resolve(this.#invalidatedProbeResult());
      }
      if (!state.active && this.#probeRuns.get(generation) === state) {
        this.#probeRuns.delete(generation);
      }
    }
    return this.availabilitySummary();
  }

  /**
   * Invalidate probe state after a credential/account change.
   *
   * The cache must be removed as well as the in-memory state: otherwise a
   * restart could reload the previous account's fresh availability and skip
   * the first probe for the new account. Incrementing the generation also
   * prevents an already-running old-token probe from recreating that cache.
   *
   * 只有在「憑證整個失效、不該再相信任何一列」時才該用這個。換帳號請用
   * markProbeStale()，否則使用者會失去整份探測紀錄。
   */
  invalidateProbe() {
    this.#probeGeneration++;
    this.#available = null;
    this.#probeResults = [];
    this.#failureStreaks.clear();
    this.#lastProbe = 0;
    this.#lastFullProbe = 0;
    this.#lastTruncation = null;
    this.#knownIds = new Set();
    for (const [generation, state] of this.#probeRuns) {
      if (generation === this.#probeGeneration) continue;
      for (const queued of state.queue.splice(0)) {
        queued.resolve(this.#invalidatedProbeResult());
      }
      if (!state.active && this.#probeRuns.get(generation) === state) {
        this.#probeRuns.delete(generation);
      }
    }
    try {
      fs.unlinkSync(this.#cachePath);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.warn('[opencode-next] Could not clear availability cache:', err.message);
      }
    }
  }

  availabilitySummary() {
    const candidates = this.#models.length;
    const available = this.getModels().length;
    return {
      candidates,
      available,
      probedAt: this.#lastProbe || null,
      // 上一輪是否提早熔斷、驗了幾個。null 代表最近一輪跑完或還沒跑過。
      truncation: this.#lastTruncation ? { ...this.#lastTruncation } : null
    };
  }

  /**
   * 每個候選模型的最近一次探測結果，供狀態頁逐列顯示。
   *
   * 回傳的是一份拷貝：呼叫端（HTTP handler）不該有機會改到內部狀態。
   * 尚未探測過的模型也會列出來並標成 `probed: false`，否則狀態頁在第一次
   * 探測完成前會是一片空白，看起來像壞掉。
   */
  getProbeResults() {
    const byId = new Map(this.#probeResults.map((r) => [r.id, r]));
    return this.#models.map((m) => {
      const r = byId.get(m.id);
      const effective = this.#withContext(m);
      return {
        id: m.id,
        name: m.name,
        contextWindow: effective.contextWindow,
        catalogContextWindow: effective.catalogContextWindow,
        contextOverride: effective.contextOverride,
        contextSource: effective.contextSource,
        // 上游目錄給的單次輸出上限（`limit.output`）。131 個免費模型全都有這個
        // 欄位，但它原本只活在 describe() 裡，設定頁完全看不到——使用者問
        // 「最大值是多少」時只能猜。這裡把它一起送出去。
        maxOutputTokens: Number.isFinite(m.defaultMaxTokens) ? m.defaultMaxTokens : null,
        probed: r !== undefined,
        ok: r?.ok ?? false,
        // 上游是否認得這個模型。
        //
        // `ok` 問的是「這次問到了嗎」，`valid` 問的是「這個模型存不存在、
        // 有沒有被下架」。429（限流／額度用完）不給問，但上游已經指名回應
        // 了這個 model id——模型有效，只是此刻排不進去。使用者要的分類就是
        // 這個語意：可用＝上游有效，不是能不能用。
        valid: r === undefined ? false : Boolean(r.ok || r.status === 429),
        status: r?.status ?? null,
        ms: Number.isFinite(r?.ms) ? r.ms : null,
        probedAt: Number.isFinite(r?.probedAt) ? r.probedAt : null,
        reason: r?.reason ?? null,
        errorType: r?.errorType ?? null,
        // 上游原文，只給失敗的列用（成功時 probe 不讀 body，本來就沒有）。
        detail: r?.detail ?? null,
        available: this.isAvailable(m.id),
        // 這一列現在會不會出現在選擇器（含使用者勾選的過濾）。
        shown: this.willShow(m.id),
        failureStreak: this.#failureStreaks.get(m.id) ?? 0
      };
    });
  }

  /**
   * Runs live availability probes; same-mode calls coalesce, while full and
   * incremental sweeps are serialized within a generation.
   *
   * With `options.incremental`, only candidates that have never been probed
   * are tested. New candidates enter the picker only on success; known models
   * use a two-failure hysteresis, with 404/410 retirement applied immediately.
   * A blocked or incomplete sweep is not a per-model verdict and changes no
   * availability, failure streak, or diagnostic history.
   *
   * `probeFn(token, ids, options)` is injected so this class stays testable.
   */
  async refreshAvailability(token, probeFn, options = {}) {
    if (!token) throw new Error('A token is required to probe model availability.');
    const generation = this.#probeGeneration;
    const isScoped = Array.isArray(options.modelIds) && options.modelIds.length > 0;
    const mode = isScoped ? `scoped:${[...options.modelIds].sort().join(',')}` : (options.incremental ? 'incremental' : 'full');
    let state = this.#probeRuns.get(generation);
    if (!state) {
      state = { generation, active: null, queue: [] };
      this.#probeRuns.set(generation, state);
    }

    if (state.active?.mode === mode) return state.active.promise;
    const queued = state.queue.find((entry) => entry.mode === mode);
    if (queued) return queued.promise;

    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry = { generation, mode, token, probeFn, options, promise, resolve, reject };
    if (state.active) state.queue.push(entry);
    else this.#startProbeRun(state, entry);
    return promise;
  }

  #startProbeRun(state, entry) {
    state.active = entry;
    this.#executeAvailabilityProbe(entry.token, entry.probeFn, entry.options, entry.generation).then(
      (result) => {
        this.#finishProbeRun(state, entry);
        entry.resolve(result);
      },
      (error) => {
        this.#finishProbeRun(state, entry);
        entry.reject(error);
      }
    );
  }

  #finishProbeRun(state, entry) {
    if (state.active !== entry) return;
    state.active = null;
    while (state.queue.length > 0) {
      const next = state.queue.shift();
      if (next.generation !== this.#probeGeneration) {
        next.resolve(this.#invalidatedProbeResult());
        continue;
      }
      this.#startProbeRun(state, next);
      return;
    }
    if (this.#probeRuns.get(state.generation) === state) this.#probeRuns.delete(state.generation);
  }

  #invalidatedProbeResult() {
    return {
      results: [],
      blocked: false,
      applied: false,
      available: this.#available ? [...this.#available] : this.getModels().map((model) => model.id),
      note: 'invalidated'
    };
  }

  async #executeAvailabilityProbe(token, probeFn, options, probeGeneration) {
    await this.init();

    const incremental = Boolean(options.incremental);
    const allIds = this.#models.map((m) => m.id);
    const scoped = Array.isArray(options.modelIds) && options.modelIds.length > 0;
    const ids = scoped
      ? allIds.filter((id) => options.modelIds.includes(id))
      : (incremental ? this.unseenCandidates() : allIds);
    const currentAvailable = () => this.#available
      ? [...this.#available]
      : this.getModels().map((model) => model.id);

    if (probeGeneration !== this.#probeGeneration) {
      return { results: [], blocked: false, applied: false, available: currentAvailable(), note: 'invalidated' };
    }

    if (ids.length === 0) {
      return {
        results: [],
        blocked: false,
        blockedReason: null,
        tested: 0,
        total: 0,
        applied: false,
        available: currentAvailable(),
        note: 'nothing-new-to-probe'
      };
    }

    const outcome = await probeFn(token, ids, options);

    // A credential/account change while probing invalidates the old token's
    // result and removes its persisted cache. Do not let this in-flight run
    // write the previous account's state back to disk.
    if (probeGeneration !== this.#probeGeneration) {
      return {
        ...(outcome ?? { results: [], blocked: false }),
        applied: false,
        available: currentAvailable(),
        note: 'invalidated'
      };
    }

    const preliminaryResults = Array.isArray(outcome?.results) ? outcome.results : [];
    const blockedReason = outcome?.blockedReason
      ?? preliminaryResults.find((result) => CHANNEL_BLOCKED_REASONS.has(result?.reason))?.reason
      ?? null;
    // A blocked lane yields no trustworthy per-model verdicts. Even full
    // arrays of 402 quota results cannot be committed as individual failures.
    if (!outcome || outcome.blocked || blockedReason) {
      return {
        ...(outcome ?? { results: [], blocked: true }),
        blocked: true,
        blockedReason,
        applied: false,
        available: currentAvailable(),
        note: outcome?.note ?? 'channel-blocked'
      };
    }

    const results = preliminaryResults;
    const requested = new Set(ids);
    const byId = new Map();
    let malformed = outcome.inconclusive === true;
    for (const result of results) {
      if (!result || typeof result.id !== 'string' || !requested.has(result.id)
        || typeof result.ok !== 'boolean' || byId.has(result.id)) {
        malformed = true;
        break;
      }
      byId.set(result.id, result);
    }
    const hasThrottled = results.some((r) => r.status === 429);
    if (!hasThrottled && (byId.size !== ids.length
      || (Number.isFinite(outcome.tested) && outcome.tested !== ids.length)
      || (Number.isFinite(outcome.total) && outcome.total !== ids.length))) {
      malformed = true;
    }
    if (malformed) {
      return {
        ...outcome,
        applied: false,
        available: currentAvailable(),
        note: outcome.note ?? 'inconclusive'
      };
    }

    // Before any completed sweep, only the static list is considered
    // pre-verified. This gives existing picker entries hysteresis while new
    // candidates still require an actual successful result.
    if (!this.#available) {
      const candidateIds = new Set(allIds);
      this.#available = new Set(
        STATIC_FREE_MODELS.filter((model) => candidateIds.has(model.id)).map((model) => model.id)
      );
    }
    const wasAvailable = new Set(this.#available);
    const probedAt = Date.now();

    for (const id of ids) {
      const result = byId.get(id);
      if (!result) continue; // 熔斷提前中斷時，未 probe 的模型保留原本可用性狀態
      this.#knownIds.add(id);
      if (result.ok) {
        this.#available.add(id);
        this.#failureStreaks.delete(id);
        continue;
      }

      // 429 代表「上游認得這個模型，只是這次不給問」。
      //
      // 這是使用者明確要求的語意：可用＝上游有效，不是當下問得到。限流、
      // 速率超標、免費池暫時用完，上游都已經回應了這個 model id——模型存在、
      // 沒被下架，只是此刻被擋。把它當成失敗踢出清單，等於因為別人擠滿櫃台
      // 就宣稱這家店倒了。
      //
      // 所以：加入可用清單、清掉失敗計數。狀態欄仍會顯示「被限流（429）」，
      // 使用者看得到它現在問不到，但它依然在選擇器裡、依然算有效。
      if (result.status === 429) {
        this.#available.add(id);
        this.#failureStreaks.delete(id);
        continue;
      }

      // Only explicit retirement responses are authoritative. In particular,
      // `unavailable` from a 400 body is not enough to drop a model at once.
      if (result.status === 410 || result.reason === 'not-found' || result.reason === 'deprecated') {
        this.#available.delete(id);
        this.#failureStreaks.delete(id);
        continue;
      }

      const streak = (this.#failureStreaks.get(id) ?? 0) + 1;
      this.#failureStreaks.set(id, streak);
      if (streak >= 2) this.#available.delete(id);
    }

    // Full sweeps cover every current candidate. Drop availability for ids no
    // longer in the catalog, but keep their diagnostics/history for migration
    // and for a future reappearance of the same candidate.
    if (!incremental && !scoped && !hasThrottled) {
      const currentIds = new Set(allIds);
      for (const id of this.#available) {
        if (!currentIds.has(id)) this.#available.delete(id);
      }
    }

    this.#lastProbe = probedAt;
    if (!incremental && !scoped) this.#lastFullProbe = probedAt;
    const updatedRows = results.map((result) => ({
      id: result.id,
      ok: result.ok,
      status: result.status,
      ms: result.ms,
      reason: result.reason,
      errorType: result.errorType,
      detail: result.detail,
      probedAt
    }));
    const diagnosticRows = new Map(this.#probeResults.map((result) => [result.id, result]));
    for (const row of updatedRows) diagnosticRows.set(row.id, row);
    this.#probeResults = [...diagnosticRows.values()];

    const available = [...this.#available];
    const added = available.filter((id) => !wasAvailable.has(id));
    // 這一輪是不是被熔斷。要一起寫進快取，否則重啟後「只驗了 4 個」
    // 這件事會消失，畫面又變成「46 個都驗過、13 個可用」的假象。
    const truncated = outcome.stopped === 'rate-limited' || outcome.stopped === 'unreachable'
      ? {
          stopped: outcome.stopped,
          at: probedAt,
          tested: outcome.tested ?? updatedRows.length,
          total: ids.length,
          stoppedBy: outcome.stoppedBy ?? null,
          // 上游 429 附帶的解除時間。額度用完時這是唯一能講出「還要等多久」
          // 的資訊；null 代表上游沒給，不要自己猜。
          retryAt: Number.isFinite(outcome.retryAt) ? outcome.retryAt : null
        }
      : null;
    this.#lastTruncation = truncated;
    writeProbeCache(this.#cachePath, {
      version: 2,
      probedAt: this.#lastProbe,
      fullProbedAt: this.#lastFullProbe,
      available,
      knownIds: [...this.#knownIds],
      failureStreaks: Object.fromEntries(this.#failureStreaks),
      ...(truncated ? { truncation: truncated } : {}),
      // Keep failure reason and upstream detail so a hidden model remains
      // diagnosable after a restart. v1 caches without row timestamps migrate
      // using the sweep-level `probedAt` above.
      results: this.#probeResults.map(({ id, ok, status, ms, reason, errorType, detail, probedAt: rowTime }) => ({
        id,
        ok,
        status,
        ms,
        probedAt: rowTime,
        ...(reason === undefined ? {} : { reason }),
        ...(errorType === undefined ? {} : { errorType }),
        ...(detail === undefined || detail === '' ? {} : { detail })
      }))
    });

    return { ...outcome, applied: true, available, added };
  }

  /**
   * Describes a model in DeepSeek Harness LlmAdapter format.
   */
  describe(provider, modelId) {
    const model = this.getModel(modelId) || {
      id: modelId,
      name: modelId,
      contextWindow: 128000,
      defaultMaxTokens: 8192,
      inputModalities: ['text'],
      efforts: [],
      defaultEffort: undefined
    };

    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.defaultMaxTokens,
      ...(model.efforts?.length
        ? {
            reasoning: {
              efforts: model.efforts.map((level) => ({
                id: level,
                name: level.charAt(0).toUpperCase() + level.slice(1)
              })),
              ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {})
            }
          }
        : {})
    };
  }

  describeAll(provider) {
    return this.getModels().map((m) => this.describe(provider, m.id));
  }
}
