import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import { colorizeQuotaFooter, colorizeQuotaFooterBoth } from "./quota.ts";
import {
  defaultConfigFile,
  loadProviderConfig,
  paintQuotaStatus,
  resolveFooterMode,
  saveProviderConfig,
  type ProviderFileConfig,
  type QuotaStatusCoordinator,
} from "./usage-status.ts";

export interface SettingsFieldDef {
  key: string;
  label: string;
  description?: string;
  options: readonly string[];
  defaultValue?: string;
  // Immediate side-effect after save (e.g. repaint). Absent = save only.
  onChange?: (ctx: ExtensionCommandContext, quotaStatus?: QuotaStatusCoordinator) => Promise<void>;
}

// Adding a setting = one row here. The TUI dialog and the select fallback
// both render field pickers automatically once there are two or more rows.
// Frozen: callers and tests read the registry, never mutate it.
export const SETTINGS_FIELDS: readonly SettingsFieldDef[] = Object.freeze([
  {
    key: "quotaFooter",
    label: "Quota footer",
    description: "Show remaining quota in the footer",
    options: ["off", "single", "both"],
    defaultValue: "off",
    onChange: async (ctx, quotaStatus) => {
      if (quotaStatus) {
        await quotaStatus.refresh(ctx);
        paintQuotaStatus(quotaStatus, ctx);
      }
    },
  },
]);

export function fieldDisplayValue(config: ProviderFileConfig | undefined, field: SettingsFieldDef): string {
  const raw = config?.settings?.[field.key];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return field.defaultValue ?? "unset";
}

export function saveSettingValue(field: SettingsFieldDef, value: string, file: string): boolean {
  const current = loadProviderConfig(file) ?? {};
  const settings =
    current.settings && typeof current.settings === "object" ? current.settings : {};
  return saveProviderConfig(file, { ...current, settings: { ...settings, [field.key]: value } });
}

// Shared by the TUI dialog (silent per cycle) and the select fallback:
// saves, runs the field's side-effect, reports success.
export async function applySettingValue(
  field: SettingsFieldDef,
  value: string,
  file: string,
  ctx: ExtensionCommandContext,
  quotaStatus?: QuotaStatusCoordinator,
): Promise<boolean> {
  if (!saveSettingValue(field, value, file)) {
    return false;
  }
  await field.onChange?.(ctx, quotaStatus);
  return true;
}

// Rendered footer sample for a mode, for settings previews. Model-aware like
// the slot itself (a Claude model previews the 3P pool). Plain data only —
// callers colorize. Off has no sample: the slot stays empty.
export function previewQuotaFooterText(
  coord: QuotaStatusCoordinator | undefined,
  modelId: string | undefined,
  mode: string,
): string | undefined {
  if (!coord || mode === "off") return undefined;
  const plain = coord.footerFor(modelId, mode === "both" ? "both" : "single");
  if (!plain) return undefined;
  return mode === "both" ? colorizeQuotaFooterBoth(plain) : colorizeQuotaFooter(plain);
}

// Rows for pi-tui's SettingsList — the same list component Pi's /settings is
// built on. Rows with `values` cycle inline on Enter/Space (no submenu).
export function buildSettingsItems(
  config: ProviderFileConfig | undefined,
  fields: readonly SettingsFieldDef[] = SETTINGS_FIELDS,
): SettingItem[] {
  return fields.map((f) => ({
    id: f.key,
    label: f.label,
    description: f.description,
    currentValue: fieldDisplayValue(config, f),
    values: [...f.options],
  }));
}

export function emitOutput(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
  } else {
    if (type === "error" || type === "warning") console.error(text);
    else console.log(text);
  }
}

// Pi's canonical list theme when the host package is importable; otherwise an
// identical mapping on the live theme (plain-node tests can't load the host
// package root, and the mapping is five stable color roles).
async function settingsListTheme(theme: Theme): Promise<SettingsListTheme> {
  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    return pi.getSettingsListTheme();
  } catch {
    return {
      label: (text, selected) => (selected ? theme.fg("accent", text) : text),
      value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
      description: (text) => theme.fg("dim", text),
      cursor: theme.fg("accent", "→ "),
      hint: (text) => theme.fg("dim", text),
    };
  }
}

// Single entry behind the settings seam: commands dispatches here and knows
// nothing about dialogs, file paths, or previews.
export async function openSettings(
  ctx: ExtensionCommandContext,
  quotaStatus?: QuotaStatusCoordinator,
): Promise<void> {
  const file = defaultConfigFile();
  if (ctx.mode === "tui" && ctx.hasUI) {
    await openSettingsDialog(ctx, quotaStatus, file);
    return;
  }
  const config = loadProviderConfig(file);
  if (!ctx.hasUI) {
    emitOutput(
      ctx,
      SETTINGS_FIELDS.map((f) => `${f.label}: ${fieldDisplayValue(config, f)}`).join("\n") +
        `\nEdit ${file} to change.`,
    );
    return;
  }
  let field = SETTINGS_FIELDS[0];
  if (!field) return;
  if (SETTINGS_FIELDS.length > 1) {
    const labels = SETTINGS_FIELDS.map(
      (f) => `${f.label} (current: ${fieldDisplayValue(config, f)})`,
    );
    const choice = await ctx.ui.select("Antigravity settings", labels);
    if (!choice) return; // dismissed — change nothing
    const found = SETTINGS_FIELDS[labels.indexOf(choice)];
    if (!found) return;
    field = found;
  }
  const picked = await ctx.ui.select(
    `${field.label} (current: ${fieldDisplayValue(config, field)})`,
    [...field.options],
  );
  if (!picked || !field.options.includes(picked)) return; // dismissed — change nothing
  if (await applySettingValue(field, picked, file, ctx, quotaStatus)) {
    emitOutput(ctx, `${field.label} set to ${picked}.`);
  } else {
    emitOutput(ctx, `Failed to write ${file}.`, "error");
  }
}

async function openSettingsDialog(
  ctx: ExtensionCommandContext,
  quotaStatus: QuotaStatusCoordinator | undefined,
  file: string,
): Promise<void> {
  if (quotaStatus) await quotaStatus.ensurePreview(ctx);
  await ctx.ui.custom<void>(async (tui, theme, _kb, done) => {
    const config = loadProviderConfig(file);
    const items = buildSettingsItems(config);
    const quotaField = SETTINGS_FIELDS.find((f) => f.key === "quotaFooter");
    // Live sample of what the footer will show for a mode, using cached
    // (just ensured) quota numbers. Model-aware like the slot itself.
    const paintPreview = (mode: string) => {
      const item = items.find((i) => i.id === "quotaFooter");
      if (!item) return;
      const base = quotaField?.description ?? "";
      const sample = mode === "off" ? "hidden" : previewQuotaFooterText(quotaStatus, ctx.model?.id, mode);
      item.description = sample && base ? `${base}: ${sample}` : (sample ?? base);
    };
    paintPreview(resolveFooterMode(config));
    const list = new SettingsList(
      items,
      Math.min(items.length, 10),
      await settingsListTheme(theme),
      (id, newValue) => {
        const field = SETTINGS_FIELDS.find((f) => f.key === id);
        if (!field) return;
        list.invalidate();
        tui.requestRender();
        void applySettingValue(field, newValue, file, ctx, quotaStatus).then(() => {
          paintPreview(newValue);
          list.invalidate();
          tui.requestRender();
        });
      },
      () => done(),
    );
    // Pi-native frame: a border line above and below the list, like
    // /settings (SettingsSelectorComponent wraps its SettingsList in
    // DynamicBorders). Extension custom UI can't reuse pi's separate
    // focus target, so the wrapper delegates input to the inner list.
    const border = {
      render: (width: number) => [theme.fg("border", "─".repeat(Math.max(1, width)))],
    };
    return {
      render: (width: number) => [...border.render(width), ...list.render(width), ...border.render(width)],
      handleInput: (data: string) => list.handleInput(data),
      invalidate: () => list.invalidate(),
    };
  });
}
