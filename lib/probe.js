/**
 * Live availability probing for OpenCode's free-lane models.
 *
 * The public catalog advertises far more free models than the free lane
 * actually serves: entries linger with `status: "deprecated"` while still
 * answering 200 (e.g. cat-jam-free), and others look active yet return
 * `Model is unavailable`. Availability therefore cannot be derived from
 * metadata alone — it has to be observed.
 *
 * Each probe opens a real streaming request and cancels it as soon as the
 * status line arrives, so a healthy model costs ~1-2s and a dead one
 * ~0.3-1s. Probing is opt-in, concurrency-limited, and aborts early when the
 * lane itself is unreachable from this network.
 */

import {
  OPENCODE_INFERENCE_URL,
  PROBE_CONCURRENCY,
  PROBE_MAX_TOKENS,
  PROBE_TIMEOUT_MS
} from './constants.js';
import { buildHeaders, ensureFreeLaneTools, canonicalSessionId, randomId } from './client.js';
import {
  classifyHttpFailure,
  detectErrorType,
  parseErrorType as parseErrorTypeShared
} from './failures.js';
import { executeBunFetch, resolveBunPath } from './bun-transport.js';

/**
 * A 403 means one of two very different things, so the body decides:
 *
 *  - `FreeTierError` — the lane refused the request outright (wrong client,
 *    non-streaming, blocked egress IP). Every remaining probe would fail the
 *    same way, so the run must stop.
 *  - `RegionError` — this one model is geo-restricted. The lane itself is
 *    healthy and other models must still be probed.
 *
 * 這份判斷現在與推論路徑共用 `failures.js`，避免探測說「可用」而實際推論
 * 失敗的落差：兩邊只要有任一邊漏了 `errorType`，就會對同一個回應給出不同結論。
 */
function classifyFailure(status, errorType, rawText = '') {
  if (status === 'ERR') return { reachable: false, reason: 'transport' };
  // 其餘交給共用的分類器，reason 直接沿用，確保兩條路徑的用詞一致。
  //
  // 這裡刻意不再自己攔 403：實測 `FreeTierError` 的 body 裡夾帶的正是
  // 「你的網路出口有濫用流量」那段話，若在這層先用 `errorType` 判斷，就會
  // 蓋掉共用分類器已經做好的「網路風控 vs 免費通道」區分，於是整輪探測
  // 不會因為 IP 被擋而停手，白白多送 30 幾個注定失敗的請求出去。
  //
  // `rawText` 同理要往下傳：400 光看狀態碼分不出「上下文超限」、「模型不可用」
  // 與「上游沒說原因」，三者在狀態頁上應該是三種不同的標籤。
  const { reason, code } = classifyHttpFailure(status, errorType, { rawText });
  return { reachable: isReachableReason(reason), reason, code };
}

/**
 * 「這個失敗是否代表通道本身出了問題」。
 *
 * 判準刻意寫成「只有這幾種才算不可達」，其餘一律視為仍可達——這與重構前的
 * 行為逐條相符（含未知狀態碼的 `http-<n>` 一律算可達），避免這次共用化
 * 意外改變探測結果。
 *
 * 直覺是：探測失敗 ≠ 通道壞掉。429 或 400 只說明「這次沒問到」，模型與通道
 * 都還在，繼續探測其餘模型才是對的；401/403/5xx 與帳號額度耗盡則代表通道或
 * 授權本身有問題，再探下去只是白費請求。
 */
const UNREACHABLE_REASONS = new Set([
  'transport',
  'unauthorized',
  'upstream-error',
  'free-lane-blocked',
  'forbidden',
  // Exhausted account quota affects the lane/account, not an individual model;
  // treat it as inconclusive so one 402 cannot retire the whole picker.
  'quota-exceeded',
  // IP／網路出口被風控。這比 `free-lane-blocked` 更絕對：擋的是整條出口，
  // 剩下 30 幾個模型再探也只會拿到同一段「abusive traffic」，白白多送請求
  // 出去（還可能讓這個 IP 的評分更差），所以必須立刻停止整輪探測。
  'network-blocked'
]);

function isReachableReason(reason) {
  return !UNREACHABLE_REASONS.has(reason);
}

/** Extracts the upstream error type from a JSON error body. */
function parseErrorType(text) {
  return parseErrorTypeShared(text);
}

/**
 * 從回應標頭讀出「還要等多久」。
 *
 * 上游在 429 會送 `retry-after: 5397`（秒）。RFC 9110 也允許 HTTP-date 格式，
 * 兩種都要吃。Bun transport 與 Node fetch 都是標準 `Headers`，所以同一份
 * 邏輯兩邊通用。
 *
 * 讀不到就回 null——不要猜。猜錯會讓使用者以為「再等 5 分鐘就好」，然後
 * 每五分鐘撞一次同樣的牆。
 */
export function readRetryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const raw = headers.get('retry-after');
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim();
  // 純數字 = 秒數。
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }
  // HTTP-date。
  const when = Date.parse(text);
  if (Number.isFinite(when)) {
    const delta = when - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

/**
 * Probes a single model. Resolves to a verdict describing whether the model
 * served the request, and whether the lane stayed reachable.
 */
export async function probeModel(token, modelId, options = {}) {
  const endpoint = options.inferenceUrl || OPENCODE_INFERENCE_URL;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const started = Date.now();

  // 原始錯誤 body 要留到分類之後才用得到（400 得靠它分辨三種情況），
  // 所以宣告在 try 外面，兩個分支都能填。
  let bodyText = '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const useBun = options.bunTransport?.enabled === true || options.useBun === true;
    const fetchFn = (typeof options.fetch === 'function')
      ? options.fetch
      : (useBun
        ? (u, init) => executeBunFetch(u, init, options.bunTransport)
        : fetch);

    const res = await fetchFn(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(
        token,
        canonicalSessionId('probe-' + modelId),
        randomId('req', 16),
        'prj_probe'
      ),
      body: JSON.stringify({
        model: modelId,
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: options.maxTokens ?? PROBE_MAX_TOKENS,
        tools: ensureFreeLaneTools([]),
        tool_choice: 'none'
      }),
      signal: controller.signal
    });

    const status = res.status;
    let errorType = null;
    // 上游在 429 會帶 `retry-after`（實測值例如 5397 秒 ≈ 90 分鐘）。
    // 這是「還要等多久」唯一的權威來源，比任何猜測都準。
    let retryAfterMs = null;

    if (status === 200) {
      // Only the status line matters; release the socket immediately.
      await res.body?.cancel?.().catch(() => {});
    } else {
      retryAfterMs = readRetryAfterMs(res.headers);
      // Error bodies are small and carry the discriminator we need.
      //
      // 這一步必須是「文字優先、結構化 type 其次」：實測上游在 403 裡用的
      // `type` 是 `FreeTierError`，但 `message` 講的是「這個 IP 有濫用流量」。
      // 只看 type 會把「換網路才能解」誤判成「客戶端不合規」，而兩者接下來
      // 該做的事完全不同。
      const bodyText2 = await res.text().catch(() => '');
      bodyText = bodyText2;
      errorType = detectErrorType(bodyText2) || parseErrorType(bodyText2);
    }

    const { reachable, reason } = classifyFailure(status, errorType, bodyText);

    return {
      id: modelId,
      ok: status === 200,
      status,
      errorType,
      reachable,
      ms: Date.now() - started,
      reason,
      // 額度解除的絕對時間（毫秒）。null 代表上游沒說或不是限流。
      retryAfterMs,
      retryAt: retryAfterMs === null ? null : Date.now() + retryAfterMs,
      // 留一份原始回應給狀態頁顯示。
      //
      // 中文說明是我們的解讀，解讀可能錯（今天就錯過一次）；原始文字不會，
      // 而且可以直接拿去搜尋。使用者想自己查的時候，需要的是這個。
      // 截斷是為了不讓某個模型回了整頁 HTML 就把狀態頁撐爆。
      detail: bodyText ? bodyText.trim().slice(0, 300) : ''
    };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || controller.signal.aborted;
    return {
      id: modelId,
      ok: false,
      status: 'ERR',
      errorType: null,
      reachable: false,
      ms: Date.now() - started,
      reason: aborted ? 'timeout' : 'transport'
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes many models with bounded concurrency, preserving input order.
 * `onProgress` receives (done, total, verdict) after each verdict.
 *
 * 熔斷（bail-out）是刻意的額度保護，但**必須說清楚它停在哪裡**。
 *
 * 原本 429 會讓整輪直接停止，且回傳的 `tested` 只算已跑完的筆數——呼叫端
 * 因此無法分辨「46 個都驗過了」與「第 4 個撞到限流就收手」。使用者看到的
 * 症狀是「可用 13，但只有 4 筆探測紀錄」，看起來像探測壞掉。
 *
 * 現在回傳 `stopped`（`rate-limited`／`unreachable`／`null`）與 `untested`
 * （沒送出去的 model id）。呼叫端可以據此保留舊判定，而不是把沒驗過的
 * 模型當成失敗。
 */
export async function probeModels(token, modelIds, options = {}) {
  const concurrency = Math.max(1, options.concurrency ?? PROBE_CONCURRENCY);
  const results = new Array(modelIds.length);
  let cursor = 0;
  let done = 0;
  let stop = false;
  /** 為什麼停手：`rate-limited`（額度）或 `unreachable`（通道／網路）。 */
  let stopped = null;
  let stoppedBy = null;

  const worker = async () => {
    while (!stop) {
      const index = cursor++;
      if (index >= modelIds.length) return;

      const verdict = await probeModel(token, modelIds[index], options);
      results[index] = verdict;
      done++;

      // A blocked lane invalidates every remaining verdict, so bail out early.
      if (!verdict.reachable) {
        stop = true;
        stopped = 'unreachable';
        stoppedBy = verdict;
        options.onProgress?.(done, modelIds.length, verdict);
        return;
      }

      // 遇到 429 限流／額度已滿時立即熔斷停手，不再向剩下的模型發送請求，
      // 避免在幾秒鐘內將帳號當天的剩餘額度完全耗盡。
      //
      // 注意：429 的 verdict 是 `reachable: true`（模型本身有效），所以這段
      // 必須排在 reachable 判斷之後，否則會被上面攔走而記成「通道不可達」。
      if (verdict.status === 429) {
        stop = true;
        stopped = 'rate-limited';
        stoppedBy = verdict;
        options.onProgress?.(done, modelIds.length, verdict);
        return;
      }

      options.onProgress?.(done, modelIds.length, verdict);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, modelIds.length) }, () => worker())
  );

  const settled = results.filter(Boolean);
  const blocked = settled.some((r) => !r.reachable);
  // 沒送出去的模型：呼叫端要保留它們的舊判定，不能當成失敗。
  const testedIds = new Set(settled.map((r) => r.id));
  const untested = modelIds.filter((id) => !testedIds.has(id));
  // 上游在 429 上給的解除時間，取最遠的那一個（同一輪通常都一樣）。
  const retryAt = settled.reduce(
    (latest, r) => (Number.isFinite(r?.retryAt) && (latest === null || r.retryAt > latest) ? r.retryAt : latest),
    null
  );

  return {
    results: settled,
    blocked,
    blockedReason: blocked ? settled.find((r) => !r.reachable)?.reason : null,
    tested: settled.length,
    total: modelIds.length,
    // 整輪是否被熔斷，以及是額度還是通道。null 代表跑完了。
    stopped,
    stoppedBy: stoppedBy ? { id: stoppedBy.id, status: stoppedBy.status, reason: stoppedBy.reason } : null,
    // 額度解除的絕對時間（毫秒）。null 代表上游沒給。
    retryAt,
    untested
  };
}
