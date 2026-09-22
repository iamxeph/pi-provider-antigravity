import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loginAntigravity, refreshAntigravityToken, getApiKey } from "./auth.ts";
import { DEFAULT_ENDPOINT, PROVIDER_ID, PROVIDER_NAME } from "./constants.ts";
import { createModelCatalog } from "./model-catalog.ts";
import { createQuotaStatus } from "./quota-status.ts";
import { streamAntigravity } from "./stream.ts";
import { createAntigravityCommands } from "./commands.ts";
import { registerWebSearchTool } from "./search.ts";

export { PROVIDER_ID, PROVIDER_NAME };

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
  quotaStatus.bind(pi);
}
