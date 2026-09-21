import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { loginAntigravity, refreshAntigravityToken, getApiKey, resolveCredentials } from "./auth.ts";
import { DEFAULT_ENDPOINT, PROVIDER_ID } from "./protocol.ts";
import { createModelCatalog } from "./model-catalog.ts";
import { createQuotaStatus } from "./quota-status.ts";
import { streamAntigravity } from "./stream.ts";
import { completeSubcommands, runAntigravitySubcommand } from "./commands.ts";
import { performWebSearch } from "./search.ts";

export { PROVIDER_ID };
export const PROVIDER_NAME = "Antigravity";

export default function (pi: ExtensionAPI): void {
  const quotaStatus = createQuotaStatus();
  // The one deep Model Catalog seam for this extension: handles Pi refreshModels,
  // Model Plan resolution for streaming, and CLI formatting for subcommands.
  const catalog = createModelCatalog();

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: "antigravity-api",
    models: [], // Purely dynamic provider per Pi SDK architecture
    oauth: {
      name: PROVIDER_NAME,
      isSubscription: true,
      login: loginAntigravity,
      refreshToken: refreshAntigravityToken,
      getApiKey,
    },
    streamSimple: (model, context, options) => streamAntigravity(model, context, options, catalog),
    refreshModels: async (context) => catalog.refresh(context),
  });

  pi.registerCommand("antigravity", {
    description: "Antigravity quota, models and settings",
    getArgumentCompletions: (prefix) => completeSubcommands(prefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await runAntigravitySubcommand(args, ctx, quotaStatus, catalog);
    },
  });

  if (typeof pi.registerTool === "function") {
    pi.registerTool({
      name: "antigravity_websearch",
      label: "Antigravity Web Search",
      description:
        "Performs a web search for a given query. Returns a summary of relevant information along with URL citations.",
      promptSnippet: "Search the web using Google Search Grounding with source citations",
      promptGuidelines: [
        "Use antigravity_websearch when you need real-time web search, latest documentation, or up-to-date facts with verified citations.",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "The search query string to look up on the web." }),
        domain: Type.Optional(
          Type.String({
            description: "Optional domain to recommend the search prioritize (e.g. 'github.com', 'developer.mozilla.org').",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const creds = await resolveCredentials(ctx);
        if (!creds) {
          return {
            content: [{ type: "text", text: "Error: Not logged in. Run /login antigravity first." }],
            details: { error: "not_logged_in" },
          };
        }
        try {
          const result = await performWebSearch(creds, {
            query: params.query,
            domain: params.domain,
            signal,
          });
          return {
            content: [{ type: "text", text: result.formattedOutput }],
            details: {
              sources: result.sources,
              queries: result.queries,
            },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Search failed: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    });
  }

  // Footer quota slot: paint cached text instantly, refresh in background.
  pi.on("session_start", async (_event, ctx) => {
    await quotaStatus.refreshAndPaint(ctx);
  });

  // Model switch changes which Quota Pool backs the footer — repaint instantly,
  // then fill in fresh text when switching (back) to an Antigravity model.
  pi.on("model_select", async (event, ctx) => {
    const modelCtx = {
      ui: ctx.ui,
      modelRegistry: ctx.modelRegistry,
      model: event.model || ctx.model,
    };
    await quotaStatus.refreshAndPaint(modelCtx);
  });

  // Turn settled: refresh only when the throttle window expired.
  pi.on("agent_settled", async (_event, ctx) => {
    await quotaStatus.refreshAndPaint(ctx);
  });
}
