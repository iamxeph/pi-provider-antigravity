import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loginAntigravity, refreshAntigravityToken, getApiKey } from "./auth.ts";
import { DEFAULT_ENDPOINT, PROVIDER_ID } from "./protocol.ts";
import { extractBaseModelId, refreshCatalog } from "./catalog.ts";
import { streamAntigravity } from "./stream.ts";
import { runAntigravitySubcommand } from "./commands.ts";

export { PROVIDER_ID, extractBaseModelId };
export const PROVIDER_NAME = "Antigravity";

export default function (pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: "antigravity-api" as any,
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
    description: "Antigravity provider commands (/antigravity [usage|models|refresh|login])",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await runAntigravitySubcommand(args, ctx);
    },
  });
}
