/**
 * Optional OpenCode v2-compatible Bun transport, ported from
 * FishBottle7/opencode2dsh PR #110. The Bun runtime is supplied by the user;
 * this module never downloads or installs it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { stableProjectId } from './client.js';

const require = createRequire(import.meta.url);

const WORKER_PATH = fileURLToPath(new URL('./bun-worker.mjs', import.meta.url));
const INFERENCE_PATHS = new Set([
  '/inference/openai/v1/chat/completions',
  '/inference/v1/chat/completions',
  '/zen/v1/chat/completions',
  '/inference/v1/responses',
  '/inference/openai/v1/responses',
  '/zen/v1/responses'
]);
const activeRequests = new Set();

/** Resolve the configured Bun executable without invoking a shell. */
export function resolveBunPath(customPath) {
  if (typeof customPath === 'string' && customPath.trim() !== '') {
    const value = customPath.trim();
    if (existsSync(value)) return value;
    throw new Error(`Configured bunPath does not exist: ${value}`);
  }

  const exeName = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const candidates = [
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', 'bun', 'bin', 'bun.exe') : null,
    join(homedir(), '.bun', 'bin', exeName),
    process.platform === 'win32' ? 'C:\\tools\\bun.exe' : '/usr/local/bin/bun',
    process.platform === 'win32' ? null : '/usr/bin/bun'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Scan PATH for verified absolute directories only (never relative CWD)
  const pathDirs = (process.env.PATH || '').split(delimiter);
  for (const dir of pathDirs) {
    if (dir && isAbsolute(dir)) {
      const candidate = join(dir, exeName);
      if (existsSync(candidate)) return candidate;
    }
  }

  throw new Error('Unable to locate a verified Bun executable. Please specify bunPath in settings.');
}

/** A Bun executable that can actually be spawned. Empty when none is installed. */
export function installedBunPath(customPath) {
  try {
    const resolved = resolveBunPath(customPath);
    return resolved && existsSync(resolved) ? resolved : '';
  } catch {
    return '';
  }
}

let lastInference = null;
let bunReportCache = null;

/** Remember the latest inference shape. Never store credentials or message text. */
export function noteInference(record) {
  lastInference = { ...record, at: Date.now() };
}

export function lastInferenceReport() {
  return lastInference;
}

/** Detect the Bun runtime this plugin can spawn. Cached briefly for the settings page. */
export function describeBunEnvironment(customPath, { refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && bunReportCache && bunReportCache.customPath === (customPath || '') && now - bunReportCache.at < 30_000) {
    return bunReportCache.value;
  }
  const path = installedBunPath(customPath);
  let version = '';
  let usable = false;
  if (path) {
    try {
      const result = spawnSync(path, ['--version'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
      version = String(result.stdout || '').trim();
      usable = result.status === 0 && version.length > 0;
    } catch {
      usable = false;
    }
  }
  const value = { installed: Boolean(path), path, version, usable };
  bunReportCache = { at: now, customPath: customPath || '', value };
  return value;
}

/** Exact-origin, exact-path allowlist for inference only. */
export function isEligibleInferenceUrl(input) {
  try {
    const url = new URL(input);
    return url.origin === 'https://opencode.ai'
      && !url.username && !url.password && !url.search && !url.hash
      && INFERENCE_PATHS.has(url.pathname);
  } catch {
    return false;
  }
}

/** Fields observed in the installed OpenCode 2.0.32 client. Not its prompt. */
export function environmentBlock(platform = process.platform) {
  let directory = '.';
  try { directory = process.cwd() || '.'; } catch { /* keep relative fallback */ }
  let git = 'no';
  try { if (existsSync(join(directory, '.git'))) git = 'yes'; } catch { /* not a git checkout */ }
  let temp = 'the process temporary directory';
  try { temp = tmpdir() || temp; } catch { /* keep generic label */ }
  return [
    '<env>',
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${directory}`,
    `  Is directory a git repo: ${git}`,
    `  Platform: ${platform}`,
    `  Prefer ${temp} over generic system temporary directories`,
    '</env>'
  ].join('\n');
}

const OFFICIAL_PREAMBLE_TEXT = "You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.\n\n# Harness\n- Responses are rendered as GitHub-flavored Markdown.\n- `<system-reminder>` blocks are harness instructions, not user-authored content. Read and follow them.\n- Prefer parallelizing independent tool calls.\n- Use the edit tool for targeted changes to existing text files.\n- Use the write tool to create files or completely replace their content.\n\n# Communication\n- Use clear file paths when referring to files.\n- Keep responses clear and concise, and avoid unnecessary technical jargon.\n\n# Working in codebases\n- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.\n- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.";

const FALLBACK_CODEMODE_BLOB = JSON.stringify({
  total: 8,
  shown: 8,
  namespaces: [
    {
      name: "opencode",
      description: "Tools for managing OpenCode itself, such as working with sessions and worktrees, searching the available models, and reading MCP resources.",
      count: 8,
      entries: [
        { path: "opencode.list_mcp_resources", line: "  - tools.opencode.list_mcp_resources(): Promise<unknown>" },
        { path: "opencode.read_mcp_resource", line: "  - tools.opencode.read_mcp_resource(): Promise<unknown>" },
        { path: "opencode.models", line: "  - tools.opencode.models(): Promise<unknown>" },
        { path: "opencode.session_status", line: "  - tools.opencode.session_status(): Promise<unknown>" }
      ]
    }
  ]
});

function loadLocalCodeModeBlob() {
  try {
    const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
    if (!existsSync(dbPath)) return null;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM instruction_blob WHERE value LIKE '%\"name\":\"opencode\"%' LIMIT 1").get();
    db.close();
    return row?.value || null;
  } catch {
    return null;
  }
}

/** Assembles the authentic official system preamble required by upstream WAF verification. */
export function officialSystemPreamble(platform = process.platform) {
  const dateStr = `Today's date: ${new Date().toDateString()}`;
  const env = environmentBlock(platform);
  const codeMode = loadLocalCodeModeBlob() || FALLBACK_CODEMODE_BLOB;
  return [
    OFFICIAL_PREAMBLE_TEXT,
    dateStr,
    env,
    `Code Mode:\n${codeMode}`
  ].join('\n\n');
}

/** Add the installed client's environment block without mutating DSH tools. */
export function environmentPayload(bodyText, platform = process.platform) {
  let payload;
  try { payload = JSON.parse(bodyText); } catch { return bodyText; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return bodyText;

  const block = officialSystemPreamble(platform);

  if (Array.isArray(payload.messages)) {
    const messages = payload.messages;
    const system = messages.filter((message) => message?.role === 'system' || message?.role === 'developer');
    const text = system.map((message) => typeof message.content === 'string'
      ? message.content : JSON.stringify(message.content)).join('\n');
    if (!/<env>[\s\S]*?<\/env>/.test(text)) {
      const existing = messages.find((message) => message?.role === 'system' && typeof message.content === 'string');
      if (existing) {
        existing.content = `${block}\n\n${existing.content}`;
      } else {
        messages.unshift({ role: 'system', content: block });
      }
    }
  } else if (Array.isArray(payload.input)) {
    const instructions = typeof payload.instructions === 'string' ? payload.instructions : '';
    if (!/<env>[\s\S]*?<\/env>/.test(instructions)) {
      payload.instructions = `${block}\n\n${instructions}`;
    }
  }
  return JSON.stringify(payload);
}

/** Prepare the exact safe anonymous request used by the Bun worker. */
export async function prepareBunRequest(input, init = {}, options = {}) {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const url = new URL(isRequest ? input.url : String(input));
  if (!isEligibleInferenceUrl(url.href)) {
    throw new Error(`Bun transport refused non-inference destination: ${url.origin}${url.pathname}`);
  }
  if (url.pathname === '/inference/v1/chat/completions' || url.pathname === '/zen/v1/chat/completions') {
    url.pathname = '/inference/openai/v1/chat/completions';
  }

  const method = String(init.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
  if (method !== 'POST') throw new Error('Bun transport accepts inference POST requests only');
  const version = options.clientVersion || '2.0.32';
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Invalid bunTransport.clientVersion');
  }

  const headers = new Headers(init.headers ?? (isRequest ? input.headers : undefined));
  if (options.anonymous === true) {
    // Anonymous lane: deliberately drop the personal credential so no account
    // token leaves the machine. The upstream accepts the public placeholder.
    headers.set('authorization', 'Bearer public');
  } else if (!/^Bearer \S+$/i.test(headers.get('authorization') || '')) {
    // Keep a caller-supplied Bearer credential. The installed client is signed in
    // and does not hard-code Bearer public. Fall back only when none was given.
    headers.set('authorization', 'Bearer public');
  }
  headers.set('user-agent', `opencode/latest/${version}/cli`);
  const names = [];
  headers.forEach((_value, name) => names.push(name));
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-stainless-')
      || ['cookie', 'host', 'content-length', 'connection', 'x-opencode-request'].includes(lower)) {
      headers.delete(name);
    }
  }
  if (!headers.has('x-opencode-project') || headers.get('x-opencode-project') === 'global') {
    headers.set('x-opencode-project', stableProjectId());
  }

  let body = '';
  const sourceBody = init.body;
  if (typeof sourceBody === 'string') body = sourceBody;
  else if (sourceBody instanceof Uint8Array) body = Buffer.from(sourceBody).toString('utf8');
  else if (sourceBody !== undefined && sourceBody !== null) body = String(sourceBody);
  else if (isRequest) body = await input.text();
  const preparedBody = environmentPayload(body);
  const headerPairs = [];
  headers.forEach((value, name) => headerPairs.push([name, value]));
  return { url: url.href, headers: headerPairs, body: preparedBody };
}

/** Reap active Bun children when DSH disposes this provider. */
export function disposeBunTransport() {
  for (const stop of [...activeRequests]) stop(new Error('OpenCode Bun transport disposed'));
}

/**
 * Fetch-compatible Bun subprocess relay. Preserves upstream HTTP status,
 * headers and streaming body; spawn failures become ordinary transport errors.
 */
export async function executeBunFetch(input, init = {}, options = {}) {
  const request = await prepareBunRequest(input, init, options);
  const bunExe = resolveBunPath(options.bunPath);
  const workerPath = typeof options.workerPath === 'string' && options.workerPath.trim()
    ? options.workerPath.trim() : WORKER_PATH;
  let child;
  try {
    const userAgent = request.headers.find(([name]) => name.toLowerCase() === 'user-agent')?.[1]
      || 'opencode/latest/2.0.32/cli';
    child = spawn(bunExe, [`--user-agent=${userAgent}`, '--use-system-ca', workerPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    throw new Error(`Unable to start Bun subprocess (${bunExe}): ${error?.message ?? error}`);
  }
  child.stderr.resume();
  child.stdin.on('error', () => {});

  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const signal = init.signal ?? (isRequest ? input.signal : null);
  let terminalError = null;
  let cleaned = false;
  let timeout = null;
  let exitCode = null;
  let childError = null;
  let resolveExit;
  const childExited = new Promise((resolve) => { resolveExit = resolve; });
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch { /* already gone */ }
    }
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (timeout) clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
    activeRequests.delete(stop);
    kill();
  };
  const stop = (error) => {
    if (!terminalError) terminalError = error instanceof Error ? error : new Error(String(error));
    if (timeout) clearTimeout(timeout);
    kill();
  };
  const onAbort = () => stop(signal.reason ?? new Error('Request aborted'));
  const armTimeout = (ms, phase) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => stop(new Error(`Bun transport ${phase} timeout after ${ms} ms`)), ms);
    timeout.unref?.();
  };
  child.on('error', (error) => {
    childError = error;
    resolveExit(-1);
    stop(new Error(`Unable to start Bun subprocess (${bunExe}): ${error.message}`));
  });
  child.once('exit', (code) => { exitCode = code; resolveExit(code); });
  activeRequests.add(stop);

  if (signal) {
    if (signal.aborted) {
      stop(signal.reason ?? new Error('Request aborted'));
      cleanup();
      throw terminalError;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const headerTimeoutMs = options.headerTimeoutMs ?? options.timeoutMs ?? 30_000;
  const bodyIdleMs = options.bodyIdleMs ?? 120_000;
  armTimeout(headerTimeoutMs, 'response-header');
  child.stdin.end(JSON.stringify(request));

  const iterator = child.stdout[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  let metadata = null;
  try {
    while (!metadata) {
      const next = await iterator.next();
      if (terminalError) throw terminalError;
      if (next.done) {
        const code = exitCode ?? await childExited;
        if (terminalError) throw terminalError;
        if (childError) throw new Error(`Bun worker failed before response headers: ${childError.message}`);
        throw new Error(`Bun worker ended before response headers (exit ${code}); check bunPath: ${bunExe}`);
      }
      pending = Buffer.concat([pending, next.value]);
      const newline = pending.indexOf(10);
      if (newline >= 0) {
        if (newline > 65_536) throw new Error('Bun transport response headers are too large');
        metadata = JSON.parse(pending.subarray(0, newline).toString('utf8'));
        pending = pending.subarray(newline + 1);
      } else if (pending.length > 65_536) {
        throw new Error('Invalid Bun transport response headers');
      }
    }

    if (metadata?.error) throw new Error(`Bun worker rejected request: ${metadata.error}`);
    if (!Number.isInteger(metadata?.status) || metadata.status < 200 || metadata.status > 599) {
      throw new Error('Invalid Bun transport response status');
    }
    armTimeout(bodyIdleMs, 'body-idle');
    const stream = new ReadableStream({
      pull: async (controller) => {
        try {
          if (terminalError) throw terminalError;
          if (pending.length) {
            controller.enqueue(new Uint8Array(pending));
            pending = Buffer.alloc(0);
            armTimeout(bodyIdleMs, 'body-idle');
            return;
          }
          const next = await iterator.next();
          if (terminalError) throw terminalError;
          if (next.done) {
            const code = exitCode ?? await childExited;
            if (terminalError) throw terminalError;
            if (childError) throw new Error(`Bun worker stream failed: ${childError.message}`);
            if (code !== 0) throw new Error(`Bun worker stream ended unexpectedly (exit ${code})`);
            controller.close();
            cleanup();
          } else {
            controller.enqueue(new Uint8Array(next.value));
            armTimeout(bodyIdleMs, 'body-idle');
          }
        } catch (error) {
          controller.error(error);
          cleanup();
        }
      },
      cancel: () => cleanup()
    });
    return new Response(stream, { status: metadata.status, statusText: metadata.statusText, headers: metadata.headers });
  } catch (error) {
    cleanup();
    throw error;
  }
}
