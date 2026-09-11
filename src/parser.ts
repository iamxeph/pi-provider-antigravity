import type { TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";

/**
 * One assembled content block, Pi-spelled (TextContent | ThinkingContent |
 * ToolCall): thinking blocks carry thinkingSignature, text blocks carry
 * textSignature, toolCalls carry the wire-spelled thoughtSignature.
 * The import is type-only — the module stays dependency-free at runtime.
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

/**
 * Stream events in pi-ai spelling, minus the `partial` live helper the
 * caller attaches at push time. The feed is the single owner of the
 * response surface — block events, usage counts, and stopReason all come
 * out of here, so no caller translates between vocabularies. This union
 * must track AssistantMessageEvent (minus start/done/error); the push site
 * in stream.ts fails typecheck if the two drift apart.
 * The import stays type-only — the module is dependency-free at runtime.
 */
export type FeedStreamEvent =
  | { type: "text_start" | "thinking_start"; contentIndex: number }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall };


export interface SseFeedOutput {
  events: FeedStreamEvent[];
  usage: ParsedStreamResult["usage"];
  stopReason: ParsedStreamResult["stopReason"];
  /**
   * Live ref to the single assembled-block store owned by this feed.
   * Every event index is valid into it at the time the output is returned.
   * Read-only for callers: the feed is the sole writer. Signatures are
   * placement-complete only on close() (SDK spelling); no respelling downstream.
   */
  content: ParsedBlock[];
}

/**
 * Stateful incremental SSE reader: the single module that understands the
 * Antigravity Wire Fingerprint on the wire. Feed raw response chunks as they
 * arrive; line buffering, block accumulation, usage, stopReason, lone
 * Thought Signature attachment, event translation, and the single
 * assembled-block store all live here. Callers attach `partial` and push —
 * never a parallel array, never a second vocabulary. close() is the single
 * final surface: terminal events plus the fully assembled content.
 */
export function createSseFeed(): {
  feed(chunk: string): SseFeedOutput;
  close(): SseFeedOutput;
} {
  const content: ParsedBlock[] = [];
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    reasoning: 0,
    total: 0,
  };
  let stopReason: ParsedStreamResult["stopReason"] = "stop";
  let lastThoughtSignature: string | undefined;
  let buffer = "";
  let openType: "text" | "thinking" | null = null;

  const snapshot = (events: FeedStreamEvent[]): SseFeedOutput => ({
    events,
    usage: { ...usage },
    stopReason,
    content,
  });

  // Lone-signature turn: a Thought Signature that arrived detached from any
  // thinking part rides the first thinking block (SDK spelling), else the
  // last text block. Runs once at close, so the final content carries the
  // placement policy instead of every caller re-deriving it.
  const attachLoneSignature = (): void => {
    if (!lastThoughtSignature) return;
    // Not lone: a block already carries it. agy 1.2.0 sends
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
      // The thinking block wins (never a second carrier), and one that already
      // holds a signature keeps it.
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
  };

  const closeOpenBlock = (events: FeedStreamEvent[]): void => {
    if (openType === null) return;
    const contentIndex = content.length - 1;
    const block = content[contentIndex];
    if (block?.type === "thinking") {
      events.push({ type: "thinking_end", contentIndex, content: block.thinking });
    } else if (block?.type === "text") {
      events.push({ type: "text_end", contentIndex, content: block.text });
    }
    openType = null;
  };

  const processLine = (rawLine: string, events: FeedStreamEvent[]): void => {
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
      usage.input = Math.max(0, promptTokens - cacheRead);
      usage.cacheRead = cacheRead;
      const candidates = typeof um.candidatesTokenCount === "number" ? um.candidatesTokenCount : 0;
      const thoughts = typeof um.thoughtsTokenCount === "number" ? um.thoughtsTokenCount : 0;
      usage.output = candidates + thoughts;
      usage.reasoning = thoughts;
      if (typeof um.totalTokenCount === "number") usage.total = um.totalTokenCount;
    }

    const candidate = response.candidates?.[0];
    if (!candidate) return;

    // Sticky: length/error/toolUse are never downgraded by a later STOP.
    // Mirrors pi-ai mapStopReasonString: only STOP is benign, MAX_TOKENS is
    // length, every other reason (SAFETY, RECITATION, BLOCKLIST, ...) is error.
    if (candidate.finishReason === "MAX_TOKENS") {
      stopReason = "length";
    } else if (typeof candidate.finishReason === "string" && candidate.finishReason !== "STOP") {
      stopReason = "error";
    }

    const parts = candidate.content?.parts || [];
    for (const part of parts) {
      if (part.thoughtSignature) {
        lastThoughtSignature = part.thoughtSignature;
      }

      if (part.thought) {
        const delta = part.text || "";
        // A part carrying no thinking text opens no block: the wire uses empty
        // thought parts as Thought Signature carriers, and an eager block would
        // outlive the turn as an empty thinking block, which the builder replays
        // as `{thought:true,text:""}` — a part agy never sends. The signature is
        // already recorded above; close() keeps a carrier for it.
        if (delta === "" && openType !== "thinking") continue;
        if (openType !== "thinking") {
          closeOpenBlock(events);
          content.push({ type: "thinking", thinking: "" });
          events.push({ type: "thinking_start", contentIndex: content.length - 1 });
          openType = "thinking";
        }
        const block = content[content.length - 1];
        if (block?.type !== "thinking") continue;
        block.thinking += delta;
        if (part.thoughtSignature) {
          block.thinkingSignature = part.thoughtSignature;
        }
        events.push({
          type: "thinking_delta",
          contentIndex: content.length - 1,
          delta,
        });
      } else if (part.functionCall) {
        closeOpenBlock(events);
        stopReason = "toolUse";
        const block: ToolCall = {
          type: "toolCall",
          id: part.functionCall.id || `call_${content.length}`,
          name: part.functionCall.name || "",
          arguments: part.functionCall.args || {},
          thoughtSignature: part.thoughtSignature || lastThoughtSignature,
        };
        content.push(block);
        const contentIndex = content.length - 1;
        events.push({ type: "toolcall_start", contentIndex });
        events.push({
          type: "toolcall_delta",
          contentIndex,
          delta: JSON.stringify(block.arguments),
        });
        events.push({ type: "toolcall_end", contentIndex, toolCall: block });
      } else if (part.text !== undefined) {
        // Same rule as the thinking branch: an empty text part is a Thought
        // Signature carrier (or a streamed artifact), not content, so it opens no
        // block. 7 of the 26 frozen responses and 91% of live antigravity turns
        // carried the empty block this used to create.
        if (part.text === "" && openType !== "text") continue;
        if (openType !== "text") {
          closeOpenBlock(events);
          content.push({ type: "text", text: "" });
          events.push({ type: "text_start", contentIndex: content.length - 1 });
          openType = "text";
        }
        const block = content[content.length - 1];
        if (block?.type !== "text") continue;
        block.text += part.text;
        events.push({ type: "text_delta", contentIndex: content.length - 1, delta: part.text });
      }
    }
  };

  return {
    feed(chunk: string): SseFeedOutput {
      const events: FeedStreamEvent[] = [];
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const rawLine of lines) processLine(rawLine, events);
      return snapshot(events);
    },
    close(): SseFeedOutput {
      const events: FeedStreamEvent[] = [];
      if (buffer.trim() !== "") processLine(buffer, events);
      buffer = "";
      closeOpenBlock(events);
      attachLoneSignature();
      return snapshot(events);
    },
  };
}

