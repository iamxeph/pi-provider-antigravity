import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import type { QuotaStatusCoordinator } from "./quota-status.ts";

export const ANSI_FG_RESET = "\x1b[39m";

export const PROVIDER_CONFIG_FILE = "pi-provider-antigravity.json";

export interface ProviderFileConfig {
  settings?: { quotaFooter?: unknown; [key: string]: unknown };
  // Runtime state namespaced per subsystem (e.g. states.quota); unknown
  // entries pass through untouched.
  states?: { [name: string]: { [key: string]: unknown } | undefined };
}

export type QuotaFooterMode = "off" | "smart" | "all";

export const FOOTER_MODE_NOTES: Readonly<Record<string, string>> = Object.freeze({
  smart:
    "Picks whichever window runs out first (5h or weekly), weighting the weekly pool by a ratio learned from your usage",
  all: "Lists every window of the pool backing the current model (5h or weekly)",
});

export const FOOTER_MODE_OPTIONS: readonly QuotaFooterMode[] = Object.freeze([
  "off",
  "smart",
  "all",
]);

export function normalizeFooterMode(value: unknown): QuotaFooterMode | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FOOTER_MODE_OPTIONS.includes(v as QuotaFooterMode) ? (v as QuotaFooterMode) : undefined;
}

// Single opt-in file next to Pi's settings.json (NOT settings.json itself —
// Pi manages that file and may drop unknown keys). Pi resolves its dir via
// PI_CODING_AGENT_DIR else ~/.pi/agent:
//   { "settings": { "quotaFooter": "smart" } }   // off (default) | smart | all
// A "states" section holds runtime data namespaced per subsystem
// (e.g. states.quota); unknown keys and sections pass through untouched. Read per call: tiny file, and edits apply
// on the next refresh without a restart.
export function defaultConfigFile(env: NodeJS.ProcessEnv = process.env): string {
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

// Temp file in the same directory so the rename stays on one filesystem, and
// fsync before it so a crash cannot leave the new name pointing at empty data.
// An existing file's mode is carried over: rename replaces the inode, so
// without it a user's tightened permissions would silently reset.
export function writeProviderConfigAtomically(file: string, data: ProviderFileConfig): boolean {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : undefined;
    const fd = fs.openSync(tmp, "w", mode);
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n", "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing left to clean up.
    }
    return false;
  }
}

// The file's single writer: parse once, let the caller mutate the keys it owns,
// write atomically. A file we cannot read is never overwritten — this is the
// file the CLI tells users to hand-edit, so one syntax error must not cost them
// the rest of the document (settings and every subsystem's states entry).
// Callers keep their own merge rule; leaving other keys untouched is what
// preserves them.
export function updateProviderConfig(
  file: string,
  mutate: (config: ProviderFileConfig) => void,
): boolean {
  try {
    let data: ProviderFileConfig = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      data = raw as ProviderFileConfig;
    } catch (err: any) {
      // A missing file is a fresh install; anything else is unreadable.
      if (err?.code !== "ENOENT") return false;
    }
    mutate(data);
    return writeProviderConfigAtomically(file, data);
  } catch {
    // Best-effort: a caller that loses its write keeps working from memory.
    return false;
  }
}

export function resolveFooterMode(config?: ProviderFileConfig): QuotaFooterMode {
  return normalizeFooterMode(config?.settings?.quotaFooter) ?? "off";
}

/**
 * Loads subsystem state from states[subsystem], e.g. states.quota.
 */
export function loadSubsystemState<T>(
  subsystem: string,
  file = defaultConfigFile(),
): T | undefined {
  const state = loadProviderConfig(file)?.states?.[subsystem];
  return state && typeof state === "object" && !Array.isArray(state) ? (state as T) : undefined;
}

/**
 * Atomically merges state into states[subsystem] while preserving settings and other subsystems.
 */
export function saveSubsystemState<T extends object>(
  subsystem: string,
  state: T,
  file = defaultConfigFile(),
): boolean {
  return updateProviderConfig(file, (config) => {
    const states =
      config.states && typeof config.states === "object" && !Array.isArray(config.states)
        ? config.states
        : {};
    const current =
      states[subsystem] && typeof states[subsystem] === "object" && !Array.isArray(states[subsystem])
        ? states[subsystem]
        : {};
    states[subsystem] = { ...current, ...state };
    config.states = states;
  });
}

// Production QuotaStatusStore backed by the provider file. Reads per call:
// tiny file, and edits apply on the next refresh without a restart.
export function fileQuotaStatusStore(file = defaultConfigFile()) {
  return {
    loadMode: () => resolveFooterMode(loadProviderConfig(file)),
    loadQuotaState: () => loadSubsystemState<Record<string, unknown>>("quota", file),
    saveQuotaState: (state: Record<string, unknown>) => saveSubsystemState("quota", state, file),
  };
}

export interface SettingsFieldDef {
  key: string;
  label: string;
  description?: string;
  options: readonly string[];
  defaultValue?: string;
  optionNotes?: Record<string, string>;
  onChange?: (ctx: ExtensionCommandContext, quotaStatus?: QuotaStatusCoordinator) => Promise<void>;
}

export const SETTINGS_FIELDS: readonly SettingsFieldDef[] = Object.freeze([
  {
    key: "quotaFooter",
    label: "Quota footer",
    description: "Show remaining quota in Pi's status footer",
    options: FOOTER_MODE_OPTIONS,
    defaultValue: "off",
    optionNotes: FOOTER_MODE_NOTES,
    onChange: async (ctx, quotaStatus) => {
      if (!quotaStatus) return;
      if (quotaStatus.mode() !== "off") await quotaStatus.refresh(ctx, { ignoreMode: true });
      quotaStatus.paint(ctx);
    },
  },
]);

export function fieldDisplayValue(
  config: ProviderFileConfig | undefined,
  field: SettingsFieldDef,
): string {
  const raw = config?.settings?.[field.key];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return field.defaultValue ?? "unset";
}

export function saveSettingValue(field: SettingsFieldDef, value: string, file: string): boolean {
  return updateProviderConfig(file, (config) => {
    const settings =
      config.settings && typeof config.settings === "object" && !Array.isArray(config.settings)
        ? config.settings
        : {};
    settings[field.key] = value;
    config.settings = settings;
  });
}

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

// A refused write is either "unreadable file" or "the write itself failed", and
// applySettingValue reports both the same way. So the message stays conditional
// instead of naming a cause, and still hands over the recovery for the case a
// hand-editor actually hits.
function writeFailedMessage(file: string): string {
  return `Failed to write ${file}. If the file is not valid JSON, fix or delete it.`;
}

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
    const text =
      SETTINGS_FIELDS.map((f) => `${f.label}: ${fieldDisplayValue(config, f)}`).join("\n") +
      `\nEdit ${file} to change.`;
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else console.log(text);
    return;
  }
  let field = SETTINGS_FIELDS[0];
  if (!field) return;
  if (SETTINGS_FIELDS.length > 1) {
    const labels = SETTINGS_FIELDS.map(
      (f) => `${f.label} (current: ${fieldDisplayValue(config, f)})`,
    );
    const choice = await ctx.ui.select("Antigravity settings", labels);
    if (!choice) return;
    const found = SETTINGS_FIELDS[labels.indexOf(choice)];
    if (!found) return;
    field = found;
  }
  const picked = await ctx.ui.select(
    `${field.label} (current: ${fieldDisplayValue(config, field)})`,
    [...field.options],
  );
  if (!picked || !field.options.includes(picked)) return;
  if (await applySettingValue(field, picked, file, ctx, quotaStatus)) {
    ctx.ui.notify(`${field.label} set to ${picked}.`, "info");
  } else {
    ctx.ui.notify(writeFailedMessage(file), "error");
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
    const paintPreview = (mode: string) => {
      const item = items.find((i) => i.id === "quotaFooter");
      if (!item) return;
      const base = quotaField?.description ?? "";
      const sample =
        mode === "off" ? "hidden" : previewQuotaFooterText(quotaStatus, ctx.model?.id, mode);
      const head = sample && base ? `${base}: ${sample}` : (sample ?? base);
      const note = quotaField?.optionNotes?.[mode];
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
        void applySettingValue(field, newValue, file, ctx, quotaStatus).then((saved) => {
          // A refused write (unreadable file) must not look like a success: the
          // list has already moved to the value it asked for, so put the row back
          // on what the file actually holds before reporting the failure.
          if (!saved) {
            list.updateValue(field.key, fieldDisplayValue(loadProviderConfig(file), field));
            ctx.ui.notify(writeFailedMessage(file), "error");
            list.invalidate();
            tui.requestRender();
            return;
          }
          paintPreview(newValue);
          list.invalidate();
          tui.requestRender();
        });
      },
      () => done(),
    );
    const border = {
      render: (width: number) => [theme.fg("border", "─".repeat(Math.max(1, width)))],
    };
    return {
      render: (width: number) => [
        ...border.render(width),
        ...list.render(width),
        ...border.render(width),
      ],
      handleInput: (data: string) => list.handleInput(data),
      invalidate: () => list.invalidate(),
    };
  });
}
