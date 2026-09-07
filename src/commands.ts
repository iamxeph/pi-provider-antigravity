import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseStoredCredentials } from "./auth.ts";
import { DEFAULT_ENDPOINT, PROVIDER_ID } from "./protocol.ts";
import {
  fetchQuotaSummary,
  formatQuotaSummary,
} from "./quota.ts";
import {
  fetchAvailableModelsCatalog,
} from "./catalog-refresh.ts";
import {
  formatModelsList,
} from "./catalog-view.ts";

const USAGE_TEXT =
  "Usage: /antigravity <command>\n\nCommands:\n  usage    Show 5h and weekly quota pool limits\n  models   List recommended models with context window and remaining quota (alias: model)\n  refresh  Force refresh model catalog\n  login    Run /login antigravity";

interface FetchSubcommand {
  progress: string;
  errLabel: string;
  run: (token: string, projectId: string, signal?: AbortSignal) => Promise<string>;
}

const FETCH_SUBCOMMANDS: Record<string, FetchSubcommand> = {
  usage: {
    progress: "Fetching quota summary…",
    errLabel: "usage",
    run: (token, projectId, signal) =>
      fetchQuotaSummary(token, projectId, DEFAULT_ENDPOINT, signal).then(formatQuotaSummary),
  },
  models: {
    progress: "Fetching available models…",
    errLabel: "models",
    run: (token, projectId, signal) =>
      fetchAvailableModelsCatalog(token, projectId, DEFAULT_ENDPOINT, signal).then(formatModelsList),
  },
};

function emitOutput(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
  } else {
    if (type === "error" || type === "warning") console.error(text);
    else console.log(text);
  }
}

export async function resolveToken(
  ctx: ExtensionCommandContext
): Promise<{ token: string; projectId: string } | null> {
  const apiKey = await ctx.modelRegistry?.getApiKeyForProvider?.(PROVIDER_ID);
  if (!apiKey) return null;
  return parseStoredCredentials(apiKey);
}

async function runWithToken(
  ctx: ExtensionCommandContext,
  cmd: FetchSubcommand
): Promise<void> {
  const creds = await resolveToken(ctx);
  if (!creds) {
    emitOutput(ctx, "Not logged in. Run /login antigravity first.", "warning");
    return;
  }
  try {
    if (ctx.hasUI) ctx.ui.notify(cmd.progress, "info");
    emitOutput(ctx, await cmd.run(creds.token, creds.projectId, ctx.signal));
  } catch (err: any) {
    emitOutput(ctx, `Failed to fetch ${cmd.errLabel}: ${err.message}`, "error");
  }
}

export function parseAntigravitySubcommand(args: string): string {
  const sub = (args || "").trim().toLowerCase();
  // "model" is an alias of "models"
  return sub === "model" ? "models" : sub;
}

export async function runAntigravitySubcommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const sub = parseAntigravitySubcommand(args);

  const fetchCmd = FETCH_SUBCOMMANDS[sub];
  if (fetchCmd) {
    await runWithToken(ctx, fetchCmd);
    return;
  }

  if (sub === "refresh") {
    try {
      if (ctx.hasUI) ctx.ui.notify("Refreshing models…", "info");
      await ctx.modelRegistry?.refresh?.({ force: true, providers: [PROVIDER_ID], signal: ctx.signal });
      emitOutput(ctx, "Antigravity models refreshed successfully.");
    } catch (err: any) {
      emitOutput(ctx, `Failed to refresh: ${err.message}`, "error");
    }
    return;
  }

  if (sub === "login") {
    if (ctx.hasUI) {
      ctx.ui.setEditorText("/login antigravity");
      ctx.ui.notify("Press Enter to log in to Antigravity.", "info");
    } else {
      emitOutput(ctx, "Please run /login antigravity to authenticate.");
    }
    return;
  }

  emitOutput(ctx, USAGE_TEXT);
}
