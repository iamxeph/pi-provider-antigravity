import type { Model } from "@earendil-works/pi-ai";
import { DEFAULT_ENDPOINT, PROVIDER_ID } from "./protocol.ts";

/**
 * Model Catalog map (pure, in-process): Public Model ID ↔ Runtime Model ID
 * mapping, Model Plan resolution, the Catalog Generation store, Pi Model
 * synthesis, and presentation (display names, Subcommand table format).
 * No network, no credentials, no persistence — the wire side
 * (fetch/parse/publish) lives in catalog-refresh.ts and talks to this module
 * only through createCatalogStore (one generation behind one read) and the
 * persistence codec, so one recorded generation is the single freshness truth.
 */
export type CanonicalTier = "low" | "medium" | "high";

/**
 * Canonical Tier Suffix: The wire suffix that mirrors the user-requested thinking
 * effort by name (-low, -medium, -high), attempted first when resolving a Runtime Model ID.
 * (See CONTEXT.md and ADR-0014)
 */
export const CANONICAL_TIER_SUFFIXES: Record<CanonicalTier, string> = Object.freeze({
  low: "-low",
  medium: "-medium",
  high: "-high",
});

/**
 * Tier Alias: Alternative wire spellings representing the same thinking effort tier
 * (-thinking or -agent for high, -extra-low for low, or an unsuffixed base identifier
 * for the default tier), resolved when the canonical suffix is absent.
 * (See CONTEXT.md and ADR-0014)
 */
export const TIER_ALIASES: Record<CanonicalTier, readonly string[]> = Object.freeze({
  low: Object.freeze(["-extra-low"]),
  medium: Object.freeze([]),
  high: Object.freeze(["-thinking", "-agent"]),
});

/**
 * Special suffixes present in captures that designate non-effort variant types (e.g. server-directed
 * dynamic thinking selection). Stripped for base model grouping and recognized as runtime IDs,
 * but not selectable as a user thinking effort tier.
 */
export const SPECIAL_TIER_SUFFIXES: readonly string[] = Object.freeze(["-tiered"]);

/**
 * Union of all known model ID tier suffixes (canonical, aliases, and special tokens).
 */
export const ALL_TIER_SUFFIXES: readonly string[] = Object.freeze([
  ...new Set([
    ...Object.values(CANONICAL_TIER_SUFFIXES),
    ...Object.values(TIER_ALIASES).flat(),
    ...SPECIAL_TIER_SUFFIXES,
  ]),
]);

/**
 * Strips any known tier suffix from a model ID for grouping.
 */
const TIER_SUFFIX_PATTERN = new RegExp(
  `-(?:${ALL_TIER_SUFFIXES.map((s) => s.replace(/^-/, "")).join("|")})$`,
);

/**
 * Suffixes (canonical + aliases) that count toward a specific tier when advertising
 * available effort levels in the model picker.
 */
export function tierSpellings(tier: CanonicalTier): readonly string[] {
  return [CANONICAL_TIER_SUFFIXES[tier], ...TIER_ALIASES[tier]];
}

export function extractBaseModelId(runtimeId: string): string {
  if (runtimeId === "gemini-pro-agent") return "gemini-3.1-pro";
  if (runtimeId.startsWith("gemini-3.1-pro-")) return "gemini-3.1-pro";

  return runtimeId.replace(TIER_SUFFIX_PATTERN, "");
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

// The catalog seam's types: what a request path reads (CatalogSnapshot), the
// generation a store holds (CatalogGeneration), and the store that owns the
// writes. Request paths take one snapshot per call so enums, runtime IDs, and
// thinking configs always come from the same refresh generation (see Model Plan
// in CONTEXT.md).
export interface CatalogThinking {
  budget?: number;
  supportsThinking?: boolean;
}

/**
 * The per-Runtime-Model-ID facts a request path reads and Catalog Persistence
 * keeps — the only part of a generation that crosses a restart.
 */
export interface CatalogSnapshot {
  enums: Record<string, string>;
  runtimeIds: string[];
  thinking: Record<string, CatalogThinking>;
  deprecated: Record<string, string>;
}

export interface CatalogGeneration {
  snapshot: CatalogSnapshot;
  /** Full item list of the recorded refresh; absent after an offline restore. */
  items?: AvailableModelsCatalog;
  /** Fetch successes recorded in this process; 0 until one is recorded. */
  version: number;
}

/**
 * The single catalog seam. Callers get one read and two writes; the invariant
 * that a restore never overwrites a recorded generation lives in here, not with
 * the callers.
 */
export interface CatalogStore {
  /**
   * Current generation. The snapshot is a copy the caller may keep; `items` is
   * shared, because readers only enumerate it (formatModelsList slices before
   * sorting) and never mutate it.
   */
  generation(): CatalogGeneration;
  /** Records one completed generation: derives its snapshot, bumps version. */
  record(catalog: AvailableModelsCatalog): void;
  /** Restores a persisted snapshot, but only into a pristine store. */
  restore(snapshot: CatalogSnapshot): void;
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

function snapshotFromCatalog(catalog: AvailableModelsCatalog): CatalogSnapshot {
  // A generation is complete: derive it wholesale instead of merging, so enums
  // for server-removed models are evicted instead of pinned forever.
  return {
    enums: { ...catalog.modelEnums },
    runtimeIds: [...new Set(catalog.models.map((m) => m.id))],
    thinking: buildThinkingMap(catalog.models),
    deprecated: { ...(catalog.deprecated ?? {}) },
  };
}

function copySnapshot(snapshot: CatalogSnapshot): CatalogSnapshot {
  return {
    enums: { ...snapshot.enums },
    runtimeIds: [...snapshot.runtimeIds],
    thinking: Object.fromEntries(
      Object.entries(snapshot.thinking).map(([id, info]) => [id, { ...info }]),
    ),
    deprecated: { ...snapshot.deprecated },
  };
}

const EMPTY_SNAPSHOT = (): CatalogSnapshot => ({ enums: {}, runtimeIds: [], thinking: {}, deprecated: {} });

/**
 * Creates the one catalog seam this provider wires up: `index.ts` builds it and
 * hands it to the refresh hook and every request path.
 */
export function createCatalogStore(): CatalogStore {
  let generation: CatalogGeneration = { snapshot: EMPTY_SNAPSHOT(), version: 0 };
  return {
    generation: () => ({ ...generation, snapshot: copySnapshot(generation.snapshot) }),
    record: (catalog) => {
      generation = {
        snapshot: snapshotFromCatalog(catalog),
        items: catalog,
        version: generation.version + 1,
      };
    },
    // Version 0 means no fetch has landed in this process, so nothing here can
    // be fresher than the persist: an older file must never replace a recorded
    // generation (the refresh path calls this on every start, including after
    // a successful fetch in the same process).
    restore: (snapshot) => {
      if (generation.version > 0) return;
      generation = { snapshot: copySnapshot(snapshot), version: 0 };
    },
  };
}

// Catalog Persistence codec: the private entry this provider keeps inside its
// own Pi store entry (PRIVATE_SNAPSHOT_KEY, catalog-refresh.ts). The key
// spells a snapshot's `enums` as `modelEnums` and must keep doing so — Pi
// persists unknown keys verbatim, and every installed provider already has
// that spelling on disk (ADR-0004).
export interface PersistedSnapshot {
  modelEnums: Record<string, string>;
  runtimeIds: string[];
  thinking: Record<string, CatalogThinking>;
  deprecated: Record<string, string>;
}

export function toPersistedSnapshot(snapshot: CatalogSnapshot): PersistedSnapshot {
  return {
    modelEnums: { ...snapshot.enums },
    runtimeIds: [...snapshot.runtimeIds],
    thinking: { ...snapshot.thinking },
    deprecated: { ...snapshot.deprecated },
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isThinkingRecord(value: unknown): value is Record<string, CatalogThinking> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => !!entry && typeof entry === "object" && !Array.isArray(entry))
  );
}

/**
 * Lenient inverse of toPersistedSnapshot: a field that is missing or malformed
 * restores as empty rather than as garbage, and an entry with no usable field
 * restores as absent (the refresh path then falls back to a fresh fetch).
 */
export function fromPersistedSnapshot(raw: unknown): CatalogSnapshot | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Partial<PersistedSnapshot>;
  const enums = isStringRecord(entry.modelEnums) ? entry.modelEnums : undefined;
  const runtimeIds = Array.isArray(entry.runtimeIds)
    ? entry.runtimeIds.filter((id): id is string => typeof id === "string")
    : undefined;
  const thinking = isThinkingRecord(entry.thinking) ? entry.thinking : undefined;
  const deprecated = isStringRecord(entry.deprecated) ? entry.deprecated : undefined;
  if (!enums && !runtimeIds && !thinking && !deprecated) return undefined;
  return { enums: enums ?? {}, runtimeIds: runtimeIds ?? [], thinking: thinking ?? {}, deprecated: deprecated ?? {} };
}

/**
 * Tier Fallback: The unidirectional upward-escalation policy that resolves to an alternative
 * tier (such as medium escalating to high on models lacking a medium variant, or unadvertised
 * efforts clamping to available tiers) when neither canonical nor alias suffixes exist.
 * (See CONTEXT.md and ADR-0014)
 */
export const TIER_FALLBACKS: Record<string, readonly string[]> = Object.freeze({
  minimal: Object.freeze(["-low", "-extra-low", ""]),
  low: Object.freeze(["-extra-low", ""]),
  medium: Object.freeze(["", "-high"]), // Gemini 3.1 Pro lists no -medium: up to high, never down
  high: Object.freeze(["-thinking", "-agent", ""]), // Claude's high tier is -thinking
  xhigh: Object.freeze(["-high", "-thinking", "-agent", ""]),
  max: Object.freeze(["-high", "-thinking", "-agent", ""]),
});

export const DEFAULT_TIER_ORDER: readonly string[] = Object.freeze([
  CANONICAL_TIER_SUFFIXES.high,
  ...TIER_ALIASES.high,
  "",
]);

/**
 * Ordered candidate suffixes attempted when resolving a Runtime Model ID for an effort.
 * Canonical suffix comes first, followed by fallbacks.
 */
export function tierCandidateOrder(effort?: string): readonly string[] {
  if (!effort) return DEFAULT_TIER_ORDER;
  const canonical = effort in CANONICAL_TIER_SUFFIXES
    ? [CANONICAL_TIER_SUFFIXES[effort as CanonicalTier]]
    : [`-${effort}`];
  const fallbacks = TIER_FALLBACKS[effort] ?? DEFAULT_TIER_ORDER;
  return [...new Set([...canonical, ...fallbacks])];
}

function resolveRuntimeModelId(
  modelId: string,
  effort: string | undefined,
  availableRuntimeIds: string[]
): string {
  if (ALL_TIER_SUFFIXES.some((suffix) => modelId.endsWith(suffix))) {
    return modelId;
  }

  // Tier resolution against the live snapshot: the server's own variant list is
  // the candidate set, effort only sets the suffix preference order — so newly
  // released models (e.g. gemini-3.9-flash) resolve with no code change.
  if (availableRuntimeIds.length > 0) {
    const variants = new Set(availableRuntimeIds.filter((id) => extractBaseModelId(id) === modelId));
    const order = tierCandidateOrder(effort);

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
 * switches tool schema mode. The caller passes the store's current snapshot, so
 * enums and runtime IDs never mix generations.
 */
export function resolveModelPlan(
  publicModelId: string,
  effort: string | undefined,
  snapshot: CatalogSnapshot
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
      `Unknown model "${runtimeModelId}" (not in the current catalog snapshot). ` +
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
  snapshot: CatalogSnapshot
): { includeThoughts: boolean; thinkingBudget: number } {
  // Pi signals thinking-off by omitting `reasoning` entirely (never by an "off"
  // string: it is outside SimpleStreamOptions.reasoning's ThinkingLevel type),
  // so there is deliberately no string branch here. What the wire must carry
  // for that state is unverified — no capture has includeThoughts:false.
  const budget = snapshot.thinking[runtimeModelId]?.budget;
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
  const hasVariant = (suffixes: readonly string[]) =>
    items.some((it) => suffixes.some((suffix) => it.id.endsWith(suffix)));
  const thinkingLevelMap = {
    off: null,
    minimal: null,
    ...(hasVariant(tierSpellings("low")) ? {} : { low: null }),
    ...(hasVariant(tierSpellings("medium")) ? {} : { medium: null }),
    ...(hasVariant(tierSpellings("high")) || items.some((it) => it.id === baseId)
      ? {}
      : { high: null }),
  };

  const family = classifyModelFamily(baseId);
  const isFlash = baseId.includes("flash");
  const isClaude = family === "claude";
  const isGpt = family === "gpt";

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
