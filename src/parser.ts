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
    total: number;
  };
  stopReason: "stop" | "toolUse" | "length" | "error";
}

export type SseBlockEvent =
  | { kind: "text_start" | "thinking_start"; index: number }
  | { kind: "text_delta" | "thinking_delta"; index: number; delta: string; thinkingSignature?: string }
  | { kind: "text_end" | "thinking_end"; index: number; content: string }
  | { kind: "toolCall"; index: number; block: ToolCall };

export interface SseFeedOutput {
  events: SseBlockEvent[];
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
 * Thought Signature attachment, and the single assembled-block store all live
 * here. Callers translate BlockEvents into their own event vocabulary and read
 * blocks through the live content ref — never a parallel array. close() is
 * the single final surface: terminal events plus the fully assembled content.
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
    total: 0,
  };
  let stopReason: ParsedStreamResult["stopReason"] = "stop";
  let lastThoughtSignature: string | undefined;
  let buffer = "";
  let openType: "text" | "thinking" | null = null;

  const snapshot = (events: SseBlockEvent[]): SseFeedOutput => ({
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
    const thinking = content.find((b): b is ThinkingContent => b.type === "thinking");
    if (thinking && !thinking.thinkingSignature) {
      thinking.thinkingSignature = lastThoughtSignature;
    } else if (!thinking) {
      for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i];
        if (block?.type === "text" && !block.textSignature) {
          block.textSignature = lastThoughtSignature;
          break;
        }
      }
    }
  };

  const closeOpenBlock = (events: SseBlockEvent[]): void => {
    if (openType === null) return;
    const index = content.length - 1;
    const block = content[index];
    if (block?.type === "thinking") {
      events.push({ kind: "thinking_end", index, content: block.thinking });
    } else if (block?.type === "text") {
      events.push({ kind: "text_end", index, content: block.text });
    }
    openType = null;
  };

  const processLine = (rawLine: string, events: SseBlockEvent[]): void => {
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
        if (openType !== "thinking") {
          closeOpenBlock(events);
          content.push({ type: "thinking", thinking: "" });
          events.push({ kind: "thinking_start", index: content.length - 1 });
          openType = "thinking";
        }
        const block = content[content.length - 1];
        if (block?.type !== "thinking") continue;
        const delta = part.text || "";
        block.thinking += delta;
        if (part.thoughtSignature) {
          block.thinkingSignature = part.thoughtSignature;
        }
        events.push({
          kind: "thinking_delta",
          index: content.length - 1,
          delta,
          ...(part.thoughtSignature ? { thinkingSignature: part.thoughtSignature } : {}),
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
        events.push({ kind: "toolCall", index: content.length - 1, block });
      } else if (part.text !== undefined) {
        if (openType !== "text") {
          closeOpenBlock(events);
          content.push({ type: "text", text: "" });
          events.push({ kind: "text_start", index: content.length - 1 });
          openType = "text";
        }
        const block = content[content.length - 1];
        if (block?.type !== "text") continue;
        block.text += part.text;
        events.push({ kind: "text_delta", index: content.length - 1, delta: part.text });
      }
    }
  };

  return {
    feed(chunk: string): SseFeedOutput {
      const events: SseBlockEvent[] = [];
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const rawLine of lines) processLine(rawLine, events);
      return snapshot(events);
    },
    close(): SseFeedOutput {
      const events: SseBlockEvent[] = [];
      if (buffer.trim() !== "") processLine(buffer, events);
      buffer = "";
      closeOpenBlock(events);
      attachLoneSignature();
      return snapshot(events);
    },
  };
}

