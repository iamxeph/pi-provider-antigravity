import type { Model } from "@earendil-works/pi-ai";
import { DEFAULT_ENDPOINT, PROVIDER_ID } from "./protocol.ts";

/**
 * Model Catalog map (pure, in-process): Public Model ID ↔ Runtime Model ID
 * mapping, Model Plan resolution, the versioned snapshot store, Pi Model
 * synthesis, and presentation (display names, Subcommand table format).
 * No network, no credentials, no persistence — the wire side
 * (fetch/parse/publish) lives in catalog-refresh.ts and talks to this
 * module only through ingestCatalog (writes) and the snapshot accessors
 * (reads), so one ingested generation is the single freshness truth.
 */
export function extractBaseModelId(runtimeId: string): string {
  if (runtimeId === "gemini-pro-agent") return "gemini-3.1-pro";
  if (runtimeId.startsWith("gemini-3.1-pro-")) return "gemini-3.1-pro";

  return runtimeId.replace(/-(?:high|medium|low|tiered|thinking|agent|extra-low)$/, "");
}

/**
 * Checks Model Family compatibility for thoughtSignature replay.
 * Official agy CLI wire captures demonstrate that:
 * - Gemini models (gemini-3.7, gemini-3.8, etc.) share thoughtSignatures seamlessly.
 * - Claude models replay thoughtSignatures within the Claude family, part-split
 *   like Gemini (1.1.27 stream_turn8/9 counter-capture).
 * - Non-Gemini models (Claude, GPT-OSS) do NOT share signatures with Gemini models.
 */
export type ModelFamily = "gemini" | "claude" | "gpt" | "unknown";

/**
 * The single model-identity predicate (see CONTEXT.md Model Family): which
 * family a model ID belongs to. Accepts any ID space — Public or Runtime
 * Model ID, with or without a `provider/` prefix — by stripping the prefix
 * before the prefix match, so every caller classifies identically. Unknown
 * (including missing) IDs report "unknown"; mapping that onto a Quota Pool
 * or plan flags stays with the consumer, preserving each caller's default.
 */
export function classifyModelFamily(modelId?: string): ModelFamily {
  const bare = ((modelId || "").split("/").pop() || "").toLowerCase();
  if (bare.startsWith("gemini-")) return "gemini";
  if (bare.startsWith("claude-")) return "claude";
  if (bare.startsWith("gpt-")) return "gpt";
  return "unknown";
}

export function isCompatibleFamily(msgModel?: string, targetModelId?: string): boolean {
  if (!msgModel || !targetModelId) return true;
  if (msgModel === targetModelId) return true;

  const msgFamily = classifyModelFamily(msgModel);
  if (msgFamily !== "unknown" && msgFamily === classifyModelFamily(targetModelId)) return true;

  return extractBaseModelId(msgModel) === extractBaseModelId(targetModelId);
}

export interface AvailableModelItem {
  id: string;
  displayName?: string;
  modelEnum?: string;
  remainingFraction?: number;
  resetTime?: string;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  minThinkingBudget?: number;
  supportsImages?: boolean;
  maxTokens?: number;
  maxOutputTokens?: number;
}

export interface AvailableModelsCatalog {
  models: AvailableModelItem[];
  modelEnums: Record<string, string>;
  agentModelSorts?: string[];
  deprecated?: Record<string, string>;
}

// Active catalog state: single versioned snapshot. refreshCatalog owns writes;
// request paths take one snapshot per call so enums, runtime IDs, and thinking
// configs always come from the same refresh generation (see Model Plan in CONTEXT.md).
export interface CatalogThinking {
  budget?: number;
  supportsThinking?: boolean;
}

export interface CatalogSnapshot {
  enums: Record<string, string>;
  runtimeIds: string[];
  thinking?: Record<string, CatalogThinking>;
  deprecated?: Record<string, string>;
  version: number;
}

/**
 * Builds the per-Runtime-ID thinking lookup for a snapshot generation from
 * parsed catalog items. Pure: shared by the refresh path and tests so both
 * derive the same snapshot shape from one parse.
 */
export function buildThinkingMap(models: AvailableModelItem[]): Record<string, CatalogThinking> {
  return Object.fromEntries(
    models.map((m) => [
      m.id,
      {
        ...(typeof m.thinkingBudget === "number" ? { budget: m.thinkingBudget } : {}),
        supportsThinking: m.supportsThinking ?? false,
      },
    ]),
  );
}

let activeStore: CatalogSnapshot = {
  enums: {},
  runtimeIds: [],
  thinking: {},
  deprecated: {},
  version: 0,
};

export function getCatalogSnapshot(): CatalogSnapshot {
  return {
    enums: { ...activeStore.enums },
    runtimeIds: [...activeStore.runtimeIds],
    thinking: Object.fromEntries(
      Object.entries(activeStore.thinking ?? {}).map(([id, info]) => [id, { ...info }]),
    ),
    deprecated: { ...(activeStore.deprecated ?? {}) },
    version: activeStore.version,
  };
}

/**
 * Records one complete refresh generation. Wire-side only: the sole writer is
 * the refresh path in catalog-refresh.ts. Request paths never call this —
 * they read via getCatalogSnapshot and pass the snapshot explicitly.
 */
export function updateCatalogStore(
  enums: Record<string, string>,
  runtimeIds: string[],
  thinking: Record<string, CatalogThinking> = {},
  deprecated: Record<string, string> = {}
): void {
  // A fresh generation is complete: replace instead of merging, so enums for
  // server-removed models are evicted instead of pinned forever.
  activeStore = {
    enums: { ...enums },
    runtimeIds: [...new Set(runtimeIds)],
    thinking: { ...thinking },
    deprecated: { ...deprecated },
    version: activeStore.version + 1,
  };
}

// Last full Model Catalog generation behind the single catalog seam: the
// snapshot holds only IDs/enums/thinking, while the models table also needs
// display names, quota flags, and sort order. Written only by ingestCatalog.
let lastCatalog: AvailableModelsCatalog | undefined;

/**
 * Records one complete catalog generation: snapshot store plus the full
 * items the models table formats. The sole writer is the refresh path;
 * request paths read via getCatalogSnapshot / getStoredCatalog and never
 * write, so one generation is always the single freshness truth.
 */
export function ingestCatalog(catalog: AvailableModelsCatalog): void {
  updateCatalogStore(
    catalog.modelEnums,
    catalog.models.map((m) => m.id),
    buildThinkingMap(catalog.models),
    catalog.deprecated || {},
  );
  lastCatalog = catalog;
}

/** Full catalog behind the seam, if any generation was ingested yet. */
export function getStoredCatalog(): AvailableModelsCatalog | undefined {
  return lastCatalog;
}

/**
 * Wire tier spellings per Pi effort, best first. A variant named after the
 * effort itself (`low` → `-low`) is tried before these, so a tier the wire adds
 * later needs no edit here; only spellings that differ or are missing are
 * listed.
 */
const TIER_FALLBACKS: Record<string, string[]> = {
  minimal: ["-low", "-extra-low", ""], // the wire lists no -minimal today
  low: ["-extra-low", ""],
  medium: ["", "-high"], // Gemini 3.1 Pro lists no -medium: up to high, never down
  high: ["-thinking", "-agent", ""], // Claude's high tier is -thinking
  xhigh: ["-high", "-thinking", "-agent", ""],
  max: ["-high", "-thinking", "-agent", ""],
};

function resolveRuntimeModelId(
  modelId: string,
  effort?: string,
  availableRuntimeIds: string[] = activeStore.runtimeIds
): string {
  if (
    modelId.endsWith("-high") ||
    modelId.endsWith("-medium") ||
    modelId.endsWith("-low") ||
    modelId.endsWith("-thinking") ||
    modelId.endsWith("-agent") ||
    modelId.endsWith("-extra-low") ||
    modelId.endsWith("-tiered")
  ) {
    return modelId;
  }

  // Tier resolution against the live snapshot: the server's own variant list is
  // the candidate set, effort only sets the suffix preference order — so newly
  // released models (e.g. gemini-3.9-flash) resolve with no code change.
  if (Array.isArray(availableRuntimeIds) && availableRuntimeIds.length > 0) {
    const variants = new Set(availableRuntimeIds.filter((id) => extractBaseModelId(id) === modelId));
    const order = [
      ...(effort ? [`-${effort}`] : []),
      ...(TIER_FALLBACKS[effort ?? ""] ?? ["-high", "-thinking", "-agent", ""]),
    ];

    for (const suffix of order) {
      if (variants.has(`${modelId}${suffix}`)) {
        return `${modelId}${suffix}`;
      }
    }

    // A model the server lists under exactly one variant (claude-opus-4-6-thinking,
    // gpt-oss-120b-medium) has no tier to choose from: that one variant serves
    // every effort.
    if (variants.size === 1) {
      return [...variants][0];
    }
  }

  // No runtime-ID list to resolve against: leave the ID unchanged. The enum
  // lookup in resolveModelPlan then fails fast with refresh guidance instead
  // of guessing a tier the server may not list.
  return modelId;
}

export interface ModelPlan {
  runtimeModelId: string;
  modelEnum: string;
  thinkingConfig: { includeThoughts: boolean; thinkingBudget: number };
  isNonGemini: boolean;
  isClaude: boolean;
}

/**
 * Resolves one Model Plan (see CONTEXT.md) from a single snapshot generation:
 * Runtime Model ID, model enum, thinking budget, and the non-Gemini flag that
 * switches tool schema mode. Pass an explicit snapshot in tests; otherwise the
 * live snapshot is read once, so enums and runtime IDs never mix generations.
 */
export function resolveModelPlan(
  publicModelId: string,
  effort?: string,
  snapshot: CatalogSnapshot = getCatalogSnapshot()
): ModelPlan {
  const runtimeModelId = followRenames(
    resolveRuntimeModelId(publicModelId, effort, snapshot.runtimeIds),
    snapshot
  );
  const modelEnum = snapshot.enums[runtimeModelId];
  if (!modelEnum) {
    // Fail fast: a retired or mistyped ID must surface here with guidance,
    // not as a cryptic server rejection for an empty model_enum label.
    throw new Error(
      `Unknown model "${runtimeModelId}" (not in catalog snapshot v${snapshot.version}). ` +
        `Run /antigravity refresh and pick a current model.`
    );
  }
  const family = classifyModelFamily(runtimeModelId);
  return {
    runtimeModelId,
    modelEnum,
    thinkingConfig: resolveThinkingConfig(runtimeModelId, snapshot),
    isNonGemini: family !== "gemini",
    isClaude: family === "claude",
  };
}

/**
 * Follows server-directed renames (deprecatedModelIds), e.g.
 * gemini-3.1-pro-high → gemini-pro-agent. Applied uniformly to derived and
 * explicitly passed IDs: the server lists the old ID as deprecated, so new
 * code must not keep sending it. Cycles terminate via the visited set.
 */
function followRenames(runtimeModelId: string, snapshot: CatalogSnapshot): string {
  const renamed = snapshot.deprecated;
  if (!renamed) return runtimeModelId;
  let current = runtimeModelId;
  const seen = new Set<string>([current]);
  while (renamed[current] && !seen.has(renamed[current])) {
    current = renamed[current];
    seen.add(current);
  }
  return current;
}

/**
 * Resolves the thinking config for one Runtime Model ID from a single snapshot
 * generation. The wire budget wins; a snapshot with no per-ID thinking data (a
 * pre-budget persist) or no wire budget for the resolved ID degrades to
 * disabled thoughts rather than a guessed budget, and self-heals on the next
 * refresh. Models the wire marks as non-thinking land here too: no budget on
 * the wire means no thoughts.
 */
function resolveThinkingConfig(
  runtimeModelId: string,
  snapshot: CatalogSnapshot = getCatalogSnapshot()
): { includeThoughts: boolean; thinkingBudget: number } {
  // Pi signals thinking-off by omitting `reasoning` entirely (never by an "off"
  // string: it is outside SimpleStreamOptions.reasoning's ThinkingLevel type),
  // so there is deliberately no string branch here. What the wire must carry
  // for that state is unverified — no capture has includeThoughts:false.
  const budget = snapshot.thinking?.[runtimeModelId]?.budget;
  return typeof budget === "number"
    ? { includeThoughts: true, thinkingBudget: budget }
    : { includeThoughts: false, thinkingBudget: 0 };
}

// Antigravity is quota-based with no per-token billing, so every model
// reports zero cost instead of fictitious Gemini API prices.
// Revisit if a metered paid tier ever appears.
export function estimateModelCost(_baseId: string): Model<any>["cost"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function synthesizeDynamicModel(baseId: string, items: AvailableModelItem[]): Model<any> {
  const repItem = items.find((it) => it.id === `${baseId}-high` || it.id === baseId) || items[0];

  // Pi must only offer effort levels the snapshot has a variant for — the same
  // suffix vocabulary the resolver reads, seen from the other side. agy's
  // vocabulary is low|medium|high (ADR-0009) and a model may list fewer:
  // Gemini 3.1 Pro has no -medium, gpt-oss only -medium, Claude only -thinking
  // (the default/high tier). `xhigh`/`max` stay unsupported (no mapping entry).
  const hasVariant = (suffixes: string[]) =>
    items.some((it) => suffixes.some((suffix) => it.id.endsWith(suffix)));
  const thinkingLevelMap = {
    off: null,
    minimal: null,
    ...(hasVariant(["-low", "-extra-low"]) ? {} : { low: null }),
    ...(hasVariant(["-medium"]) ? {} : { medium: null }),
    ...(hasVariant(["-high", "-thinking", "-agent"]) || items.some((it) => it.id === baseId)
      ? {}
      : { high: null }),
  };

  const isFlash = baseId.includes("flash");
  const isClaude = baseId.startsWith("claude-");
  const isGpt = baseId.startsWith("gpt-");

  // Static fallbacks mirror captures/agy_cli_1.2.0/models.resp.json
  // (Claude maxTokens 250000 / maxOutputTokens 64000, also seen on the wire
  // in stream_turn8/9). Live refresh overwrites these with catalog values.
  const defaultContext = isFlash ? 1048576 : isClaude ? 250000 : isGpt ? 128000 : 1048576;
  const defaultMaxOutput = isClaude ? 64000 : isGpt ? 32768 : 65536;

  return {
    id: baseId,
    name: formatModelDisplayName(baseId, repItem?.displayName),
    provider: PROVIDER_ID,
    api: "antigravity-api",
    baseUrl: DEFAULT_ENDPOINT,
    reasoning: repItem?.supportsThinking ?? true,
    thinkingLevelMap,
    input: repItem?.supportsImages ? ["text", "image"] : ["text"],
    cost: estimateModelCost(baseId),
    contextWindow: repItem?.maxTokens || defaultContext,
    maxTokens: repItem?.maxOutputTokens || defaultMaxOutput,
  };
}

export function buildDynamicPublicModels(catalog?: AvailableModelsCatalog): Array<Model<any>> {
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
    return [];
  }

  // Filter eligible models according to agentModelSorts (strict agy CLI parity)
  const agentSortIds = catalog.agentModelSorts;
  const eligibleItems =
    Array.isArray(agentSortIds) && agentSortIds.length > 0
      ? catalog.models.filter((m) => agentSortIds.includes(m.id))
      : catalog.models;

  const runtimeGroups = new Map<string, AvailableModelItem[]>();
  for (const item of eligibleItems) {
    const baseId = extractBaseModelId(item.id);
    const list = runtimeGroups.get(baseId) || [];
    list.push(item);
    runtimeGroups.set(baseId, list);
  }

  // Preserve recommended ordering from agentModelSorts
  const orderedBaseIds: string[] = [];
  if (Array.isArray(agentSortIds)) {
    for (const sortId of agentSortIds) {
      const baseId = extractBaseModelId(sortId);
      if (runtimeGroups.has(baseId) && !orderedBaseIds.includes(baseId)) {
        orderedBaseIds.push(baseId);
      }
    }
  }

  for (const baseId of runtimeGroups.keys()) {
    if (!orderedBaseIds.includes(baseId)) {
      orderedBaseIds.push(baseId);
    }
  }

  return orderedBaseIds.map((baseId) => synthesizeDynamicModel(baseId, runtimeGroups.get(baseId)!));
}

/**
 * Model Catalog presentation (pure, in-process): display-name rules and the
 * Subcommand table format. No network, no snapshot access — everything enters
 * as plain CatalogSnapshot / AvailableModelsCatalog values, so tests pin the
 * rendered output without fetching. Lives here (not in catalog-refresh.ts)
 * so the wire module keeps only fetch/parse/publish.
 */
export function formatModelDisplayName(baseId: string, rawDisplayName?: string): string {
  if (rawDisplayName) {
    const cleaned = rawDisplayName.replace(/\s*\([^)]*\)/g, "").trim();
    if (cleaned.length > 0) {
      return cleaned;
    }
  }
  const words = baseId.split("-").map((w) => {
    if (/^\d+(\.\d+)?$/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  return words.join(" ");
}

function formatTokenCount(n?: number): string {
  if (typeof n !== "number") return "n/a";
  if (n % 1048576 === 0) return `${n / 1048576}M`;
  if (n % 1024 === 0) return `${n / 1024}k`;
  if (n % 1000 === 0) return `${n / 1000}k`;
  // ponytail: odd values (e.g. 65535) round to nearest KiB instead of a noisy decimal
  return `${Math.round(n / 1024)}k`;
}

export function formatModelsList(catalog: AvailableModelsCatalog): string {
  const sorts = catalog.agentModelSorts;
  const recommendedOnly = Array.isArray(sorts) && sorts.length > 0;
  const rank = new Map((sorts || []).map((id, i) => [id, i]));

  const models = (recommendedOnly ? catalog.models.filter((m) => rank.has(m.id)) : catalog.models.slice()).sort(
    (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id)
  );

  const rows = models.map((m) => {
    const flags: string[] = [];
    if (m.supportsThinking) flags.push("thinking");
    if (m.supportsImages) flags.push("images");
    return {
      id: m.id,
      name: formatModelDisplayName(m.id, m.displayName || m.id),
      ctx: `${formatTokenCount(m.maxTokens)}/${formatTokenCount(m.maxOutputTokens)}`,
      feat: flags.length > 0 ? flags.join(", ") : "-",
      rem: typeof m.remainingFraction === "number" ? `${Math.round(m.remainingFraction * 100)}%` : "N/A",
    };
  });

  const headers = { id: "Model", name: "Name", ctx: "Context", feat: "Features", rem: "Rem" };
  const w = {
    id: Math.max(headers.id.length, ...rows.map((r) => r.id.length)),
    name: Math.max(headers.name.length, ...rows.map((r) => r.name.length)),
    ctx: Math.max(headers.ctx.length, ...rows.map((r) => r.ctx.length)),
    feat: Math.max(headers.feat.length, ...rows.map((r) => r.feat.length)),
  };

  const lines: string[] = [
    `Available Antigravity Models (${models.length}${recommendedOnly ? " recommended" : ""}):`,
    `  ${headers.id.padEnd(w.id)}  ${headers.name.padEnd(w.name)}  ${headers.ctx.padEnd(w.ctx)}  ${headers.feat.padEnd(w.feat)}  ${headers.rem}`,
  ];
  for (const r of rows) {
    lines.push(
      `  ${r.id.padEnd(w.id)}  ${r.name.padEnd(w.name)}  ${r.ctx.padEnd(w.ctx)}  ${r.feat.padEnd(w.feat)}  ${r.rem.padStart(4)}`
    );
  }

  return lines.join("\n");
}
