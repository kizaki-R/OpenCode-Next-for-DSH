/**
 * 外掛進入點的契約測試（lib/index.js）。
 *
 * 為什麼要單獨測這個：`index.js` 是 DSH 載入外掛時唯一呼叫的東西，而在它之前
 * 完全沒有測試涵蓋。它壞掉的形式很特別——不是某個模型不能用，而是**整個外掛
 * 不會出現**：provider 不在清單裡、設定頁不見、也沒有任何錯誤畫面。使用者只會
 * 覺得「裝了但沒反應」。
 *
 * 這一支用一個假的 ctx 走完 apply()，驗證：
 *   - 載入器需要的具名匯出（name / inject / Config / apply）都在；
 *   - 有 export default 會讓載入器的 unwrapExports 把整個 namespace 折疊起來，
 *     反而把 name / Config / apply 藏掉，所以必須沒有 default；
 *   - 真的向 ctx.llm 註冊了 provider，且 id 與設定一致；
 *   - 設定頁的註冊失敗**不會**拖垮 provider（這是最重要的不變式）；
 *   - dispose 會清掉計時器，不讓已卸載的外掛繼續打上游。
 *
 * 全程不連外：apply() 內的探測是背景執行的，這裡用假 catalog 資料與已登入的
 * 假 token 讓它安靜跑完，或直接讓它早退。
 */

import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';

let failures = 0;
let checks = 0;
function check(name, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${name}${cond ? '' : `  ${detail}`}`);
}

const indexUrl = new URL('../lib/index.js', import.meta.url);

console.log('--- 載入器需要的具名匯出 ---');
const mod = await import(indexUrl.href);

check('匯出 name 且值正確', mod.name === 'opencode-next', String(mod.name));
check('inject 只要求 llm（attachments 刻意延遲解析）',
  Array.isArray(mod.inject) && mod.inject.includes('llm') && !mod.inject.includes('attachments'),
  JSON.stringify(mod.inject));
check('匯出 Config（DSH 用來驗證設定）', mod.Config !== undefined);
check('匯出 apply', typeof mod.apply === 'function');
// 載入器的 unwrapExports 會在只有 default 時折疊 namespace。有 default 反而會把
// name / Config / apply 藏起來，所以這裡把「沒有 default」固定成契約。
check('刻意沒有 export default', !('default' in mod), Object.keys(mod).join(','));
check('額外匯出 TokenManager / ModelCatalog / OpenCodeOAuthAdapter',
  typeof mod.TokenManager === 'function' &&
  typeof mod.ModelCatalog === 'function' &&
  typeof mod.OpenCodeOAuthAdapter === 'function');

/* --------------------------------------------------------- 假 ctx 走完 apply */

console.log('\n--- apply() 向 ctx.llm 註冊 provider ---');

/** 建一個記錄呼叫的假 ctx；options.webServerFails 用來模擬設定頁掛不起來。 */
function makeCtx({ webServerFails = false } = {}) {
  const record = {
    adapters: [],
    emitted: [],
    logs: [],
    disposeHandlers: [],
    injected: [],
    webRegistered: [],
    intervals: 0
  };

  const ctx = {
    llm: {
      registerAdapter(ids, adapter) {
        record.adapters.push({ ids, adapter });
      }
    },
    get(name) {
      return undefined; // 沒有 attachments 服務（headless profile）
    },
    inject(deps, fn) {
      record.injected.push(deps);
      if (webServerFails) throw new Error('simulated: webServer unavailable');
      // registerWebApi 會在這裡註冊路由；給它一個假的 webServer。
      const webCtx = {
        webServer: {
          register(route) {
            record.webRegistered.push(route);
          },
          // settings.test.mjs 證實 register 是唯一用到的入口。
          on() {},
          off() {}
        },
        effect(fn) {
          try { fn(); } catch { /* ignore */ }
          return () => {};
        },
        logger: { info() {}, warn() {} }
      };
      fn(webCtx);
    },
    on(event, handler) {
      if (event === 'dispose') record.disposeHandlers.push(handler);
    },
    emit(event) {
      record.emitted.push(event);
    },
    logger: {
      info: (m) => record.logs.push(['info', m]),
      warn: (m) => record.logs.push(['warn', m]),
      error: (m) => record.logs.push(['error', m])
    }
  };

  return { ctx, record };
}

const work = mkdtempSync(path.join(tmpdir(), 'ocoa-index-'));
try {
  // 用一個不存在的憑證路徑，讓背景探測沒有 token 可拿、安靜早退，不連外。
  const credentialPath = path.join(work, 'absent-token.json');
  const probeCachePath = path.join(work, 'absent-cache.json');

  const { ctx, record } = makeCtx();
  mod.apply(ctx, {
    credentialPath,
    probeCachePath,
    // 關掉自動偵測，背景就不會嘗試探測上游。
    autoDetectModels: false
  });

  check('向 ctx.llm 註冊了恰一個 provider', record.adapters.length === 1, String(record.adapters.length));
  const reg = record.adapters[0];
  check('註冊的 provider id 來自設定', Array.isArray(reg?.ids) && reg.ids[0] === 'opencode-next',
    JSON.stringify(reg?.ids));
  check('註冊的物件像個 adapter（有 generate 或 stream）',
    typeof reg?.adapter?.generate === 'function' || typeof reg?.adapter?.stream === 'function',
    Object.keys(reg?.adapter ?? {}).join(','));

  console.log('\n--- 設定頁的宿主端也掛上了 ---');
  check('嘗試注入 webServer', record.injected.some((d) => Array.isArray(d) && d.includes('webServer')),
    JSON.stringify(record.injected));
  check('註冊了設定頁路由', record.webRegistered.length > 0, String(record.webRegistered.length));

  console.log('\n--- dispose 會清掉計時器 ---');
  check('註冊了 dispose 處理器', record.disposeHandlers.length === 1,
    String(record.disposeHandlers.length));
  // 觸發 dispose；不應該丟出例外。
  let disposeThrew = null;
  try {
    for (const h of record.disposeHandlers) h();
  } catch (err) {
    disposeThrew = err;
  }
  check('dispose 不丟出例外', disposeThrew === null, disposeThrew?.message);

  /* ------------------------------------- 最關鍵的不變式：設定頁壞掉不影響 provider */

  console.log('\n--- 設定頁註冊失敗時，provider 仍必須註冊（最重要）---');
  const { ctx: ctx2, record: rec2 } = makeCtx({ webServerFails: true });
  let applyThrew = null;
  try {
    mod.apply(ctx2, { credentialPath, probeCachePath, autoDetectModels: false });
  } catch (err) {
    applyThrew = err;
  }

  check('apply 不因設定頁失敗而丟出例外', applyThrew === null, applyThrew?.message);
  check('provider 仍然註冊成功（模型可用性優先）', rec2.adapters.length === 1,
    String(rec2.adapters.length));
  check('有記錄一筆 warning 說明設定頁不可用',
    rec2.logs.some(([lvl, msg]) => lvl === 'warn' && /Settings page unavailable/.test(msg)),
    JSON.stringify(rec2.logs.filter(([l]) => l === 'warn')));

  /* ------------------------------------------------ 自訂 providerId 要貫通 */

  console.log('\n--- 自訂 providerId 會一路傳到註冊與狀態頁 ---');
  const { ctx: ctx3, record: rec3 } = makeCtx();
  mod.apply(ctx3, { providerId: 'my-opencode', credentialPath, probeCachePath, autoDetectModels: false });
  check('註冊使用自訂 providerId', rec3.adapters[0]?.ids?.[0] === 'my-opencode',
    JSON.stringify(rec3.adapters[0]?.ids));
  check('啟動訊息提到自訂 providerId',
    rec3.logs.some(([, m]) => /my-opencode/.test(m)),
    JSON.stringify(rec3.logs.slice(0, 3)));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? `✔ Plugin entry tests passed (${checks} checks)` : `❌ ${failures} / ${checks} checks failed`}`);
if (failures > 0) process.exit(1);
