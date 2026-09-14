import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { requireCredentials } from "./auth.ts";
import { buildAntigravityRequestBody } from "./builder.ts";
import { postAntigravityStream } from "./protocol.ts";
import type { ModelCatalog } from "./model-catalog.ts";

/**
 * One assembled content block, Pi-spelled (TextContent | ThinkingContent |
 * ToolCall): thinking blocks carry thinkingSignature, text blocks carry
 * textSignature, toolCalls carry the wire-spelled thoughtSignature.
 */
export type ParsedBlock = TextContent | ThinkingContent | ToolCall;

export interface ParsedStreamResult {
  content: ParsedBlock[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    /**
     * Reasoning tokens, a subset of `output` (pi-ai Usage.reasoning). Captured
     * turns without a `thoughtsTokenCount` report 0, like pi-ai's own Google
     * adapter does for a missing count.
     */
    reasoning: number;
    total: number;
  };
  stopReason: "stop" | "toolUse" | "length" | "error";
}

export type StreamDeliveryEvent =
  | { type: "text_start" | "thinking_start"; contentIndex: number }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall };

interface StreamParserState {
  content: ParsedBlock[];
  usage: ParsedStreamResult["usage"];
  stopReason: ParsedStreamResult["stopReason"];
  openType: "text" | "thinking" | null;
  lastThoughtSignature?: string;
  buffer: string;
}

function attachLoneSignature(content: ParsedBlock[], lastThoughtSignature?: string): void {
  if (!lastThoughtSignature) return;
  // Not lone: a block already carries it. The wire sends
  // `{thoughtSignature, functionCall}`, whose signature the toolCall branch
  // attaches itself — pushing a carrier on top of that put an empty text
  // block on a turn that never had one.
  const attached = content.some((b) =>
    b.type === "thinking"
      ? Boolean(b.thinkingSignature)
      : b.type === "toolCall"
        ? Boolean(b.thoughtSignature)
        : b.type === "text"
          ? Boolean(b.textSignature)
          : false,
  );
  if (attached) return;

  const thinking = content.find((b): b is ThinkingContent => b.type === "thinking");
  if (thinking) {
    if (!thinking.thinkingSignature) thinking.thinkingSignature = lastThoughtSignature;
    return;
  }

  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block?.type === "text" && !block.textSignature) {
      block.textSignature = lastThoughtSignature;
      return;
    }
  }

  // The turn carried no block to hold it: keep the signature rather than
  // dropping it silently. The builder drops the empty part and replays the
  // signature on the next one, so this never puts an empty text on the wire.
  content.push({ type: "text", text: "", textSignature: lastThoughtSignature });
}

function closeOpenBlock(
  state: StreamParserState,
  onEvent?: (ev: StreamDeliveryEvent) => void,
): void {
  if (state.openType === null) return;
  const contentIndex = state.content.length - 1;
  const block = state.content[contentIndex];
  if (block?.type === "thinking") {
    onEvent?.({ type: "thinking_end", contentIndex, content: block.thinking });
  } else if (block?.type === "text") {
    onEvent?.({ type: "text_end", contentIndex, content: block.text });
  }
  state.openType = null;
}

function processLine(
  rawLine: string,
  state: StreamParserState,
  onEvent?: (ev: StreamDeliveryEvent) => void,
): void {
  const line = rawLine.trim();
  if (!line.startsWith("data:")) return;

  const dataStr = line.slice(5).trim();
  if (!dataStr || dataStr === "[DONE]") return;

  let payload: any;
  try {
    payload = JSON.parse(dataStr);
  } catch {
    return;
  }

  const response = payload.response || payload;

  // Usage metadata (promptTokenCount includes cached tokens per Google spec).
  // output counts thinking tokens too, mirroring the pi-ai Google adapter:
  // usageMetadata reports candidates and thoughts separately.
  if (response.usageMetadata) {
    const um = response.usageMetadata;
    const promptTokens = typeof um.promptTokenCount === "number" ? um.promptTokenCount : 0;
    const cacheRead = typeof um.cachedContentTokenCount === "number" ? um.cachedContentTokenCount : 0;
    state.usage.input = Math.max(0, promptTokens - cacheRead);
    state.usage.cacheRead = cacheRead;
    const candidates = typeof um.candidatesTokenCount === "number" ? um.candidatesTokenCount : 0;
    const thoughts = typeof um.thoughtsTokenCount === "number" ? um.thoughtsTokenCount : 0;
    state.usage.output = candidates + thoughts;
    state.usage.reasoning = thoughts;
    if (typeof um.totalTokenCount === "number") state.usage.total = um.totalTokenCount;
  }

  const candidate = response.candidates?.[0];
  if (!candidate) return;

  // Sticky: length/error/toolUse are never downgraded by a later STOP.
  // Mirrors pi-ai mapStopReasonString: only STOP is benign, MAX_TOKENS is
  // length, every other reason (SAFETY, RECITATION, BLOCKLIST, ...) is error.
  if (candidate.finishReason === "MAX_TOKENS") {
    state.stopReason = "length";
  } else if (typeof candidate.finishReason === "string" && candidate.finishReason !== "STOP") {
    state.stopReason = "error";
  }

  const parts = candidate.content?.parts || [];
  for (const part of parts) {
    if (part.thoughtSignature) {
      state.lastThoughtSignature = part.thoughtSignature;
    }

    if (part.thought) {
      const delta = part.text || "";
      // A part carrying no thinking text opens no block: the wire uses empty
      // thought parts as Thought Signature carriers, and an eager block would
      // outlive the turn as an empty thinking block, which the builder replays
      // as `{thought:true,text:""}` — a part the wire never sends. The signature is
      // already recorded above; close() keeps a carrier for it.
      if (delta === "" && state.openType !== "thinking") continue;
      if (state.openType !== "thinking") {
        closeOpenBlock(state, onEvent);
        state.content.push({ type: "thinking", thinking: "" });
        onEvent?.({ type: "thinking_start", contentIndex: state.content.length - 1 });
        state.openType = "thinking";
      }
      const block = state.content[state.content.length - 1];
      if (block?.type !== "thinking") continue;
      block.thinking += delta;
      if (part.thoughtSignature) {
        block.thinkingSignature = part.thoughtSignature;
      }
      onEvent?.({
        type: "thinking_delta",
        contentIndex: state.content.length - 1,
        delta,
      });
    } else if (part.functionCall) {
      closeOpenBlock(state, onEvent);
      state.stopReason = "toolUse";
      const block: ToolCall = {
        type: "toolCall",
        id: part.functionCall.id || `call_${state.content.length}`,
        name: part.functionCall.name || "",
        arguments: part.functionCall.args || {},
        thoughtSignature: part.thoughtSignature || state.lastThoughtSignature,
      };
      state.content.push(block);
      const contentIndex = state.content.length - 1;
      onEvent?.({ type: "toolcall_start", contentIndex });
      onEvent?.({
        type: "toolcall_delta",
        contentIndex,
        delta: JSON.stringify(block.arguments),
      });
      onEvent?.({ type: "toolcall_end", contentIndex, toolCall: block });
    } else if (part.text !== undefined) {
      // Same rule as the thinking branch: an empty text part is a Thought
      // Signature carrier (or a streamed artifact), not content, so it opens no
      // block. 7 of the 26 frozen responses and 91% of live antigravity turns
      // carried the empty block this used to create.
      if (part.text === "" && state.openType !== "text") continue;
      if (state.openType !== "text") {
        closeOpenBlock(state, onEvent);
        state.content.push({ type: "text", text: "" });
        onEvent?.({ type: "text_start", contentIndex: state.content.length - 1 });
        state.openType = "text";
      }
      const block = state.content[state.content.length - 1];
      if (block?.type !== "text") continue;
      block.text += part.text;
      onEvent?.({ type: "text_delta", contentIndex: state.content.length - 1, delta: part.text });
    }
  }
}

function feedChunk(
  chunk: string,
  state: StreamParserState,
  onEvent?: (ev: StreamDeliveryEvent) => void,
): void {
  state.buffer += chunk;
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() || "";
  for (const line of lines) {
    processLine(line, state, onEvent);
  }
}

function finishStream(
  state: StreamParserState,
  onEvent?: (ev: StreamDeliveryEvent) => void,
): void {
  if (state.buffer.trim() !== "") {
    processLine(state.buffer, state, onEvent);
  }
  state.buffer = "";
  closeOpenBlock(state, onEvent);
  attachLoneSignature(state.content, state.lastThoughtSignature);
}

/**
 * Pure parsing seam for whole or chunked SSE wire responses (fixtures, replay, tests).
 * Replaces the shallow createSseFeed adapter with direct response decoding.
 */
export function parseAntigravitySseResponse(
  rawSse: string | Iterable<string>,
  onEvent?: (ev: StreamDeliveryEvent) => void,
): ParsedStreamResult {
  const state: StreamParserState = {
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 },
    stopReason: "stop",
    openType: null,
    buffer: "",
  };

  if (typeof rawSse === "string") {
    feedChunk(rawSse, state, onEvent);
  } else {
    for (const chunk of rawSse) {
      feedChunk(chunk, state, onEvent);
    }
  }
  finishStream(state, onEvent);

  return {
    content: state.content,
    usage: state.usage,
    stopReason: state.stopReason,
  };
}

async function consumeAntigravityStream(
  streamBody: ReadableStream<Uint8Array>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  modelCost?: Model<any>["cost"],
): Promise<void> {
  const state: StreamParserState = {
    content: output.content,
    usage: { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 },
    stopReason: "stop",
    openType: null,
    buffer: "",
  };

  const updateUsageAndCost = () => {
    output.usage.input = state.usage.input;
    output.usage.cacheRead = state.usage.cacheRead;
    output.usage.output = state.usage.output;
    output.usage.reasoning = state.usage.reasoning;
    output.usage.totalTokens = state.usage.total;

    if (modelCost) {
      const inputCost = (output.usage.input * (modelCost.input || 0)) / 1_000_000;
      const outputCost = (output.usage.output * (modelCost.output || 0)) / 1_000_000;
      const cacheCost = (output.usage.cacheRead * (modelCost.cacheRead || 0)) / 1_000_000;
      output.usage.cost = {
        input: inputCost,
        output: outputCost,
        cacheRead: cacheCost,
        cacheWrite: 0,
        total: inputCost + outputCost + cacheCost,
      };
    }
    output.stopReason = state.stopReason;
  };

  const dispatchEvent = (ev: StreamDeliveryEvent) => {
    updateUsageAndCost();
    stream.push({ ...ev, partial: output });
  };

  const reader = streamBody.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    feedChunk(decoder.decode(value, { stream: true }), state, dispatchEvent);
  }

  finishStream(state, dispatchEvent);
  updateUsageAndCost();
}

/**
 * Stream Delivery Module: the deep module encapsulating wire byte streaming,
 * incremental SSE decoding, usage accounting, Thought Signature placement,
 * and direct Pi AssistantMessageEventStream dispatch.
 */
export function streamAntigravity(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  catalog: ModelCatalog,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      stream.push({ type: "start", partial: output });

      const { token, projectId } = await requireCredentials(options);

      const effort = options?.reasoning;
      // trajectoryId is provider-specific (absent from the SDK options
      // type), so read it via runtime-checked `in` narrowing instead of a cast.
      const trajectoryId =
        options && "trajectoryId" in options && typeof options.trajectoryId === "string"
          ? options.trajectoryId
          : undefined;
      const plan = catalog.resolvePlan(model.id, effort);

      const requestBody = buildAntigravityRequestBody({
        projectId,
        plan,
        context,
        sessionId: options?.sessionId,
        trajectoryId,
        maxOutputTokens: model.maxTokens,
        toolChoice: options?.toolChoice,
      });

      const streamBody = await postAntigravityStream({
        auth: token,
        path: "v1internal:streamGenerateContent?alt=sse",
        body: requestBody,
        signal: options?.signal,
      });

      await consumeAntigravityStream(streamBody, output, stream, model.cost);

      const doneReason: "stop" | "toolUse" | "length" =
        output.stopReason === "toolUse" || output.stopReason === "length"
          ? output.stopReason
          : "stop";

      stream.push({
        type: "done",
        reason: doneReason,
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
