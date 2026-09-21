import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveCredentials, NOT_LOGGED_IN, type AntigravityCredentials } from "./auth.ts";
import { PROVIDER_ID } from "./protocol.ts";
import { openSettings } from "./config.ts";
import { createQuotaStatus, type QuotaStatus } from "./quota-status.ts";
import type { ModelCatalog } from "./model-catalog.ts";
import { executeWebSearchCommand } from "./search.ts";

export interface SubcommandCompletion {
  value: string;
  label: string;
  description: string;
}

export interface AntigravityCommandsDeps {
  quotaStatus?: QuotaStatus;
  catalog: ModelCatalog;
}

export interface AntigravityCommands {
  handle(args: string, ctx: ExtensionCommandContext): Promise<void>;
  complete(prefix: string): SubcommandCompletion[] | null;
}

interface SubcommandContext {
  ctx: ExtensionCommandContext;
  quotaStatus?: QuotaStatus;
  catalog: ModelCatalog;
  subArgs?: string;
}

interface SubcommandDef {
  name: string;
  description: string;
  aliases?: readonly string[];
  run: (deps: SubcommandContext) => Promise<void> | void;
}

function emitOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
  } else {
    if (type === "error" || type === "warning") console.error(text);
    else console.log(text);
  }
}

const SUBCOMMANDS: readonly SubcommandDef[] = Object.freeze([
  {
    name: "usage",
    description: "Show remaining 5h and weekly quota",
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
    description: "Fetch the latest model list",
    run: async ({ ctx, catalog }) => runRefreshSubcommand(ctx, catalog),
  },
  {
    name: "settings",
    description: "Configure provider settings",
    aliases: Object.freeze(["setting"]),
    run: async ({ ctx, quotaStatus }) => {
      const qs = quotaStatus ?? createQuotaStatus();
      await openSettings(ctx, [qs.createSettingsField()]);
    },
  },
  {
    name: "websearch",
    description: "Search the web using Google Search Grounding",
    run: async ({ ctx, subArgs }) => executeWebSearchCommand(ctx, subArgs),
  },
  {
    name: "login",
    description: "Run /login antigravity",
    run: ({ ctx }) => runLoginSubcommand(ctx),
  },
]);

function buildUsageText(commands: readonly SubcommandDef[] = SUBCOMMANDS): string {
  const maxNameLen = Math.max(...commands.map((c) => c.name.length));
  const lines = commands.map((c) => {
    const aliasPart = c.aliases?.length ? ` (alias: ${c.aliases.join(", ")})` : "";
    return `  ${c.name.padEnd(maxNameLen)} ${c.description}${aliasPart}`;
  });
  return `Usage: /antigravity <command>\n\nCommands:\n${lines.join("\n")}`;
}

const USAGE_TEXT = buildUsageText();

function completeSubcommands(
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

function parseAntigravitySubcommand(
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

async function runModelsSubcommand(ctx: ExtensionCommandContext, catalog: ModelCatalog): Promise<void> {
  if ((await resolveCredentials(ctx)) === null) {
    emitOutput(ctx, NOT_LOGGED_IN, "warning");
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
      throw new Error("no models were returned");
    }
    if (status === "stale") {
      // Refresh failed: say so, but still show the retained generation —
      // a stale list beats no list, as long as it is labeled.
      emitOutput(ctx, "Failed to refresh models; showing last known list.", "warning");
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
  quotaStatus?: QuotaStatus,
): Promise<void> {
  if ((await resolveCredentials(ctx)) === null) {
    emitOutput(ctx, NOT_LOGGED_IN, "warning");
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
      emitOutput(ctx, "Failed to refresh models; keeping last known list.", "warning");
    } else {
      emitOutput(ctx, "Failed to refresh models: no models were returned.", "error");
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

/**
 * Creates the deep Antigravity Command Dispatcher module, encapsulating
 * subcommand routing, argument parsing, alias resolution, usage help formatting,
 * and execution behind a single authoritative seam.
 */
export function createAntigravityCommands(deps: AntigravityCommandsDeps): AntigravityCommands {
  return {
    async handle(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const raw = (args || "").trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const sub = parseAntigravitySubcommand(parts[0] || "");
      const subArgs = raw.slice(parts[0]?.length || 0).trim();
      const cmd = SUBCOMMANDS.find((c) => c.name === sub);
      if (cmd) {
        await cmd.run({
          ctx,
          quotaStatus: deps.quotaStatus,
          catalog: deps.catalog,
          subArgs,
        });
        return;
      }

      emitOutput(ctx, USAGE_TEXT);
    },

    complete(prefix: string): SubcommandCompletion[] | null {
      return completeSubcommands(prefix);
    },
  };
}
