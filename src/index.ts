import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loginAntigravity, refreshAntigravityToken, getApiKey } from "./auth.ts";
import { DEFAULT_ENDPOINT, PROVIDER_ID } from "./protocol.ts";
import { createModelCatalog } from "./model-catalog.ts";
import { createQuotaStatus } from "./quota-status.ts";
import { streamAntigravity } from "./stream.ts";
import { createAntigravityCommands } from "./commands.ts";
import { registerWebSearchTool } from "./search.ts";

export { PROVIDER_ID };
export const PROVIDER_NAME = "Antigravity";

export default function (pi: ExtensionAPI): void {
  const quotaStatus = createQuotaStatus();
  // The one deep Model Catalog seam for this extension: handles Pi refreshModels,
  // Model Plan resolution for streaming, and CLI formatting for subcommands.
  const catalog = createModelCatalog();
  const commands = createAntigravityCommands({ quotaStatus, catalog });

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
    getArgumentCompletions: (prefix) => commands.complete(prefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await commands.handle(args, ctx);
    },
  });

  registerWebSearchTool(pi);

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
