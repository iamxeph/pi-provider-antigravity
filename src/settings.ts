import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import {
  ANSI_FG_RESET,
  FOOTER_MODE_NOTES,
  FOOTER_MODE_OPTIONS,
  normalizeFooterMode,
  paintQuotaStatus,
  type QuotaFooterMode,
  type QuotaStatusCoordinator,
  type QuotaStatusStore,
} from "./quota-status.ts";

export { type QuotaFooterMode, normalizeFooterMode };

export const PROVIDER_CONFIG_FILE = "pi-provider-antigravity.json";

export interface ProviderFileConfig {
  settings?: { quotaFooter?: unknown; [key: string]: unknown };
  // Runtime state namespaced per subsystem (e.g. states.quota); unknown
  // entries pass through untouched.
  states?: { [name: string]: { [key: string]: unknown } | undefined };
}

// Single opt-in file next to Pi's settings.json (NOT settings.json itself —
// Pi manages that file and may drop unknown keys). Pi resolves its dir via
// PI_CODING_AGENT_DIR else ~/.pi/agent; mirror that:
//   { "settings": { "quotaFooter": "smart" } }   // off (default) | smart | all
// A "states" section holds runtime data namespaced per subsystem
// (e.g. states.quota); unknown keys and sections pass through untouched. Read per call: tiny file, and edits apply
// on the next refresh without a restart.
export function defaultConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  // Mirrors Pi's canonical getAgentDir() (PI_CODING_AGENT_DIR else ~/.pi/agent)
  // — the same source pi-subagents imports from @earendil-works/pi-coding-agent.
  // Hand-rolled because a root value-import breaks plain-node tests: the
  // package index pulls @earendil-works/pi-server, which isn't installable here.
  const dir = (env.PI_CODING_AGENT_DIR || "").trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(dir, PROVIDER_CONFIG_FILE);
}

export function loadProviderConfig(file = defaultConfigFile()): ProviderFileConfig | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as ProviderFileConfig;
  } catch {
    // Missing/unreadable/invalid file means "not configured".
  }
  return undefined;
}

export function saveProviderConfig(file: string, data: ProviderFileConfig): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

export function resolveFooterMode(config?: ProviderFileConfig): QuotaFooterMode {
  return normalizeFooterMode(config?.settings?.quotaFooter) ?? "off";
}

// Production QuotaStatusStore backed by the provider file. Reads per call:
// tiny file, and edits apply on the next refresh without a restart.
export function fileQuotaStatusStore(file = defaultConfigFile()): QuotaStatusStore {
  return {
    loadMode: () => resolveFooterMode(loadProviderConfig(file)),
    loadQuotaState: () => {
      const quota = loadProviderConfig(file)?.states?.quota;
      return quota && typeof quota === "object" && !Array.isArray(quota) ? quota : undefined;
    },
    // Merges state into the existing file, preserving settings and unknown
    // keys. Never clobbers a file we couldn't parse.
    saveQuotaState: (state) => {
      try {
        let data: ProviderFileConfig = {};
        try {
          const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
          data = raw as ProviderFileConfig;
        } catch (err: any) {
          if (err?.code !== "ENOENT") return false;
        }
        const states =
          data.states && typeof data.states === "object" && !Array.isArray(data.states) ? data.states : {};
        const quota =
          states.quota && typeof states.quota === "object" && !Array.isArray(states.quota) ? states.quota : {};
        states.quota = { ...quota, ...state };
        data.states = states;
        return saveProviderConfig(file, data);
      } catch {
        // Cache is best-effort; a stale ratio is still usable.
        return false;
      }
    },
  };
}

export interface SettingsFieldDef {
  key: string;
  label: string;
  description?: string;
  options: readonly string[];
  defaultValue?: string;
  // Per-option explanation shown on its own line under the live sample (only
  // the highlighted value's note is shown).
  optionNotes?: Record<string, string>;
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
    options: FOOTER_MODE_OPTIONS,
    defaultValue: "off",
    optionNotes: FOOTER_MODE_NOTES,
    onChange: async (ctx, quotaStatus) => {
      if (!quotaStatus) return;
      // An explicit pick is an explicit look: the mode/model gates would
      // otherwise leave the preview blank while the footer is off or another
      // provider's model is selected. Nothing to fetch when the new value is off.
      if (quotaStatus.mode() !== "off") await quotaStatus.refresh(ctx, { ignoreMode: true });
      paintQuotaStatus(quotaStatus, ctx);
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
// the slot itself (a Claude model previews the 3P pool). Off has no sample: the
// slot stays empty. The leading reset closes the dim description color the
// dialog renders it in — the sample must read like the footer, where an
// uncolored window is plain foreground and only low ones are yellow/red.
export function previewQuotaFooterText(
  coord: QuotaStatusCoordinator | undefined,
  modelId: string | undefined,
  mode: string,
): string | undefined {
  if (!coord) return undefined;
  const normalized = normalizeFooterMode(mode);
  if (!normalized || normalized === "off") return undefined;
  const { colored } = coord.renderFooter(modelId, normalized);
  if (!colored) return undefined;
  return ANSI_FG_RESET + colored;
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
      const head = sample && base ? `${base}: ${sample}` : (sample ?? base);
      const note = quotaField?.optionNotes?.[mode];
      // Note on its own line, not appended: the sample closes the description
      // color, so anything trailing it would lose dim.
      item.description = note ? `${head}\n${note}` : head;
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
