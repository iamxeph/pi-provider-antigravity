import type { ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { resolveCredentials } from "./auth.ts";
import { getModelProfile } from "./model-identity.ts";
import { postAntigravityJson, PROVIDER_ID } from "./protocol.ts";
import {
  defaultConfigFile,
  loadProviderConfig,
  loadSubsystemState,
  saveSubsystemState,
  type ProviderFileConfig,
  type SettingsFieldDef,
} from "./config.ts";

/**
 * Quota Status module (deep, ports & adapters): Quota Pool wire parsing, urgent-window
 * math, ratio self-calibration, throttle, cache, and status footer slot painting.
 * Persists calibration state through the Provider Config Seam (states.quota).
 */

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

export function resolveFooterMode(config?: ProviderFileConfig): QuotaFooterMode {
  return normalizeFooterMode(config?.settings?.quotaFooter) ?? "off";
}

export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  window?: string;
  resetTime?: string;
  description?: string;
  remainingFraction: number;
}

export interface QuotaGroup {
  displayName: string;
  description?: string;
  buckets: QuotaBucket[];
}

export interface QuotaSummary {
  groups: QuotaGroup[];
  description?: string;
}

function renderProgressBar(fraction: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

type QuotaWindowKind = "5h" | "weekly" | "other";

const QUOTA_WINDOW_RANK: Record<QuotaWindowKind, number> = {
  "5h": 0,
  weekly: 1,
  other: 2,
};

function classifyQuotaWindow(bucket: QuotaBucket): QuotaWindowKind {
  // The wire reports a machine `window` ("5h"/"weekly" in every capture). Trust
  // it — no display-prose guessing. Unknown or missing windows are "other".
  const w = (bucket.window || "").trim().toLowerCase();
  if (w === "5h") return "5h";
  if (w === "weekly") return "weekly";
  return "other";
}

function shortWindowLabel(bucket: QuotaBucket, kind: QuotaWindowKind): string {
  if (kind === "5h") return "5h";
  if (kind === "weekly") return "Wk";
  return bucket.displayName || bucket.bucketId || "Quota";
}

function sortQuotaBuckets(buckets: QuotaBucket[]): QuotaBucket[] {
  return buckets
    .slice()
    .sort(
      (a, b) =>
        QUOTA_WINDOW_RANK[classifyQuotaWindow(a)] - QUOTA_WINDOW_RANK[classifyQuotaWindow(b)],
    );
}

function formatResetRemaining(resetTime?: string, nowFn: () => number = Date.now): string | null {
  if (!resetTime) return null;
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) return null;
  const delta = ts - nowFn();
  if (delta <= 0) return "ready";
  const totalMin = Math.ceil(delta / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

function parseQuotaSummary(data: any): QuotaSummary {
  const groups: QuotaGroup[] = [];

  for (const g of data.groups || []) {
    const buckets: QuotaBucket[] = [];
    for (const b of g.buckets || []) {
      buckets.push({
        bucketId: b.bucketId || "unknown",
        displayName: b.displayName || b.bucketId || "Limit",
        window: b.window,
        resetTime: b.resetTime,
        description: b.description,
        remainingFraction: typeof b.remainingFraction === "number" ? b.remainingFraction : 1,
      });
    }
    groups.push({
      displayName: g.displayName || "Quota Group",
      description: g.description,
      buckets,
    });
  }

  return {
    groups,
    description: data.description,
  };
}

function formatQuotaSummary(summary: QuotaSummary, nowFn: () => number = Date.now): string {
  const lines: string[] = [];

  for (const group of summary.groups) {
    if (lines.length > 0) lines.push("");
    lines.push(`${group.displayName}`);
    for (const b of sortQuotaBuckets(group.buckets)) {
      const pct = Math.round(b.remainingFraction * 100);
      const label = shortWindowLabel(b, classifyQuotaWindow(b)).padEnd(3);
      const reset = formatResetRemaining(b.resetTime, nowFn);
      const suffix = reset && pct < 100 ? ` (${reset})` : "";
      lines.push(
        `  ${label} ${renderProgressBar(b.remainingFraction)} ${String(pct).padStart(3)}% left${suffix}`,
      );
    }
  }

  return lines.join("\n");
}

function isGeminiQuotaGroup(group: QuotaGroup): boolean {
  // Bucket ids ("gemini-5h" vs "3p-5h") — not display prose ("Gemini Models").
  return (group.buckets || []).some((b) => (b.bucketId || "").toLowerCase().includes("gemini"));
}

function selectQuotaGroup(groups: QuotaGroup[], modelId?: string): QuotaGroup | undefined {
  if (groups.length === 0) return undefined;
  const profile = getModelProfile(modelId);
  if (profile.quotaPoolKind === "3p") {
    const found = groups.find((g) => !isGeminiQuotaGroup(g));
    if (found) return found;
  }
  return groups.find((g) => isGeminiQuotaGroup(g)) || groups[0];
}

// Compact one-line footer text (e.g. "Wk 6% (2d 15h)") showing the most
// urgent window of the group backing the current model: 5h and weekly pools
// differ in volume, so the wall you hit first is min(r5h, rWk × R) — not min
// fraction. R self-calibrates from observed deltas (see calibrateWeeklyTo5hRatio).
const DEFAULT_WEEKLY_TO_5H_RATIO = 6.0;

interface WindowFractionPair {
  "5h": number;
  weekly: number;
}

function windowBucket(buckets: QuotaBucket[], kind: QuotaWindowKind): QuotaBucket | undefined {
  return buckets.find((b) => classifyQuotaWindow(b) === kind);
}

// Pool-group key for persisted pairs: the 5h bucket's wire id minus its window
// suffix ("gemini-5h" → "gemini"). Display names are upstream prose, and the raw
// id would echo the window inside every record ("gemini-5h": { "5h", weekly }).
// Unrecognized shapes keep the full id — matching only needs determinism.
function poolKey(bucket: QuotaBucket): string {
  const id = bucket.bucketId || "unknown";
  return id.replace(/[-_](5h|five-?hour|weekly)$/i, "") || id;
}

// Plain-object form for JSON persistence (see coordinator state).
function extractWindowFractionPairs(
  summary?: QuotaSummary,
): Record<string, WindowFractionPair> {
  const pairs: Record<string, WindowFractionPair> = {};
  for (const g of summary?.groups || []) {
    const bucket5h = windowBucket(g.buckets, "5h");
    const bucketWeekly = windowBucket(g.buckets, "weekly");
    if (bucket5h && bucketWeekly)
      pairs[poolKey(bucket5h)] = {
        "5h": bucket5h.remainingFraction,
        weekly: bucketWeekly.remainingFraction,
      };
  }
  return pairs;
}

// Self-calibrates the 5h vs weekly volume ratio R from delta consumption:
// the same absolute spend drops the 5h fraction R× faster than weekly.
// First valid pool wins; resets and noise fall outside the guards below.
function calibrateWeeklyTo5hRatio(
  previous: Record<string, WindowFractionPair> | undefined,
  current: Record<string, WindowFractionPair> | undefined,
  currentRatio = DEFAULT_WEEKLY_TO_5H_RATIO,
): number {
  if (!previous || !current) return currentRatio;
  for (const key of Object.keys(current)) {
    const prev = previous[key];
    const curr = current[key];
    if (!prev || !curr) continue;

    const dFiveHour = prev["5h"] - curr["5h"];
    const dWeekly = prev.weekly - curr.weekly;

    if (dFiveHour > 0.0001 && dWeekly > 0.00001) {
      const observedRatio = dFiveHour / dWeekly;
      if (observedRatio >= 1.0 && observedRatio <= 20.0) {
        return Math.round(observedRatio * 100) / 100;
      }
    }
  }
  return currentRatio;
}

function selectUrgentBucket(group: QuotaGroup, weeklyTo5hRatio: number): QuotaBucket | undefined {
  const buckets = group.buckets;
  if (buckets.length === 0) return undefined;
  const bucket5h = windowBucket(buckets, "5h");
  const bucketWeekly = windowBucket(buckets, "weekly");
  if (bucket5h && bucketWeekly) {
    return bucketWeekly.remainingFraction * weeklyTo5hRatio < bucket5h.remainingFraction
      ? bucketWeekly
      : bucket5h;
  }
  let worst = buckets[0];
  for (const b of buckets) {
    if (b.remainingFraction < worst.remainingFraction) worst = b;
  }
  return worst;
}

function buildQuotaFooter(
  summary: QuotaSummary,
  modelId?: string,
  weeklyTo5hRatio = DEFAULT_WEEKLY_TO_5H_RATIO,
  nowFn: () => number = Date.now,
): string | undefined {
  const group = selectQuotaGroup(summary.groups, modelId);
  if (!group) return undefined;
  const urgent = selectUrgentBucket(group, weeklyTo5hRatio);
  return urgent ? formatQuotaWindowPart(urgent, nowFn) : undefined;
}

// Both windows of the backing group, 5h first (e.g. "5h 35% (26m) · Wk 75% (6d 14h)").
function buildQuotaFooterBoth(
  summary: QuotaSummary,
  modelId?: string,
  nowFn: () => number = Date.now,
): string | undefined {
  const group = selectQuotaGroup(summary.groups, modelId);
  if (!group || group.buckets.length === 0) return undefined;
  return sortQuotaBuckets(group.buckets)
    .map((b) => formatQuotaWindowPart(b, nowFn))
    .join(" · ");
}

// Window prefix names the bucket ("5h"/"Wk"); unknown windows fall back to
// the bucket's own display name.
function formatQuotaWindowPart(bucket: QuotaBucket, nowFn: () => number = Date.now): string {
  const kind = classifyQuotaWindow(bucket);
  const prefix =
    kind === "5h" ? "5h" : kind === "weekly" ? "Wk" : bucket.displayName || bucket.bucketId;
  const pct = Math.round(bucket.remainingFraction * 100);
  const short = formatResetRemaining(bucket.resetTime, nowFn)?.replace(/^in /, "");
  if (short && pct < 100) return `${prefix} ${pct}% (${short})`;
  return `${prefix} ${pct}%`;
}

// Threshold coloring for footer slots. Prefers Theme.fg when available so
// coloring adapts to the active theme (light/dark/custom); falls back to basic
// ANSI on dark (mirroring Theme.fg with foreground-only resets) when invoked
// without a theme (e.g. tests, headless, or mock contexts).
const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_DIM = "\x1b[90m";
const ANSI_FG_RESET = "\x1b[39m";

const QUOTA_WARN_PCT = 30;
const QUOTA_ALERT_PCT = 10;

type QuotaColorTone = "error" | "warning" | "dim";
type QuotaColorizer = (tone: QuotaColorTone, text: string) => string;
export type QuotaColorStyle =
  | { fg: (tone: QuotaColorTone, text: string) => string }
  | QuotaColorizer;

function resolveColorizer(style?: QuotaColorStyle): QuotaColorizer {
  if (typeof style === "function") return style;
  if (style && typeof style.fg === "function") return (tone, text) => style.fg(tone, text);
  return (tone, text) => {
    const code = tone === "error" ? ANSI_RED : tone === "warning" ? ANSI_YELLOW : ANSI_DIM;
    return `${code}${text}${ANSI_FG_RESET}`;
  };
}

function colorizeQuotaFooter(
  footer: string | undefined,
  style?: QuotaColorStyle,
): string | undefined {
  if (!footer) return undefined;
  const color = resolveColorizer(style);
  const match = footer.match(/(\d+)%/);
  if (!match) return color("dim", footer);
  const pct = parseInt(match[1], 10);
  if (pct <= QUOTA_ALERT_PCT) return color("error", footer);
  if (pct <= QUOTA_WARN_PCT) return color("warning", footer);
  return color("dim", footer);
}

// Colors each " · "-separated window part by its own percentage.
function colorizeQuotaFooterBoth(
  footer: string | undefined,
  style?: QuotaColorStyle,
): string | undefined {
  if (!footer) return undefined;
  const color = resolveColorizer(style);
  const sep = color("dim", " · ");
  return footer
    .split(" · ")
    .map((part) => colorizeQuotaFooter(part, style) ?? part)
    .join(sep);
}

function previewQuotaFooterText(
  coord: QuotaStatus | undefined,
  modelId: string | undefined,
  mode: string,
  style?: QuotaColorStyle,
): string | undefined {
  if (!coord) return undefined;
  const normalized = normalizeFooterMode(mode);
  if (!normalized || normalized === "off") return undefined;
  const { colored } = coord.renderFooter(modelId, normalized, style);
  if (!colored) return undefined;
  return ANSI_FG_RESET + colored;
}

// Namespaced by repo so no other extension (e.g. a personal-config "quota"
// slot) can overwrite this footer slot, and vice versa.
export const QUOTA_STATUS_KEY = "pi-provider-antigravity-footer-usage";
const QUOTA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// Baselines older than this may straddle a quota reset (negative or
// meaningless deltas), so cross-session calibration ignores them. An hour
// caps the straddle risk at ~1/5 of the 5h window while an hour of active
// use still dwarfs the noise guards below thousands-fold.
const MAX_OBSERVATION_AGE_MS = 60 * 60 * 1000;

// Persisted Quota Pool calibration state (states.quota in the provider file).
// The file shape is owned by the settings subsystem; the coordinator only sees
// this narrow view through its store.
export interface QuotaState {
  [key: string]: unknown;
}

// The seam behind the coordinator: production uses the file-backed store
// from local config file, tests use an in-memory adapter or custom file.
export interface QuotaStatusStore {
  loadMode: () => QuotaFooterMode;
  loadQuotaState: () => QuotaState | undefined;
  saveQuotaState: (state: {
    weeklyTo5hRatio: number;
    previousObservation: Record<string, WindowFractionPair>;
    updatedAt: number;
  }) => boolean;
}

// Production QuotaStatusStore backed by the provider file. Reads per call:
// tiny file, and edits apply on the next refresh without a restart.
export function fileQuotaStatusStore(file = defaultConfigFile()): QuotaStatusStore {
  return {
    loadMode: () => resolveFooterMode(loadProviderConfig(file)),
    loadQuotaState: () => loadSubsystemState<QuotaState>("quota", file),
    saveQuotaState: (state) => saveSubsystemState("quota", state, file),
  };
}

function createQuotaFooterField(
  quotaStatus?: QuotaStatus,
): SettingsFieldDef {
  return {
    key: "quotaFooter",
    label: "Quota footer",
    description: "Show remaining quota in Pi's status footer",
    options: FOOTER_MODE_OPTIONS,
    defaultValue: "off",
    optionNotes: FOOTER_MODE_NOTES,
    renderPreview: quotaStatus
      ? (mode, ctx, theme) => {
          if (mode === "off") return "hidden";
          const activeTheme = theme || (ctx.ui as { theme?: Theme })?.theme;
          return previewQuotaFooterText(quotaStatus, ctx.model?.id, mode, activeTheme);
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

export interface RefreshOptions {
  force?: boolean;
  // Explicit looks at quota (/antigravity usage) bypass the mode and model
  // gates but still calibrate, persist, and share the throttle window.
  ignoreMode?: boolean;
  signal?: AbortSignal;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Lenient shape check for persisted observations; garbage restores as absent.
function validPairs(raw: unknown): Record<string, WindowFractionPair> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const pairs: Record<string, WindowFractionPair> = {};
  for (const [key, value] of Object.entries(raw)) {
    const rec = value as { "5h"?: unknown; weekly?: unknown };
    const fiveHour = rec?.["5h"];
    const weekly = rec?.weekly;
    if (isFiniteNumber(fiveHour) && isFiniteNumber(weekly)) pairs[key] = { "5h": fiveHour, weekly };
  }
  return Object.keys(pairs).length > 0 ? pairs : undefined;
}

export type QuotaStatusCtx = Pick<ExtensionContext, "ui" | "modelRegistry" | "model">;

// Pi binds every ExtensionContext property read to a liveness assertion, so a
// ctx captured before a session replacement or reload throws on any read once
// the runtime is invalidated. A turn aborted by teardown still emits
// agent_settled from that invalidated runtime, so handlers receive a dead ctx.
// Probe once before touching it — painting a dead session's footer is meaningless.
function isLiveCtx(ctx: QuotaStatusCtx): boolean {
  try {
    void ctx.ui;
    return true;
  } catch {
    return false;
  }
}

export interface FooterModeDef {
  key: QuotaFooterMode;
  note?: string;
  render: (
    summary: QuotaSummary | undefined,
    modelId?: string,
    ratio?: number,
    style?: QuotaColorStyle,
    nowFn?: () => number,
  ) => { plain?: string; colored?: string };
}

export const FOOTER_MODES: Record<QuotaFooterMode, FooterModeDef> = Object.freeze({
  off: {
    key: "off",
    render: () => ({}),
  },
  smart: {
    key: "smart",
    note: FOOTER_MODE_NOTES.smart,
    render: (summary, modelId, ratio = DEFAULT_WEEKLY_TO_5H_RATIO, style, nowFn = Date.now) => {
      if (!summary) return {};
      const plain = buildQuotaFooter(summary, modelId, ratio, nowFn);
      return { plain, colored: colorizeQuotaFooter(plain, style) };
    },
  },
  all: {
    key: "all",
    note: FOOTER_MODE_NOTES.all,
    render: (summary, modelId, _ratio, style, nowFn = Date.now) => {
      if (!summary) return {};
      const plain = buildQuotaFooterBoth(summary, modelId, nowFn);
      return { plain, colored: colorizeQuotaFooterBoth(plain, style) };
    },
  },
});

export function isAntigravityModel(model?: { provider?: string }): boolean {
  return model?.provider === PROVIDER_ID;
}

export interface QuotaStatusDeps {
  store?: QuotaStatusStore;
  configFile?: string;
  fetchQuotaSummary?: (token: string, signal?: AbortSignal) => Promise<any>;
  now?: () => number;
}

export interface QuotaStatus {
  readonly ratio: number;
  mode(): QuotaFooterMode;
  refreshAndPaint(ctx: QuotaStatusCtx): Promise<void>;
  paint(ctx: QuotaStatusCtx): void;
  inspectUsage(ctx: QuotaStatusCtx & { signal?: AbortSignal }): Promise<string>;
  createSettingsField(): SettingsFieldDef;
  ensurePreview(ctx: QuotaStatusCtx): Promise<QuotaSummary | undefined>;
  refresh(ctx: QuotaStatusCtx, opts?: RefreshOptions): Promise<QuotaSummary | undefined>;
  ingest(summary: any): void;
  renderFooter(
    modelId?: string,
    mode?: QuotaFooterMode,
    style?: QuotaColorStyle,
  ): { plain?: string; colored?: string };
}

// In-memory throttle around the quota fetch: at most one network call per
// QUOTA_REFRESH_INTERVAL_MS, with inflight dedup. Failures keep the stale
// footer instead of flashing errors in the status bar.
export class QuotaStatusCoordinator implements QuotaStatus {
  private summary: QuotaSummary | undefined;
  private fetchedAt = 0;
  private inflight: Promise<QuotaSummary | undefined> | null = null;
  private weeklyTo5hRatio: number;
  private lastPairs: Record<string, WindowFractionPair> | undefined;
  private readonly store: QuotaStatusStore;
  private readonly fetchSummaryOverride?: (token: string, signal?: AbortSignal) => Promise<any>;
  private readonly nowFn: () => number;

  constructor(depsOrStoreOrFile?: QuotaStatusDeps | string | QuotaStatusStore) {
    if (typeof depsOrStoreOrFile === "string" || !depsOrStoreOrFile) {
      this.store = fileQuotaStatusStore(depsOrStoreOrFile || defaultConfigFile());
      this.nowFn = Date.now;
    } else if ("loadMode" in depsOrStoreOrFile) {
      this.store = depsOrStoreOrFile;
      this.nowFn = Date.now;
    } else {
      this.store =
        depsOrStoreOrFile.store ??
        fileQuotaStatusStore(depsOrStoreOrFile.configFile || defaultConfigFile());
      this.fetchSummaryOverride = depsOrStoreOrFile.fetchQuotaSummary;
      this.nowFn = depsOrStoreOrFile.now ?? Date.now;
    }
    this.weeklyTo5hRatio = DEFAULT_WEEKLY_TO_5H_RATIO;
    this.loadPersisted();
  }

  get ratio(): number {
    return this.weeklyTo5hRatio;
  }

  // Single source of truth for the mode: the injected store.
  mode(): QuotaFooterMode {
    return this.store.loadMode();
  }

  footerFor(modelId?: string, mode: QuotaFooterMode = "smart"): string | undefined {
    return FOOTER_MODES[mode]?.render(this.summary, modelId, this.weeklyTo5hRatio, undefined, this.nowFn).plain;
  }

  renderFooter(
    modelId?: string,
    mode: QuotaFooterMode = "smart",
    style?: QuotaColorStyle,
  ): { plain?: string; colored?: string } {
    return FOOTER_MODES[mode]?.render(this.summary, modelId, this.weeklyTo5hRatio, style, this.nowFn) ?? {};
  }

  get isFresh(): boolean {
    return !!this.summary && this.nowFn() - this.fetchedAt < QUOTA_REFRESH_INTERVAL_MS;
  }

  refresh(ctx: QuotaStatusCtx, opts: RefreshOptions = {}): Promise<QuotaSummary | undefined> {
    if (!isLiveCtx(ctx)) return Promise.resolve(undefined);
    if (!opts.ignoreMode && (this.mode() === "off" || !isAntigravityModel(ctx.model))) {
      return Promise.resolve(undefined);
    }
    if (this.inflight) return this.inflight;
    if (!opts.force && this.isFresh) return Promise.resolve(this.summary);
    return this.fetchOnce(ctx, opts.signal);
  }

  // The single ordering behind the footer slot: paint cached text instantly,
  // refresh when the throttle window expired, repaint with fresh text.
  // Event handlers delegate here instead of replicating the sequence.
  async refreshAndPaint(ctx: QuotaStatusCtx): Promise<void> {
    this.paint(ctx);
    await this.refresh(ctx);
    this.paint(ctx);
  }

  // Paints current cached quota status to the footer slot.
  paint(ctx: QuotaStatusCtx): void {
    if (!isLiveCtx(ctx)) return;
    const mode = this.mode();
    if (mode === "off" || !isAntigravityModel(ctx.model)) {
      ctx.ui.setStatus(QUOTA_STATUS_KEY, undefined);
      return;
    }
    const theme = (ctx.ui as { theme?: Theme })?.theme;
    const { colored } = this.renderFooter(ctx.model?.id, mode, theme);
    ctx.ui.setStatus(QUOTA_STATUS_KEY, colored);
  }

  // Atomic inspect for /antigravity usage: forces fresh quota fetch, repaints
  // the footer slot, and formats the full summary. Callers need no flag knowledge.
  async inspectUsage(ctx: QuotaStatusCtx & { signal?: AbortSignal }): Promise<string> {
    const summary = await this.refresh(ctx, { force: true, ignoreMode: true, signal: ctx.signal });
    if (!summary) {
      throw new Error("Failed to fetch usage.");
    }
    this.paint(ctx);
    return formatQuotaSummary(summary, this.nowFn);
  }

  createSettingsField(): SettingsFieldDef {
    return createQuotaFooterField(this);
  }

  // One fetch for preview purposes even when the footer slot is off or the
  // current model belongs to another provider: opening quota settings is an
  // explicit look at quota (like /antigravity usage), and the preview is the
  // only place that quota is visible while a foreign model is selected.
  ensurePreview(ctx: QuotaStatusCtx): Promise<QuotaSummary | undefined> {
    if (this.summary) return Promise.resolve(this.summary);
    if (this.inflight) return this.inflight;
    return this.fetchOnce(ctx);
  }

  private fetchOnce(ctx: QuotaStatusCtx, signal?: AbortSignal): Promise<QuotaSummary | undefined> {
    this.inflight = this.fetch(ctx, signal).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetch(
    ctx: QuotaStatusCtx,
    signal?: AbortSignal,
  ): Promise<QuotaSummary | undefined> {
    try {
      const creds = await resolveCredentials(ctx);
      if (!creds) return undefined;

      let rawSummary: any;
      if (this.fetchSummaryOverride) {
        rawSummary = await this.fetchSummaryOverride(creds.token, signal);
      } else {
        rawSummary = await postAntigravityJson<any>({
          auth: creds,
          path: "v1internal:retrieveUserQuotaSummary",
          body: { project: creds.projectId },
          signal,
        });
      }
      if (!rawSummary) return undefined;
      const summary = rawSummary.groups ? parseQuotaSummary(rawSummary) : rawSummary;
      this.ingest(summary);
      return summary;
    } catch {
      return undefined;
    }
  }

  // Accepts an externally fetched summary or raw JSON into the shared cache: same
  // calibration, persistence, and freshness as fetch().
  ingest(summaryOrRaw: any): void {
    const summary: QuotaSummary =
      summaryOrRaw && summaryOrRaw.groups && typeof summaryOrRaw.groups[0]?.buckets?.[0]?.remainingFraction === "number"
        ? parseQuotaSummary(summaryOrRaw)
        : summaryOrRaw;

    const calibrated = calibrateWeeklyTo5hRatio(
      this.lastPairs,
      extractWindowFractionPairs(summary),
      this.weeklyTo5hRatio,
    );
    this.weeklyTo5hRatio = calibrated;
    this.lastPairs = extractWindowFractionPairs(summary);
    this.summary = summary;
    this.fetchedAt = this.nowFn();
    this.saveState();
  }

  private loadPersisted(): void {
    const entry = this.store.loadQuotaState();
    const ratio = entry?.weeklyTo5hRatio;
    if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0) {
      this.weeklyTo5hRatio = ratio;
    }
    const at = entry?.updatedAt;
    this.lastPairs =
      typeof at === "number" && this.nowFn() - at <= MAX_OBSERVATION_AGE_MS
        ? validPairs(entry?.previousObservation)
        : undefined;
  }

  // Persists calibration state through the injected store. Best-effort: a
  // stale ratio is still usable.
  private saveState(): void {
    try {
      this.store.saveQuotaState({
        weeklyTo5hRatio: this.weeklyTo5hRatio,
        previousObservation: this.lastPairs ?? {},
        updatedAt: this.nowFn(),
      });
    } catch {
      // Cache is best-effort; a stale ratio is still usable.
    }
  }
}

export function createQuotaStatus(
  deps?: QuotaStatusDeps | string | QuotaStatusStore,
): QuotaStatus {
  return new QuotaStatusCoordinator(deps);
}
