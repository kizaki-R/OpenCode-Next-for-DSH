/**
 * OpenCode Go DSH LlmAdapter 接點（Stage 2：文字串流與工具呼叫）。
 *
 * 設計界線：
 *   - 固定推論端點：`POST https://opencode.ai/inference/go/openai/v1/chat/completions`。
 *   - 使用 Bearer Personal API Key、外掛自己的 User-Agent、`redirect: 'manual'`。
 *   - `x-opencode-session` 必須來自 DSH 實際會話 ID；缺漏或無效時拒絕請求。
 *   - 僅做 Chat Completions 文字 SSE 與工具呼叫（工具名稱、分段參數、工具結果續輪、
 *     finish reason、取消與逾時），並啟用 `stream_options.include_usage`。
 *   - 不沿用免費通道的 CLI 身分標頭、Bun 請求改寫、工具別名或假工具；
 *     不自動換帳號、不跨 provider 退回、不自動重送計費請求。
 */

import {
  DEFAULT_FIRST_EVENT_MS,
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_PIXEL_BUDGET,
  DEFAULT_STREAM_IDLE_MS,
  GO_PROVIDER,
  GO_PROVIDER_NAME
} from '../constants.js';
import { collectImageRefs, convertMessages, convertTools } from '../client.js';
import { toFailure } from '../failures.js';
import { resolveImageDataUrls } from '../images.js';
import { parseOpenAiSseStream } from '../stream.js';
import { supportsGoImageInput, toGoPickerDescriptor } from './catalog.js';
import { GoClientError, postGoChatCompletions, validateGoSessionId } from './client.js';
import { redactSecret } from './credentials.js';

function analyzeActiveUserImages(dshMessages) {
  const userMessages = [];
  let activeImageBlocks = 0;
  if (Array.isArray(dshMessages)) {
    for (const msg of dshMessages) {
      if (!msg || (msg.role !== 'user' && msg.role !== 'human') || !Array.isArray(msg.content)) continue;
      userMessages.push(msg);
      for (const block of msg.content) {
        if (block && block.type === 'image' && block.offloaded !== true) {
          activeImageBlocks++;
        }
      }
    }
  }
  const refs = activeImageBlocks > 0 ? collectImageRefs(userMessages) : new Map();
  let invalidImageBlocks = 0;
  if (activeImageBlocks > 0) {
    for (const msg of userMessages) {
      for (const block of msg.content) {
        if (!block || block.type !== 'image' || block.offloaded === true) continue;
        const id = block?.attachment?.attachmentId;
        if (typeof id !== 'string' || !id || !refs.has(id)) {
          invalidImageBlocks++;
        }
      }
    }
  }
  return { activeImageBlocks, invalidImageBlocks, refs };
}

export const GO_NO_RETRY_POLICY = Object.freeze({
  mode: 'off',
  maxRetries: 0,
  retryableCodes: Object.freeze([]),
  initialDelayMs: 0,
  maxDelayMs: 0,
  jitterRatio: 0
});

function toDshFailure(err, activeKey = '') {
  const safeMsg = redactSecret(err?.message || 'OpenCode Go request failed.', activeKey);
  const wrapped = new Error(safeMsg);
  if (err?.status !== undefined) wrapped.status = err.status;

  if (err instanceof GoClientError) {
    let code = 'TRANSPORT';
    if (err.category === 'invalid-key' || err.category === 'no-entitlement' || err.category === 'permission-policy') {
      code = 'AUTH';
    } else if (err.category === 'invalid-request') {
      code = err.subCategory === 'model-not-eligible' ? 'MODEL_UNAVAILABLE' : 'INVALID_REQUEST';
    } else if (err.category === 'transient') {
      if (err.subCategory === 'quota-exceeded') code = 'QUOTA';
      else if (err.subCategory === 'rate-limited') code = 'RATE_LIMIT';
      else if (err.subCategory === 'timeout') code = 'TIMEOUT';
      else if (err.subCategory === 'upstream-error') code = 'SERVER';
      else code = 'TRANSPORT';
    } else if (err.category === 'invalid-response' && err.subCategory === 'endpoint-not-found') {
      code = 'SERVER';
    }

    const failure = toFailure(wrapped, {
      code,
      status: err.status ?? undefined,
      reason: err.subCategory || err.category,
      retryable: false
    });
    if (Number.isFinite(err.retryAfterMs)) {
      failure.retryAfterMs = err.retryAfterMs;
    }
    return failure;
  }

  return toFailure(wrapped, {
    code: 'TRANSPORT',
    reason: 'transport',
    retryable: false
  });
}

function createGoWatchdog(firstEventMs, idleMs, callerSignal) {
  const controller = new AbortController();
  let timer = null;
  let waitingFirst = true;
  let timeoutError = null;

  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const arm = () => {
    if (timer !== null) clearTimeout(timer);
    const limit = waitingFirst ? firstEventMs : idleMs;
    timer = setTimeout(() => {
      timeoutError = new Error(
        waitingFirst
          ? `OpenCode Go stream sent no first event within ${limit}ms`
          : `OpenCode Go stream was idle for ${limit}ms`
      );
      toFailure(timeoutError, { code: 'TIMEOUT', reason: 'timeout', status: undefined });
      controller.abort(timeoutError);
    }, limit);
  };

  arm();

  return {
    signal: controller.signal,
    tick() {
      waitingFirst = false;
      arm();
    },
    timedOut: () => timeoutError !== null,
    error: () => timeoutError ?? new Error('OpenCode Go stream aborted'),
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      callerSignal?.removeEventListener?.('abort', onCallerAbort);
    }
  };
}

async function* withGoWatchdog(source, watchdog, activeKey, body = null) {
  const iterator = source[Symbol.asyncIterator]();
  const waitAbort = () => new Promise((_, reject) => {
    if (watchdog.signal.aborted) {
      reject(watchdog.timedOut() ? watchdog.error() : (watchdog.signal.reason || new Error('Aborted')));
      return;
    }
    const onAbort = () => {
      try { body?.cancel?.().catch?.(() => {}); } catch {}
      reject(watchdog.timedOut() ? watchdog.error() : (watchdog.signal.reason || new Error('Aborted')));
    };
    watchdog.signal.addEventListener('abort', onAbort, { once: true });
    waitAbort._cleanup = () => watchdog.signal.removeEventListener('abort', onAbort);
  });

  try {
    for (;;) {
      if (watchdog.timedOut()) throw watchdog.error();
      if (watchdog.signal.aborted) throw watchdog.signal.reason || new Error('Aborted');
      const abortRace = waitAbort();
      let next;
      try {
        next = await Promise.race([iterator.next(), abortRace]);
      } finally {
        waitAbort._cleanup?.();
        waitAbort._cleanup = null;
      }
      if (next.done === true) return;
      watchdog.tick();
      yield next.value;
    }
  } catch (error) {
    if (watchdog.timedOut()) throw watchdog.error();
    if (watchdog.signal.aborted) throw error;
    if (error?.failure?.code) throw error;
    throw toFailure(
      new Error(redactSecret(error?.message || 'OpenCode Go stream interrupted.', activeKey)),
      { code: 'TRANSPORT', reason: 'transport', retryable: false }
    );
  } finally {
    waitAbort._cleanup?.();
  }
}

export class OpenCodeGoAdapter {
  #service;
  #providerId;
  #providerName;
  #config;

  constructor(service, config = {}) {
    this.#service = service;
    this.#config = config || {};
    this.#providerId = (typeof config?.providerId === 'string' && config.providerId.trim())
      || service?.providerId?.()
      || GO_PROVIDER;
    this.#providerName = (typeof config?.providerName === 'string' && config.providerName.trim())
      || service?.providerName?.()
      || GO_PROVIDER_NAME;
  }

  providerInfo(provider) {
    return {
      id: provider || this.#providerId,
      name: this.#providerName
    };
  }

  /**
   * 明確停用自動重試：不自動重送計費請求。
   */
  providerRetryPolicy(_provider) {
    return GO_NO_RETRY_POLICY;
  }

  imageRequestPricing(_provider, _model) {
    return undefined;
  }

  /**
   * 僅列出已驗證資格且可進行文字／工具推論的 Go 模型。
   */
  async listModels(provider) {
    const models = this.#service?.getPickerModels?.() ?? [];
    const targetProvider = provider || this.#providerId;
    return models.map((m) => toGoPickerDescriptor(targetProvider, m));
  }

  async resolveModel(provider, modelId) {
    const status = this.#service?.getStatus?.();
    if (!this.#service?.isEnabled?.()) {
      throw toFailure(new Error('OpenCode Go provider is disabled.'), {
        code: 'MODEL_UNAVAILABLE',
        reason: 'go-disabled',
        retryable: false
      });
    }
    if (status?.connectionState !== 'connected') {
      throw toFailure(new Error('OpenCode Go subscription is not verified/connected.'), {
        code: 'AUTH',
        reason: status?.connectionState || 'unconfigured',
        retryable: false
      });
    }
    const models = this.#service?.getPickerModels?.() ?? [];
    const found = models.find((m) => m.id === modelId);
    if (!found) {
      throw toFailure(new Error(`Model "${modelId}" is not available in OpenCode Go.`), {
        code: 'MODEL_UNAVAILABLE',
        reason: 'model-not-eligible',
        retryable: false
      });
    }
    return toGoPickerDescriptor(provider || this.#providerId, found);
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options)
    };
  }

  async *stream(options = {}) {
    let sessionId;
    try {
      sessionId = validateGoSessionId(options);
    } catch (err) {
      throw toDshFailure(err);
    }

    let ctx;
    try {
      ctx = await this.#service.getInferenceContext(options.model);
    } catch (err) {
      throw toDshFailure(err);
    }

    const { key, model, userAgent, fetchFn } = ctx;
    const imageSupported = supportsGoImageInput(model);
    const { activeImageBlocks, invalidImageBlocks, refs: userImageRefs } = analyzeActiveUserImages(options.messages || []);

    let imageUrls = new Map();
    if (activeImageBlocks > 0) {
      if (!imageSupported) {
        throw toFailure(
          new Error(`Model "${model.id}" on OpenCode Go does not support image input in this plugin; image request was rejected without falling back to text-only.`),
          {
            code: 'INVALID_REQUEST',
            reason: 'image-unsupported',
            retryable: false
          }
        );
      }

      if (invalidImageBlocks > 0 || userImageRefs.size === 0) {
        throw toFailure(
          new Error(`Attached image for OpenCode Go model "${model.id}" is missing a valid attachment reference; refusing to send text without the image.`),
          {
            code: 'INVALID_REQUEST',
            reason: 'image-invalid',
            retryable: false
          }
        );
      }

      const attachments = this.#config.resolveAttachments?.();
      if (!attachments) {
        throw toFailure(
          new Error(`OpenCode Go image input requires DSH attachments service for model "${model.id}"; refusing to silently drop attached image.`),
          {
            code: 'INVALID_REQUEST',
            reason: 'attachments-unavailable',
            retryable: false
          }
        );
      }

      imageUrls = await resolveImageDataUrls(userImageRefs, {
        attachments,
        pixelBudget: this.#pixelBudget(),
        maxBytes: this.#maxImageBytes(),
        signal: options.signal
      });

      for (const attachmentId of userImageRefs.keys()) {
        const resolvedUrl = imageUrls.get(attachmentId);
        if (typeof resolvedUrl !== 'string' || !resolvedUrl.toLowerCase().startsWith('data:image/')) {
          throw toFailure(
            new Error(`Could not read attached image (${attachmentId}) for OpenCode Go model "${model.id}"; refusing to send text without the image.`),
            {
              code: 'INVALID_REQUEST',
              reason: 'image-unreadable',
              retryable: false
            }
          );
        }
      }
    }

    const userTools = convertTools(options.tools);
    const hasUserTools = Array.isArray(userTools) && userTools.length > 0;
    const messages = convertMessages(options.messages || [], {
      system: options.system,
      imageUrls,
      imageSupported
    });

    const bodyPayload = {
      model: model.id,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0
        ? { max_completion_tokens: options.maxTokens }
        : {}),
      ...(hasUserTools ? { tools: userTools } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(Array.isArray(options.stop) && options.stop.length > 0 ? { stop: options.stop } : {})
    };

    const watchdog = createGoWatchdog(this.#firstEventMs(), this.#idleMs(), options.signal);

    try {
      const res = await postGoChatCompletions({
        key,
        sessionId,
        payload: bodyPayload,
        fetchFn,
        signal: watchdog.signal,
        userAgent
      });

      const stream = withGoWatchdog(
        parseOpenAiSseStream(res.body, { includeGoBilling: true }),
        watchdog,
        key,
        res.body
      );

      for await (const chunk of stream) {
        if (chunk.type === 'usage') {
          this.#service?.noteBilling?.(chunk.usage);
        }
        yield chunk;
      }
    } catch (err) {
      if (watchdog.timedOut()) throw watchdog.error();
      if (options.signal?.aborted) throw err;
      if (err?.failure?.code) throw err;
      throw toDshFailure(err, key);
    } finally {
      watchdog.dispose();
    }
  }

  #idleMs() {
    const configured = Number(this.#config.streamIdleTimeoutMs);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STREAM_IDLE_MS;
  }

  #firstEventMs() {
    const configured = Number(this.#config.firstEventTimeoutMs);
    if (Number.isFinite(configured) && configured > 0) return configured;
    return Math.min(DEFAULT_FIRST_EVENT_MS, this.#idleMs());
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
   * 僅作 adapter 層介面保留；共用的 Go service 只由外掛卸載路徑釋放。
   */
  dispose() {}
}
