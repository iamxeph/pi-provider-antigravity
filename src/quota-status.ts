import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseStoredCredentials } from "./auth.ts";
import { classifyModelFamily } from "./model-catalog.ts";
import { postAntigravity, PROVIDER_ID } from "./protocol.ts";

/**
 * Quota Status module (deep, mock): everything behind the footer slot and
 * /antigravity usage — Quota Pool wire parse, urgent-window math, ratio
 * self-calibration, throttle, cache, and calibration persistence.
 * Callers use footerFor / ingest / refresh / refreshAndPaint only; the fetch,
 * the ratio state, and the file shape behind the injected store are internal.
 * The store itself (file-backed or in-memory) arrives through QuotaStatusStore.
 */

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

export function renderProgressBar(fraction: number, width = 10): string {
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
    .sort((a, b) => QUOTA_WINDOW_RANK[classifyQuotaWindow(a)] - QUOTA_WINDOW_RANK[classifyQuotaWindow(b)]);
}

export function formatResetRemaining(resetTime?: string): string | null {
  if (!resetTime) return null;
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) return null;
  const delta = ts - Date.now();
  if (delta <= 0) return "ready";
  const totalMin = Math.ceil(delta / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

export function parseQuotaSummary(data: any): QuotaSummary {
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

export function formatQuotaSummary(summary: QuotaSummary): string {
  const lines: string[] = [];

  for (const group of summary.groups) {
    if (lines.length > 0) lines.push("");
    lines.push(`${group.displayName}`);
    for (const b of sortQuotaBuckets(group.buckets)) {
      const pct = Math.round(b.remainingFraction * 100);
      const label = shortWindowLabel(b, classifyQuotaWindow(b)).padEnd(3);
      const reset = formatResetRemaining(b.resetTime);
      const suffix = reset && pct < 100 ? ` (${reset})` : "";
      lines.push(`  ${label} ${renderProgressBar(b.remainingFraction)} ${String(pct).padStart(3)}% left${suffix}`);
    }
  }

  return lines.join("\n");
}

export function isGeminiQuotaGroup(group: QuotaGroup): boolean {
  // Bucket ids ("gemini-5h" vs "3p-5h") — not display prose ("Gemini Models").
  return (group.buckets || []).some((b) => (b.bucketId || "").toLowerCase().includes("gemini"));
}

export function selectQuotaGroup(groups: QuotaGroup[], modelId?: string): QuotaGroup | undefined {
  if (groups.length === 0) return undefined;
  const family = classifyModelFamily(modelId);
  if (family === "claude" || family === "gpt") {
    const found = groups.find((g) => !isGeminiQuotaGroup(g));
    if (found) return found;
  }
  return groups.find((g) => isGeminiQuotaGroup(g)) || groups[0];
}

// Compact one-line footer text (e.g. "Wk 6% (2d 15h)") showing the most
// urgent window of the group backing the current model: 5h and weekly pools
// differ in volume, so the wall you hit first is min(r5h, rWk × R) — not min
// fraction. R self-calibrates from observed deltas (see calibrateWeeklyTo5hRatio).
export const DEFAULT_WEEKLY_TO_5H_RATIO = 6.0;

export interface WindowFractionPair {
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
export function extractWindowFractionPairs(summary?: QuotaSummary): Record<string, WindowFractionPair> {
  const pairs: Record<string, WindowFractionPair> = {};
  for (const g of summary?.groups || []) {
    const bucket5h = windowBucket(g.buckets, "5h");
    const bucketWeekly = windowBucket(g.buckets, "weekly");
    if (bucket5h && bucketWeekly) pairs[poolKey(bucket5h)] = { "5h": bucket5h.remainingFraction, weekly: bucketWeekly.remainingFraction };
  }
  return pairs;
}

// Self-calibrates the 5h vs weekly volume ratio R from delta consumption:
// the same absolute spend drops the 5h fraction R× faster than weekly.
// First valid pool wins; resets and noise fall outside the guards below.
export function calibrateWeeklyTo5hRatio(
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
    return bucketWeekly.remainingFraction * weeklyTo5hRatio < bucket5h.remainingFraction ? bucketWeekly : bucket5h;
  }
  let worst = buckets[0];
  for (const b of buckets) {
    if (b.remainingFraction < worst.remainingFraction) worst = b;
  }
  return worst;
}

export function buildQuotaFooter(
  summary: QuotaSummary,
  modelId?: string,
  weeklyTo5hRatio = DEFAULT_WEEKLY_TO_5H_RATIO,
): string | undefined {
  const group = selectQuotaGroup(summary.groups, modelId);
  if (!group) return undefined;
  const urgent = selectUrgentBucket(group, weeklyTo5hRatio);
  return urgent ? formatQuotaWindowPart(urgent) : undefined;
}

// Both windows of the backing group, 5h first (e.g. "5h 35% (26m) · Wk 75% (6d 14h)").
export function buildQuotaFooterBoth(summary: QuotaSummary, modelId?: string): string | undefined {
  const group = selectQuotaGroup(summary.groups, modelId);
  if (!group || group.buckets.length === 0) return undefined;
  return sortQuotaBuckets(group.buckets).map(formatQuotaWindowPart).join(" · ");
}

// Window prefix names the bucket ("5h"/"Wk"); unknown windows fall back to
// the bucket's own display name.
export function formatQuotaWindowPart(bucket: QuotaBucket): string {
  const kind = classifyQuotaWindow(bucket);
  const prefix = kind === "5h" ? "5h" : kind === "weekly" ? "Wk" : bucket.displayName || bucket.bucketId;
  const pct = Math.round(bucket.remainingFraction * 100);
  const short = formatResetRemaining(bucket.resetTime)?.replace(/^in /, "");
  if (short && pct < 100) return `${prefix} ${pct}% (${short})`;
  return `${prefix} ${pct}%`;
}

// Threshold coloring for footer slots. Event handlers never see Theme, so this
// uses basic ANSI (theme.fg("error"/"warning") equivalents on dark) with a
// foreground-only reset, mirroring Theme.fg instead of a full reset.
const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";
export const ANSI_FG_RESET = "\x1b[39m";

export const QUOTA_WARN_PCT = 30;
export const QUOTA_ALERT_PCT = 10;

export function colorizeQuotaFooter(footer: string | undefined): string | undefined {
  if (!footer) return undefined;
  const match = footer.match(/(\d+)%/);
  if (!match) return footer;
  const pct = parseInt(match[1], 10);
  if (pct <= QUOTA_ALERT_PCT) return `${ANSI_RED}${footer}${ANSI_FG_RESET}`;
  if (pct <= QUOTA_WARN_PCT) return `${ANSI_YELLOW}${footer}${ANSI_FG_RESET}`;
  return footer;
}

// Colors each " · "-separated window part by its own percentage.
export function colorizeQuotaFooterBoth(footer: string | undefined): string | undefined {
  if (!footer) return undefined;
  return footer
    .split(" · ")
    .map((part) => colorizeQuotaFooter(part) ?? part)
    .join(" · ");
}

// Namespaced by repo so no other extension (e.g. a personal-config "quota"
// slot) can overwrite this footer slot, and vice versa.
export const QUOTA_STATUS_KEY = "pi-provider-antigravity-footer-usage";
export const QUOTA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// Baselines older than this may straddle a quota reset (negative or
// meaningless deltas), so cross-session calibration ignores them. An hour
// caps the straddle risk at ~1/5 of the 5h window while an hour of active
// use still dwarfs the noise guards below thousands-fold.
export const MAX_OBSERVATION_AGE_MS = 60 * 60 * 1000;

// Persisted Quota Pool calibration state (states.quota in the provider file).
// The file shape is owned by the settings module; the coordinator only sees
// this narrow view through its store.
export interface QuotaState {
  [key: string]: unknown;
}

// The seam behind the coordinator: production uses the file-backed store
// from the settings module, tests use an in-memory adapter.
export interface QuotaStatusStore {
  loadMode: () => QuotaFooterMode;
  loadQuotaState: () => QuotaState | undefined;
  saveQuotaState: (state: {
    weeklyTo5hRatio: number;
    previousObservation: Record<string, WindowFractionPair>;
    updatedAt: number;
  }) => boolean;
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

export type QuotaFooterMode = "off" | "smart" | "all";

export interface FooterModeDef {
  key: QuotaFooterMode;
  render: (
    summary: QuotaSummary | undefined,
    modelId?: string,
    ratio?: number,
  ) => { plain?: string; colored?: string };
}

export const FOOTER_MODES: Record<QuotaFooterMode, FooterModeDef> = Object.freeze({
  off: {
    key: "off",
    render: () => ({}),
  },
  smart: {
    key: "smart",
    render: (summary, modelId, ratio = DEFAULT_WEEKLY_TO_5H_RATIO) => {
      if (!summary) return {};
      const plain = buildQuotaFooter(summary, modelId, ratio);
      return { plain, colored: colorizeQuotaFooter(plain) };
    },
  },
  all: {
    key: "all",
    render: (summary, modelId) => {
      if (!summary) return {};
      const plain = buildQuotaFooterBoth(summary, modelId);
      return { plain, colored: colorizeQuotaFooterBoth(plain) };
    },
  },
});

export const FOOTER_MODE_OPTIONS: readonly QuotaFooterMode[] = Object.freeze(
  Object.keys(FOOTER_MODES) as QuotaFooterMode[],
);

export function normalizeFooterMode(value: unknown): QuotaFooterMode | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v in FOOTER_MODES ? (v as QuotaFooterMode) : undefined;
}

export function isAntigravityModel(model?: { provider?: string }): boolean {
  return model?.provider === PROVIDER_ID;
}

export function paintQuotaStatus(coord: QuotaStatusCoordinator, ctx: QuotaStatusCtx): void {
  coord.paint(ctx);
}

// In-memory throttle around the quota fetch: at most one network call per
// QUOTA_REFRESH_INTERVAL_MS, with inflight dedup. Failures keep the stale
// footer instead of flashing errors in the status bar.
export class QuotaStatusCoordinator {
  private summary: QuotaSummary | undefined;
  private fetchedAt = 0;
  private inflight: Promise<QuotaSummary | undefined> | null = null;
  private weeklyTo5hRatio: number;
  private lastPairs: Record<string, WindowFractionPair> | undefined;
  private readonly store: QuotaStatusStore;

  constructor(store: QuotaStatusStore) {
    this.store = store;
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
    return FOOTER_MODES[mode]?.render(this.summary, modelId, this.weeklyTo5hRatio).plain;
  }

  renderFooter(
    modelId?: string,
    mode: QuotaFooterMode = "smart",
  ): { plain?: string; colored?: string } {
    return FOOTER_MODES[mode]?.render(this.summary, modelId, this.weeklyTo5hRatio) ?? {};
  }

  get isFresh(): boolean {
    return !!this.summary && Date.now() - this.fetchedAt < QUOTA_REFRESH_INTERVAL_MS;
  }

  refresh(ctx: QuotaStatusCtx, opts: RefreshOptions = {}): Promise<QuotaSummary | undefined> {
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
    const mode = this.mode();
    if (mode === "off" || !isAntigravityModel(ctx.model)) {
      ctx.ui.setStatus(QUOTA_STATUS_KEY, undefined);
      return;
    }
    const { colored } = this.renderFooter(ctx.model?.id, mode);
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
    return formatQuotaSummary(summary);
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

  private async fetch(ctx: QuotaStatusCtx, signal?: AbortSignal): Promise<QuotaSummary | undefined> {
    try {
      const apiKey = await ctx.modelRegistry?.getApiKeyForProvider?.(PROVIDER_ID);
      if (!apiKey) return undefined;
      const { token, projectId } = parseStoredCredentials(apiKey);
      if (!token) return undefined;
      const res = await postAntigravity({
        token,
        path: "v1internal:retrieveUserQuotaSummary",
        body: { project: projectId },
        signal,
      });
      if (!res.ok) return undefined;
      const summary = parseQuotaSummary(await res.json());
      this.ingest(summary);
      return summary;
    } catch {
      return undefined;
    }
  }

  // Accepts an externally fetched summary into the shared cache: same
  // calibration, persistence, and freshness as fetch().
  ingest(summary: QuotaSummary): void {
    const calibrated = calibrateWeeklyTo5hRatio(this.lastPairs, extractWindowFractionPairs(summary), this.weeklyTo5hRatio);
    this.weeklyTo5hRatio = calibrated;
    this.lastPairs = extractWindowFractionPairs(summary);
    this.summary = summary;
    this.fetchedAt = Date.now();
    this.saveState();
  }

  private loadPersisted(): void {
    const entry = this.store.loadQuotaState();
    const ratio = entry?.weeklyTo5hRatio;
    if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0) {
      this.weeklyTo5hRatio = ratio;
    }
    const at = entry?.updatedAt;
    this.lastPairs = typeof at === "number" && Date.now() - at <= MAX_OBSERVATION_AGE_MS
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
        updatedAt: Date.now(),
      });
    } catch {
      // Cache is best-effort; a stale ratio is still usable.
    }
  }
}
