import {
  DEFAULT_FIRST_EVENT_MS,
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_PIXEL_BUDGET,
  DEFAULT_STREAM_IDLE_MS,
  OPENCODE_INFERENCE_URL,
  PROVIDER,
  PROVIDER_NAME
} from './constants.js';
import {
  buildHeaders,
  collectImageRefs,
  convertMessages,
  convertTools,
  ensureFreeLaneTools,
  prepareToolsWithAliases,
  canonicalSessionId,
  randomId,
  stableProjectId
} from './client.js';
import { requestImageTarget, resolveImageDataUrls } from './images.js';
import { classifyHttpFailure, detectErrorType, toFailure } from './failures.js';
import { buildAttemptChain, canFallback } from './fallback.js';
import { parseOpenAiSseStream } from './stream.js';
import { executeBunFetch, lastInferenceReport, noteInference } from './bun-transport.js';

const HOST_RETRY_DELAYS_MS = Object.freeze([3000, 5000, 7000, 10000, 12000]);

export const SAFE_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  // 交給 DSH host retry，讓 UI 顯示「已重試 n/5」並在重試耗盡後才顯示失敗。
  // providerRetryAfterMs 提供精確的 3/5/7/10/12 秒；以下是 host 的安全上限／退路。
  maxRetries: HOST_RETRY_DELAYS_MS.length,
  retryableCodes: Object.freeze([
    'EMPTY_RESPONSE',
    'RATE_LIMIT',
    'SERVER',
    'TIMEOUT',
    'TRANSPORT'
  ]),
  initialDelayMs: HOST_RETRY_DELAYS_MS[0],
  maxDelayMs: HOST_RETRY_DELAYS_MS.at(-1),
  jitterRatio: 0
});

export class OpenCodeOAuthAdapter {
  #catalog;
  #tokenManager;
  #config;
  #hostRetryAttempts = new Map();

  constructor(catalog, tokenManager, config = {}) {
    this.#catalog = catalog;
    this.#tokenManager = tokenManager;
    this.#config = config;
  }

  /** Reap outstanding Bun relay children when DSH disposes this adapter. */
  dispose() {
    this.#config.bunTransport?.dispose?.();
  }

  /**
   * 使用者設定的備援前三順位。
   *
   * 讀取失敗一律退回「關閉」：設定檔壞掉不該讓推論路徑跟著掛掉。
   */
  #fallbackSettings() {
    try {
      return this.#config.fallback?.get?.() ?? { enabled: false, models: [] };
    } catch {
      return { enabled: false, models: [] };
    }
  }

  /**
   * 自動切換是否開啟（預設關閉）。
   *
   * 讀取失敗一律視為關閉：自動切換是「憑證已確定失效」才啟動的補救，
   * 不能因為設定檔壞掉就自己打開。
   */
  #autoSwitchSettings() {
    try {
      return this.#config.autoSwitch?.get?.() ?? { enabled: false };
    } catch {
      return { enabled: false };
    }
  }

  /** 這次請求要依序嘗試的模型：主模型，加上（若開啟）可用的備援順位。 */
  #attemptChain(primary, replacement = null) {
    return buildAttemptChain({
      primary,
      settings: this.#fallbackSettings(),
      isAvailable: (id) => this.#catalog.isAvailable(id),
      replacement
    });
  }

  providerInfo(provider) {
    return {
      id: provider || PROVIDER,
      name: this.#config.providerName || PROVIDER_NAME
    };
  }

  /**
   * Provider-owned retry policy. Conservative policy to protect IP reputation.
   */
  providerRetryPolicy(_provider) {
    return SAFE_RETRY_POLICY;
  }

  /**
   * Provider-side image request pricing. 回傳 undefined 代表沿用 DSH 的中性估算。
   *
   * OpenCode 的免費通道是同一個閘道代理多個上游模型，各家視覺計費規則不同，我們
   * 沒有可信的數字。與其編一個看起來精確、實際會誤導 token 計量的公式，不如明確
   * 宣告「本路由不自訂圖片計價」，讓 DSH 用它自己的中性估算。
   */
  imageRequestPricing(_provider, _model) {
    return undefined;
  }

  /**
   * 本轉接器送出請求時實際使用的圖片尺寸與位元組目標。
   *
   * 必須與 `stream()` 內 `resolveImageDataUrls()` 用的預算一致，否則截圖呼叫端
   * 依這裡的尺寸算出的 handle 文字會跟真正送出的位元組對不上。
   */
  imageRequestTarget(_provider, _model, image) {
    return (
      requestImageTarget(image, this.#pixelBudget(), this.#maxImageBytes()) ?? {
        width: image?.width ?? 1,
        height: image?.height ?? 1,
        maxBytes: image?.bytes ?? 1
      }
    );
  }

  #pixelBudget() {
    const configured = Number(this.#config.imagePixelBudget);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_IMAGE_PIXEL_BUDGET;
  }

  #maxImageBytes() {
    const configured = Number(this.#config.imageMaxBytes);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_IMAGE_MAX_BYTES;
  }

  /**
   * Bind one generation to a concrete dispatch. DSH expects { model, stream }.
   * `signal` is optional cancellation for the adapter-owned model lookup.
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options)
    };
  }

  async listModels(provider) {
    await this.#catalog.init();
    return this.#catalog.describeAll(provider || PROVIDER);
  }

  async resolveModel(provider, modelId) {
    await this.#catalog.init();
    return this.#catalog.describe(provider || PROVIDER, modelId);
  }

  /**
   * Main LlmAdapter stream generation method.
   *
   * 這裡只負責「依序試哪幾個模型」，真正的請求在 `#streamOnce()`。
   *
   * 備援的三條規則是刻意的：
   *
   *  1. **吐過內容就不再換。** 一旦已經 yield 給呼叫端，改用另一個模型重跑
   *     會讓使用者看到兩段拼接的答案（前一個模型的前言 + 後一個模型的正文）。
   *     寧可把原本的錯誤丟出去。
   *
   *  2. **只換「模型自己壞掉」的情況。** 判斷交給 `canFallback(reason)`：
   *     400 模型下線、410 下架、404、地區封鎖、超時可以換；IP 被風控、
   *     免費通道擋客戶端、授權失效則不換——那些換 30 個模型也不會好，
   *     只會多送 30 次注定失敗的請求出去，讓這個 IP 更難看。
   *
   *  3. **使用者取消不算失敗。** 取消時直接往外丟，不消耗備援順位。
   */
  async *stream(options) {
    let chain = this.#attemptChain(options.model);
    let emitted = false;
    const sessionId = options.sessionId || canonicalSessionId(options.messages?.[0]?.content);
    const retryKey = `${sessionId}:${options.model}`;
    const now = Date.now();
    for (const [key, state] of this.#hostRetryAttempts) {
      if (now - state.updatedAt > 30 * 60 * 1000) this.#hostRetryAttempts.delete(key);
    }
    // 已試過的模型。上游中途建議替代模型時會改動 chain，這裡記著才不會重複。
    const tried = new Set();
    // 自動切換的回合狀態：每回合最多一次，且只有在還沒吐出任何 chunk 前才允許。
    // 用共享物件往下傳，`#streamOnce` 才看得到「這個回合已經換過／已經有輸出」。
    const turn = { emitted: false, switched: false };
    for (let index = 0; index < chain.length; index++) {
      const modelId = chain[index];
      tried.add(modelId);

      try {
        for await (const chunk of this.#streamOnce(options, modelId, turn)) {
          emitted = true;
          turn.emitted = true;
          yield chunk;
        }
        this.#hostRetryAttempts.delete(retryKey);
        return;
      } catch (error) {
        if (emitted) {
          this.#hostRetryAttempts.delete(retryKey);
          // 已交付回答內容的串流不可重播，否則 host retry 會把答案接成兩份。
          // 移除 retry marker，確保 DSH 不會在部分內容後重跑整個 turn。
          if (error?.failure?.code && SAFE_RETRY_POLICY.retryableCodes.includes(error.failure.code)) {
            delete error.failure;
            delete error.code;
            delete error.reason;
          }
          throw error;
        }
        if (options.signal?.aborted) {
          this.#hostRetryAttempts.delete(retryKey);
          throw error;
        }

        // 所有 transient errors 交給 DSH host retry policy，讓 UI 顯示「已重試 n/5」。
        // providerRetryAfterMs 是 DSH LlmFailure 官方欄位，可指定每一輪的精確等待時間。
        // 注意：遇到 rate-limited (429) 時不要連發 5 次重試，避免短時間內打爆額度！
        if (SAFE_RETRY_POLICY.retryableCodes.includes(error?.failure?.code) && error?.reason !== 'rate-limited') {
          const state = this.#hostRetryAttempts.get(retryKey) ?? { count: 0, updatedAt: Date.now() };
          if (state.count < HOST_RETRY_DELAYS_MS.length) {
            error.failure.providerRetryAfterMs = HOST_RETRY_DELAYS_MS[state.count];
            this.#hostRetryAttempts.set(retryKey, { count: state.count + 1, updatedAt: Date.now() });
          } else {
            // DSH 已用完五次 host retry；清掉狀態，讓使用者手動再送時重新從 3 秒開始。
            this.#hostRetryAttempts.delete(retryKey);
          }
          throw error;
        }

        this.#hostRetryAttempts.delete(retryKey);
        if (!canFallback(error?.reason)) throw error;

        // 410 會帶上游自己指名的替代模型。若使用者沒排到它、也還沒試過，
        // 就把它接到隊尾——這是上游的建議，值得一試。
        if (typeof error?.replacement === 'string' && !tried.has(error.replacement)) {
          const settings = this.#fallbackSettings();
          if (settings.enabled) chain = [...chain, error.replacement];
        }

        // chain 可能剛被延長，所以 `isLast` 要以延長後的長度重算。
        if (index === chain.length - 1) throw error;
        console.warn(
          `[opencode-next] model "${modelId}" failed (${error?.reason ?? 'unknown'}); `
          + `falling back to "${chain[index + 1]}"`
        );
      }
    }
  }

  /** 對單一模型送一次請求並把 SSE 串出去。 */
  async *#streamOnce(options, modelId, turn) {
    const model = this.#catalog.getModel(modelId) || {
      id: modelId,
      name: modelId,
      defaultMaxTokens: 8192
    };

    // Session and request IDs
    const sessionId = options.sessionId || canonicalSessionId(options.messages?.[0]?.content);
    const requestId = randomId('req', 16);
    // 專案 id 必須是穩定的 `prj_xxx` 形式；舊版直接送字面值 'opencode'，
    // 白白丟掉 buildHeaders 的雜湊預設。
    const projectId = options.projectId || stableProjectId('opencode');

    let credential = this.#tokenManager.acquireCredential
      ? await this.#tokenManager.acquireCredential()
      : { token: await this.#tokenManager.getValidToken(), ...this.#tokenManager.credentialSnapshot?.() };
    let token = credential.token;

    // Map reasoning effort
    let reasoningEffort;
    if (options.reasoningEffort) {
      reasoningEffort = options.reasoningEffort === 'off' ? 'none' : options.reasoningEffort;
    }

    const maxTokens = options.maxTokens || model.defaultMaxTokens || 8192;

    // 圖片：先用 attachment service 讀成 data URI，再交給 convertMessages 內嵌。
    // 路由不支援圖片時（catalog 的 inputModalities 沒有 'image'）直接跳過讀取。
    const imageSupported = model.inputModalities === undefined
      || model.inputModalities.includes('image');
    let imageUrls = new Map();
    if (imageSupported) {
      const refs = collectImageRefs(options.messages || []);
      if (refs.size > 0) {
        imageUrls = await resolveImageDataUrls(refs, {
          attachments: this.#config.resolveAttachments?.(),
          pixelBudget: this.#pixelBudget(),
          maxBytes: this.#maxImageBytes(),
          signal: options.signal
        });
      }
    }

    // Convert caller tools and map to upstream names via safe aliases
    const userTools = convertTools(options.tools);
    const hasUserTools = Array.isArray(userTools) && userTools.length > 0;
    const { tools, toUpstreamName, toDshName } = prepareToolsWithAliases(userTools);

    const messages = convertMessages(options.messages || [], {
      system: options.system,
      imageUrls,
      imageSupported,
      toUpstreamName
    });

    const bodyPayload = {
      model: model.id,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: maxTokens,
      tools,
      ...(hasUserTools ? {} : { tool_choice: 'none' }),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(Array.isArray(options.stop) && options.stop.length > 0 ? { stop: options.stop } : {})
    };

    const endpoint = this.#config.inferenceUrl || OPENCODE_INFERENCE_URL;

    // 看門狗自己也要能切斷連線。
    //
    // 光是在本機放棄等待沒用：body 的 reader 還掛在那條連線上，上游 socket 不會
    // 關，被放棄的請求會一路留到 TCP 超時。所以這裡把呼叫端的 signal 與看門狗的
    // signal 併成一個，超時時直接 abort 掉 fetch。
    const watchdog = createWatchdog(this.#firstEventMs(), this.#idleMs(), options.signal);

    // 401 handling is deliberately narrow: refresh the exact dispatched account
    // once; only a second 401 on that refreshed credential can rotate accounts.
    // Every retry here is before yielding any content (the outer turn guard also
    // prevents replay after partial output).
    let res = null;
    let attempts = 0;

    try {
      while (attempts < 3) {
        attempts++;
        const headers = buildHeaders(token, sessionId, requestId, projectId, credential.orgId);

        try {
          const useBun = this.#config.bunTransport?.enabled === true || this.#config.useBun === true;
          const toolNames = Array.isArray(tools)
            ? tools.map((tool) => tool?.function?.name || tool?.name).filter(Boolean)
            : [];
          noteInference({
            transport: useBun ? 'bun' : 'node',
            model: model.id,
            toolCount: toolNames.length,
            tools: toolNames.slice(0, 16),
            hasBash: toolNames.includes('bash'),
            hasRead: toolNames.includes('read')
          });
          // BunTransport 啟用後若 Bun 啟動／協定失敗，應如實回報 transport error，
          // 不能靜默退回 Node fetch 再製造相同的 429。
          const fetchFn = useBun
            ? (u, init) => executeBunFetch(u, init, {
                ...this.#config.bunTransport,
                anonymous: this.#config.anonymousChannel?.enabled === true
              })
            : fetch;

          res = await fetchFn(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(bodyPayload),
            signal: watchdog.signal
          });

          if (res.status === 401 && attempts === 1) {
            if (this.#tokenManager.refreshCredential) {
              const refreshed = await this.#tokenManager.refreshCredential(credential);
              if (refreshed?.stale || !refreshed?.token) break;
              credential = refreshed;
              token = refreshed.token;
            } else {
              token = await this.#tokenManager.refresh();
              credential = { token, ...this.#tokenManager.credentialSnapshot?.() };
            }
            continue;
          }

          if (res.status === 401 && attempts === 2 && !turn.emitted && !turn.switched
              && credential.accountId && this.#autoSwitchSettings().enabled === true
              && this.#tokenManager.switchToNextAccount) {
            const next = await this.#tokenManager.switchToNextAccount(credential.accountId, { version: credential.version });
            if (next) {
              turn.switched = true;
              credential = await this.#tokenManager.acquireCredential();
              token = credential.token;
              continue;
            }
          }

          break;
        } catch (err) {
          if (options.signal?.aborted) throw err;
          if (watchdog.timedOut()) throw watchdog.error();
          throw toFailure(err, { code: 'TRANSPORT', reason: 'transport' });
        }
      }

      if (!res || !res.ok) {
        const errText = res ? await res.text() : 'No response from OpenCode server';
        const errJson = (() => {
          try {
            return JSON.parse(errText);
          } catch {
            return null;
          }
        })();

        let msg = errJson?.error?.message || errJson?.message || errText;
        if (typeof msg === 'string' && msg.includes('Endpoint is unavailable')) {
          msg = `${msg}（該模型上游端點目前維護/不可用，請切換其他在線模型）`;
        }
        const status = res ? res.status : 500;

        // 403 有幾種完全不同的意思，靠 body 分辨（與 probe.js 共用同一份判斷）。
        // 沒有這一步，使用者只看到一句 403，分不出「換模型就好」和「整個通道被擋」。
        //
        // 順序很重要：先看原始 body 的文字特徵，再看結構化的 `type`。
        // 上游有時會把「IP 風控」那段說明包在 `FreeTierError` 的 body 裡，
        // 若先採用 `type: "FreeTierError"`，就會把「你的網路出口被擋、請關 VPN」
        // 誤導成「請求缺少必要欄位」——而那正是使用者最需要正確答案的時刻。
        const structuredType = errJson?.error?.type || errJson?.type || null;
        const errorType = detectErrorType(errText) || structuredType;

        const classified = {
          ...classifyHttpFailure(status, errorType, {
            // 410 會附上 `metadata.replacement`（實測 space-bunny-free →
            // minimax-m3.1-flash-free）。把它帶進分類，提示就能直接說該換哪一個，
            // 而不是只說「這個模型已下架」讓使用者自己找。
            replacement: errJson?.metadata?.replacement ?? null,
            // 400／429 都要靠原始 body 分辨錯誤類型。
            rawText: errText
          }),
          status
        };
        const shape = lastInferenceReport() ?? {};
        const toolList = Array.isArray(shape.tools) && shape.tools.length ? shape.tools.join(',') : 'none';
        const error = new Error(`OpenCode OAuth inference failed (${status}): ${msg} [transport=${shape.transport || 'unknown'}; tools=${toolList}]`);
        error.status = status;
        // 備援迴圈靠它把上游指名的替代模型接到隊尾。
        if (classified.replacement) error.replacement = classified.replacement;

        // 一定要經由 toFailure 掛上 `.failure`：DSH 的 normalizeLlmFailure
        // 只信任 `.failure`，單獨寫 `.code` 會被核銷成 `UNKNOWN`，
        // 讓重試政策與錯誤提示同時失效。
        throw toFailure(error, classified);
      }

      // 解析 SSE 時套上看門狗。
      //
      // 免費通道偶爾會在送出 200 之後完全沉默：連線還在、但一個 frame 都不來。
      // 沒有超時的話整個回合就卡在那裡，使用者只看到轉圈圈，而 DSH 這端也拿不到
      // 任何可以重試的錯誤。這裡把「等第一個事件」與「事件之間的閒置」分開計時：
      // 前者用較短的 FIRST_EVENT，後者用 streamIdleTimeoutMs。
      yield* withStreamWatchdog(parseOpenAiSseStream(res.body, { ...options, resolveToolName: toDshName }), watchdog);
    } finally {
      watchdog.dispose();
    }
  }

  #idleMs() {
    const configured = Number(this.#config.streamIdleTimeoutMs);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STREAM_IDLE_MS;
  }

  #firstEventMs() {
    const idle = this.#idleMs();
    return Math.min(DEFAULT_FIRST_EVENT_MS, idle);
  }
}

/**
 * 建立一個「太久沒動靜就 abort」的控制器，並把呼叫端的 signal 串進來。
 *
 * 失敗會產生 `code = 'TIMEOUT'` 的錯誤，正好落在 `SAFE_RETRY_POLICY` 的
 * retryableCodes 裡，所以上層會依政策重試，而不是把整個回合吊死。
 */
function createWatchdog(firstEventMs, idleMs, callerSignal) {
  const controller = new AbortController();
  let timer = null;
  let armed = true;
  let timeoutError = null;

  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const arm = () => {
    if (timer !== null) clearTimeout(timer);
    const limit = armed ? firstEventMs : idleMs;
    timer = setTimeout(() => {
      timeoutError = new Error(
        armed
          ? `OpenCode stream sent no first event within ${limit}ms`
          : `OpenCode stream was idle for ${limit}ms`
      );

      // 這裡必須走 toFailure：只寫 `.code = 'TIMEOUT'` 的話，
      // DSH 的 normalizeLlmFailure 會把它核銷成 `UNKNOWN`，
      // 於是 SAFE_RETRY_POLICY 的 retryableCodes 永遠比對不到 TIMEOUT，
      // 重試政策形同虛設——這正是看門狗原本「有做但沒生效」的原因。
      //
      // `reason` 讓備援迴圈知道「這個模型等到超時」，因而可以換下一個順位：
      // 免費通道裡遲遲不送第一個事件的模型通常是該上游端點掛住，換一個就好。
      toFailure(timeoutError, { code: 'TIMEOUT', reason: 'timeout', status: undefined });
      controller.abort(timeoutError);
    }, limit);
  };

  arm();

  return {
    signal: controller.signal,
    /** 收到一個 chunk 後重置閒置計時，並解除「等首個事件」階段。 */
    tick() {
      armed = false;
      arm();
    },
    timedOut: () => timeoutError !== null,
    error: () => timeoutError ?? new Error('OpenCode stream aborted'),
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      callerSignal?.removeEventListener?.('abort', onCallerAbort);
    }
  };
}

/**
 * 把看門狗接到 AsyncIterable 上：每次拿到值就重置計時，超時由 fetch 那端的
 * abort 傳播過來。
 */
async function* withStreamWatchdog(source, watchdog) {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (watchdog.timedOut()) throw watchdog.error();
      const next = await iterator.next();
      if (next.done === true) return;
      watchdog.tick();
      yield next.value;
    }
  } catch (error) {
    if (watchdog.timedOut()) throw watchdog.error();
    if (watchdog.signal.aborted) throw error; // 使用者取消，不把它誤當成斷線重試。
    if (error?.failure?.code) throw error;
    // SSE body 在讀取途中 reset/terminated 時，補上 host retry policy 可辨識的碼。
    throw toFailure(error, { code: 'TRANSPORT', reason: 'transport' });
  }
}
