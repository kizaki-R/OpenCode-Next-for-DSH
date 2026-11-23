/**
 * 模型勾選（選擇器顯示名單）。
 *
 * 使用者的需求：「不要把所有模型永遠全部塞進選擇器」。做法是讓設定頁的
 * 模型表格每一列都有勾選框，勾了的才會出現在宿主的模型選擇器。
 *
 * 兩種模式：
 *
 *   - `auto`（初始狀態）：行為跟以前完全一樣——探測判定可用就顯示，
 *     新模型由探測流程自行決定。此時勾選框只是狀態的展示，不參與決策。
 *
 *   - `manual`：使用者動過勾選之後就進入這個模式。此時顯示名單完全由
 *     勾選決定，之後新探測通過的模型不會再自動加入。
 *
 * 手動模式的第一次勾選，要把「當下 auto 模式會顯示的名單」整份快照進
 * shown：這樣使用者看到的勾選狀態不會因為切模式而跳動，只是從今以後新
 * 模型不再自動加入。快照由 catalog 負責（它才知道 auto 名單），儲存本身
 * 不負責。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** 預設存放位置；刻意與探測快取、備援設定分開，語意不同不該混在同一支檔案。 */
export function defaultPickerPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'opencode-oauth.picker.json');
}

/** OpenCode Go 訂閱模型勾選名單存放位置。 */
export function defaultGoPickerPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'opencode-oauth.go-picker.json');
}

/**
 * 把請求帶來的 shown 清單整理成乾淨的陣列。
 *
 * 驗證在伺服器端做，不信任瀏覽器送來的內容：去空白、去重、丟掉非字串。
 * 沒有設上限的上限（500）：目錄裡的免費模型量級是數十個，500 足夠容納
 * 任何合理的勾選，又足以檔掉惡意的巨型清單。
 */
export function normalizeShownList(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 500) break;
  }
  return out;
}

/**
 * 勾選名單的持久化。
 *
 * 為什麼不放進 DSH 的 plugin config：那份設定要在 DSH 的設定檔裡手改，
 * 而使用者要的是一個畫面就能勾選的清單。所以狀態存在外掛自己的檔案，
 * 由 API 寫入，介面只是它的前端。
 *
 * 壞掉的設定檔等同於「沒勾選過」，退回 auto 模式照常運作，不自動覆寫。
 */
export class PickerStore {
  #path;
  #state = { mode: 'auto', shown: [] };
  #loaded = false;

  constructor({ path } = {}) {
    this.#path = path === undefined ? defaultPickerPath() : path;
  }

  #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    if (!this.#path) return;
    try {
      if (!existsSync(this.#path)) return;
      const text = readFileSync(this.#path, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(text);
      this.#state = {
        mode: parsed?.mode === 'manual' ? 'manual' : 'auto',
        shown: normalizeShownList(parsed?.shown)
      };
    } catch {
      this.#state = { mode: 'auto', shown: [] };
    }
  }

  /** 目前設定。回傳副本，呼叫端改不動內部狀態。 */
  get() {
    this.#load();
    return { mode: this.#state.mode, shown: [...this.#state.shown] };
  }

  /**
   * 更新設定。
   *
   * 先寫暫存檔再 rename：直接覆寫時若行程中途結束，會留下一個半截的
   * JSON，下次啟動就整份勾選消失。rename 在同一個磁碟區上是原子操作。
   */
  set({ mode, shown } = {}) {
    this.#load();
    const next = {
      mode: mode === 'manual' ? 'manual' : 'auto',
      shown: shown === undefined
        ? [...this.#state.shown]
        : normalizeShownList(shown)
    };
    this.#state = next;
    if (!this.#path) return this.get();
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, ...next }, null, 2), 'utf8');
      renameSync(temporary, this.#path);
    } catch {
      // 寫不進去也要讓這次設定在記憶體中生效，至少本次執行期間是對的。
    }
    return this.get();
  }
}
