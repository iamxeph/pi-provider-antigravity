import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseStoredCredentials } from "./auth.ts";
import { PROVIDER_ID } from "./protocol.ts";
import type { QuotaStatusCoordinator } from "./quota-status.ts";
import type { ModelCatalog } from "./model-catalog.ts";

import { emitOutput, openSettings } from "./settings.ts";

export interface SubcommandContext {
  ctx: ExtensionCommandContext;
  quotaStatus?: QuotaStatusCoordinator;
  catalog: ModelCatalog;
}

export interface SubcommandDef {
  name: string;
  description: string;
  aliases?: readonly string[];
  run: (deps: SubcommandContext) => Promise<void> | void;
}

export interface SubcommandCompletion {
  value: string;
  label: string;
  description: string;
}

export const SUBCOMMANDS: readonly SubcommandDef[] = Object.freeze([
  {
    name: "usage",
    description: "Show 5h and weekly quota pool limits",
    run: async ({ ctx, quotaStatus }) => runUsageSubcommand(ctx, quotaStatus),
  },
  {
    name: "models",
    description: "List recommended models with context window and remaining quota",
    aliases: Object.freeze(["model"]),
    run: async ({ ctx, catalog }) => runModelsSubcommand(ctx, catalog),
  },
  {
    name: "refresh",
    description: "Force refresh model catalog",
    run: async ({ ctx, catalog }) => runRefreshSubcommand(ctx, catalog),
  },
  {
    name: "settings",
    description: "Pick provider settings: Enter cycles values",
    aliases: Object.freeze(["setting"]),
    run: async ({ ctx, quotaStatus }) => openSettings(ctx, quotaStatus),
  },
  {
    name: "login",
    description: "Run /login antigravity",
    run: ({ ctx }) => runLoginSubcommand(ctx),
  },
]);

export function buildUsageText(commands: readonly SubcommandDef[] = SUBCOMMANDS): string {
  const maxNameLen = Math.max(...commands.map((c) => c.name.length));
  const lines = commands.map((c) => {
    const aliasPart = c.aliases?.length ? ` (alias: ${c.aliases.join(", ")})` : "";
    return `  ${c.name.padEnd(maxNameLen)} ${c.description}${aliasPart}`;
  });
  return `Usage: /antigravity <command>\n\nCommands:\n${lines.join("\n")}`;
}

export const USAGE_TEXT = buildUsageText();

export function completeSubcommands(
  prefix: string,
  commands: readonly SubcommandDef[] = SUBCOMMANDS,
): SubcommandCompletion[] | null {
  const trimmed = prefix.trim();
  if (trimmed === "") {
    return commands.map((s) => ({ value: s.name, label: s.name, description: s.description }));
  }
  if (/\s/.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  return commands
    .filter((s) => s.name.startsWith(lower))
    .map((s) => ({
      value: s.name,
      label: s.name,
      description: s.description,
    }));
}

export function parseAntigravitySubcommand(
  args: string,
  commands: readonly SubcommandDef[] = SUBCOMMANDS,
): string {
  const sub = (args || "").trim().toLowerCase();
  for (const cmd of commands) {
    if (cmd.name === sub || cmd.aliases?.includes(sub)) {
      return cmd.name;
    }
  }
  return sub;
}

export async function resolveToken(
  ctx: ExtensionCommandContext
): Promise<{ token: string; projectId: string } | null> {
  const apiKey = await ctx.modelRegistry?.getApiKeyForProvider?.(PROVIDER_ID);
  if (!apiKey) return null;
  return parseStoredCredentials(apiKey);
}

async function runModelsSubcommand(ctx: ExtensionCommandContext, catalog: ModelCatalog): Promise<void> {
  if ((await resolveToken(ctx)) === null) {
    emitOutput(ctx, "Not logged in. Run /login antigravity first.", "warning");
    return;
  }
  try {
    if (ctx.hasUI) ctx.ui.notify("Fetching available models…", "info");
    // Single Model Catalog path: freshness lives behind the catalog seam —
    // this module only branches on the verdict and prints.
    const { status, catalog: items } = await catalog.refreshGeneration(() =>
      ctx.modelRegistry?.refresh?.({ force: true, providers: [PROVIDER_ID], signal: ctx.signal }),
    );
    if (status === "failed" || !items) {
      throw new Error("no new generation received");
    }
    if (status === "stale") {
      // Refresh failed: say so, but still show the retained generation —
      // a stale list beats no list, as long as it is labeled.
      emitOutput(ctx, "Failed to refresh models, showing last known list.", "warning");
      emitOutput(ctx, catalog.formatList());
      return;
    }
    emitOutput(ctx, catalog.formatList());
  } catch (err: any) {
    emitOutput(ctx, `Failed to fetch models: ${err.message}`, "error");
  }
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
    const text = await quotaStatus.inspectUsage(ctx);
    emitOutput(ctx, text);
  } catch (err: any) {
    emitOutput(ctx, `Failed to fetch usage: ${err.message}`, "error");
  }
}

async function runRefreshSubcommand(ctx: ExtensionCommandContext, catalog: ModelCatalog): Promise<void> {
  try {
    if (ctx.hasUI) ctx.ui.notify("Refreshing models…", "info");
    const { status } = await catalog.refreshGeneration(() =>
      ctx.modelRegistry?.refresh?.({ force: true, providers: [PROVIDER_ID], signal: ctx.signal }),
    );
    if (status === "fresh") {
      emitOutput(ctx, "Antigravity models refreshed successfully.");
    } else if (status === "stale") {
      emitOutput(ctx, "Failed to refresh models, keeping last known list.", "warning");
    } else {
      emitOutput(ctx, "Failed to refresh models: no new generation received.", "error");
    }
  } catch (err: any) {
    emitOutput(ctx, `Failed to refresh: ${err.message}`, "error");
  }
}

function runLoginSubcommand(ctx: ExtensionCommandContext): void {
  if (ctx.hasUI) {
    ctx.ui.setEditorText("/login antigravity");
    ctx.ui.notify("Press Enter to log in to Antigravity.", "info");
  } else {
    emitOutput(ctx, "Please run /login antigravity to authenticate.");
  }
}

export async function runAntigravitySubcommand(
  args: string,
  ctx: ExtensionCommandContext,
  quotaStatus: QuotaStatusCoordinator | undefined,
  catalog: ModelCatalog,
): Promise<void> {
  const parts = (args || "").trim().split(/\s+/).filter(Boolean);
  const sub = parseAntigravitySubcommand(parts[0] || "");
  const cmd = SUBCOMMANDS.find((c) => c.name === sub);
  if (cmd) {
    await cmd.run({ ctx, quotaStatus, catalog });
    return;
  }

  emitOutput(ctx, USAGE_TEXT);
}
