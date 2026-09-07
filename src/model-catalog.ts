import type { Model } from "@earendil-works/pi-ai";
import { DEFAULT_ENDPOINT, PROVIDER_ID } from "./protocol.ts";

/**
 * Model Catalog map (pure, in-process): Public Model ID ↔ Runtime Model ID
 * mapping, Model Plan resolution, the versioned snapshot store, Pi Model
 * synthesis, and presentation (display names, Subcommand table format).
 * No network, no credentials, no persistence — the wire side
 * (fetch/parse/publish) lives in catalog-refresh.ts and talks to this
 * module only through CatalogSnapshot values and updateCatalogStore.
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
export function isCompatibleFamily(msgModel?: string, targetModelId?: string): boolean {
  if (!msgModel || !targetModelId) return true;
  if (msgModel === targetModelId) return true;

  const isMsgGemini = msgModel.startsWith("gemini-");
  const isTargetGemini = targetModelId.startsWith("gemini-");
  if (isMsgGemini && isTargetGemini) return true;

  const isMsgClaude = msgModel.startsWith("claude-");
  const isTargetClaude = targetModelId.startsWith("claude-");
  if (isMsgClaude && isTargetClaude) return true;

  const isMsgGpt = msgModel.startsWith("gpt-");
  const isTargetGpt = targetModelId.startsWith("gpt-");
  if (isMsgGpt && isTargetGpt) return true;

  return extractBaseModelId(msgModel) === extractBaseModelId(targetModelId);
}

export function getThinkingConfig(modelId: string, effort?: string): { includeThoughts: boolean; thinkingBudget: number } {
  const isOff = effort === "off" || effort === "none";
  if (isOff) {
    return { includeThoughts: false, thinkingBudget: 0 };
  }

  // Gemini 3.8 / 3.7 / 3.6 Flash
  if (modelId.includes("flash")) {
    if (effort === "high" || effort === "xhigh" || modelId.endsWith("-high") || modelId.endsWith("-agent")) {
      return { includeThoughts: true, thinkingBudget: -1 };
    }
    if (effort === "medium" || modelId.endsWith("-medium")) {
      return { includeThoughts: true, thinkingBudget: 4000 };
    }
    if (effort === "low" || effort === "minimal" || modelId.endsWith("-low")) {
      return { includeThoughts: true, thinkingBudget: 1000 };
    }
    return { includeThoughts: true, thinkingBudget: -1 };
  }

  // Gemini 3.1 Pro
  if (modelId.includes("pro")) {
    if (effort === "low" || effort === "minimal" || modelId.endsWith("-low")) {
      return { includeThoughts: true, thinkingBudget: 1001 };
    }
    return { includeThoughts: true, thinkingBudget: 10001 };
  }

  // Claude models
  if (modelId.startsWith("claude-")) {
    return { includeThoughts: true, thinkingBudget: 1024 };
  }

  // GPT-OSS 120B
  if (modelId.startsWith("gpt-oss-")) {
    return { includeThoughts: true, thinkingBudget: 8192 };
  }

  return { includeThoughts: true, thinkingBudget: -1 };
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

  const isOff = effort === "off" || effort === "none";
  const isLow = isOff || effort === "low" || effort === "minimal";
  const isMedium = effort === "medium";

  // Tier resolution against the live snapshot: effort picks suffix candidates
  // in preference order, the first one the server lists wins — so newly
  // released models (e.g. gemini-3.9-flash) resolve with no code change.
  if (Array.isArray(availableRuntimeIds) && availableRuntimeIds.length > 0) {
    const candidates: string[] = [];
    if (isLow) {
      candidates.push(`${modelId}-low`, `${modelId}-extra-low`, modelId);
    } else if (isMedium) {
      candidates.push(`${modelId}-medium`, modelId);
    } else {
      candidates.push(`${modelId}-high`, `${modelId}-thinking`, `${modelId}-agent`, modelId);
    }

    for (const cand of candidates) {
      if (availableRuntimeIds.includes(cand)) {
        return cand;
      }
    }
  }

  // Fallback heuristics when runtime ID catalog is not available
  if (modelId.includes("flash")) {
    if (isLow) return `${modelId}-low`;
    if (isMedium) return `${modelId}-medium`;
    return `${modelId}-high`;
  }

  if (modelId.includes("pro")) {
    if (isLow) return `${modelId}-low`;
    return `${modelId}-high`;
  }

  if (modelId.startsWith("claude-")) {
    if (modelId.includes("opus")) return `${modelId}-thinking`;
    return modelId;
  }

  if (modelId.startsWith("gpt-")) {
    return `${modelId}-medium`;
  }

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
  return {
    runtimeModelId,
    modelEnum,
    thinkingConfig: resolveThinkingConfig(runtimeModelId, effort, snapshot),
    isNonGemini: !runtimeModelId.startsWith("gemini-"),
    isClaude: runtimeModelId.startsWith("claude-"),
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
 * generation. Snapshot wire values win; the hardcoded heuristic below only
 * serves snapshots without per-ID thinking data (pre-budget persists) and
 * models the wire marks as non-thinking resolve to disabled thoughts.
 */
function resolveThinkingConfig(
  runtimeModelId: string,
  effort?: string,
  snapshot: CatalogSnapshot = getCatalogSnapshot()
): { includeThoughts: boolean; thinkingBudget: number } {
  if (effort === "off" || effort === "none") {
    return { includeThoughts: false, thinkingBudget: 0 };
  }
  const info = snapshot.thinking?.[runtimeModelId];
  if (info) {
    if (typeof info.budget === "number") {
      return { includeThoughts: true, thinkingBudget: info.budget };
    }
    if (!info.supportsThinking) {
      return { includeThoughts: false, thinkingBudget: 0 };
    }
  }
  return getThinkingConfig(runtimeModelId, effort);
}

// Antigravity is quota-based with no per-token billing, so every model
// reports zero cost instead of fictitious Gemini API prices.
// Revisit if a metered paid tier ever appears.
export function estimateModelCost(_baseId: string): Model<any>["cost"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function synthesizeDynamicModel(baseId: string, items: AvailableModelItem[]): Model<any> {
  const repItem = items.find((it) => it.id === `${baseId}-high` || it.id === baseId) || items[0];

  const isFlash = baseId.includes("flash");
  const isClaude = baseId.startsWith("claude-");
  const isGpt = baseId.startsWith("gpt-");

  // Static fallbacks mirror captures/agy_cli_1.1.27/models.resp.json
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
