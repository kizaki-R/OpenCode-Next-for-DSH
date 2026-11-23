import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

/** 避免無效或極端值破壞宿主的 token 預算計算。 */
export const MIN_CONTEXT_WINDOW = 1024;
export const MAX_CONTEXT_WINDOW = 100_000_000;

export function defaultContextWindowPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'opencode-next.context.json');
}

function isValidContextWindow(value) {
  return Number.isSafeInteger(value)
    && value >= MIN_CONTEXT_WINDOW
    && value <= MAX_CONTEXT_WINDOW;
}

function normalizeOverrides(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result = Object.create(null);
  for (const [modelId, value] of Object.entries(input)) {
    const id = modelId.trim();
    if (id && id.length <= 200 && isValidContextWindow(value)) result[id] = value;
  }
  return result;
}

/**
 * 每個模型的手動上下文覆寫。
 * 只儲存 model id 與整數容量，不碰憑證或對話內容。
 */
export class ContextWindowStore {
  #path;
  #overrides = Object.create(null);
  #loaded = false;

  constructor({ path } = {}) {
    this.#path = path || defaultContextWindowPath();
  }

  #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      if (!existsSync(this.#path)) return;
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8').replace(/^\uFEFF/, ''));
      if (parsed?.version !== 1) return;
      this.#overrides = normalizeOverrides(parsed.overrides);
    } catch {
      // 設定檔損毀時退回跟隨目錄值；不覆寫原檔，保留供使用者檢查。
      this.#overrides = Object.create(null);
    }
  }

  #persist(next) {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, overrides: next }, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      });
      renameSync(temporary, this.#path);
    } finally {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {}
    }
  }

  /** 取得單一模型的覆寫值；沒有覆寫時回傳 null。 */
  getOverride(modelId) {
    this.#load();
    return Object.hasOwn(this.#overrides, modelId) ? this.#overrides[modelId] : null;
  }

  /** 取得副本，避免呼叫端修改內部設定。 */
  get() {
    this.#load();
    return { ...this.#overrides };
  }

  /** 設定手動值；成功寫入後才更新記憶體狀態。 */
  set(modelId, contextWindow) {
    this.#load();
    const id = typeof modelId === 'string' ? modelId.trim() : '';
    if (!id || id.length > 200) throw new TypeError('modelId must be a non-empty string of at most 200 characters.');
    if (!isValidContextWindow(contextWindow)) {
      throw new RangeError(`contextWindow must be an integer from ${MIN_CONTEXT_WINDOW} to ${MAX_CONTEXT_WINDOW}.`);
    }
    const next = { ...this.#overrides, [id]: contextWindow };
    this.#persist(next);
    this.#overrides = next;
    return contextWindow;
  }

  /** 清除單一模型覆寫，讓它回到目錄／外掛備援值。 */
  reset(modelId) {
    this.#load();
    const id = typeof modelId === 'string' ? modelId.trim() : '';
    if (!id || !Object.hasOwn(this.#overrides, id)) return false;
    const next = { ...this.#overrides };
    delete next[id];
    this.#persist(next);
    this.#overrides = next;
    return true;
  }
}
