/**
 * 輕量 Bun 轉發工作行程。
 *
 * 為什麼需要這個行程：
 *   OpenCode 上游對免費用量實施了基於執行階段 TLS / HTTP 特徵的指紋檢查，
 *   Node.js（Undici / node:http）發出的請求會被識別並直接返回 429 FreeUsageLimitError。
 *   Bun 的原生 fetch（基於 WebKit / BoringSSL）與官方客戶端完全一致，能夠正常通過檢驗。
 *
 * 設計原則：
 *   - 本行程無本機伺服器、無任何工具執行能力，純粹轉發單次記憶體中的 HTTP 請求。
 *   - stdin 接收 JSON: { url, headers, body }
 *   - stdout 第一行輸出 JSON: { status, statusText, headers }，後續位元組為伺服器原始 SSE 串流。
 *   - 限制目標網域僅能為 https://opencode.ai 且路徑必須在白名單內。
 */

const ALLOWED_PATHS = new Set([
  '/inference/openai/v1/chat/completions',
  '/inference/v1/chat/completions',
  '/zen/v1/chat/completions',
  '/inference/v1/responses',
  '/inference/openai/v1/responses',
  '/zen/v1/responses'
]);

let started = false;

try {
  const stdinText = await Bun.stdin.text();
  const input = JSON.parse(stdinText);
  const url = new URL(input.url);

  if (url.origin !== 'https://opencode.ai' || url.username || url.password || url.search || url.hash || !ALLOWED_PATHS.has(url.pathname)) {
    throw new Error(`不支援的目標位址: ${url.origin}${url.pathname}`);
  }

  const headers = new Headers(input.headers);
  if (!/^Bearer \S+$/i.test(headers.get('authorization') || '')) {
    throw new Error('Bun 傳輸只接受 Bearer 授權');
  }

  // 移除 Node 執行階段特定或可能干擾的標頭
  for (const name of ['cookie', 'host', 'content-length', 'connection']) {
    headers.delete(name);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: input.body,
    redirect: 'error'
  });

  const outputHeaders = [...response.headers].filter(([name]) =>
    !['set-cookie', 'content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name)
  );

  process.stdout.write(JSON.stringify({
    status: response.status,
    statusText: response.statusText,
    headers: outputHeaders
  }) + '\n');

  started = true;

  if (response.body) {
    for await (const chunk of response.body) {
      if (!process.stdout.write(chunk)) {
        await new Promise((resolve) => process.stdout.once('drain', resolve));
      }
    }
  }
} catch (error) {
  if (!started) {
    process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }) + '\n');
  }
  process.exitCode = 1;
}
