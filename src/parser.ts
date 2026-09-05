export interface ParsedBlock {
  type: "text" | "thinking" | "toolCall";
  text?: string;
  thinking?: string;
  thoughtSignature?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, any>;
}

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
  | { kind: "text_delta" | "thinking_delta"; index: number; delta: string; thoughtSignature?: string }
  | { kind: "text_end" | "thinking_end"; index: number; content: string }
  | { kind: "toolCall"; index: number; block: ParsedBlock };

export interface SseFeedOutput {
  events: SseBlockEvent[];
  usage: ParsedStreamResult["usage"];
  stopReason: ParsedStreamResult["stopReason"];
  thoughtSignature?: string;
}

/**
 * Stateful incremental SSE reader: the single module that understands the
 * Antigravity Wire Fingerprint on the wire. Feed raw response chunks as they
 * arrive; line buffering, block accumulation, usage, and stopReason all live
 * here. Callers only translate BlockEvents (thin adapters).
 */
export function createSseFeed(): {
  feed(chunk: string): SseFeedOutput;
  close(): SseFeedOutput;
  result(): ParsedStreamResult;
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
    ...(lastThoughtSignature ? { thoughtSignature: lastThoughtSignature } : {}),
  });

  const closeOpenBlock = (events: SseBlockEvent[]): void => {
    if (openType === null) return;
    const index = content.length - 1;
    const block = content[index];
    if (openType === "thinking") {
      events.push({ kind: "thinking_end", index, content: block.thinking || "" });
    } else {
      events.push({ kind: "text_end", index, content: block.text || "" });
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

    // Usage metadata (promptTokenCount includes cached tokens per Google spec)
    if (response.usageMetadata) {
      const um = response.usageMetadata;
      const promptTokens = typeof um.promptTokenCount === "number" ? um.promptTokenCount : 0;
      const cacheRead = typeof um.cachedContentTokenCount === "number" ? um.cachedContentTokenCount : 0;
      usage.input = Math.max(0, promptTokens - cacheRead);
      usage.cacheRead = cacheRead;
      if (typeof um.candidatesTokenCount === "number") usage.output = um.candidatesTokenCount;
      if (typeof um.totalTokenCount === "number") usage.total = um.totalTokenCount;
    }

    const candidate = response.candidates?.[0];
    if (!candidate) return;

    // Sticky: length/error/toolUse are never downgraded by a later STOP.
    if (candidate.finishReason === "MAX_TOKENS") {
      stopReason = "length";
    } else if (candidate.finishReason === "SAFETY") {
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
        const delta = part.text || "";
        block.thinking = (block.thinking || "") + delta;
        if (part.thoughtSignature) {
          block.thoughtSignature = part.thoughtSignature;
        }
        events.push({
          kind: "thinking_delta",
          index: content.length - 1,
          delta,
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        });
      } else if (part.functionCall) {
        closeOpenBlock(events);
        stopReason = "toolUse";
        const block: ParsedBlock = {
          type: "toolCall",
          id: part.functionCall.id || `call_${content.length}`,
          name: part.functionCall.name,
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
        block.text = (block.text || "") + part.text;
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
      return snapshot(events);
    },
    result(): ParsedStreamResult {
      return {
        content,
        usage: { ...usage },
        stopReason,
      };
    },
  };
}

export function parseAntigravitySseChunks(rawSse: string): ParsedStreamResult {
  const feed = createSseFeed();
  feed.feed(rawSse);
  feed.close();
  return feed.result();
}
