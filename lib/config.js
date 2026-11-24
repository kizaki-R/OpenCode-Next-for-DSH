import {
  PROVIDER,
  PROVIDER_NAME,
  GO_PROVIDER,
  GO_PROVIDER_NAME,
  GO_CREDENTIAL_ENV_VAR,
  OPENCODE_INFERENCE_URL,
  DEFAULT_STREAM_IDLE_MS,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_CATALOG_POLL_MS,
  DEFAULT_IMAGE_PIXEL_BUDGET,
  DEFAULT_IMAGE_MAX_BYTES
} from './constants.js';

/**
 * 取得 schemastery。
 *
 * 第一層是正規解——正常安裝（tgz / dsh plugin add）時，外掛位於 profile 的
 * node_modules 底下，Node 會逐層往上找到同一個 node_modules，直接成功。
 *
 * 第二層是給**開發機**用的。以 junction 掛進 profile 時，Node 用 realpath 解析，
 * 起點變成原始碼目錄，往上是使用者的專案資料夾，找不到 profile 的 node_modules，
 * 於是第一層會失敗。這裡改用 DSH 執行階段提供的環境變數推出 profile 目錄，再用
 * createRequire 從那個位置解析。**不使用硬編碼的使用者名稱**——那會把開發機的
 * 使用者名稱編進要出貨的檔案，而且換一台電腦就必然失效。
 *
 * 第三層是內建 stub。少了 schemastery 只會失去欄位層級的驗證（min/max），
 * 預設值仍然正確，所以外掛要能照常載入，不能因為這個套件缺席就掛掉。
 */
let Schema = null;
try {
  const mod = await import('@deepseek-ai/schemastery');
  Schema = mod.default || mod;
} catch {
  try {
    const { createRequire } = await import('node:module');
    const { join } = await import('node:path');
    const home = process.env.DSH_HOME
      || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
    const profileDir = process.env.DSH_PROFILE_DIR
      || join(home, 'profiles', process.env.DSH_PROFILE || 'desktop');
    // 借 profile 目錄當解析起點；路徑不存在時 createRequire 只是解析失敗，
    // 不會丟出例外，所以這裡是安全的。
    const require = createRequire(join(profileDir, '__dsh_resolve__.js'));
    Schema = require('@deepseek-ai/schemastery');
    if (Schema && Schema.default) Schema = Schema.default;
  } catch {
    // Fallback stub if schemastery is completely unavailable
    const stub = (defaultValue) => ({
      default: (v) => stub(v === undefined ? defaultValue : v),
      description: () => stub(defaultValue),
      min: () => stub(defaultValue),
      '~standard': { validate: (val) => ({ value: val === undefined ? defaultValue : val }) }
    });
    Schema = {
      object: (fields) => {
        const obj = {
          default: () => obj,
          description: () => obj,
          '~standard': {
            validate: (val = {}) => {
              const value = {};
              for (const [key, field] of Object.entries(fields)) {
                const res = field?.['~standard']?.validate?.(val[key]);
                value[key] = res?.value;
              }
              return { value };
            }
          }
        };
        return obj;
      },
      string: () => stub(''),
      number: () => stub(0),
      boolean: () => stub(false)
    };
  }
}

export const Config = Schema.object({
  providerId: Schema.string()
    .default(PROVIDER)
    .description('Provider ID in DSH (default: "opencode-next").'),

  providerName: Schema.string()
    .default(PROVIDER_NAME)
    .description('Display name in DSH model picker.'),

  inferenceUrl: Schema.string()
    .default(OPENCODE_INFERENCE_URL)
    .description('OpenCode OpenAI-compatible inference base URL.'),

  credentialPath: Schema.string()
    .default('')
    .description('Optional custom path for saved OAuth tokens (empty means auto-detect from local OpenCode Desktop or ~/.dsh/opencode-next.token.json).'),

  streamIdleTimeoutMs: Schema.number()
    .min(1000)
    .default(DEFAULT_STREAM_IDLE_MS)
    .description('Timeout in milliseconds for stream idle watchdog.'),

  autoDetectModels: Schema.boolean()
    .default(true)
    .description('Probe the free lane and advertise only models that actually respond. Keeps the picker in sync as OpenCode adds or retires free models.'),

  probeIntervalMs: Schema.number()
    .min(60000)
    .default(DEFAULT_PROBE_INTERVAL_MS)
    .description('How often to re-verify every model, in milliseconds (default: 6 hours). Retires models that stopped serving.'),

  catalogPollMs: Schema.number()
    .min(0)
    .default(DEFAULT_CATALOG_POLL_MS)
    .description('How often to re-fetch the catalog looking for newly published free models, in milliseconds (default: 15 minutes). Set to 0 to disable new-model polling.'),

  probeCachePath: Schema.string()
    .default('')
    .description('Optional path for the availability cache (default: ~/.dsh/opencode-next.models.json).'),

  imagePixelBudget: Schema.number()
    .min(10000)
    .default(DEFAULT_IMAGE_PIXEL_BUDGET)
    .description('Pixel budget per request image (default: 640000, about 1050x610). Must stay fixed so attachment request variants stay cacheable.'),

  imageMaxBytes: Schema.number()
    .min(65536)
    .default(DEFAULT_IMAGE_MAX_BYTES)
    .description('Encoded byte target per request image (default: 2 MiB). Base64 images count toward the request body size.'),

  autoSwitchAccounts: Schema.boolean()
    .default(false)
    .description('Switch to another saved account when the active account is still rejected with 401 after one refresh. Off by default; 429, 402, 400, network blocks and timeouts never rotate accounts.'),

  bunTransport: Schema.object({
    enabled: Schema.boolean().default(false),
    bunPath: Schema.string().default(''),
    clientVersion: Schema.string().default('2.0.32')
  }).default({ enabled: false, bunPath: '', clientVersion: '2.0.32' })
    .description('Opt in to Bun native fetch for OpenCode v2 anonymous inference compatibility. Requires a Bun runtime installed separately.'),

  anonymousChannel: Schema.object({
    enabled: Schema.boolean().default(false)
  }).default({ enabled: false })
    .description('Send inference without your account credential, using the public anonymous lane. Off by default. Unofficial usage the upstream does not promise to keep working.'),

  goSubscription: Schema.object({
    enabled: Schema.boolean().default(true),
    providerId: Schema.string().default(GO_PROVIDER),
    providerName: Schema.string().default(GO_PROVIDER_NAME),
    credentialRef: Schema.string().default(GO_CREDENTIAL_ENV_VAR),
    cachePath: Schema.string().default('')
  }).default({
    enabled: true,
    providerId: GO_PROVIDER,
    providerName: GO_PROVIDER_NAME,
    credentialRef: GO_CREDENTIAL_ENV_VAR,
    cachePath: ''
  }).description('Independent OpenCode Go subscription provider (enabled by default; set enabled: false to disable). Resolves the Console Personal API Key via DSH credential service or environment variable; never stores raw API keys.')
});

export function resolveConfig(raw = {}) {
  if (Config && Config['~standard'] && typeof Config['~standard'].validate === 'function') {
    const res = Config['~standard'].validate(raw);
    if (res.issues) {
      const msg = res.issues.map((i) => i.message).join('; ');
      throw new Error(`opencode-next config error: ${msg}`);
    }
    return res.value;
  }

  return {
    providerId: raw.providerId || PROVIDER,
    providerName: raw.providerName || PROVIDER_NAME,
    inferenceUrl: raw.inferenceUrl || OPENCODE_INFERENCE_URL,
    credentialPath: raw.credentialPath || '',
    streamIdleTimeoutMs: raw.streamIdleTimeoutMs || DEFAULT_STREAM_IDLE_MS,
    autoDetectModels: raw.autoDetectModels ?? true,
    probeIntervalMs: raw.probeIntervalMs || DEFAULT_PROBE_INTERVAL_MS,
    catalogPollMs: raw.catalogPollMs ?? DEFAULT_CATALOG_POLL_MS,
    probeCachePath: raw.probeCachePath || '',
    imagePixelBudget: raw.imagePixelBudget || DEFAULT_IMAGE_PIXEL_BUDGET,
    imageMaxBytes: raw.imageMaxBytes || DEFAULT_IMAGE_MAX_BYTES,
    autoSwitchAccounts: raw.autoSwitchAccounts === true,
    bunTransport: {
      enabled: raw.bunTransport?.enabled === true,
      bunPath: raw.bunTransport?.bunPath || '',
      clientVersion: raw.bunTransport?.clientVersion || '2.0.32'
    },
    anonymousChannel: {
      enabled: raw.anonymousChannel?.enabled === true
    },
    goSubscription: {
      enabled: raw.goSubscription?.enabled !== false,
      providerId: raw.goSubscription?.providerId || GO_PROVIDER,
      providerName: raw.goSubscription?.providerName || GO_PROVIDER_NAME,
      credentialRef: raw.goSubscription?.credentialRef || GO_CREDENTIAL_ENV_VAR,
      cachePath: raw.goSubscription?.cachePath || ''
    }
  };
}
