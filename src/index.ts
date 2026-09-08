import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loginAntigravity, refreshAntigravityToken, getApiKey } from "./auth.ts";
import { DEFAULT_ENDPOINT, PROVIDER_ID } from "./protocol.ts";
import { refreshCatalog } from "./catalog-refresh.ts";
import { QuotaStatusCoordinator } from "./usage-status.ts";
import { fileQuotaStatusStore } from "./settings.ts";
import { streamAntigravity } from "./stream.ts";
import { runAntigravitySubcommand } from "./commands.ts";

export { PROVIDER_ID };
export const PROVIDER_NAME = "Antigravity";

const SUBCOMMANDS = [
  { name: "usage", description: "Show 5h and weekly quota pool limits" },
  { name: "models", description: "List recommended models with context window and remaining quota" },
  { name: "refresh", description: "Force refresh model catalog" },
  { name: "settings", description: "Pick provider settings: Enter cycles values" },
  { name: "login", description: "Run /login antigravity" },
];

export default function (pi: ExtensionAPI): void {
  const quotaStatus = new QuotaStatusCoordinator(fileQuotaStatusStore());

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: "antigravity-api",
    models: [], // Purely dynamic provider per Pi SDK architecture
    oauth: {
      name: PROVIDER_NAME,
      login: loginAntigravity,
      refreshToken: refreshAntigravityToken,
      getApiKey,
    },
    streamSimple: streamAntigravity,
    refreshModels: async (context: any) => refreshCatalog(context),
  });

  pi.registerCommand("antigravity", {
    description: "Antigravity quota, models and settings",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trim();
      if (trimmed === "") {
        return SUBCOMMANDS.map((s) => ({ value: s.name, label: s.name, description: s.description }));
      }
      if (/\s/.test(trimmed)) return null;
      const lower = trimmed.toLowerCase();
      return SUBCOMMANDS.filter((s) => s.name.startsWith(lower)).map((s) => ({
        value: s.name,
        label: s.name,
        description: s.description,
      }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await runAntigravitySubcommand(args, ctx, quotaStatus);
    },
  });

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
