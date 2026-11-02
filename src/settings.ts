import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ProviderFileConfig, SettingsFieldDef } from "./config.ts";
// Type-only: quota-status.ts imports this module at runtime, so a value import back would cycle.
import type { QuotaStatus } from "./quota-status.ts";

/**
 * Every /antigravity settings entry, one shape each: mode type, options, notes,
 * resolve<X>(config), create<X>Field(deps?). The file plumbing and the settings
 * dialog live in config.ts. Saved keys in the provider file (see config.ts):
 *   { "settings": { "quotaFooter": "smart" } }   // off (default) | smart | all
 *   { "settings": { "unsignedToolCalls": "skip" } }   // fail (default) | skip
 */

export type QuotaFooterMode = "off" | "smart" | "all";

export const QUOTA_FOOTER_OPTIONS: readonly QuotaFooterMode[] = Object.freeze([
  "off",
  "smart",
  "all",
]);

export const QUOTA_FOOTER_NOTES: Readonly<Record<string, string>> = Object.freeze({
  smart:
    "Picks whichever window runs out first (5h or weekly), weighting the weekly pool by a ratio learned from your usage",
  all: "Lists every window of the pool backing the current model (5h or weekly)",
});

export function normalizeQuotaFooter(value: unknown): QuotaFooterMode | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return QUOTA_FOOTER_OPTIONS.includes(v as QuotaFooterMode) ? (v as QuotaFooterMode) : undefined;
}

export function resolveQuotaFooter(config?: ProviderFileConfig): QuotaFooterMode {
  return normalizeQuotaFooter(config?.settings?.quotaFooter) ?? "off";
}

export function createQuotaFooterField(quotaStatus?: QuotaStatus): SettingsFieldDef {
  return {
    key: "quotaFooter",
    label: "Quota footer",
    description: "Show remaining quota in Pi's status footer",
    options: QUOTA_FOOTER_OPTIONS,
    defaultValue: "off",
    optionNotes: QUOTA_FOOTER_NOTES,
    renderPreview: quotaStatus
      ? (mode, ctx, theme) => {
          if (mode === "off") return "hidden";
          const activeTheme = theme || (ctx.ui as { theme?: Theme })?.theme;
          return quotaStatus.previewFooter(ctx.model?.id, mode, activeTheme);
        }
      : undefined,
    prepare: quotaStatus
      ? async (ctx) => {
          await quotaStatus.ensurePreview(ctx);
        }
      : undefined,
    onChange: quotaStatus
      ? async (ctx, _value) => {
          if (quotaStatus.mode() !== "off") {
            await quotaStatus.refresh(ctx, { ignoreMode: true });
          }
          quotaStatus.paint(ctx);
        }
      : undefined,
  };
}

/**
 * What a Gemini request does with a same-model tool call whose thoughtSignature is
 * gone (usually another extension rebuilt the history). "fail" (default) lets the
 * backend's 400 surface the loss (ADR-0007); "skip" opts into Google's
 * skip_thought_signature_validator for it, trading that turn's reasoning continuity.
 */
export type UnsignedToolCallsMode = "fail" | "skip";

export const UNSIGNED_TOOL_CALLS_OPTIONS: readonly UnsignedToolCallsMode[] = Object.freeze(["fail", "skip"]);

const UNSIGNED_TOOL_CALLS_NOTES: Readonly<Record<string, string>> = Object.freeze({
  fail: "The request fails with 400, so the lost signature stays visible.",
  skip: "Sends skip_thought_signature_validator; reasoning may degrade for the rest of the turn.",
});

export function resolveUnsignedToolCalls(config?: ProviderFileConfig): UnsignedToolCallsMode {
  return config?.settings?.unsignedToolCalls === "skip" ? "skip" : "fail";
}

export function createUnsignedToolCallsField(): SettingsFieldDef {
  return {
    key: "unsignedToolCalls",
    label: "Unsigned tool calls",
    description: "What to do when a Gemini tool call has lost its thoughtSignature.",
    options: UNSIGNED_TOOL_CALLS_OPTIONS,
    defaultValue: "fail",
    optionNotes: UNSIGNED_TOOL_CALLS_NOTES,
  };
}
