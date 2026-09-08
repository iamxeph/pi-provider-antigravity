import { postAntigravity } from "./protocol.ts";

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
  const lower = (modelId || "").toLowerCase();
  if (lower.includes("claude") || lower.includes("gpt") || lower.includes("3p")) {
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
const ANSI_FG_RESET = "\x1b[39m";

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

export async function fetchQuotaSummary(
  token: string,
  projectId: string,
  signal?: AbortSignal
): Promise<QuotaSummary> {
  const res = await postAntigravity({
    token,
    path: "v1internal:retrieveUserQuotaSummary",
    body: { project: projectId },
    signal,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to fetch quota summary (${res.status}): ${errText}`);
  }
  const json = await res.json();
  return parseQuotaSummary(json);
}
