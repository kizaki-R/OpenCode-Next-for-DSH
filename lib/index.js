import { copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, resolveConfig } from './config.js';
import { ModelCatalog } from './catalog.js';
import { TokenManager } from './token-manager.js';
import { AutoSwitchStore } from './store.js';
import { ContextWindowStore } from './context-window.js';
import { OpenCodeOAuthAdapter } from './adapter.js';
import { FallbackStore } from './fallback.js';
import { PickerStore } from './picker.js';
import { probeModels } from './probe.js';
import { createStatusReporter } from './status.js';
import { registerWebApi } from './web-api.js';
import { PROVIDER, PROVIDER_NAME, GO_PROVIDER, GO_PROVIDER_NAME } from './constants.js';
import { installedBunPath } from './bun-transport.js';
import { createGoService } from './go/service.js';
import { OpenCodeGoAdapter } from './go/adapter.js';

export const name = 'opencode-next';
export const inject = ['llm'];
export { Config };

/**
 * Applies the opencode-next Cordis plugin into the DSH host runtime.
 *
 * Model discovery is fully automatic and runs on two cadences:
 *   - a light catalog poll (default 15 min) that notices newly published free
 *     models as soon as OpenCode lists them;
 *   - a full availability probe (default 6 h) that re-verifies every candidate
 *     so retired models disappear from the picker.
 *
 * Note: named exports only, no `export default`, so the loader's
 * `unwrapExports` cannot collapse this namespace into a default export and
 * hide `name` / `Config` / `apply`.
 */
function migrateLegacyStateFiles() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const suffixes = ['accounts.json', 'models.json', 'picker.json', 'go-picker.json', 'context.json', 'token.json'];
  for (const suffix of suffixes) {
    const legacy = join(home, `opencode-oauth.${suffix}`);
    const next = join(home, `opencode-next.${suffix}`);
    try {
      if (!existsSync(next) && existsSync(legacy)) {
        copyFileSync(legacy, next);
      }
    } catch {
      // 遷移失敗不阻擋外掛啟動
    }
  }
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  if (!config?.probeCachePath && !config?.credentialPath) {
    migrateLegacyStateFiles();
  }
  // Node fetch is rejected with 429 even when the request shape is valid.
  // A missing plugin config must not silently select that path when Bun exists.
  if (config?.bunTransport?.enabled !== false) {
    const bunPath = installedBunPath(resolved.bunTransport?.bunPath);
    if (bunPath) {
      resolved.bunTransport = {
        ...resolved.bunTransport,
        enabled: true,
        bunPath: resolved.bunTransport?.bunPath || bunPath
      };
    }
  }
  const tokenManager = new TokenManager(resolved.credentialPath || undefined);
  const contextWindowStore = new ContextWindowStore();
  // 勾選名單與備援設定一樣存在外掛自己的檔案裡：使用者要的是「一個畫面
  // 就能勾選」的清單，而不是得手改 DSH 設定檔的 plugin config。
  const pickerStore = new PickerStore();
  const catalog = new ModelCatalog({
    probeCachePath: resolved.probeCachePath || undefined,
    contextStore: contextWindowStore,
    pickerStore
  });

  /**
   * attachment service 是**延遲解析**而且允許缺席的。
   *
   * core 的 provider 也是用 `ctx.get('attachments')` 在請求當下取服務，而不是硬寫進
   * `inject`。這樣做有兩個好處：沒有掛 attachment 服務的 profile 仍然載得進本外掛
   * （圖片退化成佔位文字，其他功能照常），而且服務晚於本外掛載入時也拿得到。
   */
  const resolveAttachments = () => {
    try {
      return ctx.get?.('attachments');
    } catch {
      return undefined;
    }
  };

  // 備援順位存在外掛自己的檔案裡，而不是 DSH 的 plugin config：使用者要的是
  // 一個在設定頁就能勾選、就能調順序的開關，而 plugin config 得手動改設定檔。
  // 建在這裡（而不是 web-api 裡）是因為 adapter 讀它、API 寫它，必須是同一份
  // 記憶體狀態，否則改完要重啟才生效。
  const fallbackStore = new FallbackStore();
  const autoSwitchStore = new AutoSwitchStore({ defaultEnabled: resolved.autoSwitchAccounts });

  const adapter = new OpenCodeOAuthAdapter(catalog, tokenManager, {
    ...resolved,
    resolveAttachments,
    fallback: fallbackStore,
    autoSwitch: autoSwitchStore
  });

  const providerId = resolved.providerId || PROVIDER;
  ctx.llm.registerAdapter([providerId], adapter);

  const goConfig = resolved.goSubscription || {};
  const goProviderId = (goConfig.providerId && goConfig.providerId !== providerId)
    ? goConfig.providerId
    : GO_PROVIDER;
  const goService = createGoService({
    ctx,
    config: {
      ...goConfig,
      providerId: goProviderId,
      providerName: goConfig.providerName || GO_PROVIDER_NAME
    }
  });
  let goAdapter = null;
  if (goConfig.enabled === true) {
    goAdapter = new OpenCodeGoAdapter(goService, {
      providerId: goProviderId,
      providerName: goConfig.providerName || GO_PROVIDER_NAME,
      streamIdleTimeoutMs: resolved.streamIdleTimeoutMs,
      firstEventTimeoutMs: goConfig.firstEventTimeoutMs,
      resolveAttachments,
      imagePixelBudget: resolved.imagePixelBudget,
      imageMaxBytes: resolved.imageMaxBytes
    });
    ctx.llm.registerAdapter([goProviderId], goAdapter);
  }

  const notifyAdaptersUpdated = () => {
    if (typeof ctx.emit === 'function') {
      try {
        ctx.emit('llm/adapters-updated');
      } catch (err) {
        ctx.logger?.warn?.(`[opencode-next] Could not emit adapters-updated: ${err.message}`);
      }
    }
  };

  /**
   * 設定頁（狀態頁）的宿主端。
   *
   * 這裡刻意「註冊失敗不影響 provider」：模型能不能用遠比設定頁出不出的來重要，
   * 所以整段包了 try/catch。web server 不存在（例如 headless profile）時，
   * registerWebApi 內部的 ctx.inject(['webServer']) 本來就會安靜地不掛路由。
   */
  try {
    const statusReporter = createStatusReporter({
      tokenManager,
      catalog,
      fallback: fallbackStore,
      autoSwitch: autoSwitchStore,
      go: goService,
      config: {
        providerId,
        providerName: resolved.providerName || PROVIDER_NAME,
        autoDetectModels: resolved.autoDetectModels,
        probeIntervalMs: resolved.probeIntervalMs,
        catalogPollMs: resolved.catalogPollMs,
        imagePixelBudget: resolved.imagePixelBudget,
        imageMaxBytes: resolved.imageMaxBytes
      }
    });

    registerWebApi(ctx, {
      tokenManager,
      catalog,
      statusReporter,
      fallback: fallbackStore,
      autoSwitch: autoSwitchStore,
      contextWindowStore,
      goService,
      onAdaptersUpdated: notifyAdaptersUpdated,
      config: {
        credentialPath: resolved.credentialPath || undefined,
        inferenceUrl: resolved.inferenceUrl,
        bunTransport: resolved.bunTransport
      }
    });
  } catch (err) {
    ctx.logger?.warn?.(
      `[opencode-next] Settings page unavailable: ${err?.message ?? err}`
    );
  }

  ctx.logger?.info?.(
    `[opencode-next] Registered provider "${providerId}" (${catalog.getModels().length} models); inference transport: ${resolved.bunTransport?.enabled ? 'bun' : 'node'}.`
  );
  if (goAdapter) {
    ctx.logger?.info?.(
      `[opencode-next] Registered OpenCode Go provider "${goProviderId}" (${goService.getPickerModels().length} picker models; text/tools).`
    );
  }

  let probeTimer = null;
  let pollTimer = null;
  let disposed = false;

  const log = (level, message) => ctx.logger?.[level]?.(`[opencode-next] ${message}`);

  /** Describes which candidates a probe left hidden, for the log. */
  const describeHidden = () => {
    const hidden = catalog.getCandidates().filter((m) => !catalog.isAvailable(m.id)).map((m) => m.id);
    if (hidden.length > 0) log('info', `Hidden (not serving): ${hidden.join(', ')}`);
  };

  /**
   * Full verification sweep: re-fetches the catalog, probes every candidate,
   * and republishes the model list.
   */
  const runFullProbe = async (reason) => {
    if (disposed) return;

    await catalog.init();

    if (!resolved.autoDetectModels) {
      log('info', `Catalog: ${catalog.getCandidates().length} free candidates (auto-detect disabled).`);
      notifyAdaptersUpdated();
      return;
    }

    // A fresh cached result is good enough on restart — but only if the
    // catalog has not gained models since. New candidates must still be
    // probed right away, otherwise a model published today would stay hidden
    // until the next scheduled poll.
    const unseen = catalog.unseenCandidates();
    const cacheFresh = reason !== 'manual' && catalog.isProbeFresh(resolved.probeIntervalMs);

    if (cacheFresh && unseen.length === 0) {
      const s = catalog.availabilitySummary();
      log('info', `Availability cache is fresh: ${s.available}/${s.candidates} free models available.`);
      notifyAdaptersUpdated();
      return;
    }

    const incremental = cacheFresh && unseen.length > 0;
    if (incremental) {
      log('info', `Catalog has ${unseen.length} unverified free model(s): ${unseen.join(', ')}`);
    }

    let token;
    try {
      token = await tokenManager.getValidToken();
    } catch (err) {
      // No credential yet: keep the known list so the picker still renders and
      // retry on the next interval, or as soon as the user signs in.
      log('warn', `Skipping availability probe (${reason}): ${err.message}`);
      notifyAdaptersUpdated();
      return;
    }

    try {
      const outcome = await catalog.refreshAvailability(token, probeModels, {
        inferenceUrl: resolved.inferenceUrl,
        bunTransport: resolved.bunTransport,
        incremental,
        onProgress: (done, total) => {
          if (done === total || done % 10 === 0) log('info', `Probing models: ${done}/${total}`);
        }
      });

      if (!outcome.applied) {
        log(
          'warn',
          `Availability probe inconclusive (${reason}): the free lane did not route the request (status ${outcome.results?.[0]?.status ?? 'unknown'}). Keeping the previous model list.`
        );
        notifyAdaptersUpdated();
        return;
      }

      const s = catalog.availabilitySummary();
      if (incremental) {
        log(
          'info',
          `Verified ${outcome.tested} new free model(s) (${reason}): ${outcome.added?.length ? outcome.added.join(', ') : 'none serving yet'}.`
        );
      } else {
        log('info', `Availability updated (${reason}): ${s.available}/${s.candidates} free models responding.`);
      }
      describeHidden();
      notifyAdaptersUpdated();
    } catch (err) {
      log('warn', `Availability probe failed (${reason}): ${err.message}`);
      notifyAdaptersUpdated();
    }
  };

  /**
   * Light poll: re-fetches the catalog and, when new free models appear,
   * probes only those and adds them to the picker. Cheap enough to run often.
   */
  const pollForNewModels = async () => {
    if (disposed || !resolved.autoDetectModels) return;

    try {
      const { added, removed } = await catalog.refreshCatalog();

      if (added.length === 0 && removed.length === 0) return;

      if (added.length > 0) log('info', `Catalog gained ${added.length} free candidate(s): ${added.join(', ')}`);
      if (removed.length > 0) log('info', `Catalog dropped ${removed.length} free candidate(s): ${removed.join(', ')}`);

      // 發現新候選模型時只更新候選目錄，不自動發起探測。
      // 避免背景未經許可發送請求消耗使用者的每日額度。
      describeHidden();
      notifyAdaptersUpdated();
    } catch (err) {
      log('warn', `Catalog poll failed: ${err.message}`);
    }
  };

  const startTimers = () => {
    if (disposed) return;

    if (resolved.autoDetectModels && !pollTimer && resolved.catalogPollMs > 0) {
      pollTimer = setInterval(
        () => void pollForNewModels(),
        Math.max(60_000, resolved.catalogPollMs)
      );
      pollTimer.unref?.();
    }
  };

  // 僅在背景載入本機快取與靜態目錄，完全取消開機自動探測與定時自動探測。
  //
  // 理由：OpenCode 免費通道每日額度極為有限（約數十次），若每次開機或每隔數小時
  // 就在背景對 46 個模型全量探測，會在幾秒內將使用者的每日全量額度消耗殆盡。
  // 改為「手動一鍵探測」模式，由使用者決定何時發起探測。
  void catalog.init()
    .then(() => {
      notifyAdaptersUpdated();
      startTimers();
    })
    .catch((err) => {
      log('warn', `Startup catalog init failed: ${err.message}`);
      startTimers();
    });

  const runGoStartupSync = () => {
    if (disposed) return;
    if (goAdapter) {
      void goService.init()
        .then((status) => {
          if (disposed) return;
          notifyAdaptersUpdated();
          if (status?.credential?.present) {
            return goService.refresh({ reason: 'startup' })
              .then(() => {
                if (!disposed) notifyAdaptersUpdated();
              });
          }
        })
        .catch((err) => {
          log('warn', `OpenCode Go startup init/refresh failed: ${err?.message ?? err}`);
        });
    } else if (ctx.get?.('credentials') ?? ctx.credentials) {
      void goService.syncCredential?.()
        .catch((err) => {
          log('warn', `OpenCode Go credential sync failed: ${err?.message ?? err}`);
        });
    }
  };

  runGoStartupSync();

  // DSH 的 credentials 服務可能在 opencode-next 之後才完成註冊；
  // 監聽注入就緒事件，一掛載就重新解析憑證並自動載入 Go 模型。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['credentials'], () => {
        runGoStartupSync();
      });
    } catch {
      // 測試替身或無 inject 支援時忽略
    }
  }

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      disposed = true;
      if (probeTimer) clearInterval(probeTimer);
      if (pollTimer) clearInterval(pollTimer);
      adapter.dispose?.();
      goAdapter?.dispose?.();
      goService.dispose?.();
    });
  }
}

export {
  TokenManager,
  ModelCatalog,
  OpenCodeOAuthAdapter,
  OpenCodeGoAdapter,
  createGoService,
  PROVIDER,
  PROVIDER_NAME,
  GO_PROVIDER,
  GO_PROVIDER_NAME
};
