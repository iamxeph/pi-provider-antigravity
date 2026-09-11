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
import { createSseFeed, type SseFeedOutput } from "./parser.ts";
import { buildAntigravityRequestBody } from "./builder.ts";
import { postAntigravity } from "./protocol.ts";
import { resolveModelPlan, type CatalogStore } from "./model-catalog.ts";

export function streamAntigravity(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  store: CatalogStore
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
      const snapshot = store.generation().snapshot;
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

      // Single driver for one feed output: the feed owns block events,
      // usage counts, and stopReason. Content lives in the feed's store —
      // every output re-points at the live ref, so close() hands over the
      // final blocks with Thought Signatures already placed (no copy here).
      // The caller only attaches the `partial` live helper and pushes;
      // there is no translation seam. Cost math stays here: it needs
      // model.cost, which the feed never sees.
      const applyFeedOutput = (fed: SseFeedOutput) => {
        output.content = fed.content;
        output.usage.input = fed.usage.input;
        output.usage.cacheRead = fed.usage.cacheRead;
        output.usage.output = fed.usage.output;
        output.usage.reasoning = fed.usage.reasoning;
        output.usage.totalTokens = fed.usage.total;

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

        output.stopReason = fed.stopReason;
        for (const ev of fed.events) {
          stream.push({ ...ev, partial: output });
        }
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
