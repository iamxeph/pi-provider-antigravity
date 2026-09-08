import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseStoredCredentials } from "./auth.ts";
import { PROVIDER_ID } from "./protocol.ts";
import type { QuotaFooterMode } from "./settings.ts";
import {
  buildQuotaFooter,
  buildQuotaFooterBoth,
  calibrateWeeklyTo5hRatio,
  colorizeQuotaFooter,
  colorizeQuotaFooterBoth,
  DEFAULT_WEEKLY_TO_5H_RATIO,
  extractWindowFractionPairs,
  fetchQuotaSummary,
  type QuotaSummary,
  type WindowFractionPair,
} from "./quota.ts";

// Distinct from personal-config keys (e.g. "quota") so both extensions can
// coexist without overwriting each other's footer slot.
export const QUOTA_STATUS_KEY = "antigravity_quota";
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

// Footer quota belongs to this provider: foreign models (or none selected)
// get no slot and trigger no quota fetch. Pi core keeps Model.id bare
// ("gemini-3.8-flash"); the "antigravity/..." form is only /model selection
// syntax, so the provider field is the single reliable signal.
export function isAntigravityModel(model?: { provider?: string }): boolean {
  return model?.provider === PROVIDER_ID;
}

export function paintQuotaStatus(coord: QuotaStatusCoordinator, ctx: QuotaStatusCtx): void {
  const mode = coord.mode();
  if (mode === "off" || !isAntigravityModel(ctx.model)) {
    ctx.ui.setStatus(QUOTA_STATUS_KEY, undefined);
    return;
  }
  const plain = coord.footerFor(ctx.model?.id, mode);
  ctx.ui.setStatus(
    QUOTA_STATUS_KEY,
    mode === "both" ? colorizeQuotaFooterBoth(plain) : colorizeQuotaFooter(plain),
  );
}

// In-memory throttle around fetchQuotaSummary: at most one network call per
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

  footerFor(modelId?: string, mode: QuotaFooterMode = "single"): string | undefined {
    if (!this.summary || mode === "off") return undefined;
    return mode === "both"
      ? buildQuotaFooterBoth(this.summary, modelId)
      : buildQuotaFooter(this.summary, modelId, this.weeklyTo5hRatio);
  }

  get isFresh(): boolean {
    return !!this.summary && Date.now() - this.fetchedAt < QUOTA_REFRESH_INTERVAL_MS;
  }

  refresh(ctx: QuotaStatusCtx, force = false): Promise<QuotaSummary | undefined> {
    if (this.mode() === "off" || !isAntigravityModel(ctx.model)) return Promise.resolve(undefined);
    if (this.inflight) return this.inflight;
    if (!force && this.isFresh) return Promise.resolve(this.summary);
    return this.fetchOnce(ctx);
  }

  // The single ordering behind the footer slot: paint cached text instantly,
  // refresh when the throttle window expired, repaint with fresh text.
  // Event handlers delegate here instead of replicating the sequence.
  async refreshAndPaint(ctx: QuotaStatusCtx): Promise<void> {
    paintQuotaStatus(this, ctx);
    await this.refresh(ctx);
    paintQuotaStatus(this, ctx);
  }

  // One fetch for preview purposes even when the footer slot is off: opening
  // quota settings is an explicit look at quota.
  ensurePreview(ctx: QuotaStatusCtx): Promise<QuotaSummary | undefined> {
    if (this.summary) return Promise.resolve(this.summary);
    if (this.inflight) return this.inflight;
    if (!isAntigravityModel(ctx.model)) return Promise.resolve(undefined);
    return this.fetchOnce(ctx);
  }

  private fetchOnce(ctx: QuotaStatusCtx): Promise<QuotaSummary | undefined> {
    this.inflight = this.fetch(ctx).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetch(ctx: QuotaStatusCtx): Promise<QuotaSummary | undefined> {
    try {
      const apiKey = await ctx.modelRegistry?.getApiKeyForProvider?.(PROVIDER_ID);
      if (!apiKey) return undefined;
      const { token, projectId } = parseStoredCredentials(apiKey);
      if (!token) return undefined;
      const summary = await fetchQuotaSummary(token, projectId);
      this.ingest(summary);
      return summary;
    } catch {
      return undefined;
    }
  }

  // Accepts an externally fetched summary (e.g. /antigravity usage) into the
  // shared cache: same calibration, persistence, and freshness as fetch().
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
