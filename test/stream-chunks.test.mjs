/**
 * Offline regression test for the SSE -> StreamChunk parser.
 *
 * Reproduces the exact upstream shape that crashed a live session: reasoning
 * deltas, text deltas, then a tool call whose first delta carries no `id`,
 * with upstream `tool_calls[].index = 0` while the tool block is DSH block
 * index 2. The old parser reused the upstream index as the block index, so the
 * tool-call block overwrote the reasoning block and its terminal `block-end`
 * carried a block whose `id`/`name`/`arguments` were `undefined` — the value
 * `session.append('tool/call')` rejects as non-JSON-serializable data.
 */
import { mapFinishReason, parseOpenAiSseStream } from '../lib/stream.js';

/** Minimal stand-in for DSH's BlockAssembler (same rules, same validation). */
class BlockAssembler {
  constructor() {
    this.partials = new Map();
    this.order = [];
    this.usage = undefined;
    this.finish = undefined;
    this.replayState = undefined;
  }
  push(chunk) {
    switch (chunk.type) {
      case 'block-start':
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index);
          this.partials.set(chunk.index, { blockType: chunk.blockType, text: '', toolCallArguments: '' });
        }
        return;
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning');
        if (partial.block) return;
        partial.text += chunk.text;
        return;
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call');
        if (partial.block) return;
        partial.toolCallId = chunk.id;
        if (chunk.name) partial.toolCallName = chunk.name;
        partial.toolCallArguments += chunk.argumentsDelta;
        return;
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type);
        if (partial.block) return;
        partial.block = chunk.block;
        return;
      }
      case 'usage':
        this.usage = chunk.usage;
        return;
      case 'finish':
        this.finish = chunk.reason;
        this.replayState = chunk.replayState;
        return;
      default:
        throw new Error(`unknown chunk type ${chunk.type}`);
    }
  }
  ensure(index, blockType) {
    let partial = this.partials.get(index);
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '' };
      this.partials.set(index, partial);
      this.order.push(index);
    }
    return partial;
  }
  blocks() {
    return this.order.map((index) => {
      const partial = this.partials.get(index);
      if (partial.block) return partial.block;
      switch (partial.blockType) {
        case 'text':
          return { type: 'text', text: partial.text };
        case 'reasoning':
          return { type: 'reasoning', text: partial.text };
        case 'tool-call':
          return {
            type: 'tool-call',
            id: partial.toolCallId ?? 'missing',
            name: partial.toolCallName ?? '',
            arguments: partial.toolCallArguments
          };
        default:
          throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`);
      }
    });
  }
}

/** Rejects any value DSH's `snapshotJsonValue` would refuse. */
function assertJsonLossless(value, path) {
  if (value === undefined) throw new Error(`${path}: undefined is not JSON-serializable`);
  if (typeof value === 'function' || typeof value === 'symbol') throw new Error(`${path}: not serializable`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${path}: non-finite number`);
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) assertJsonLossless(child, `${path}.${key}`);
}

function sseStream(events, chunkBytes = 64) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        controller.enqueue(bytes.subarray(offset, offset + chunkBytes));
      }
      controller.close();
    }
  });
}

async function collect(events) {
  const chunks = [];
  for await (const chunk of parseOpenAiSseStream(sseStream(events))) chunks.push(chunk);
  const assembler = new BlockAssembler();
  for (const chunk of chunks) assembler.push(chunk);
  return { chunks, assembler };
}

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  ok - ${message}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL - ${message}`);
}

console.log('SSE -> StreamChunk parser\n');

console.log('reasoning + text + unnamed tool call (the crash shape):');
{
  const { chunks, assembler } = await collect([
    { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '思考' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: '中' } }] },
    { choices: [{ index: 0, delta: { content: '執行。' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'pwsh', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', function: { arguments: '{"command"' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"echo hi"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46, completion_tokens_details: { reasoning_tokens: 56 } } }
  ]);

  const blocks = assembler.blocks();
  check(chunks.every((chunk) => JSON.stringify(chunk) !== undefined), 'every chunk is JSON-serializable');
  check(blocks.length === 3, 'three blocks assembled (reasoning, text, tool-call)');
  check(blocks[0]?.type === 'reasoning' && blocks[0]?.text === '思考中', 'reasoning block preserved and joined');
  check(blocks[1]?.type === 'text' && blocks[1]?.text === '執行。', 'text block preserved');
  check(blocks[2]?.type === 'tool-call', 'the tool call is block index 2, not an overwrite of index 0');
  check(blocks[2]?.id === 'call_abc', 'tool-call id survives the unnamed first delta');
  check(blocks[2]?.name === 'pwsh', 'tool-call name preserved');
  check(blocks[2]?.arguments === '{"command":"echo hi"}', 'tool-call arguments assembled across deltas');
  check(assembler.finish?.kind === 'tool-calls', 'finish reason is the discriminated object { kind: "tool-calls" }');
  check(assembler.usage?.inputTokens === 12 && assembler.usage?.outputTokens === 34, 'input/output usage mapped');
  check(assembler.usage?.reasoningTokens === 56, 'reasoning tokens mapped');
  check(assembler.replayState?.blocks?.length === 3, 'replayState blocks align with emitted blocks');

  // The exact event payload the agent loop writes for a tool call.
  let serializable = true;
  try {
    for (const block of blocks) {
      if (block.type !== 'tool-call') continue;
      assertJsonLossless({ turn: 1, step: 1, callId: block.id, name: block.name, arguments: block.arguments }, 'tool/call');
    }
  } catch (error) {
    serializable = false;
    console.error(`    ${error.message}`);
  }
  check(serializable, 'tool/call event data is losslessly JSON-serializable');
}

console.log('\ntext ends an open tool block (tool -> text -> tool keeps separate indexes):');
{
  const { assembler } = await collect([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read', arguments: '{"p":1}' } }] } }] },
    { choices: [{ index: 0, delta: { content: '先說明' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_b', function: { name: 'bash', arguments: '{"c":2}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  ]);
  const blocks = assembler.blocks();
  check(blocks.length === 3, `three blocks, got ${blocks.length}`);
  check(blocks[0]?.type === 'tool-call' && blocks[0]?.id === 'call_a', 'first tool call keeps its own block');
  check(blocks[1]?.type === 'text' && blocks[1]?.text === '先說明', 'text block between tool calls preserved');
  check(blocks[2]?.type === 'tool-call' && blocks[2]?.id === 'call_b', 'second tool call gets a fresh block');
}

console.log('\nplain text completion:');
{
  const { assembler } = await collect([
    { choices: [{ index: 0, delta: { content: 'PHOENIX' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  ]);
  const blocks = assembler.blocks();
  check(blocks.length === 1 && blocks[0]?.type === 'text' && blocks[0]?.text === 'PHOENIX', 'single text block');
  check(assembler.finish?.kind === 'stop', 'finish kind is stop');
}

console.log('\nfinish reason mapping:');
check(mapFinishReason('stop').kind === 'stop', 'stop');
check(mapFinishReason('tool_calls').kind === 'tool-calls', 'tool_calls -> tool-calls');
check(mapFinishReason('function_call').kind === 'tool-calls', 'function_call -> tool-calls');
check(mapFinishReason('length').kind === 'max-tokens', 'length -> max-tokens');
check(mapFinishReason(undefined).kind === 'stop', 'missing reason defaults to stop');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n✔ SSE parser regression test passed');
