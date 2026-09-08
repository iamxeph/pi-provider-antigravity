import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseStoredCredentials } from "./auth.ts";
import { PROVIDER_ID } from "./protocol.ts";
import {
  fetchQuotaSummary,
  formatQuotaSummary,
} from "./quota.ts";
import {
  fetchAvailableModelsCatalog,
} from "./catalog-refresh.ts";
import {
  formatModelsList,
} from "./model-catalog.ts";

import { emitOutput, openSettings } from "./settings.ts";
import {
  paintQuotaStatus,
  type QuotaStatusCoordinator,
} from "./usage-status.ts";

const USAGE_TEXT =
  "Usage: /antigravity <command>\n\nCommands:\n  usage    Show 5h and weekly quota pool limits\n  models   List recommended models with context window and remaining quota (alias: model)\n  refresh  Force refresh model catalog\n  settings Pick provider settings: Enter cycles values (alias: setting)\n  login    Run /login antigravity";

interface FetchSubcommand {
  progress: string;
  errLabel: string;
  run: (token: string, projectId: string, signal?: AbortSignal) => Promise<string>;
}

const FETCH_SUBCOMMANDS: Record<string, FetchSubcommand> = {
  models: {
    progress: "Fetching available models…",
    errLabel: "models",
    run: (token, projectId, signal) =>
      fetchAvailableModelsCatalog(token, projectId, signal).then(formatModelsList),
  },
};

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
  // Aliases: "model" → "models", "setting" → "settings"
  if (sub === "model") return "models";
  if (sub === "setting") return "settings";
  return sub;
}

async function runUsageSubcommand(
  ctx: ExtensionCommandContext,
  quotaStatus?: QuotaStatusCoordinator,
): Promise<void> {
  const creds = await resolveToken(ctx);
  if (!creds) {
    emitOutput(ctx, "Not logged in. Run /login antigravity first.", "warning");
    return;
  }
  try {
    if (ctx.hasUI) ctx.ui.notify("Fetching quota summary…", "info");
    const summary = await fetchQuotaSummary(creds.token, creds.projectId, ctx.signal);
    // Feed the shared cache so the footer, calibration, and disk state see
    // this fresh observation too — no redundant fetch, no stale footer.
    if (quotaStatus) {
      quotaStatus.ingest(summary);
      paintQuotaStatus(quotaStatus, ctx);
    }
    emitOutput(ctx, formatQuotaSummary(summary));
  } catch (err: any) {
    emitOutput(ctx, `Failed to fetch usage: ${err.message}`, "error");
  }
}

export async function runAntigravitySubcommand(
  args: string,
  ctx: ExtensionCommandContext,
  quotaStatus?: QuotaStatusCoordinator,
): Promise<void> {
  const parts = (args || "").trim().split(/\s+/).filter(Boolean);
  const sub = parseAntigravitySubcommand(parts[0] || "");

  if (sub === "usage") {
    await runUsageSubcommand(ctx, quotaStatus);
    return;
  }

  const fetchCmd = FETCH_SUBCOMMANDS[sub];
  if (fetchCmd) {
    await runWithToken(ctx, fetchCmd);
    return;
  }

  if (sub === "settings") {
    await openSettings(ctx, quotaStatus);
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
