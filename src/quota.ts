import { buildAntigravityHeaders, DEFAULT_ENDPOINT, formatApiError, withMetadataTimeout } from "./protocol.ts";

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
  const s = `${bucket.window || ""} ${bucket.displayName || ""} ${bucket.bucketId || ""}`.toLowerCase();
  if (s.includes("5h") || s.includes("five") || s.includes("rolling")) return "5h";
  if (s.includes("week")) return "weekly";
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

function formatResetRemaining(resetTime?: string): string | null {
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

export async function fetchQuotaSummary(
  token: string,
  projectId = "aicode-consumers",
  endpoint = DEFAULT_ENDPOINT,
  signal?: AbortSignal
): Promise<QuotaSummary> {
  const timeout = withMetadataTimeout(signal);
  try {
    const res = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
      method: "POST",
      headers: buildAntigravityHeaders(token),
      body: JSON.stringify({ project: projectId }),
      signal: timeout.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(formatApiError(res.status, errText));
    }
    const json = await res.json();
    return parseQuotaSummary(json);
  } finally {
    timeout.dispose();
  }
}
