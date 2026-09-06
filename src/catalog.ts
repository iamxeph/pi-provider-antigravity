import type { Model } from "@earendil-works/pi-ai";
import { DEFAULT_ENDPOINT, PROVIDER_ID, buildAntigravityHeaders, formatApiError, withMetadataTimeout } from "./protocol.ts";
import { parseStoredCredentials } from "./auth.ts";

export function extractBaseModelId(runtimeId: string): string {
  if (runtimeId === "gemini-pro-agent") return "gemini-3.1-pro";
  if (runtimeId.startsWith("gemini-3.1-pro-")) return "gemini-3.1-pro";

  return runtimeId.replace(/-(?:high|medium|low|tiered|thinking|agent|extra-low)$/, "");
}

/**
 * Static fallback model enums captured directly from agy CLI models.resp.json.
 * Single definition: Model Catalog merges these with the active snapshot,
 * and the request builder falls back to them when no snapshot enums apply.
 */
export const STATIC_MODEL_ENUMS: Record<string, string> = {
  // Gemini 3.8 Flash
  "gemini-3.8-flash": "MODEL_PLACEHOLDER_M318",
  "gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318",
  "gemini-3.8-flash-medium": "MODEL_PLACEHOLDER_M319",
  "gemini-3.8-flash-low": "MODEL_PLACEHOLDER_M320",
  "gemini-3.8-flash-tiered": "MODEL_PLACEHOLDER_M322",
  // Gemini 3.7 Flash
  "gemini-3.7-flash": "MODEL_PLACEHOLDER_M298",
  "gemini-3.7-flash-high": "MODEL_PLACEHOLDER_M298",
  "gemini-3.7-flash-medium": "MODEL_PLACEHOLDER_M299",
  "gemini-3.7-flash-low": "MODEL_PLACEHOLDER_M300",
  "gemini-3.7-flash-tiered": "MODEL_PLACEHOLDER_M301",
  // Gemini 3.6 Flash
  "gemini-3.6-flash": "MODEL_PLACEHOLDER_M71",
  "gemini-3.6-flash-high": "MODEL_PLACEHOLDER_M71",
  "gemini-3.6-flash-medium": "MODEL_PLACEHOLDER_M72",
  "gemini-3.6-flash-low": "MODEL_PLACEHOLDER_M73",
  // Gemini 3.5 Flash
  "gemini-3.5-flash": "MODEL_PLACEHOLDER_M84",
  "gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20",
  "gemini-3.5-flash-extra-low": "MODEL_PLACEHOLDER_M187",
  "gemini-3-flash-agent": "MODEL_PLACEHOLDER_M84",
  // Gemini 3.1 Pro
  "gemini-3.1-pro": "MODEL_PLACEHOLDER_M16",
  "gemini-3.1-pro-high": "MODEL_PLACEHOLDER_M37",
  "gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
  "gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
  // Claude
  "claude-sonnet-4-6": "MODEL_PLACEHOLDER_M35",
  "claude-opus-4-6": "MODEL_PLACEHOLDER_M26",
  "claude-opus-4-6-thinking": "MODEL_PLACEHOLDER_M26",
  // GPT-OSS
  "gpt-oss-120b": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
  "gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
};

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
  supportsImages?: boolean;
  maxTokens?: number;
  maxOutputTokens?: number;
}

export interface AvailableModelsCatalog {
  models: AvailableModelItem[];
  modelEnums: Record<string, string>;
  agentModelSorts?: string[];
}

// Active catalog state: single versioned snapshot. refreshCatalog owns writes;
// request paths take one snapshot per call so enums and runtime IDs always come
// from the same refresh generation (see Model Plan in CONTEXT.md).
export interface CatalogSnapshot {
  enums: Record<string, string>;
  runtimeIds: string[];
  version: number;
}

let activeStore: CatalogSnapshot = {
  enums: { ...STATIC_MODEL_ENUMS },
  runtimeIds: [],
  version: 0,
};

export function getCatalogSnapshot(): CatalogSnapshot {
  return {
    enums: { ...activeStore.enums },
    runtimeIds: [...activeStore.runtimeIds],
    version: activeStore.version,
  };
}

function updateCatalogStore(enums: Record<string, string>, runtimeIds: string[]): void {
  // A fresh generation is complete: replace instead of merging, so enums for
  // server-removed models are evicted instead of pinned forever.
  activeStore = {
    enums: { ...STATIC_MODEL_ENUMS, ...enums },
    runtimeIds: [...new Set(runtimeIds)],
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

  // Known specific models with legacy parity mappings
  if (modelId === "gemini-3.8-flash") {
    if (isLow) return "gemini-3.8-flash-low";
    if (isMedium) return "gemini-3.8-flash-medium";
    return "gemini-3.8-flash-high";
  }

  if (modelId === "gemini-3.7-flash") {
    if (isLow) return "gemini-3.7-flash-low";
    if (isMedium) return "gemini-3.7-flash-medium";
    return "gemini-3.7-flash-high";
  }

  if (modelId === "gemini-3.6-flash") {
    if (isLow) return "gemini-3.6-flash-low";
    if (isMedium) return "gemini-3.6-flash-medium";
    return "gemini-3.6-flash-high";
  }

  if (modelId === "gemini-3.5-flash") {
    if (isLow) return "gemini-3.5-flash-extra-low";
    if (isMedium) return "gemini-3.5-flash-low";
    return "gemini-3-flash-agent";
  }

  if (modelId === "gemini-3.1-pro") {
    if (effort === "high" || effort === "xhigh") return "gemini-pro-agent";
    return "gemini-3.1-pro-low";
  }

  if (modelId === "claude-opus-4-6") {
    return "claude-opus-4-6-thinking";
  }

  if (modelId === "claude-sonnet-4-6") {
    return "claude-sonnet-4-6";
  }

  if (modelId === "gpt-oss-120b") {
    return "gpt-oss-120b-medium";
  }

  // Dynamic tier resolution for newly introduced models (e.g. gemini-3.9-flash, claude-opus-4-7, etc.)
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
  const runtimeModelId = resolveRuntimeModelId(publicModelId, effort, snapshot.runtimeIds);
  return {
    runtimeModelId,
    modelEnum: snapshot.enums[runtimeModelId] || "",
    thinkingConfig: getThinkingConfig(runtimeModelId, effort),
    isNonGemini: !runtimeModelId.startsWith("gemini-"),
    isClaude: runtimeModelId.startsWith("claude-"),
  };
}

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

  const defaultContext = isFlash ? 1048576 : isClaude ? 200000 : isGpt ? 128000 : 1048576;
  const defaultMaxOutput = isGpt ? 32768 : 65536;

  return {
    id: baseId,
    name: formatModelDisplayName(baseId, repItem?.displayName),
    provider: PROVIDER_ID,
    api: "antigravity-api" as any,
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

export async function refreshCatalog(context: any): Promise<Array<Model<any>>> {
  // Restore from context.stored first for offline restart support,
  // but only into a pristine store: a failed refresh must not clobber a
  // fresher in-memory snapshot with older persisted data.
  const storedEnums = context.stored?.["pi-provider-antigravity"]?.modelEnums;
  const storedRuntimeIds = context.stored?.["pi-provider-antigravity"]?.runtimeIds;
  if ((storedEnums || storedRuntimeIds) && getCatalogSnapshot().version === 0) {
    updateCatalogStore(storedEnums || {}, storedRuntimeIds || []);
  }

  if (!context.allowNetwork) {
    return context.stored?.models || [];
  }

  try {
    const apiKey = context.credential?.access;
    if (!apiKey) {
      return context.stored?.models || [];
    }

    const { token, projectId } = parseStoredCredentials(apiKey);
    const catalog = await fetchAvailableModelsCatalog(token, projectId, DEFAULT_ENDPOINT, context.signal);
    updateCatalogStore(catalog.modelEnums, catalog.models.map((m) => m.id));

    const dynamicModels = buildDynamicPublicModels(catalog);

    // Publish to Pi models-store.json
    if (context.publish) {
      await context.publish({
        persist: {
          models: dynamicModels,
          checkedAt: Date.now(),
          "pi-provider-antigravity": {
            modelEnums: catalog.modelEnums,
            runtimeIds: catalog.models.map((m) => m.id),
          },
        },
      });
    }

    return dynamicModels;
  } catch {
    return context.stored?.models || [];
  }
}

export function parseAvailableModels(data: any): AvailableModelsCatalog {
  const models: AvailableModelItem[] = [];
  const modelEnums: Record<string, string> = {};

  const modelsObj = data.models || {};
  for (const [id, info] of Object.entries<any>(modelsObj)) {
    if (id.startsWith("tab_") || id.startsWith("chat_")) continue; // hide internal completions

    const modelEnum = typeof info.model === "string" ? info.model : undefined;
    if (modelEnum) {
      modelEnums[id] = modelEnum;
    }

    const quotaInfo = info.quotaInfo || {};
    models.push({
      id,
      displayName: info.displayName || info.label || id,
      modelEnum,
      remainingFraction: quotaInfo.remainingFraction,
      resetTime: quotaInfo.resetTime,
      supportsThinking: Boolean(info.supportsThinking),
      supportsImages: Boolean(info.supportsImages),
      maxTokens: typeof info.maxTokens === "number" ? info.maxTokens : undefined,
      maxOutputTokens: typeof info.maxOutputTokens === "number" ? info.maxOutputTokens : undefined,
    });
  }

  const agentModelSorts: string[] = [];
  if (Array.isArray(data.agentModelSorts)) {
    for (const sortGroup of data.agentModelSorts) {
      if (Array.isArray(sortGroup.groups)) {
        for (const group of sortGroup.groups) {
          if (Array.isArray(group.modelIds)) {
            agentModelSorts.push(...group.modelIds);
          }
        }
      }
    }
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

  return {
    models,
    modelEnums,
    ...(agentModelSorts.length > 0 ? { agentModelSorts } : {}),
  };
}

export async function fetchAvailableModelsCatalog(
  token: string,
  projectId = "aicode-consumers",
  endpoint = DEFAULT_ENDPOINT,
  signal?: AbortSignal
): Promise<AvailableModelsCatalog> {
  const timeout = withMetadataTimeout(signal);
  try {
    const res = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: buildAntigravityHeaders(token),
      body: JSON.stringify({ project: projectId }),
      signal: timeout.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to fetch models ${formatApiError(res.status, errText)}`);
    }
    const json = await res.json();
    return parseAvailableModels(json);
  } finally {
    timeout.dispose();
  }
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
