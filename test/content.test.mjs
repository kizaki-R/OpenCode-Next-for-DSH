/**
 * 離線回歸測試：驗證 DSH → OpenAI 線路的內容轉換不再掉資料。
 *
 * 這裡鎖住的每一條都曾經是「安靜壞掉」的缺陷——請求照樣成功、模型照樣回話，
 * 只是它看到的東西少了一塊：
 *
 * 1. system 提示詞被 JSON.stringify 成 `[{"type":"text",...}]`；
 * 2. tool 結果同樣被 JSON.stringify；
 * 3. user 訊息裡的圖片因為檢查不存在的 `block.source` 而整張消失；
 * 4. `options.temperature` / `options.stop` 沒進 body；
 * 5. `buildHeaders()` 無條件覆寫呼叫端的 requestId。
 */
import assert from 'node:assert/strict';
import {
  buildHeaders,
  collectImageRefs,
  convertMessages,
  fileHandleText,
  flattenText,
  offloadedImageText,
  textOnlyImageText
} from '../lib/client.js';
import { requestImageTarget } from '../lib/images.js';
import { DEFAULT_IMAGE_MAX_BYTES, DEFAULT_IMAGE_PIXEL_BUDGET } from '../lib/constants.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS - ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${error.message}`);
  }
}

function checkAsync(name, fn) {
  return fn().then(
    () => console.log(`  PASS - ${name}`),
    (error) => {
      failures++;
      console.error(`  FAIL - ${name}`);
      console.error(`         ${error.message}`);
    }
  );
}

/** 真實 DSH ImageAttachmentRef 形狀（**沒有** source / data / url 欄位）。 */
function imageRef(id = 'sha256:' + 'a'.repeat(64)) {
  return {
    attachmentId: id,
    mediaType: 'image/png',
    bytes: 12345,
    width: 1280,
    height: 800,
    name: 'shot.png'
  };
}

console.log('\n[dsh-opencode-oauth] content conversion regression\n');

// ---------------------------------------------------------------- 缺陷 1
console.log('system message');
check('system content is flattened text, not a JSON literal', () => {
  const out = convertMessages([
    { role: 'system', id: 'm0', content: [{ type: 'text', text: 'You are a coding agent.' }] },
    { role: 'user', id: 'm1', content: [{ type: 'text', text: 'hi' }] }
  ]);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'You are a coding agent.');
  assert.ok(!out[0].content.includes('"type"'), 'must not contain JSON keys');
});

check('options.system and the leading system message merge into one message', () => {
  const out = convertMessages(
    [
      { role: 'system', id: 'm0', content: [{ type: 'text', text: 'SECOND PART' }] },
      { role: 'user', id: 'm1', content: [{ type: 'text', text: 'hi' }] }
    ],
    { system: 'FIRST PART' }
  );
  const systems = out.filter((m) => m.role === 'system');
  assert.equal(systems.length, 1, 'exactly one system message');
  assert.equal(systems[0].content, 'FIRST PART\n\nSECOND PART');
});

check('a duplicated system prompt is not emitted twice', () => {
  const same = 'You are a coding agent.';
  const out = convertMessages(
    [{ role: 'system', id: 'm0', content: [{ type: 'text', text: same }] }],
    { system: same }
  );
  assert.equal(out.filter((m) => m.role === 'system').length, 1);
  assert.equal(out[0].content, same);
});

check('multi-block system text is joined, not stringified', () => {
  const out = convertMessages(
    [
      {
        role: 'system',
        id: 'm0',
        content: [
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' }
        ]
      }
    ],
    {}
  );
  assert.equal(out[0].content, 'line one\nline two');
});

check('flattenText ignores reasoning and tool-call blocks', () => {
  assert.equal(
    flattenText([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer' },
      { type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }
    ]),
    'answer'
  );
  assert.equal(flattenText('plain'), 'plain');
  assert.equal(flattenText(undefined), '');
});

check('a developer message is treated as a system message', () => {
  // `developer` 是 OpenAI 新版模型取代 system 的角色。先前它會掉出所有分支被
  // 靜默丟棄，整段指示憑空消失。
  const out = convertMessages([
    { role: 'developer', id: 'd1', content: [{ type: 'text', text: 'Be terse.' }] },
    { role: 'user', id: 'u1', content: [{ type: 'text', text: 'hi' }] }
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'Be terse.');
  assert.equal(out[1].role, 'user');
});

check('a leading developer message merges with options.system', () => {
  const out = convertMessages(
    [{ role: 'developer', id: 'd1', content: [{ type: 'text', text: 'PART TWO' }] }],
    { system: 'PART ONE' }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'PART ONE\n\nPART TWO');
});

check('a mid-conversation developer message keeps its position', () => {
  const out = convertMessages([
    { role: 'user', id: 'u1', content: [{ type: 'text', text: 'one' }] },
    { role: 'developer', id: 'd1', content: [{ type: 'text', text: 'now be brief' }] },
    { role: 'user', id: 'u2', content: [{ type: 'text', text: 'two' }] }
  ]);
  assert.deepEqual(
    out.map((m) => m.role),
    ['user', 'system', 'user'],
    'it must not be hoisted to the front or dropped'
  );
  assert.equal(out[1].content, 'now be brief');
});

// ---------------------------------------------------------------- 缺陷 2
console.log('\ntool results');
check('tool result content is flattened text, not a JSON literal', () => {
  const out = convertMessages([
    {
      role: 'tool',
      id: 'm1',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'a.txt' }]
    }
  ]);
  assert.equal(out[0].role, 'tool');
  assert.equal(out[0].tool_call_id, 'call_1');
  assert.equal(out[0].content, 'a.txt');
});

check('multi-block tool result joins its text blocks', () => {
  const out = convertMessages([
    {
      role: 'tool',
      id: 'm1',
      toolCallId: 'call_1',
      content: [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' }
      ]
    }
  ]);
  assert.equal(out[0].content, 'line1\nline2');
});

check('an image inside a tool result degrades to placeholder text', () => {
  const ref = imageRef();
  const out = convertMessages([
    {
      role: 'tool',
      id: 'm1',
      toolCallId: 'call_1',
      content: [
        { type: 'text', text: 'screenshot taken' },
        { type: 'image', attachment: ref }
      ]
    }
  ]);
  assert.match(out[0].content, /screenshot taken/);
  assert.ok(out[0].content.includes(textOnlyImageText(ref)), 'keeps the attachment identity');
});

// ---------------------------------------------------------------- 缺陷 3
console.log('\nimages');
check('a real DSH image block is emitted as image_url', () => {
  const ref = imageRef();
  const url = 'data:image/png;base64,AAAA';
  const out = convertMessages(
    [
      {
        role: 'user',
        id: 'm1',
        content: [{ type: 'text', text: 'what is this' }, { type: 'image', attachment: ref }]
      }
    ],
    { imageUrls: new Map([[ref.attachmentId, url]]) }
  );
  assert.equal(out[0].role, 'user');
  assert.ok(Array.isArray(out[0].content), 'mixed content stays an array');
  const image = out[0].content.find((p) => p.type === 'image_url');
  assert.ok(image, 'image part present');
  assert.equal(image.image_url.url, url);
});

check('an image with no resolvable bytes degrades instead of vanishing', () => {
  const ref = imageRef();
  const out = convertMessages([
    { role: 'user', id: 'm1', content: [{ type: 'image', attachment: ref }] }
  ]);
  assert.equal(out.length, 1, 'the message survives');
  assert.equal(out[0].content, textOnlyImageText(ref));
});

check('offloaded images become the offload placeholder', () => {
  const ref = imageRef();
  const out = convertMessages([
    { role: 'user', id: 'm1', content: [{ type: 'image', attachment: ref, offloaded: true }] }
  ]);
  assert.equal(out[0].content, offloadedImageText(ref));
});

check('a text-only route never receives image parts', () => {
  const ref = imageRef();
  const out = convertMessages(
    [{ role: 'user', id: 'm1', content: [{ type: 'image', attachment: ref }] }],
    { imageUrls: new Map([[ref.attachmentId, 'data:image/png;base64,AAAA']]), imageSupported: false }
  );
  assert.equal(out[0].content, textOnlyImageText(ref));
});

check('file blocks become a handle instead of disappearing', () => {
  const ref = { attachmentId: 'sha256:' + 'b'.repeat(64), mediaType: 'text/plain', bytes: 42, name: 'notes.txt' };
  const out = convertMessages([
    {
      role: 'user',
      id: 'm1',
      content: [{ type: 'text', text: 'read this' }, { type: 'file', attachment: ref }]
    }
  ]);
  assert.ok(out[0].content.some((p) => p.type === 'text' && p.text.includes('notes.txt')));
  assert.ok(fileHandleText(ref).includes('notes.txt'));
});

check('collectImageRefs dedupes by attachmentId and skips offloaded', () => {
  const a = imageRef('sha256:' + '1'.repeat(64));
  const b = imageRef('sha256:' + '2'.repeat(64));
  const refs = collectImageRefs([
    { role: 'user', id: 'm1', content: [{ type: 'image', attachment: a }] },
    { role: 'user', id: 'm2', content: [{ type: 'image', attachment: a }] },
    { role: 'user', id: 'm3', content: [{ type: 'image', attachment: b, offloaded: true }] }
  ]);
  assert.equal(refs.size, 1);
  assert.ok(refs.has(a.attachmentId));
});

// ---------------------------------------------------------------- 缺陷 5
console.log('\nheaders');
check('buildHeaders keeps the caller-supplied requestId', () => {
  const headers = buildHeaders('tok', 'ses_x', 'req_supplied', 'prj_x');
  assert.equal(headers['x-opencode-request'], 'req_supplied');
});

check('buildHeaders still mints one when the caller passes none', () => {
  const headers = buildHeaders('tok', 'ses_x', undefined, 'prj_x');
  assert.match(headers['x-opencode-request'], /^req_[0-9a-f]{16}$/);
});

check('the same session string maps to one stable session id', () => {
  const one = buildHeaders('tok', 'session-abc', 'r1', 'prj_x')['x-opencode-session'];
  const two = buildHeaders('tok', 'session-abc', 'r2', 'prj_x')['x-opencode-session'];
  assert.equal(one, two);
  assert.match(one, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

// ---------------------------------------------------------------- assistant 歷史
console.log('\nassistant history');
check('reasoning is replayed as reasoning_content', () => {
  const out = convertMessages([
    {
      role: 'assistant',
      id: 'm1',
      content: [
        { type: 'reasoning', text: 'let me think' },
        { type: 'text', text: 'ok' },
        { type: 'tool-call', id: 'call_1', name: 'grep', arguments: '{"q":"x"}' }
      ]
    }
  ]);
  assert.equal(out[0].reasoning_content, 'let me think');
  assert.equal(out[0].content, 'ok');
  assert.equal(out[0].tool_calls[0].id, 'call_1');
  assert.equal(out[0].tool_calls[0].function.arguments, '{"q":"x"}');
});

check('an assistant message with neither text nor tool calls is dropped', () => {
  const out = convertMessages([
    { role: 'assistant', id: 'm1', content: [{ type: 'reasoning', text: 'only thinking' }] }
  ]);
  assert.equal(out.length, 0);
});

check('an empty user message is dropped instead of sent as []', () => {
  const out = convertMessages([{ role: 'user', id: 'm1', content: [] }]);
  assert.equal(out.length, 0);
});

// ---------------------------------------------------------------- 圖片投影
console.log('\nimage projection');
check('a small image keeps its own dimensions', () => {
  const target = requestImageTarget({ width: 800, height: 600, bytes: 50000 }, 640000, 2097152);
  assert.deepEqual(target, { width: 800, height: 600, maxBytes: 2097152 });
});

check('an oversized image is scaled to fit the pixel budget', () => {
  const target = requestImageTarget({ width: 3840, height: 2160, bytes: 9e6 }, 640000, 2097152);
  assert.ok(target.width * target.height <= 640000, `got ${target.width}x${target.height}`);
  assert.ok(Math.abs(target.width / target.height - 3840 / 2160) < 0.01, 'aspect ratio preserved');
});

check('the projection is deterministic for the same input', () => {
  const ref = { width: 3000, height: 2000, bytes: 1000 };
  assert.deepEqual(
    requestImageTarget(ref, DEFAULT_IMAGE_PIXEL_BUDGET, DEFAULT_IMAGE_MAX_BYTES),
    requestImageTarget(ref, DEFAULT_IMAGE_PIXEL_BUDGET, DEFAULT_IMAGE_MAX_BYTES)
  );
});

check('an invalid reference yields no target', () => {
  assert.equal(requestImageTarget({ width: 0, height: 0 }, 640000, 2097152), undefined);
  assert.equal(requestImageTarget(undefined, 640000, 2097152), undefined);
});

// ---------------------------------------------------------------- 投影讀取
await checkAsync('resolveImageDataUrls builds data URIs from the attachment service', async () => {
  const { resolveImageDataUrls } = await import('../lib/images.js');
  const ref = imageRef();
  const service = {
    async readImageRequest(given, target) {
      assert.equal(given.attachmentId, ref.attachmentId);
      assert.equal(typeof target.width, 'number');
      return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/webp', width: target.width, height: target.height };
    }
  };
  const urls = await resolveImageDataUrls(new Map([[ref.attachmentId, ref]]), {
    attachments: service,
    pixelBudget: 640000,
    maxBytes: 2097152
  });
  assert.equal(urls.get(ref.attachmentId), 'data:image/webp;base64,AQID');
});

await checkAsync('a failing projection falls back to the original bytes', async () => {
  const { resolveImageDataUrls } = await import('../lib/images.js');
  const ref = imageRef();
  const service = {
    async readImageRequest() {
      const error = new Error('unsupported');
      error.code = 'ATTACHMENT_PROJECTION_UNSUPPORTED';
      throw error;
    },
    async readImage() {
      return { ref, data: new Uint8Array([9, 9]) };
    }
  };
  const urls = await resolveImageDataUrls(new Map([[ref.attachmentId, ref]]), {
    attachments: service,
    pixelBudget: 640000,
    maxBytes: 2097152
  });
  assert.equal(urls.get(ref.attachmentId), 'data:image/png;base64,CQk=');
});

await checkAsync('a missing attachment service degrades instead of throwing', async () => {
  const { resolveImageDataUrls } = await import('../lib/images.js');
  const ref = imageRef();
  const urls = await resolveImageDataUrls(new Map([[ref.attachmentId, ref]]), {});
  assert.equal(urls.size, 0);
});

console.log('');
if (failures > 0) {
  console.error(`❌ ${failures} content conversion check(s) failed`);
  process.exit(1);
}
console.log('✅ All content conversion checks passed');
