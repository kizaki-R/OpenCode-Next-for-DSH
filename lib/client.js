import crypto from 'node:crypto';

const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62Fixed(value, width) {
  const base = 62n;
  let n = value;
  const out = new Array(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base));
    n /= base;
  }
  return out.join("");
}

function invertedTimestampHex(now = Date.now()) {
  return (~(BigInt(now) * 4096n + 1n) & 281474976710655n).toString(16).padStart(12, "0");
}

export function canonicalSessionId(signal = '') {
  if (typeof signal === 'string' && CANONICAL_SESSION_PATTERN.test(signal)) {
    return signal;
  }
  const sum = crypto.createHash("sha256").update("ses\0" + String(signal || Date.now() + Math.random())).digest();
  return `ses_${invertedTimestampHex()}${base62Fixed(BigInt("0x" + sum.subarray(6, 16).toString("hex")), 14)}`;
}

export function randomId(prefix = 'req', length = 16) {
  const bytes = crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
  return `${prefix}_${bytes}`;
}

export function stableProjectId(name = '') {
  const value = typeof name === 'string' && name.trim() !== '' ? name.trim() : (process.cwd?.() || 'opencode');
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

export function opencodeUserAgent(version = '2.0.32') {
  return `opencode/latest/${version}/cli`;
}

/**
 * OpenCode official v2 baseline tool names.
 */
export const OFFICIAL_V2_TOOL_NAMES = Object.freeze([
  'edit', 'glob', 'grep', 'question', 'read', 'shell', 'skill', 'subagent', 'webfetch', 'websearch', 'write', 'execute'
]);

export function makeOfficialTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: `OpenCode official ${name} tool.`,
      parameters: { type: 'object', properties: {} }
    }
  };
}

/**
 * OpenCode upstream free-lane gate requires official baseline tools.
 */
export function ensureFreeLaneTools(tools) {
  const currentTools = Array.isArray(tools) ? [...tools] : [];
  const existingNames = new Set(
    currentTools.map((t) => (t.type === 'function' ? t.function?.name || t.name : t.name))
  );

  for (const gateName of OFFICIAL_V2_TOOL_NAMES) {
    if (!existingNames.has(gateName)) {
      currentTools.push(makeOfficialTool(gateName));
    }
  }

  return currentTools;
}

/**
 * 準備送往上游的工具陣列並建立雙向別名映射。
 *
 * 1. 包含官方 v2 必備的 12 個基線工具。
 * 2. DSH 的工具映射為 oc_ext_${index}，在 description 標註原名以保留模型調用判斷依據。
 * 3. 回傳 { tools, toUpstreamName, toDshName }。
 */
export function prepareToolsWithAliases(userTools) {
  const upstreamTools = OFFICIAL_V2_TOOL_NAMES.map(name => makeOfficialTool(name));
  const dshToUpstream = new Map();
  const upstreamToDsh = new Map();

  const rawList = Array.isArray(userTools) ? userTools : [];
  rawList.forEach((t, idx) => {
    const rawName = t.type === 'function' ? (t.function?.name || t.name) : t.name;
    if (!rawName) return;

    const alias = `oc_ext_${idx}`;
    dshToUpstream.set(rawName, alias);
    upstreamToDsh.set(alias, rawName);

    const desc = t.function?.description || t.description || '';
    const annotatedDesc = `[Tool: ${rawName}] ${desc}`.trim();
    const params = t.function?.parameters || t.parameters || { type: 'object', properties: {} };

    upstreamTools.push({
      type: 'function',
      function: {
        name: alias,
        description: annotatedDesc,
        parameters: params
      }
    });
  });

  return {
    tools: upstreamTools,
    toUpstreamName: (dshName) => dshToUpstream.get(dshName) || dshName,
    toDshName: (upstreamName) => upstreamToDsh.get(upstreamName) || upstreamName
  };
}

/**
 * Builds the headers OpenCode expects for client affinity and verification.
 */
export function buildHeaders(token, sessionId, requestId, projectId, orgId) {
  const sid = canonicalSessionId(sessionId);
  const rid = requestId || randomId('req', 16);
  const pid = (projectId && projectId !== 'global') ? projectId : stableProjectId();
  const authToken = token || 'public';

  const headers = {
    'authorization': `Bearer ${authToken}`,
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': sid,
    'x-opencode-session-id': sid,
    'x-session-affinity': sid,
    'x-session-id': sid,
    'x-opencode-request': rid,
    'x-opencode-project': pid
  };

  if (typeof orgId === 'string' && orgId.trim() !== '') {
    headers['x-opencode-org-id'] = orgId.trim();
  }

  return headers;
}

/**
 * 把內容區塊裡的純文字攤平。
 *
 * DSH 的訊息內容是 ContentBlock 陣列，不是字串。舊版遇到陣列直接
 * `JSON.stringify`，於是模型看到的 system 提示詞是
 * `[{"type":"text","text":"You are a coding agent…"}]` 這種 JSON 字面值——提示詞
 * 完全失效，而且每次請求都白付一份 JSON 逸出字元的 token。這裡改成只取
 * `text` 區塊並以換行接回人類可讀的文字。
 */
export function flattenText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** 從 DSH 的 image 區塊取出附件參照；形狀不符時回傳 null。 */
function imageAttachmentRef(block) {
  const ref = block?.attachment;
  if (!ref || typeof ref !== 'object') return null;
  if (typeof ref.attachmentId !== 'string' || ref.attachmentId === '') return null;
  return ref;
}

/** 穩定、可判讀的附件短摘要，用於佔位文字。 */
function attachmentDigest(ref) {
  const id = typeof ref?.attachmentId === 'string' ? ref.attachmentId : '';
  return id.startsWith('sha256:') ? id.slice(0, 15) : id.slice(0, 14);
}

/**
 * 因請求預算被省略的圖片，改成模型看得懂身分的佔位文字。
 *
 * 關鍵是保留附件 id 前綴：模型後續對話裡若還提到這張圖，至少知道自己漏看了
 * 哪一份，而不是完全空白。
 */
export function offloadedImageText(ref) {
  return `[image omitted to fit request image limits; attachment ${attachmentDigest(ref)}…]`;
}

/** 模型不接受圖片時的佔位文字。 */
export function textOnlyImageText(ref) {
  return `[image omitted because this model accepts text only; attachment ${attachmentDigest(ref)}…]`;
}

/** DSH 的 file 區塊在 OpenAI 線路上沒有對應型別，退化成描述性 handle 文字。 */
export function fileHandleText(ref) {
  const name = typeof ref?.name === 'string' && ref.name !== '' ? ` "${ref.name}"` : '';
  const mediaType = typeof ref?.mediaType === 'string' ? ` ${ref.mediaType}` : '';
  const bytes = Number.isFinite(ref?.bytes) ? ` ${ref.bytes} bytes` : '';
  return `[file${name}${mediaType}${bytes}; attachment ${attachmentDigest(ref)}…]`;
}

/**
 * 掃出訊息裡所有還會用到的圖片附件參照，讓呼叫端可以一次把位元組讀齊。
 *
 * 回傳 `Map<attachmentId, ref>`，同一張圖重複出現只讀一次。
 */
export function collectImageRefs(dshMessages) {
  const refs = new Map();
  if (!Array.isArray(dshMessages)) return refs;
  for (const msg of dshMessages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || block.type !== 'image' || block.offloaded === true) continue;
      const ref = imageAttachmentRef(block);
      if (ref !== null && !refs.has(ref.attachmentId)) refs.set(ref.attachmentId, ref);
    }
  }
  return refs;
}

/**
 * 把 DSH 訊息轉成 OpenAI 相容的 messages 陣列。
 *
 * `options`：
 * - `system`：`GenerateOptions.system`。DSH 會把它跟開頭那幾則 system 訊息合併成
 *   單一 system message（多則重複的 system 只是白燒 token）。
 * - `imageUrls`：`Map<attachmentId, dataURI>`，由呼叫端用 attachment service 先讀好。
 * - `imageSupported`：路由是否接受圖片；false 時圖片一律換成佔位文字。
 */
export function convertMessages(dshMessages, options = {}) {
  if (!Array.isArray(dshMessages)) return [];

  const imageUrls = options.imageUrls instanceof Map ? options.imageUrls : new Map();
  const imageSupported = options.imageSupported !== false;

  const out = [];
  const systemParts = [];
  if (typeof options.system === 'string' && options.system.trim() !== '') {
    systemParts.push(options.system);
  }
  let sawSystem = false;

  /** 把一個 image 區塊轉成 OpenAI 的 image_url 片段，或退化成佔位文字。 */
  function imageBlockPart(block) {
    const ref = imageAttachmentRef(block);
    if (ref === null) return null;
    if (block.offloaded === true || !imageSupported) {
      const text = block.offloaded === true ? offloadedImageText(ref) : textOnlyImageText(ref);
      return { type: 'text', text };
    }
    const url = imageUrls.get(ref.attachmentId);
    if (typeof url !== 'string' || url === '') return { type: 'text', text: textOnlyImageText(ref) };
    return { type: 'image_url', image_url: { url } };
  }

  for (const msg of dshMessages) {
    if (!msg) continue;

    const role = msg.role === 'human' ? 'user' : msg.role;

    // `developer` 是 OpenAI 新版模型取代 system 的角色，語意與擺放位置都與 system
    // 相同。不一起處理的話它會掉出所有分支被靜默丟棄，整段指示憑空消失。
    if (role === 'system' || role === 'developer') {
      const text = flattenText(msg.content);
      if (!sawSystem && out.length === 0) {
        // 開頭的 system 訊息屬於同一段系統提示詞，跟 options.system 併成一則。
        sawSystem = true;
        if (text.trim() !== '' && !systemParts.includes(text)) systemParts.push(text);
        continue;
      }
      if (text.trim() !== '') out.push({ role: 'system', content: text });
      continue;
    }

    if (role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
        continue;
      }
      if (!Array.isArray(msg.content)) continue;
      const parts = [];
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text || '' });
        } else if (block.type === 'image') {
          const part = imageBlockPart(block);
          if (part !== null) parts.push(part);
        } else if (block.type === 'file') {
          parts.push({ type: 'text', text: fileHandleText(block.attachment) });
        }
      }
      if (parts.length === 0) continue; // 空訊息留著只會被上游拒收
      out.push({
        role: 'user',
        content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts
      });
      continue;
    }

    if (role === 'assistant') {
      let textContent = '';
      let reasoningContent = '';
      const toolCalls = [];
      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text') {
            textContent += block.text || '';
          } else if (block.type === 'reasoning') {
            reasoningContent += block.text || '';
          } else if (block.type === 'tool-call') {
            const rawName = block.name;
            const toolName = typeof options.toUpstreamName === 'function'
              ? options.toUpstreamName(rawName)
              : rawName;
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: toolName,
                arguments:
                  typeof block.arguments === 'string'
                    ? block.arguments
                    : JSON.stringify(block.arguments || {})
              }
            });
          }
        }
      }
      if (textContent === '' && toolCalls.length === 0) continue;
      const assistantMsg = { role: 'assistant', content: textContent };
      // 推理模型回放歷史時要求 assistant 帶回 reasoning_content，缺了會被上游 400。
      if (reasoningContent !== '') assistantMsg.reasoning_content = reasoningContent;
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);
      continue;
    }

    if (role === 'tool' || msg.toolCallId) {
      let content = flattenText(msg.content);
      // 工具結果裡夾帶的圖片在 OpenAI 的 tool 角色沒有位置，退化成佔位文字。
      if (Array.isArray(msg.content)) {
        const extras = [];
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'image') {
            const ref = imageAttachmentRef(block);
            if (ref !== null) extras.push(textOnlyImageText(ref));
          } else if (block.type === 'file') {
            extras.push(fileHandleText(block.attachment));
          }
        }
        if (extras.length > 0) content = [content, ...extras].filter(Boolean).join('\n');
      }
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId || msg.id,
        content
      });
      continue;
    }
  }

  const systemText = systemParts.filter(Boolean).join('\n\n');
  return systemText === '' ? out : [{ role: 'system', content: systemText }, ...out];
}

/**
 * Converts DSH tool definitions to OpenAI functions schema.
 */
export function convertTools(dshTools) {
  if (!Array.isArray(dshTools) || dshTools.length === 0) return undefined;

  return dshTools.map((t) => {
    if (t.type === 'function' && t.function) {
      return t;
    }
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} }
      }
    };
  });
}
