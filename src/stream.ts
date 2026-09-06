import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { parseStoredCredentials } from "./auth.ts";
import { createSseFeed, type SseBlockEvent } from "./parser.ts";
import { buildAntigravityRequestBody } from "./builder.ts";
import { buildAntigravityHeaders, DEFAULT_ENDPOINT, formatApiError } from "./protocol.ts";
import { resolveModelPlan, getCatalogSnapshot } from "./catalog.ts";

// Statuses worth retrying before the first byte arrives. Only non-ok
// responses are retried, never a mid-stream read.
const RETRYABLE_STREAM_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_STREAM_RETRIES = 2;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error("Antigravity stream aborted during retry backoff."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function postStreamWithRetry(url: string, body: string, token: string, signal?: AbortSignal): Promise<Response> {
  let status = 0;
  let errText = "";
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) {
      throw new Error("Antigravity stream aborted before the request completed.");
    }
    const res = await fetch(url, {
      method: "POST",
      headers: buildAntigravityHeaders(token),
      body,
      signal,
    });
    if (res.ok) return res;
    status = res.status;
    errText = await res.text();
    if (!RETRYABLE_STREAM_STATUS.has(status) || attempt >= MAX_STREAM_RETRIES) {
      throw new Error(`Antigravity stream failed ${formatApiError(status, errText)}`);
    }
    await abortableSleep(1000 * (attempt + 1), signal);
  }
}

export function streamAntigravity(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions
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

      const rawApiKey = options?.apiKey;
      if (!rawApiKey) {
        throw new Error("Missing Antigravity credentials. Run /login antigravity first.");
      }

      const { token, projectId } = parseStoredCredentials(rawApiKey);

      const effort =
        (options as any)?.reasoning ||
        (options as any)?.reasoningEffort ||
        (options as any)?.thinking;
      const snapshot = getCatalogSnapshot();
      const plan = resolveModelPlan(model.id, effort, snapshot);

      const requestBody = buildAntigravityRequestBody({
        projectId,
        plan,
        context,
        sessionId: (options as any)?.sessionId,
        trajectoryId: (options as any)?.trajectoryId,
        maxOutputTokens: model.maxTokens,
        toolChoice: (options as any)?.toolChoice,
      });

      const res = await postStreamWithRetry(
        `${DEFAULT_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
        JSON.stringify(requestBody),
        token,
        options?.signal
      );

      if (!res.body) {
        throw new Error("No response stream received from Antigravity.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const feed = createSseFeed();

      const applyUsage = (u: { input: number; output: number; cacheRead: number; total: number }) => {
        output.usage.input = u.input;
        output.usage.cacheRead = u.cacheRead;
        output.usage.output = u.output;
        output.usage.totalTokens = u.total;

        if (model.cost) {
          const c = model.cost;
          const inputCost = (output.usage.input * (c.input || 0)) / 1_000_000;
          const outputCost = (output.usage.output * (c.output || 0)) / 1_000_000;
          const cacheCost = (output.usage.cacheRead * (c.cacheRead || 0)) / 1_000_000;
          output.usage.cost = {
            input: inputCost,
            output: outputCost,
            cacheRead: cacheCost,
            cacheWrite: 0,
            total: inputCost + outputCost + cacheCost,
          };
        }
      };

      const applyStopReason = (r: "stop" | "toolUse" | "length" | "error") => {
        if (r === "stop") {
          if (output.stopReason === "pending") output.stopReason = "stop";
        } else {
          output.stopReason = r;
        }
      };

      const translate = (events: SseBlockEvent[]) => {
        for (const ev of events) {
          if (ev.kind === "text_start" || ev.kind === "thinking_start") {
            const isThinking = ev.kind === "thinking_start";
            output.content.push(
              isThinking ? ({ type: "thinking", thinking: "" } as any) : ({ type: "text", text: "" } as any)
            );
            stream.push(
              isThinking
                ? { type: "thinking_start", contentIndex: ev.index, partial: output }
                : { type: "text_start", contentIndex: ev.index, partial: output }
            );
          } else if (ev.kind === "text_delta" || ev.kind === "thinking_delta") {
            const block = output.content[ev.index] as any;
            if (ev.kind === "text_delta") {
              block.text += ev.delta;
              stream.push({ type: "text_delta", contentIndex: ev.index, delta: ev.delta, partial: output });
            } else {
              block.thinking += ev.delta;
              if (ev.thoughtSignature) block.thoughtSignature = ev.thoughtSignature;
              stream.push({ type: "thinking_delta", contentIndex: ev.index, delta: ev.delta, partial: output });
            }
          } else if (ev.kind === "text_end" || ev.kind === "thinking_end") {
            stream.push(
              ev.kind === "text_end"
                ? { type: "text_end", contentIndex: ev.index, content: ev.content, partial: output }
                : { type: "thinking_end", contentIndex: ev.index, content: ev.content, partial: output }
            );
          } else if (ev.kind === "toolCall") {
            const toolCall = {
              type: "toolCall" as const,
              id: ev.block.id || `call_${output.content.length}`,
              name: ev.block.name,
              arguments: ev.block.arguments || {},
              thoughtSignature: ev.block.thoughtSignature,
            };

            output.content.push(toolCall as any);

            stream.push({ type: "toolcall_start", contentIndex: ev.index, partial: output });
            stream.push({
              type: "toolcall_delta",
              contentIndex: ev.index,
              delta: JSON.stringify(toolCall.arguments),
              partial: output,
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: ev.index,
              toolCall: toolCall as any,
              partial: output,
            });
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const fed = feed.feed(decoder.decode(value, { stream: true }));
        applyUsage(fed.usage);
        applyStopReason(fed.stopReason);
        translate(fed.events);
      }

      const closing = feed.close();
      applyUsage(closing.usage);
      applyStopReason(closing.stopReason);
      translate(closing.events);

      if (closing.thoughtSignature) {
        const thinkingBlock = output.content.find((c: any) => c.type === "thinking") as any;
        if (thinkingBlock && !thinkingBlock.thoughtSignature) {
          thinkingBlock.thoughtSignature = closing.thoughtSignature;
        }
        (output as any).thoughtSignature = closing.thoughtSignature;
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
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
