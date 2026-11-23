/**
 * 模型備援（前三順位）。
 *
 * 使用者要的東西很簡單：「這個模型不行，就自動換我排的下一個」。但直接
 * 對每個錯誤都換模型會出事，所以整個模組的核心是**一個判斷函式**：
 * `canFallback(reason)`。
 *
 * 為什麼要分「模型層級」與「通道層級」：
 *
 *   - 模型層級（400 模型下線、410 已下架、404 不存在、地區封鎖）：換一個
 *     模型真的會成功。這是備援唯一該發揮作用的情況。
 *
 *   - 通道層級（IP 被風控、免費通道擋客戶端、授權失效、額度用盡）：擋的是
 *     「你這個人／這條網路出口」。此時換 30 個模型就是送出 30 次注定失敗的
 *     請求，只會讓 IP 評分更差，而且真正該處理的問題（關 VPN、重新登入）
 *     會被一句「所有模型都不可用」蓋掉。
 *
 * `upstream-error`（5xx）刻意**不**列入可換：免費通道是同一個閘道代理全部
 * 模型，5xx 多半是閘道本身出問題，換模型不會好；而且這個錯誤碼已經在
 * `SAFE_RETRY_POLICY.retryableCodes` 裡，上層會自己重試同一個模型。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 最多幾個備援順位。
 *
 * 原本是 3（「前三順位」），改成 1 的理由是實測：備援唯一真正有用的場景是
 * 「單一模型下架」（410 帶 replacement），而觀察到的其餘失敗——IP 風控、
 * 免費池縮減——都是整批一起壞。那種情況下第 2、第 3 順位不會成功，
 * 只會多送幾個注定失敗的請求出去，在風控這件事上反而是扣分。
 *
 * 保留 1 個順位仍然有價值：5 個 410 下架的模型就有 5 次被救回來的機會。
 */
export const MAX_FALLBACK_MODELS = 1;

/**
 * 換模型真的有用的失敗原因。
 *
 * 這份清單的每一項都對應「問題出在這個模型身上」，所以下一順位有機會成功。
 */
const FALLBACK_REASONS = new Set([
  'unavailable', // 400：上游明說這個模型不可用
  'bad-request', // 400：上游沒說原因，但實測換模型／換帳號常能過去
  'deprecated', // 410：已下架
  'not-found', // 404：上游沒有這個模型
  'region-restricted', // 這個模型被地區封鎖，通道本身是好的
  'timeout', // 首個事件超時：這個模型太慢或掛住
  'transport' // 連線層失敗：換一個再試
]);

// 刻意**不在**上面清單裡的：
//   context-overflow —— 內容太長，換模型只會更糟（其餘模型上下文通常更小）。
//                        正確處置是壓縮或縮短訊息，硬切到備援等於把使用者推去撞牆。
//   network-blocked  —— 擋的是整個網路出口，換誰都一樣。
//   free-lane-blocked —— 同上，擋的是通道不是模型。

/**
 * 這個失敗能不能靠「換下一個模型」解決。
 *
 * @param {string|null|undefined} reason 來自 `classifyHttpFailure().reason`
 *   或 probe 的 `reason`。未知值一律回 false。
 */
export function canFallback(reason) {
  if (typeof reason !== 'string') return false;
  return FALLBACK_REASONS.has(reason);
}

/** 這個 reason 屬於「通道／網路」層級，換模型無效。給 UI 與測試用。 */
export function isChannelLevelFailure(reason) {
  if (typeof reason !== 'string') return false;
  return (
    reason === 'network-blocked'
    || reason === 'free-lane-blocked'
    || reason === 'unauthorized'
    || reason === 'forbidden'
    || reason === 'quota-exceeded'
  );
}

/**
 * 把使用者設定的前三個順位整理成乾淨的清單。
 *
 * 去重、去空白、丟掉非字串、截到三個。這些驗證在伺服器端做，因為請求是
 * 從瀏覽器來的，不能假設它送來的一定是三個合法 model id。
 */
export function normalizeModelList(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_FALLBACK_MODELS) break;
  }
  return out;
}

/** 預設存放位置；刻意與探測快取分開，語意不同不該混在同一支檔案。 */
export function defaultFallbackPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'opencode-next.fallback.json');
}

/**
 * 備援設定的持久化。
 *
 * 為什麼不放進 DSH 的 plugin config：那份設定要在 DSH 的設定檔裡手改，
 * 而使用者要的是一個畫面就能勾選、就能調整順位的開關。所以狀態存在外掛
 * 自己的檔案，由 API 寫入，介面只是它的前端。
 *
 * 讀寫全程 try/catch：設定檔壞掉或沒有寫入權限時，外掛必須照常運作
 * （退回「備援關閉」），不能因此讓推論路徑失敗。
 */
export class FallbackStore {
  #path;
  #state = { enabled: false, models: [] };
  #loaded = false;

  constructor({ path } = {}) {
    this.#path = path || defaultFallbackPath();
  }

  #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      if (!existsSync(this.#path)) return;
      const text = readFileSync(this.#path, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(text);
      this.#state = {
        enabled: parsed?.enabled === true,
        models: normalizeModelList(parsed?.models)
      };
    } catch {
      // 壞掉的設定檔等同於「沒設定過」。不覆寫它，留給使用者自己檢查。
      this.#state = { enabled: false, models: [] };
    }
  }

  /** 目前設定。回傳副本，呼叫端改不動內部狀態。 */
  get() {
    this.#load();
    return { enabled: this.#state.enabled, models: [...this.#state.models] };
  }

  /**
   * 更新設定。
   *
   * 先寫暫存檔再 rename：直接覆寫時若行程中途結束，會留下一個半截的 JSON，
   * 下次啟動就整份設定消失。rename 在同一個磁碟區上是原子操作。
   */
  set(patch = {}) {
    this.#load();
    const next = {
      enabled: patch.enabled === undefined ? this.#state.enabled : patch.enabled === true,
      models:
        patch.models === undefined ? [...this.#state.models] : normalizeModelList(patch.models)
    };
    this.#state = next;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      renameSync(tmp, this.#path);
    } catch {
      // 寫不進去也要讓這次設定在記憶體中生效，至少本次執行期間是對的。
    }
    return this.get();
  }
}

/**
 * 依「使用者選的主模型 + 前三順位」算出實際要嘗試的順序。
 *
 * 規則：
 *   1. 主模型永遠排第一（使用者這次就是要它）。
 *   2. 備援只在使用者開啟且清單非空時才加入。
 *   3. 只考慮 catalog 認為可用的模型；未探測或已判定不可用的都不放進來，
 *      否則備援會把時間浪費在明知不通的模型上。
 *   4. 去重：主模型若也在順位清單裡，不要重複嘗試。
 *   5. 上游若明確指定替代模型（410 的 `metadata.replacement`），把它插在
 *      使用者順位之前——那是 OpenCode 自己的建議，比我們的猜測可靠。
 *
 * @param {object} params
 * @param {string} params.primary 這次請求指定的模型
 * @param {{enabled: boolean, models: string[]}} params.settings 使用者設定
 * @param {(id: string) => boolean|null} params.isAvailable 查詢可用性；null 代表未知
 * @param {string|null} [params.replacement] 上游建議的替代模型
 * @returns {string[]} 至少含 primary
 */
export function buildAttemptChain({ primary, settings, isAvailable, replacement = null }) {
  const chain = [];
  const seen = new Set();

  const push = (id) => {
    if (typeof id !== 'string' || id === '' || seen.has(id)) return;
    seen.add(id);
    chain.push(id);
  };

  push(primary);

  if (!settings?.enabled) return chain;

  for (const id of settings.models || []) {
    // 可用性未知（null）時仍然嘗試：catalog 還沒探測完就開著備援，
    // 直接把它全部濾掉會讓「剛裝好就勾選備援」看起來完全沒作用。
    const available = isAvailable(id);
    if (available === false) continue;
    push(id);
  }

  // 上游的建議排在最後才加，但它其實比使用者順位更該先試。
  // 這裡刻意不把它插到最前面：使用者排的順位是他明確表達的偏好，
  // 靜默把它擠掉會讓人覺得設定沒生效。放在隊尾是最小驚訝的折衷——
  // 使用者順位都失敗時，至少還有 OpenCode 自己指名的那一個。
  if (typeof replacement === 'string') {
    const available = isAvailable(replacement);
    if (available !== false) push(replacement);
  }

  return chain;
}
