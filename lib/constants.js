export const PROVIDER = "opencode-next";
export const PROVIDER_NAME = "OpenCode (OAuth)";

export const GO_PROVIDER = "opencode-go-subscription";
export const GO_PROVIDER_NAME = "OpenCode Go (Subscription)";
export const GO_CREDENTIAL_ENV_VAR = "OPENCODE_GO_API_KEY";
export const OPENCODE_GO_ORIGIN = "https://opencode.ai";
export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/inference/go/v1/usage";
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/inference/go/v1/models";
export const OPENCODE_GO_CHAT_URL = "https://opencode.ai/inference/go/openai/v1/chat/completions";
export const GO_REQUEST_TIMEOUT_MS = 15000;

export const OPENCODE_INFERENCE_URL = "https://opencode.ai/inference/openai/v1";
export const OPENCODE_MODELS_URL = "https://models.opencode.ai/api.json";

export const OAUTH_CLIENT_ID = "opencode-cli";
export const OAUTH_DEVICE_CODE_URL = "https://opencode.ai/console/auth/device/code";
export const OAUTH_DEVICE_TOKEN_URL = "https://opencode.ai/console/auth/device/token";

export const DEFAULT_STREAM_IDLE_MS = 60000;
export const DEFAULT_FIRST_EVENT_MS = 30000;
export const GO_DEFAULT_FIRST_EVENT_MS = 180000;

/**
 * 送出請求時的圖片投影預算。
 *
 * OpenAI 相容端點把圖片內嵌成 base64 放在 body 裡，整包都會計入請求大小，而
 * 長 session 累積多張截圖時很容易把 body 撐爆。640000 px（約 1050x610）是
 * 保守值：足以讓 UI 截圖裡的小字仍然可讀，同時把單圖壓到數十 KB。
 *
 * 這兩個值必須固定且確定，因為 attachment service 會用「附件 + 目標」算出的
 * variant id 做快取；預算一旦浮動，圖片位元組就會每次都重新編碼。
 */
export const DEFAULT_IMAGE_PIXEL_BUDGET = 640000;
export const DEFAULT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Live availability probing of the free lane. */
export const PROBE_CONCURRENCY = 4;
export const PROBE_MAX_TOKENS = 16;
export const PROBE_TIMEOUT_MS = 20000;
/** Full re-verification interval; retires models that stopped serving. */
export const DEFAULT_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How often to re-fetch the catalog looking for newly published free models. */
export const DEFAULT_CATALOG_POLL_MS = 15 * 60 * 1000;
/** Persisted probe results older than this are treated as stale on startup. */
export const PROBE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Offline fallback, used only when the public catalog cannot be fetched.
 * Effort values mirror what the live catalog publishes (and what upstream
 * accepted in probes), so a fallback list behaves like a fetched one.
 */
export const STATIC_FREE_MODELS = [
  {
    id: "deepseek-v4.1-flash-free",
    name: "DeepSeek V4.1 Flash Free",
    contextWindow: 200000,
    defaultMaxTokens: 65536,
    inputModalities: ["text", "image"],
    efforts: ["off", "low", "high", "max"],
    defaultEffort: "high"
  },
  {
    id: "big-pickle",
    name: "Big Pickle",
    contextWindow: 200000,
    defaultMaxTokens: 65536,
    inputModalities: ["text"],
    efforts: ["off", "low", "medium", "high"],
    defaultEffort: "medium"
  },
  {
    id: "glm-5.3-flash-free",
    name: "GLM-5.3-Flash Free",
    contextWindow: 200000,
    defaultMaxTokens: 65536,
    inputModalities: ["text"],
    efforts: ["off", "low", "high", "max"],
    defaultEffort: "high"
  },
  {
    id: "mimo-v2.6-flash-free",
    name: "MiMo-V2.6-Flash Free",
    contextWindow: 200000,
    defaultMaxTokens: 65536,
    inputModalities: ["text"],
    efforts: ["off", "low", "medium", "high"],
    defaultEffort: "medium"
  },
  {
    id: "longcat-2.5-preview-free",
    name: "LongCat 2.5 Preview Free",
    contextWindow: 1000000,
    defaultMaxTokens: 65536,
    inputModalities: ["text"],
    efforts: ["off", "low", "medium", "high"],
    defaultEffort: "medium"
  },
  {
    id: "nemotron-3-ultra-free",
    name: "Nemotron 3 Ultra Free",
    contextWindow: 1000000,
    defaultMaxTokens: 65536,
    inputModalities: ["text"],
    efforts: ["off", "low", "medium", "high"],
    defaultEffort: "medium"
  },
  {
    id: "nemotron-3.5-lightning-free",
    name: "Nemotron 3.5 Lightning Free",
    contextWindow: 1000000,
    defaultMaxTokens: 65536,
    inputModalities: ["text"],
    efforts: ["off", "low", "medium", "high"],
    defaultEffort: "medium"
  },
  {
    id: "nemotron-3.5-super-vl-free",
    name: "Nemotron 3.5 Super VL Free",
    contextWindow: 1048576,
    defaultMaxTokens: 65536,
    inputModalities: ["text", "image"],
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
    defaultEffort: "medium"
  },
  {
    id: "beam-free",
    name: "Beam Free",
    contextWindow: 1048576,
    defaultMaxTokens: 65536,
    inputModalities: ["text"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium"
  },
  {
    id: "space-bunny-free",
    name: "Space Bunny Free",
    contextWindow: 1048576,
    defaultMaxTokens: 65536,
    inputModalities: ["text"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium"
  },
  {
    id: "exo-free",
    name: "Exo Free",
    contextWindow: 1048576,
    defaultMaxTokens: 65536,
    inputModalities: ["text"],
    efforts: ["high"],
    defaultEffort: "high"
  },
  {
    id: "cat-jam-free",
    name: "Cat Jam Free",
    contextWindow: 1048576,
    defaultMaxTokens: 65536,
    inputModalities: ["text"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium"
  }
];
