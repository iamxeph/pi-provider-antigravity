import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { parseStoredCredentials } from "./auth.ts";
import { createSseFeed, type SseBlockEvent, type SseFeedOutput } from "./parser.ts";
import { buildAntigravityRequestBody } from "./builder.ts";
import { postAntigravity } from "./protocol.ts";
import { resolveModelPlan, getCatalogSnapshot } from "./model-catalog.ts";

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

      const effort = options?.reasoning;
      // trajectoryId is provider-specific (absent from the SDK options
      // type), so read it via runtime-checked `in` narrowing instead of a cast.
      const trajectoryId =
        options && "trajectoryId" in options && typeof options.trajectoryId === "string"
          ? options.trajectoryId
          : undefined;
      const snapshot = getCatalogSnapshot();
      const plan = resolveModelPlan(model.id, effort, snapshot);

      const requestBody = buildAntigravityRequestBody({
        projectId,
        plan,
        context,
        sessionId: options?.sessionId,
        trajectoryId,
        maxOutputTokens: model.maxTokens,
        toolChoice: options?.toolChoice,
      });

      const res = await postAntigravity({
        token,
        path: "v1internal:streamGenerateContent?alt=sse",
        body: requestBody,
        signal: options?.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Antigravity stream failed (${res.status}): ${errText}`);
      }

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

      // translate is a pure event forwarder: blocks live in the feed's
      // single store (output.content re-points at the live ref below), so
      // event indices never skew and no parallel array exists to maintain.
      const translate = (events: SseBlockEvent[]) => {
        for (const ev of events) {
          if (ev.kind === "text_start" || ev.kind === "thinking_start") {
            const isThinking = ev.kind === "thinking_start";
            stream.push(
              isThinking
                ? { type: "thinking_start", contentIndex: ev.index, partial: output }
                : { type: "text_start", contentIndex: ev.index, partial: output }
            );
          } else if (ev.kind === "text_delta" || ev.kind === "thinking_delta") {
            stream.push(
              ev.kind === "text_delta"
                ? { type: "text_delta", contentIndex: ev.index, delta: ev.delta, partial: output }
                : { type: "thinking_delta", contentIndex: ev.index, delta: ev.delta, partial: output }
            );
          } else if (ev.kind === "text_end" || ev.kind === "thinking_end") {
            stream.push(
              ev.kind === "text_end"
                ? { type: "text_end", contentIndex: ev.index, content: ev.content, partial: output }
                : { type: "thinking_end", contentIndex: ev.index, content: ev.content, partial: output }
            );
          } else if (ev.kind === "toolCall") {
            const toolCall = {
              type: "toolCall" as const,
              id: ev.block.id,
              name: ev.block.name,
              arguments: ev.block.arguments || {},
              thoughtSignature: ev.block.thoughtSignature,
            };
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
              toolCall: toolCall,
              partial: output,
            });
          }
        }
      };

      // Single driver for one feed output: usage, stopReason, and event
      // translation flow through here. Content lives in the feed's store —
      // every output re-points at the live ref, so close() hands over the
      // final blocks with Thought Signatures already placed (no copy here).
      const applyFeedOutput = (fed: SseFeedOutput) => {
        output.content = fed.content;
        applyUsage(fed.usage);
        output.stopReason = fed.stopReason;
        translate(fed.events);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        applyFeedOutput(feed.feed(decoder.decode(value, { stream: true })));
      }

      applyFeedOutput(feed.close());

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
