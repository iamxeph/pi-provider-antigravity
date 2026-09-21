import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type TranscriptContext,
  calculateCost,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { requireCredentials } from "./auth.ts";
import { buildAntigravityRequestBody } from "./builder.ts";
import { DEFAULT_ENDPOINT, postAntigravityStream } from "./protocol.ts";
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
  stopReason: "pending" | "stop" | "toolUse" | "length" | "error";
  rawStopReason?: string;
  responseId?: string;
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
  rawStopReason?: string;
  openType: "text" | "thinking" | null;
  lastThoughtSignature?: string;
  responseId?: string;
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

/**
 * Whether the turn carried an answer: a non-empty text block or a tool call.
 *
 * Thinking is not an answer, and neither is an empty text block — those are
 * Thought Signature carriers (see `attachLoneSignature`), so `content.length`
 * cannot stand in for this test.
 */
function hasAnswerContent(content: ParsedBlock[]): boolean {
  return content.some((block) =>
    block.type === "toolCall" ? true : block.type === "text" ? block.text.trim().length > 0 : false,
  );
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

  const streamError = payload?.error ?? payload?.response?.error;
  if (streamError) {
    throw new Error(streamError.message ?? JSON.stringify(streamError));
  }

  const response = payload.response || payload;

  if (response.responseId && !state.responseId) {
    state.responseId = response.responseId;
  }

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
    state.rawStopReason = "MAX_TOKENS";
  } else if (candidate.finishReason === "STOP") {
    if (state.stopReason === "pending") {
      state.stopReason = "stop";
    }
  } else if (typeof candidate.finishReason === "string") {
    state.stopReason = "error";
    state.rawStopReason = candidate.finishReason;
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
      if (state.stopReason === "pending" || state.stopReason === "stop") {
        state.stopReason = "toolUse";
      }
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
    stopReason: "pending",
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
    rawStopReason: state.rawStopReason,
    responseId: state.responseId,
  };
}

const NON_OVERFLOW_PATTERN =
  /rate limit|too many requests|quota exceeded|resource_exhausted/i;
const CONTEXT_OVERFLOW_PATTERN =
  /(?:(?:input|prompt) token count.*exceeds|prompt (?:is )?too long)/i;

/**
 * Normalizes provider errors matching context overflow patterns by prefixing
 * with `context_length_exceeded:` so Pi's auto-compaction recovery triggers reliably.
 */
export function normalizeOverflowError(rawMessage: string): string {
  if (rawMessage.includes("context_length_exceeded")) return rawMessage;
  if (!NON_OVERFLOW_PATTERN.test(rawMessage) && CONTEXT_OVERFLOW_PATTERN.test(rawMessage)) {
    return `context_length_exceeded: ${rawMessage}`;
  }
  return rawMessage;
}

async function consumeAntigravityStream(
  streamBody: ReadableStream<Uint8Array>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<any>,
  signal?: AbortSignal,
): Promise<void> {
  const state: StreamParserState = {
    content: output.content,
    usage: { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 },
    stopReason: "pending",
    openType: null,
    buffer: "",
  };

  let lastTotalTokens = -1;

  const updateUsageAndCost = () => {
    output.usage.input = state.usage.input;
    output.usage.cacheRead = state.usage.cacheRead;
    output.usage.output = state.usage.output;
    output.usage.reasoning = state.usage.reasoning;
    output.usage.totalTokens = state.usage.total;

    if (state.usage.total !== lastTotalTokens) {
      lastTotalTokens = state.usage.total;
      if (model.cost) {
        calculateCost(model, output.usage);
      }
    }
    if (state.responseId) {
      output.responseId ||= state.responseId;
    }
    output.stopReason = state.stopReason;
    if (state.rawStopReason) {
      output.rawStopReason = state.rawStopReason;
    }
  };

  const dispatchEvent = (ev: StreamDeliveryEvent) => {
    updateUsageAndCost();
    stream.push({ ...ev, partial: output });
  };

  const reader = streamBody.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      const { done, value } = await reader.read();
      if (done) break;
      feedChunk(decoder.decode(value, { stream: true }), state, dispatchEvent);
    }
    finishStream(state, dispatchEvent);
    updateUsageAndCost();
  } finally {
    reader.releaseLock();
  }
}

/**
 * Stream Delivery Module: the deep module encapsulating wire byte streaming,
 * incremental SSE decoding, usage accounting, Thought Signature placement,
 * no-answer turn rejection, and direct Pi AssistantMessageEventStream dispatch.
 */
export function streamAntigravity(
  model: Model<any>,
  context: TranscriptContext,
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
      const maxOutputTokens = options?.maxTokens ?? model.maxTokens;

      let requestBody = buildAntigravityRequestBody({
        projectId,
        plan,
        context,
        sessionId: options?.sessionId,
        trajectoryId,
        maxOutputTokens,
        toolChoice: options?.toolChoice,
      });

      if (options?.onPayload) {
        const replacement = await options.onPayload(requestBody, model);
        if (replacement !== undefined) {
          requestBody = replacement as typeof requestBody;
        }
      }

      const endpoint = model.baseUrl || DEFAULT_ENDPOINT;
      const mergedHeaders: Record<string, string> = {};
      if (model.headers) {
        for (const [k, v] of Object.entries(model.headers)) {
          if (typeof v === "string") mergedHeaders[k] = v;
        }
      }
      if (options?.headers) {
        for (const [k, v] of Object.entries(options.headers)) {
          if (typeof v === "string") mergedHeaders[k] = v;
        }
      }

      const { response, stream: streamBody } = await postAntigravityStream({
        auth: token,
        endpoint,
        path: "v1internal:streamGenerateContent?alt=sse",
        headers: mergedHeaders,
        body: requestBody,
        signal: options?.signal,
      });

      if (options?.onResponse) {
        const resHeaders: Record<string, string> = {};
        response.headers.forEach((val, key) => {
          resHeaders[key] = val;
        });
        await options.onResponse({ status: response.status, headers: resHeaders }, model);
      }

      await consumeAntigravityStream(streamBody, output, stream, model, options?.signal);

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "pending") {
        throw new Error("Provider stream ended without a stop reason");
      }

      if (output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error(
          output.rawStopReason
            ? `Provider stopped with: ${output.rawStopReason}`
            : output.errorMessage || "An unknown error occurred",
        );
      }

      // A STOP turn carrying no answer (neither a tool call nor non-empty text)
      // answered nothing. Pi treats a `stop` turn with no tool calls as complete,
      // so the turn would end in silence — with any thinking block hidden behind
      // `hideThinkingBlock`.
      //
      // Two distinct pathologies produce this shape:
      // 1. Deliberated to the budget: the model spent its output budget on thinking
      //    (reasoning near maxOutputTokens) and had no room left for text. This is
      //    deterministic; re-requesting the exact same budget burns tokens again.
      //    The error is non-retryable and asks the user to lower the thinking level.
      // 2. Premature or empty STOP: the model ended abruptly with reasoning: 0
      //    or only brief deliberation (e.g. whitespace-only text). This is a transient
      //    sampling/stream glitch; re-requesting succeeds immediately.
      //    The error includes Pi's retryable pattern ("Please retry your request")
      //    so Pi automatically retries and recovers without manual user intervention.
      //
      // Both wordings avoid Pi's overflow patterns (`context_length_exceeded`,
      // `prompt is too long`) so they are never rerouted into compaction.
      if (output.stopReason === "stop" && !hasAnswerContent(output.content)) {
        const reasoningTokens = output.usage.reasoning ?? 0;
        const budgetThreshold = Math.max(1, Math.floor(maxOutputTokens * 0.9));
        const isDeliberatedToBudget = reasoningTokens >= budgetThreshold;

        if (isDeliberatedToBudget) {
          throw new Error(
            `Antigravity returned no answer: the turn ended after thinking only ` +
              `(reasoning ${reasoningTokens} of ${maxOutputTokens} max output tokens). ` +
              `Lower the thinking level or prompt again.`,
          );
        }

        throw new Error(
          `Antigravity returned an empty response with no answer ` +
            `(reasoning ${reasoningTokens} of ${maxOutputTokens} max output tokens). ` +
            `Please retry your request.`,
        );
      }

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
      const rawMessage = error instanceof Error ? error.message : String(error);
      output.errorMessage = normalizeOverflowError(rawMessage);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
