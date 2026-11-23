/**
 * 從上游回應判斷「這是哪一種失敗」，並對應到 DSH 的穩定錯誤碼。
 *
 * 為什麼要獨立成一個模組：
 *
 *  1. 403 不是單一意思。免費通道會用 403 講三件完全不同的事——用戶端不合規
 *     (`FreeTierError`)、這個模型被地區封鎖 (`RegionError`)、以及其他。把它們
 *     壓成同一個錯誤碼，使用者就分不出「換模型就好」和「這個通道整個不能用」。
 *
 *  2. `probe.js` 早就有一份同樣的分流邏輯，但只吐內部用的 reason 字串。
 *     狀態頁與推論路徑需要的是同一組判斷加上 DSH 錯誤碼，所以把判斷集中在
 *     這裡，兩邊都呼叫同一份，就不會出現「探測說可用、實際上推論失敗」的落差。
 *
 *  3. DSH 只認得自己那一組錯誤碼。這裡產出的碼全部落在合法集合內，
 *     並且會經由 `toFailure()` 掛成 Error 的 `.failure`，才能真正傳到上層。
 */

/**
 * 上游錯誤型別 → 判斷結果。
 *
 * `code` 一律取自 DSH 的穩定錯誤碼集合；`reason` 是給人看的（狀態頁與日誌用），
 * 兩者刻意分開：前者餵給程式，後者餵給眼睛。
 */
const REGION_ERROR = 'RegionError';
const FREE_TIER_ERROR = 'FreeTierError';

/**
 * 網路出口被風控擋掉（不是 FreeTierError 的「用戶端不合規」）。
 *
 * 這個型別**不是**上游回傳的 `type` 欄位值——上游對這件事只給一段自由文字：
 *
 *   "OpenCode's free models aren't available from your current network because
 *    we've detected abusive traffic from this IP address. This isn't related to
 *    your account. If you're on a VPN or proxy, turn it off and try again, or
 *    subscribe to OpenCode Go at https://opencode.ai/go to keep building."
 *
 * 沒有辨識這段文字的話，它會落到泛用的 `forbidden`（「上游拒絕了這個請求」），
 * 而那句話對使用者毫無用處：真正的下一步是「關掉 VPN 或改訂閱」。這段訊息
 * 甚至明確寫了「與你的帳號無關」，所以任何叫他「重新登入」的提示都是錯的。
 */
const NETWORK_BLOCKED_ERROR = 'NetworkBlocked';

export { REGION_ERROR, FREE_TIER_ERROR, NETWORK_BLOCKED_ERROR };

/**
 * 認出「IP／網路出口被風控」的自由文字特徵。
 *
 * 用多個彼此獨立的短語而不是一整段長句：上游隨時可能微調措辭或標點，
 * 綁死完整句子會在它改字時靜默失效，然後使用者又退回看到沒用的「403」。
 *
 * 全部都是小寫比對；呼叫端負責先轉小寫。
 */
const NETWORK_BLOCK_MARKERS = [
  'abusive traffic',
  'current network',
  'from this ip address'
];

/** 這段訊息是否在講「你的網路出口被擋」。 */
export function looksLikeNetworkBlock(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const lower = text.toLowerCase();
  return NETWORK_BLOCK_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * 「這次請求太大，超過模型自己的上下文上限」。
 *
 * 為什麼要獨立辨識：它與「模型已下線」共用 400，但**處理方式完全相反**。
 * 模型本身好好的，是送進去的內容太長；使用者只要縮短訊息或壓縮就能繼續用
 * 同一個模型。把它誤標成「模型已下線」等於叫人放棄一個其實能用的模型，
 * 而且會讓人以為要換模型——換了才發現換誰都一樣（那些模型的上下文更小）。
 *
 * 實測原文：
 *   "Your request resulted in more tokens than this model's maximum context
 *    length allows. Please reduce the length of the messages or run compaction."
 */
const CONTEXT_OVERFLOW_MARKERS = [
  'maximum context length',
  'context length',
  'reduce the length of the messages',
  'too many tokens',
  'prompt is too long'
];

/** 這段訊息是否在講「請求超過上下文上限」。 */
export function looksLikeContextOverflow(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const lower = text.toLowerCase();
  return CONTEXT_OVERFLOW_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * 上游真的說了「模型不可用」的措辭。
 *
 * 只有 body 明確寫出來才標成 `unavailable`。不能因為狀態碼是 400 就假設
 * 是模型下線——400 是個大雜燴，實測至少還裝了上下文超限與「只回模型名稱、
 * 不給任何說明」兩種情況。
 */
const MODEL_UNAVAILABLE_MARKERS = [
  'model is unavailable',
  'model unavailable',
  'model is not available',
  'no such model',
  'unknown model'
];

/** 這段訊息是否明白講「模型不可用」。 */
export function looksLikeModelUnavailable(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const lower = text.toLowerCase();
  return MODEL_UNAVAILABLE_MARKERS.some((marker) => lower.includes(marker));
}

const MODEL_NOT_FOUND_TYPES = new Set([
  'modelnotfound', 'modelnotfounderror', 'modelnotfoundexception',
  'unknownmodel', 'unknownmodelerror', 'unknownmodelexception',
  'modeldoesnotexist', 'modeldoesnotexisterror'
]);

/** Only explicit model-level unknown/not-found evidence makes a 404 terminal. */
function isModelSpecificNotFound(errorType, rawText) {
  const normalizedType = typeof errorType === 'string'
    ? errorType.toLowerCase().replace(/[^a-z0-9]/g, '')
    : '';
  if (MODEL_NOT_FOUND_TYPES.has(normalizedType)) return true;
  if (typeof rawText !== 'string' || rawText.length === 0) return false;

  const lower = rawText.toLowerCase().replace(/["'`]/g, ' ');
  const codeText = lower.replace(/[_-]+/g, ' ');
  if (/\b(?:unknown|no\s+such|unrecognized)\s+model\b/.test(codeText)
    || /\bmodel(?:\s+(?:id|name))?\s+(?:(?:is|was)\s+)?not\s+found\b/.test(codeText)
    || /\bmodel(?:\s+(?:id|name))?\s+(?:does\s+not|doesn't)\s+exist\b/.test(codeText)) {
    return true;
  }

  const match = /\bmodel(?:\s+(?:id|name))?\s+([a-z0-9][a-z0-9._:/-]*)\s+(?:(?:is|was)\s+)?not\s+found\b/.exec(lower)
    ?? /\bmodel(?:\s+(?:id|name))?\s+([a-z0-9][a-z0-9._:/-]*)\s+(?:does\s+not|doesn't)\s+exist\b/.exec(lower);
  const nonModelSubjects = new Set(['endpoint', 'path', 'route', 'resource', 'request', 'service', 'url']);
  return Boolean(match && !nonModelSubjects.has(match[1]));
}

/**
 * 判斷上游是否回報模型端點暫時不可用。
 *
 * OpenCode 曾用 429 回傳 `Endpoint is unavailable`，並附上目前維護／不可用的說明。
 * 保留這個 body 分類供錯誤診斷；重試次數與等待時間一律由 DSH host retry policy 決定。
 */
const ENDPOINT_UNAVAILABLE_MARKERS = [
  'endpoint is unavailable',
  'endpoint unavailable',
  'endpoint is currently unavailable'
];

// 辨識明確限流訊息，方便錯誤報告保留原因；所有可重試 429 現在共用 host policy。
const EXPLICIT_RATE_LIMIT_MARKERS = [
  'rate limit exceeded',
  'rate-limit exceeded',
  'rate limit has been exceeded',
  'too many requests',
  'request rate exceeded',
  'requests per minute exceeded'
];

/** body 是否指出免費模型額度已達上限。 */
export function looksLikeFreeUsageLimit(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const lower = text.toLowerCase();
  return lower.includes('freeusagelimiterror') || lower.includes('free usage limit reached');
}

/** body 是否明確指出請求限流／請求過多。 */
export function looksLikeExplicitRateLimit(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const lower = text.toLowerCase();
  return EXPLICIT_RATE_LIMIT_MARKERS.some((marker) => lower.includes(marker));
}

/** 這段訊息是否在講「模型端點目前維護／不可用」。 */
export function looksLikeEndpointUnavailable(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const lower = text.toLowerCase();
  if (ENDPOINT_UNAVAILABLE_MARKERS.some((marker) => lower.includes(marker))) return true;
  // 中文訊息：提到端點，且說是維護或不可用。
  //
  // 這裡刻意用 Unicode 轉義寫簡體字：上游實際送出的是簡體字形（端點、維護與在線的簡體寫法），
  // 直接寫字面值會讓 `traditional-chinese.test.mjs` 把本檔判成混入簡體。
  // 兩個語系的字都要認，否則同一段話換個字形就分類不到。
  const endpointWord = /\u7aef[\u9ede\u70b9]/; // 端點／端点
  const maintenanceWord = /\u7dad\u8b77|\u7ef4\u62a4|\u4e0d\u53ef\u7528/; // 維護／维护／不可用
  return endpointWord.test(text) && maintenanceWord.test(text);
}

/**
 * 從 JSON 錯誤主體取出上游的型別標記。
 *
 * OpenCode 用 `{ error: { type } }`，但也見過直接掛在最外層的 `{ type }`，
 * 兩種都讀。解析失敗一律回 null，絕不讓分類本身成為新的失敗來源。
 */
export function parseErrorType(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.type || parsed?.type || null;
  } catch {
    return null;
  }
}

/**
 * 從任意錯誤文字裡認出上游型別。
 *
 * 給「只有訊息、沒有結構化 body」的情況用（例如錯誤被包裝過一層）。
 */
export function detectErrorType(text) {
  if (typeof text !== 'string') return null;
  // 先判網路風控：它比另外兩種更根本，而且上游有時會在 `FreeTierError` 的
  // body 裡夾帶這段文字。那種情況下判成 FreeTierError 會給出「請求缺少必要
  // 欄位」的猜測，正好把使用者推往錯誤方向。
  if (looksLikeNetworkBlock(text)) return NETWORK_BLOCKED_ERROR;
  if (text.includes(FREE_TIER_ERROR)) return FREE_TIER_ERROR;
  if (text.includes(REGION_ERROR)) return REGION_ERROR;
  return null;
}

/**
 * 把 HTTP 狀態碼與上游型別轉成 { code, reason, retryable }。
 *
 * `code` 必須是 DSH 認得的穩定錯誤碼，否則上層只會看到 `UNKNOWN`，
 * 重試政策與使用者提示都會同時失效。
 *
 * `retryable` 描述「重打同一個模型有沒有機會成功」，這與
 * `SAFE_RETRY_POLICY.retryableCodes` 是兩件事：後者決定要不要自動重試，
 * 前者是給狀態頁判斷「這個模型該不該標成紅燈」。
 *
 * @param {number} status HTTP 狀態碼
 * @param {string|null} errorType 上游型別標記（見 `parseErrorType`／`detectErrorType`）
 * @param {{replacement?: string|null, rawText?: string|null}} [extra] 上游在 body 裡附帶的線索。
 *   `replacement` 來自 `metadata.replacement`：410 會直接告訴你該換成哪個模型。
 *   `rawText` 是未經解析的原始 body；400 靠它區分模型不可用與其他拒絕，404
 *   則靠它確認錯誤是否明確指向模型不存在，避免把 endpoint/path 404 當成下架。
 */
export function classifyHttpFailure(status, errorType = null, extra = {}) {
  const replacement = typeof extra?.replacement === 'string' && extra.replacement !== ''
    ? extra.replacement
    : null;
  // 網路出口被風控，優先於其他所有判斷。
  //
  // 放在最前面是因為上游不一定用固定狀態碼表達它：實測同時見過 403 與 429。
  // 若讓 429 先命中，使用者會看到「被上游限流（429）」然後我們的 retryable
  // 還會讓上層自動重試——重試一百次都一樣，只會讓這個 IP 更難看。
  //
  // `retryable: false` 是這裡最重要的一個欄位：免費通道擋的是網路出口，
  // 換模型、重試、重新登入全都無效，唯一有效的動作是換網路或改訂閱。
  if (errorType === NETWORK_BLOCKED_ERROR) {
    return {
      code: 'AUTH',
      reason: 'network-blocked',
      retryable: false,
      hint: 'OpenCode 判定此網路出口有濫用流量，免費模型暫時無法使用（與你的帳號無關）。'
        + '請關閉 VPN 或 proxy 後重試；若仍不行，需改用 OpenCode Go 訂閱（https://opencode.ai/go）。'
        + '重試或換模型都不會改善。'
    };
  }

  // 免費通道擋掉的是「這個客戶端」，不是「這個模型」。重試一百次都一樣，
  // 而且會讓 IP 更難看，所以明確標成不可重試。
  if (status === 403 && errorType === FREE_TIER_ERROR) {
    return {
      code: 'AUTH',
      reason: 'free-lane-blocked',
      retryable: false,
      hint: '免費通道拒絕了這個請求（FreeTierError）：通常代表請求缺少必要欄位、'
        + '或此網路出口不在 OpenCode 允許的範圍內。重試無用，請確認外掛設定或改用其他通道。'
    };
  }

  // 地區限制只影響「這個模型」，通道本身是好的，換模型即可。
  if (status === 403 && errorType === REGION_ERROR) {
    return {
      code: 'AUTH',
      reason: 'region-restricted',
      retryable: false,
      hint: '這個模型在此地區被封鎖（RegionError）。通道本身正常，換一個模型即可。'
    };
  }

  if (status === 401 || status === 403) {
    return {
      code: 'AUTH',
      reason: status === 401 ? 'unauthorized' : 'forbidden',
      retryable: false,
      hint: status === 401
        ? '授權已失效，請重新登入 OpenCode。'
        : '上游拒絕了這個請求（403）。'
    };
  }

  if (status === 429) {
    // 免費額度耗盡：綁定帳號，更換 VPN 或 IP 無法解除。
    if (errorType === 'FreeUsageLimitError' || looksLikeFreeUsageLimit(extra?.rawText)) {
      return {
        code: 'RATE_LIMIT',
        reason: 'rate-limited',
        retryable: true,
        hint: '上游回傳 FreeUsageLimitError（429）。這不一定是帳號額度用完，也可能是請求沒有走 OpenCode 相容傳輸。請先確認已重啟 DSH；若官方 OpenCode 仍可用而此外掛不行，不要換 VPN。'
      };
    }
    // 先看 body：有些上游用 429 表示模型端點暫時不可用，這與明確限流不同。
    if (looksLikeEndpointUnavailable(extra?.rawText)) {
      return {
        code: 'RATE_LIMIT',
        reason: 'endpoint-unavailable',
        retryable: true,
        hint: '上游回報這個模型的端點暫時不可用（429）。'
      };
    }
    if (looksLikeExplicitRateLimit(extra?.rawText)) {
      return {
        code: 'RATE_LIMIT',
        reason: 'rate-limited-explicit',
        retryable: true,
        hint: '上游明確回報請求超過速率限制（429）。'
      };
    }
    return {
      code: 'RATE_LIMIT',
      reason: 'rate-limited',
      retryable: true,
      hint: '收到無法辨識類型的 429。'
    };
  }

  // 400 是一個大雜燴，至少裝了三件不同的事，處理方式也各自不同。
  //
  // 舊版把 400 一律當成「模型已下線」，結果是：
  //   - 上下文超限被說成「模型下線」，使用者去換模型，換到的上下文更小；
  //   - 上游只回 `{"model":"…"}` 這種沒有說明的 body 時，也被說成「模型下線」，
  //     使用者照著提示換模型，但真正的原因是這個帳號在該模型上的權限／額度。
  // 兩種誤導都會讓人往錯方向修，所以這裡逐項分辨。
  if (status === 400) {
    // 上下文超限：模型是好的，要動的是「送進去的內容」。
    if (looksLikeContextOverflow(extra?.rawText)) {
      return {
        code: 'INVALID_REQUEST',
        reason: 'context-overflow',
        retryable: false,
        hint: '這次請求的內容超過此模型的上下文上限（模型本身可用）。'
          + '請縮短訊息或執行壓縮後重試；換成上下文更小的模型只會更嚴重。'
      };
    }

    // 上游明說模型不可用。
    if (looksLikeModelUnavailable(extra?.rawText)) {
      return {
        code: 'INVALID_REQUEST',
        reason: 'unavailable',
        retryable: false,
        hint: '上游回報這個模型目前不可用。'
      };
    }

    // 剩下的 400 沒有可讀說明（實測 body 可能只有 `{"model":"…"}`）。
    //
    // 這裡不猜原因，只陳述觀察到的事實與它最常見的成因。硬掰一個結論
    // 會讓使用者照著錯誤方向處理，比承認「上游沒說」還糟。
    return {
      code: 'INVALID_REQUEST',
      reason: 'bad-request',
      retryable: false,
      hint: '上游以 400 拒絕，但沒有附上可讀的說明。'
        + '實測這通常與「此帳號在該模型上的權限或額度」有關，換帳號授權後可恢復；'
        + '原始回應見上方訊息，可自行搜尋。'
    };
  }

  if (status === 404) {
    if (isModelSpecificNotFound(errorType, extra?.rawText)) {
      return {
        code: 'UNKNOWN_MODEL',
        reason: 'not-found',
        retryable: false,
        hint: '上游明確找不到這個模型。'
      };
    }
    return {
      code: 'SERVER',
      reason: 'endpoint-not-found',
      retryable: false,
      hint: '上游回傳 404，但沒有指出模型不存在；可能是推論 endpoint 或路徑無效。'
    };
  }

  if (status === 410) {
    return {
      code: 'UNKNOWN_MODEL',
      reason: 'deprecated',
      retryable: false,
      // `metadata.replacement` 是上游自己給的替代模型名（實測 `space-bunny-free`
      // 會回 `minimax-m3.1-flash-free`）。提示裡直接寫出來，使用者就不必自己猜
      // 該換成哪一個；沒有提供時退回原本的說明。
      hint: replacement
        ? `這個模型已下架（410）。上游建議改用 ${replacement}。`
        : '這個模型已下架（410）。',
      // 帶出去讓備援迴圈能把上游指名的替代模型接到隊尾。
      replacement
    };
  }

  if (status === 402 || status === 409 || status === 422) {
    // 402 Payment Required 原本在 probe 裡只被標成裸的 `http-402`；
    // 標成配額問題更能直接指出「要去處理額度」，且不改變 reachable 判斷。
    return {
      code: status === 402 ? 'QUOTA' : 'INVALID_REQUEST',
      reason: status === 402 ? 'quota-exceeded' : `http-${status}`,
      retryable: false,
      hint: `上游以 ${status} 拒絕請求。`
    };
  }

  // 5xx 是上游自己的問題，值得重試。
  if (status >= 500) {
    return {
      code: 'SERVER',
      reason: 'upstream-error',
      retryable: true,
      hint: '上游伺服器暫時異常。'
    };
  }

  // 剩下的 4xx 沒有專屬語意。
  //
  // 這裡刻意用 'TRANSPORT' 而不是自創的 'UPSTREAM'：DSH 的錯誤碼是固定集合，
  // 'UPSTREAM' 不在裡面，寫上去只會被 normalizeLlmFailure 核銷成 'UNKNOWN'，
  // 讓上層既無法重試也無法給出有意義的提示。
  if (status >= 400) {
    return {
      code: 'TRANSPORT',
      reason: `http-${status}`,
      retryable: false,
      hint: `上游以 ${status} 回應。`
    };
  }

  // 理論上走不到（呼叫端只在 !res.ok 時進來），保守回一個安全值。
  return { code: 'SERVER', reason: `http-${status}`, retryable: false };
}

/**
 * 把分類結果掛到 Error 上，讓它真的能穿過 DSH 的正規化。
 *
 * `normalizeLlmFailure` 只信任 `.failure`（且要求 `.failure.code === .code`）；
 * 單純在 Error 上寫 `.code` 會被核銷成 `UNKNOWN`。這裡兩個都設，缺一不可。
 */
export function toFailure(error, classified) {
  const target = error instanceof Error ? error : new Error(String(error));
  target.code = classified.code;
  target.status = classified.status;
  // `reason` 是我們自己的欄位，DSH 不讀它。
  //
  // 備援切換必須靠它分辨「這個模型掛了，換下一個」與「整個通道／網路出口
  // 掛了，換誰都一樣」。只看 HTTP 狀態碼做不到——400 與 403 都可能出自
  // 完全不同的原因——而 `reason` 正是 `classifyHttpFailure` 已經算好的結論。
  if (classified.reason !== undefined) target.reason = classified.reason;
  target.failure = {
    message: target.message,
    code: classified.code,
    ...(Number.isInteger(classified.status) ? { status: classified.status } : {})
  };
  if (classified.hint !== undefined && !target.message.includes(classified.hint)) {
    target.message = `${target.message}（${classified.hint}）`;
    target.failure.message = target.message;
  }
  return target;
}
