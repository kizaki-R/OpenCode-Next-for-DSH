/**
 * Maps OpenAI finish_reason to a DSH FinishReason object.
 *
 * DSH's `StreamChunk` finish variant carries `reason: FinishReason`, a
 * discriminated object (`{ kind: 'stop' | 'tool-calls' | 'max-tokens' | ... }`),
 * not a bare string. Returning a string leaves `finish.kind` undefined, so the
 * agent loop cannot recognize truncation or error terminals.
 */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' };
    case 'length':
      return { kind: 'max-tokens' };
    case 'content_filter':
      return { kind: 'stop' };
    case 'stop':
    default:
      return { kind: 'stop' };
  }
}

/**
 * Transforms an OpenAI Server-Sent Events (SSE) readable stream into DSH StreamChunks.
 *
 * Handles `reasoning_content`, `content`, `tool_calls`, `usage`, and block
 * boundaries. Upstream `tool_calls[].index` is mapped onto DSH block indexes
 * once, so a tool-call block opened at block index N keeps receiving deltas
 * even when reasoning/text blocks were streamed before it.
 */
export async function* parseOpenAiSseStream(responseBody, _options = {}) {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder('utf8');

  let buffer = '';

  /** Completed blocks, indexed by DSH block index (kept dense). */
  const blocks = [];

  /** Next DSH block index to hand out. */
  let nextBlockIndex = 0;

  /** The open text/reasoning block, if any. */
  let openTextBlock = null; // { index, type: 'text' | 'reasoning', text }

  /** Open tool-call blocks keyed by DSH block index. */
  const openToolBlocks = new Map(); // blockIndex -> { blockIndex, id, name, arguments, provisionalId }

  /** Upstream tool_calls[].index -> open tool-call block accumulator. */
  const toolBlocksByUpstreamIndex = new Map();

  let finishReason = null;
  let usage = null;

  /** Close the open text/reasoning block; returns the block-end event or null. */
  function closeTextBlock() {
    if (openTextBlock === null) return null;
    const { index, type, text } = openTextBlock;
    openTextBlock = null;
    const block = type === 'reasoning' ? { type: 'reasoning', text } : { type: 'text', text };
    blocks[index] = block;
    return { type: 'block-end', index, block };
  }

  /** Close every open tool-call block, in block order. */
  function closeToolBlocks() {
    const events = [];
    const accumulators = [...openToolBlocks.values()].sort((a, b) => a.blockIndex - b.blockIndex);
    openToolBlocks.clear();
    toolBlocksByUpstreamIndex.clear();
    for (const acc of accumulators) {
      const block = {
        type: 'tool-call',
        id: acc.id,
        name: acc.name,
        arguments: acc.arguments
      };
      blocks[acc.blockIndex] = block;
      events.push({ type: 'block-end', index: acc.blockIndex, block });
    }
    return events;
  }

  /** Close everything still open (used at stream end). */
  function closeAllBlocks() {
    const events = [];
    const textEvent = closeTextBlock();
    if (textEvent !== null) events.push(textEvent);
    events.push(...closeToolBlocks());
    return events;
  }

  /**
   * Switch to a text/reasoning block. Every open tool-call block is closed
   * first: text following a tool call means that call is finished, and a later
   * tool_calls delta reusing the same upstream index then opens a new block
   * instead of appending to the closed one.
   */
  function openTextStream(type) {
    const events = [];
    if (openTextBlock !== null && openTextBlock.type === type) return events;
    const textEvent = closeTextBlock();
    if (textEvent !== null) events.push(textEvent);
    events.push(...closeToolBlocks());
    const index = nextBlockIndex++;
    openTextBlock = { index, type, text: '' };
    events.push({ type: 'block-start', index, blockType: type });
    return events;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep the incomplete trailing line

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) continue; // SSE comments / keep-alive pings
        if (line === 'data: [DONE]') continue;
        if (!line.startsWith('data: ')) continue;

        const jsonStr = line.slice(6);
        let chunk;
        try {
          chunk = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        if (chunk.usage) {
          const inputTokens = chunk.usage.prompt_tokens || 0;
          const outputTokens = chunk.usage.completion_tokens || 0;
          const totalTokens = chunk.usage.total_tokens || inputTokens + outputTokens;
          const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens;
          if (_options.includeGoBilling === true) {
            const cost = typeof chunk.usage.cost === 'number' && Number.isFinite(chunk.usage.cost)
              ? chunk.usage.cost
              : null;
            const rawSource = chunk.usage.opencode?.billing_source;
            const billingSource = typeof rawSource === 'string' && rawSource.trim()
              ? rawSource.trim()
              : null;
            const rawAllowance = chunk.usage.opencode?.allowance;
            const allowance = typeof rawAllowance === 'number' && Number.isFinite(rawAllowance)
              ? rawAllowance
              : null;
            usage = {
              inputTokens,
              outputTokens,
              totalTokens,
              ...(typeof reasoningTokens === 'number' && reasoningTokens > 0 ? { reasoningTokens } : {}),
              cost,
              opencode: {
                billing_source: billingSource,
                allowance
              }
            };
          } else {
            usage = {
              inputTokens,
              outputTokens,
              totalTokens,
              ...(typeof reasoningTokens === 'number' && reasoningTokens > 0 ? { reasoningTokens } : {})
            };
          }
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        // 1. Reasoning content (thinking)
        const reasoningDelta = delta.reasoning_content || delta.reasoning || delta.thought;
        if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
          for (const event of openTextStream('reasoning')) yield event;
          openTextBlock.text += reasoningDelta;
          yield { type: 'reasoning-delta', index: openTextBlock.index, text: reasoningDelta };
        }

        // 2. Standard text content
        const contentDelta = delta.content;
        if (typeof contentDelta === 'string' && contentDelta.length > 0) {
          for (const event of openTextStream('text')) yield event;
          openTextBlock.text += contentDelta;
          yield { type: 'text-delta', index: openTextBlock.index, text: contentDelta };
        }

        // 3. Tool calls
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          for (const tc of delta.tool_calls) {
            const upstreamIndex = typeof tc?.index === 'number' ? tc.index : 0;
            let acc = toolBlocksByUpstreamIndex.get(upstreamIndex);

            if (acc === undefined) {
              // A tool call ends any open text/reasoning block, but never another
              // tool-call block: parallel tool calls stay open until the stream ends.
              const textEvent = closeTextBlock();
              if (textEvent !== null) yield textEvent;

              const blockIndex = nextBlockIndex++;
              const upstreamId = typeof tc?.id === 'string' && tc.id.length > 0 ? tc.id : '';
              acc = {
                blockIndex,
                id: upstreamId || `call_${blockIndex}`,
                provisionalId: upstreamId === '',
                name: '',
                arguments: ''
              };
              toolBlocksByUpstreamIndex.set(upstreamIndex, acc);
              openToolBlocks.set(blockIndex, acc);

              yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' };
            }

            if (typeof tc.id === 'string' && tc.id.length > 0 && acc.provisionalId) {
              acc.id = tc.id;
              acc.provisionalId = false;
            }
            if (typeof tc.function?.name === 'string' && tc.function.name.length > 0 && acc.name === '') {
              const rawName = tc.function.name;
              acc.name = typeof _options.resolveToolName === 'function'
                ? _options.resolveToolName(rawName)
                : rawName;
            }

            const argDelta = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
            if (argDelta.length > 0) acc.arguments += argDelta;

            yield {
              type: 'tool-call-delta',
              index: acc.blockIndex,
              id: acc.id,
              ...(acc.name !== '' ? { name: acc.name } : {}),
              argumentsDelta: argDelta
            };
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* the body may already be errored or closed */
    }
  }

  // Only a normally completed stream emits the terminal records; an aborted or
  // errored stream must surface its error instead of a synthetic finish.
  for (const event of closeAllBlocks()) yield event;

  if (usage !== null) yield { type: 'usage', usage };

  const hasToolCalls = blocks.some((block) => block?.type === 'tool-call');
  const terminalReason = finishReason !== null ? finishReason : hasToolCalls ? 'tool_calls' : 'stop';

  yield {
    type: 'finish',
    reason: mapFinishReason(terminalReason),
    replayState: { blocks }
  };
}
