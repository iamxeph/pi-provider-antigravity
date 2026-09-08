import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseStoredCredentials } from "./auth.ts";
import { PROVIDER_ID } from "./protocol.ts";
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
export const PROVIDER_CONFIG_FILE = "pi-provider-antigravity.json";
// Baselines older than this may straddle a quota reset (negative or
// meaningless deltas), so cross-session calibration ignores them. An hour
// caps the straddle risk at ~1/5 of the 5h window while an hour of active
// use still dwarfs the noise guards below thousands-fold.
export const MAX_OBSERVATION_AGE_MS = 60 * 60 * 1000;

export interface ProviderFileConfig {
  settings?: { quotaFooter?: unknown; [key: string]: unknown };
  // Runtime state namespaced per subsystem (e.g. states.quota); unknown
  // entries pass through untouched.
  states?: { [name: string]: { [key: string]: unknown } | undefined };
}

export type QuotaFooterMode = "off" | "single" | "both";

// Single opt-in file next to Pi's settings.json (NOT settings.json itself —
// Pi manages that file and may drop unknown keys). Pi resolves its dir via
// PI_CODING_AGENT_DIR else ~/.pi/agent; mirror that:
//   { "settings": { "quotaFooter": "single" } }   // off (default) | single | both
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

export function normalizeFooterMode(value: unknown): QuotaFooterMode | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v === "off" || v === "single" || v === "both" ? v : undefined;
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

export function resolveFooterMode(config?: ProviderFileConfig): QuotaFooterMode {
  return normalizeFooterMode(config?.settings?.quotaFooter) ?? "off";
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
  private readonly configFile: string;

  constructor(configFile = defaultConfigFile()) {
    this.configFile = configFile;
    this.weeklyTo5hRatio = DEFAULT_WEEKLY_TO_5H_RATIO;
    this.loadPersisted();
  }

  get ratio(): number {
    return this.weeklyTo5hRatio;
  }

  // Single source of truth for the mode: the coordinator's own file.
  mode(): QuotaFooterMode {
    return resolveFooterMode(loadProviderConfig(this.configFile));
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
    const quota = loadProviderConfig(this.configFile)?.states?.quota;
    const entry = quota && typeof quota === "object" && !Array.isArray(quota)
      ? (quota as { weeklyTo5hRatio?: unknown; previousObservation?: unknown; updatedAt?: unknown })
      : undefined;
    const ratio = entry?.weeklyTo5hRatio;
    if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0) {
      this.weeklyTo5hRatio = ratio;
    }
    const at = entry?.updatedAt;
    this.lastPairs = typeof at === "number" && Date.now() - at <= MAX_OBSERVATION_AGE_MS
      ? validPairs(entry?.previousObservation)
      : undefined;
  }

  // Merges state into the existing file, preserving settings and unknown
  // keys. Never clobbers a file we couldn't parse.
  private saveState(): void {
    try {
      let data: ProviderFileConfig = {};
      try {
        const raw = JSON.parse(fs.readFileSync(this.configFile, "utf-8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        data = raw as ProviderFileConfig;
      } catch (err: any) {
        if (err?.code !== "ENOENT") return;
      }
      const states =
        data.states && typeof data.states === "object" && !Array.isArray(data.states) ? data.states : {};
      const quota =
        states.quota && typeof states.quota === "object" && !Array.isArray(states.quota) ? states.quota : {};
      states.quota = {
        ...quota,
        weeklyTo5hRatio: this.weeklyTo5hRatio,
        previousObservation: this.lastPairs ?? {},
        updatedAt: Date.now(),
      };
      data.states = states;
      if (!saveProviderConfig(this.configFile, data)) return;
    } catch {
      // Cache is best-effort; a stale ratio is still usable.
    }
  }
}
