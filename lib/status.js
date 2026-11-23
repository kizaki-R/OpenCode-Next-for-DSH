/**
 * 狀態彙整：把「外掛現在到底能不能用」這件事，整理成一份可以安全丟給瀏覽器的小抄。
 *
 * 三個設計原則：
 *
 *  1. **絕不外洩密鑰。** 狀態頁跑在瀏覽器裡，它讀得到的任何東西都可能經由截圖
 *     或 devtools 流出去。所以這裡只回答「有沒有、從哪來、何時過期」，
 *     從不帶上 access / refresh token 的值。
 *
 *  2. **一項壞掉不能弄垮整頁。** 每個子區塊各自 try/catch。憑證解析失敗時，
 *     模型清單還是要顯示；探測資料缺失時，憑證狀態還是要顯示。狀態頁最大的
 *     價值就在於「壞掉的時候還看得到東西」。
 *
 *  3. **不 import adapter。** adapter 靜態相依 `@deepseek-ai/dsh-llm`（由宿主提供），
 *     而且 index → web-api → index 會成環。這裡只碰 tokenManager 與 catalog
 *     這兩個穩定介面。
 */

import { MAX_FALLBACK_MODELS } from './fallback.js';
import { GO_CREDENTIAL_ENV_VAR, GO_PROVIDER, GO_PROVIDER_NAME } from './constants.js';

function defaultGoStatusSnapshot(config = {}) {
  return {
    enabled: false,
    providerId: config.goProviderId || GO_PROVIDER,
    providerName: config.goProviderName || GO_PROVIDER_NAME,
    connectionState: 'disabled',
    inferenceSupported: false,
    pickerPublishedCount: 0,
    picker: { mode: 'auto', shown: [] },
    credential: {
      present: false,
      source: null,
      ref: config.goCredentialRef || GO_CREDENTIAL_ENV_VAR,
      fingerprint: null,
      masked: null,
      dshCredentialsAvailable: false,
      canSave: false,
      canClear: false,
      error: null,
      message: null
    },
    usage: null,
    previewModels: [],
    checkedAt: null,
    error: null
  };
}

/**
 * 把時間點寫成「今天／明天 14:30」這種人話。
 *
 * 額度解除時間是使用者最在意的一個數字，但它不該長成 ISO 字串：他要判斷的
 * 是「現在去喝杯咖啡，還是先去吃飯」。所以用本地時區，並標出今天或明天。
 */
function formatClock(atMs) {
  try {
    const when = new Date(atMs);
    const now = new Date();
    const sameDay = when.toDateString() === now.toDateString();
    const tomorrow = new Date(now.getTime() + 86_400_000);
    const isTomorrow = when.toDateString() === tomorrow.toDateString();
    const clock = when.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (sameDay) return `今天 ${clock}`;
    if (isTomorrow) return `明天 ${clock}`;
    return when.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return new Date(atMs).toISOString();
  }
}

/** 剩餘時間的人話版本：「1 小時 30 分」「12 分」。 */
function describeWait(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '已可重試';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest > 0 ? `${hours} 小時 ${rest} 分` : `${hours} 小時`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} 天 ${restHours} 小時` : `${days} 天`;
}

/**
 * 讀出「作業系統的語言」，換成一個 BCP 47 標籤（例如 `zh-TW`、`en-US`）。
 *
 * 為什麼需要這個：瀏覽器的 `navigator.languages` 反映的是「瀏覽器自己的語言
 * 設定」，不一定等於 Windows 的顯示語言。實測就遇過系統是 `zh-TW`、但 Chrome
 * 把 `en-US` 排在第一順位的情況——那時跟瀏覽器會得到英文，不是使用者的介面語言。
 *
 * 為什麼用 `Intl` 而不是 Windows API：`Intl.DateTimeFormat().resolvedOptions().locale`
 * 是由 ICU 依作業系統地區設定解析出來的，在 Windows / macOS / Linux 都可用，
 * 不需要呼叫 Win32、不需要外部套件，也沒有 `Add-Type` 或字串編碼的麻煩。
 * 它與 `GetUserDefaultLocaleName()` 在 Windows 上實測結果一致（都是 `zh-TW`）。
 *
 * 依序嘗試多個來源，任何一個拋錯都不影響其他來源：
 *   1. `Intl.DateTimeFormat` — 主要來源，跨平台
 *   2. `Intl.NumberFormat`   — 備援，極少數環境只有其中一個可用
 *   3. `LC_ALL` / `LC_MESSAGES` / `LANG` — Linux 與 macOS 的慣例（`zh_TW.UTF-8`）
 *
 * 讀不到就回傳 `null`，由呼叫端決定退路；這裡不做語言判定，因為「哪個標籤
 * 對應到哪個語言」是前端的字典職責，主機端不該重複一份判斷邏輯。
 *
 * @returns {string|null} 例如 `zh-TW`、`en-US`；讀不到時為 `null`。
 */
export function detectSystemLocale() {
  const attempts = [
    () => new Intl.DateTimeFormat().resolvedOptions().locale,
    () => new Intl.NumberFormat().resolvedOptions().locale,
    () => process.env.LC_ALL,
    () => process.env.LC_MESSAGES,
    () => process.env.LANG
  ];

  for (const attempt of attempts) {
    try {
      const raw = attempt();
      if (typeof raw !== 'string') continue;
      // `zh_TW.UTF-8` → `zh-TW`；`en_US.UTF-8@euro` → `en-US`。
      const cleaned = raw.split('.')[0].split('@')[0].replace(/_/g, '-').trim();
      if (!cleaned) continue;
      // `C` 與 `POSIX` 是「沒有設定」，不是語言標籤。
      if (/^(c|posix)$/i.test(cleaned)) continue;
      // 只接受看起來像語言標籤的東西（`zh`、`zh-TW`、`zh-Hant-TW`）。
      if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(cleaned)) continue;
      return cleaned;
    } catch {
      // 這個來源不可用，換下一個。
    }
  }
  return null;
}

/**
 * 建立狀態蒐集器。
 *
 * 依賴以參數注入（而不是在模組頂層直接 import 單例），這樣測試可以餵假物件，
 * 也不用為了跑測試而真的去讀使用者的憑證檔。
 */
export function createStatusReporter({ tokenManager, catalog, fallback = null, autoSwitch = null, go = null, config = {}, version = null }) {
  /**
   * 探測結果的字面說明。
   *
   * 使用者看到「403」不會知道要換模型還是要重新登入；看到「此模型受地區限制」
   * 才知道下一步該做什麼。所以把內部 reason 轉成人看得懂的一句話。
   *
   * 兩個「不可用」必須分清楚，因為下一步完全不同：
   *   - `unavailable`／`deprecated`：這個模型被下架了，換一個就好。
   *   - `network-blocked`：你的網路出口被風控，換哪個模型都一樣，要關 VPN 或訂閱。
   * 把它們壓成同一句「模型不可用」會讓使用者一直換模型，而問題根本不在模型。
   */
  const describeProbe = (entry) => {
    if (!entry.probed) return '尚未探測';
    if (entry.ok) return '正常';
    switch (entry.reason) {
      case 'network-blocked':
        return '網路出口被擋（請關閉 VPN／proxy）';
      case 'free-lane-blocked':
        return '免費通道拒絕請求（FreeTierError）';
      case 'region-restricted':
        return '此模型受地區限制';
      case 'unauthorized':
        return '授權失效';
      case 'forbidden':
        return '上游拒絕（403）';
      case 'quota-exceeded':
        return '額度不足';
      case 'rate-limited':
      case 'rate-limited-explicit':
        return '429 額度或速率受限（模型有效）';
      case 'endpoint-unavailable':
        return '429 端點暫時排不進去（模型有效）';
      case 'upstream-error':
        return '上游伺服器異常';
      case 'endpoint-not-found':
        return '推論端點不存在（404）';
      case 'not-found':
        return '模型不存在';
      case 'deprecated':
        return '模型已下架';
      case 'unavailable':
        return '模型目前不可用';
      case 'context-overflow':
        return '內容超過上下文上限';
      case 'bad-request':
        return '上游拒絀（400，無說明）';
      case 'transport':
        return '連線失敗';
      default:
        return entry.status ? `HTTP ${entry.status}` : '未知狀態';
    }
  };

  /** 憑證區塊。永不拋錯，也永不回傳密鑰。 */
  const credentialSection = () => {
    try {
      return tokenManager.describeCredential();
    } catch (err) {
      return {
        present: false,
        source: null,
        hasRefresh: false,
        expiresAt: null,
        expiresInSeconds: null,
        expiringSoon: false,
        expired: false,
        error: err?.message ?? String(err)
      };
    }
  };

  /** 模型區塊：清單加逐列探測結果。 */
  const modelsSection = () => {
    try {
      const summary = catalog.availabilitySummary();
      const results = catalog.getProbeResults().map((entry) => ({
        ...entry,
        label: describeProbe(entry)
      }));

      // Available is the picker-published set, not merely models whose latest
      // probe succeeded. A first transient failure can leave a model published.
      const available = summary.available;
      const probed = results.filter((r) => r.probed).length;

      // 上游有效的模型數。
      //
      // 與上面的 `available` 是兩件事：`available` 是「有沒有發佈給選擇器」，
      // 這裡是「上游認不認得它」。429 屬於後者（模型存在，只是排不進去）。
      // 頁面上「可用」這個分類講的正是後者，所以分類數字要用這一個。
      const valid = results.filter((r) => r.valid === true).length;

      // 把失敗的模型按原因分組。
      //
      // 只給一個「N 個失敗」的數字沒有用：使用者要知道的是「壞在哪」。
      // 27 個下架與 1 個限流，前者不用管（上游砍了，誰都一樣），後者等一下
      // 就好；混在一起講會讓人以為整批都要處理。
      const counts = new Map();
      for (const entry of results) {
        // 429 不進失敗分類：模型有效，只是額度或速率受限，它不算「壞掉」。
        if (!entry.probed || entry.valid) continue;
        const key = entry.reason || 'unknown';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const breakdown = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({
          reason,
          count,
          label: describeProbe({ probed: true, ok: false, reason })
        }));

      return {
        total: results.length,
        probed,
        available,
        // 上游有效（含 429 限流）。前端「可用」分類與勾選可用性都看這個。
        valid,
        probedAt: summary.probedAt,
        // 上一輪是否提早熔斷。null 代表跑完；有值時前端要說「只驗了 N／M」，
        // 否則 13 個可用配上 4 筆紀錄，看起來像探測壞掉。
        truncation: summary.truncation ?? null,
        breakdown,
        models: results
      };
    } catch (err) {
      return {
        total: 0,
        probed: 0,
        available: 0,
        probedAt: null,
        breakdown: [],
        models: [],
        error: err?.message ?? String(err)
      };
    }
  };

  /**
   * 彙整完整狀態。
   *
   * 全部放在同一次回應裡，讓前端一次往返就能畫完整頁；日後要加欄位也不必
   * 改動前端的呼叫順序。
   */
  const buildStatus = () => {
    const credential = credentialSection();
    const models = modelsSection();

    // 高階結論分兩層：
    //   health        → 給程式與燈號用（ready / degraded / no-models / …）
    //   healthMessage → 給眼睛用，一句話同時交代「比例」與「壞在哪」
    //
    // 為什麼一定要有比例：舊版只要還有 1 個模型活著就說「模型可用」並亮綠燈。
    // 於是 45 個裡壞 34 個的時候，畫面看起來一切正常，使用者得自己一列一列
    // 數才會發現。那等於在最需要警告的時候給出綠燈。
    //
    // 為什麼要分組：只說「34 個失敗」沒有用。27 個下架是上游砍的、誰都一樣，
    // 1 個限流等一下就好、1 個地區限制要換模型——三種處置完全不同，混成一個
    // 數字就等於沒說。
    const denom = models.probed > 0 ? models.probed : models.total;
    const breakdownText = (models.breakdown ?? [])
      .slice(0, 3)
      .map((group) => `${group.count} ${group.label}`)
      .join('／');

    // 上一輪提早熔斷時，分母不是「全部候選」，而是「這一輪真的驗過的」。
    // 不說清楚的話，13/4 會被讀成「4 個候選裡有 13 個可用」這種矛盾。
    const truncation = models.truncation ?? null;
    const truncationText = truncation
      ? `本輪只驗了 ${truncation.tested}/${truncation.total} 個`
        + (truncation.stopped === 'rate-limited'
          ? `（第 ${truncation.tested} 個遇到額度或限流就停手，其餘保留上次結果）`
          : `（免費通道中斷，其餘保留上次結果）`)
      : '';

    // 額度解除時間。上游 429 會帶 retry-after，這是唯一能回答「還要等多久」
    // 的權威資訊。沒有就誠實說「上游沒說」，不要自己編一個數字。
    const quotaResetAt = Number.isFinite(truncation?.retryAt) ? truncation.retryAt : null;
    const quotaText = quotaResetAt
      ? `額度預計 ${formatClock(quotaResetAt)} 解除（約 ${describeWait(quotaResetAt - Date.now())}後）`
      : '';

    let health = 'ready';
    let healthMessage = denom > 0
      ? `授權有效 · 全部 ${denom} 個模型可用。`
      : '授權有效，模型可用。';
    if (!credential.present) {
      health = 'signed-out';
      healthMessage = '尚未登入 OpenCode，請先完成裝置授權。';
    } else if (credential.expired) {
      health = 'expired';
      healthMessage = '授權已過期，請重新登入或重新整理憑證。';
    // 額度用完時，健康狀態要直接說「額度用盡、什麼時候回來」，而不是
    // 只說「沒有模型可用」。前者使用者能行動，後者只能猜。
    } else if (models.probed > 0 && (models.valid ?? models.available) === 0) {
      health = 'no-models';
      if (quotaText) {
        healthMessage = `免費額度已用盡：${quotaText}。`;
      } else {
        healthMessage = breakdownText
          ? `授權正常，但目前沒有模型可用（${breakdownText}）。`
          : '授權正常，但目前沒有任何模型回應；可能是免費通道被擋或出口 IP 受限。';
      }
    } else if (models.probed === 0) {
      health = 'unprobed';
      healthMessage = '授權正常，尚未探測模型可用性。';
    } else if ((models.valid ?? models.available) < denom) {
      // 部分可用：這是舊版最大的盲點，它會回報「模型可用」。
      // 比例用 valid 算：429 是「有效但暫時排不進去」，不該算成壞掉。
      health = 'degraded';
      healthMessage = `授權有效 · ${models.valid ?? models.available}/${denom} 個模型有效`
        + (breakdownText ? `（${breakdownText}）` : '')
        + (truncationText ? ` · ${truncationText}` : '')
        + '。';
    } else if (credential.expiringSoon) {
      health = 'expiring';
      healthMessage = '授權即將到期，系統會自動重新整理。';
    }
    // 全部有效但仍被熔斷：這是最容易誤導的一種，必須補上範圍說明。
    if (truncationText && health !== 'degraded' && health !== 'signed-out' && health !== 'expired') {
      healthMessage = healthMessage.replace(/。$/, '') + ` · ${truncationText}。`;
    }
    // 額度解除時間獨立補上：就算這次探測跑完，額度也可能正在冷卻。
    if (quotaText && health !== 'no-models') {
      healthMessage = healthMessage.replace(/。$/, '') + ` · ${quotaText}。`;
    }

    return {
      health,
      healthMessage,
      // 額度冷卻狀態獨立成欄位，前端可以自己畫倒數，不必解析句子。
      quota: quotaResetAt
        ? {
            resetAt: quotaResetAt,
            remainingMs: Math.max(0, quotaResetAt - Date.now()),
            source: 'retry-after'
          }
        : null,
      provider: {
        id: config.providerId ?? 'opencode-next',
        name: config.providerName ?? 'OpenCode (OAuth)'
      },
      version,
      credential,
      models,
      config: {
        autoDetectModels: config.autoDetectModels !== false,
        probeIntervalMs: config.probeIntervalMs ?? null,
        catalogPollMs: config.catalogPollMs ?? null,
        imagePixelBudget: config.imagePixelBudget ?? null,
        imageMaxBytes: config.imageMaxBytes ?? null
      },
      // 備援開關與前三順位。前端據此畫出勾選框與三個下拉選單。
      // 讀取失敗退回「關閉」，設定檔壞掉不該讓整頁掛掉。
      fallback: (() => {
        try {
          const saved = fallback?.get?.() ?? null;
          return {
            enabled: saved?.enabled === true,
            models: Array.isArray(saved?.models) ? saved.models : [],
            maxModels: MAX_FALLBACK_MODELS
          };
        } catch {
          return { enabled: false, models: [], maxModels: MAX_FALLBACK_MODELS };
        }
      })(),
      // 選擇器勾選的現狀：mode 是 auto（探測決定，等於舊行為）或 manual
      // （使用者勾選決定）。shown 是此刻會顯示的名單，前端據此畫勾選框。
      // 沒接勾選功能時是 null，前端就不畫這一欄。
      picker: (() => {
        try { return catalog?.pickerState?.() ?? null; }
        catch { return null; }
      })(),
      // 作業系統的語言標籤，供前端「跟隨系統語言」使用。
      // 讀不到就是 null，前端會退回預設語言（繁中）。
      autoSwitch: (() => {
        try { return { enabled: autoSwitch?.get?.()?.enabled === true }; }
        catch { return { enabled: false }; }
      })(),
      go: (() => {
        try { return go?.getStatus?.() ?? defaultGoStatusSnapshot(config); }
        catch (err) {
          return {
            ...defaultGoStatusSnapshot(config),
            connectionState: 'transient-error',
            error: {
              category: 'internal',
              message: err?.message ?? String(err)
            }
          };
        }
      })(),
      systemLocale: detectSystemLocale(),
      generatedAt: Date.now()
    };
  };

  return { buildStatus, describeProbe };
}
