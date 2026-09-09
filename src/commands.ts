import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseStoredCredentials } from "./auth.ts";
import { PROVIDER_ID } from "./protocol.ts";
import {
  formatQuotaSummary,
  paintQuotaStatus,
  type QuotaStatusCoordinator,
} from "./quota-status.ts";
import {
  formatModelsList,
  getCatalogSnapshot,
  getStoredCatalog,
} from "./model-catalog.ts";

import { emitOutput, openSettings } from "./settings.ts";

const USAGE_TEXT =
  "Usage: /antigravity <command>\n\nCommands:\n  usage    Show 5h and weekly quota pool limits\n  models   List recommended models with context window and remaining quota (alias: model)\n  refresh  Force refresh model catalog\n  settings Pick provider settings: Enter cycles values (alias: setting)\n  login    Run /login antigravity";

export async function resolveToken(
  ctx: ExtensionCommandContext
): Promise<{ token: string; projectId: string } | null> {
  const apiKey = await ctx.modelRegistry?.getApiKeyForProvider?.(PROVIDER_ID);
  if (!apiKey) return null;
  return parseStoredCredentials(apiKey);
}

async function runModelsSubcommand(ctx: ExtensionCommandContext): Promise<void> {
  if ((await resolveToken(ctx)) === null) {
    emitOutput(ctx, "Not logged in. Run /login antigravity first.", "warning");
    return;
  }
  try {
    if (ctx.hasUI) ctx.ui.notify("Fetching available models…", "info");
    // Single Model Catalog path: the refresh owns fetch→snapshot→publish and
    // the table formats the generation it ingested. refreshCatalog swallows
    // fetch errors internally, so a snapshot version bump is the only proof
    // a fresh generation landed — no bump means the fetch failed, and the
    // failure is reported instead of showing the retained stale generation.
    const before = getCatalogSnapshot().version;
    await ctx.modelRegistry?.refresh?.({ force: true, providers: [PROVIDER_ID], signal: ctx.signal });
    const catalog = getStoredCatalog();
    if (!catalog || getCatalogSnapshot().version === before) {
      // Refresh failed: say so, but still show the retained generation when
      // one exists — a stale list beats no list, as long as it is labeled.
      if (catalog) {
        emitOutput(ctx, "Failed to refresh models, showing last known list.", "warning");
        emitOutput(ctx, formatModelsList(catalog));
        return;
      }
      throw new Error("no new generation received");
    }
    emitOutput(ctx, formatModelsList(catalog));
  } catch (err: any) {
    emitOutput(ctx, `Failed to fetch models: ${err.message}`, "error");
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
  if ((await resolveToken(ctx)) === null) {
    emitOutput(ctx, "Not logged in. Run /login antigravity first.", "warning");
    return;
  }
  if (!quotaStatus) {
    emitOutput(ctx, "Quota status is unavailable.", "error");
    return;
  }
  try {
    if (ctx.hasUI) ctx.ui.notify("Fetching quota summary…", "info");
    // Explicit look at quota: bypass the mode and model gates, but share the
    // fetch, calibration, and persistence with the footer — no redundant
    // fetch, no stale footer.
    const summary = await quotaStatus.refresh(ctx, { force: true, ignoreMode: true, signal: ctx.signal });
    if (!summary) {
      emitOutput(ctx, "Failed to fetch usage.", "error");
      return;
    }
    paintQuotaStatus(quotaStatus, ctx);
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

  if (sub === "models") {
    await runModelsSubcommand(ctx);
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
