import type { Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { resolveCredentials, type AntigravityCredentials } from "./auth.ts";
import { DEFAULT_ENDPOINT, postAntigravityJson, PROVIDER_ID } from "./protocol.ts";
import { getModelProfile } from "./model-identity.ts";

export const PRIVATE_SNAPSHOT_KEY = "pi-provider-antigravity";

type CanonicalTier = "low" | "medium" | "high";

/**
 * Canonical Tier Suffix: The wire suffix that mirrors the user-requested thinking
 * effort by name (-low, -medium, -high), attempted first when resolving a Runtime Model ID.
 */
const CANONICAL_TIER_SUFFIXES: Record<CanonicalTier, string> = Object.freeze({
  low: "-low",
  medium: "-medium",
  high: "-high",
});

/**
 * Tier Alias: Alternative wire spellings representing the same thinking effort tier
 * (-thinking or -agent for high, -extra-low for low, or an unsuffixed base identifier
 * for the default tier), resolved when the canonical suffix is absent.
 */
const TIER_ALIASES: Record<CanonicalTier, readonly string[]> = Object.freeze({
  low: Object.freeze(["-extra-low"]),
  medium: Object.freeze([]),
  high: Object.freeze(["-thinking", "-agent"]),
});

/**
 * Special suffixes in the catalog that designate non-effort variant types (e.g. server-directed
 * dynamic thinking selection). Stripped for base model grouping and recognized as runtime IDs,
 * but not selectable as a user thinking effort tier.
 */
const SPECIAL_TIER_SUFFIXES: readonly string[] = Object.freeze(["-tiered"]);

/**
 * Union of all known model ID tier suffixes (canonical, aliases, and special tokens).
 */
const ALL_TIER_SUFFIXES: readonly string[] = Object.freeze([
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

function tierSpellings(tier: CanonicalTier): readonly string[] {
  return [CANONICAL_TIER_SUFFIXES[tier], ...TIER_ALIASES[tier]];
}

function extractBaseModelId(runtimeId: string): string {
  if (runtimeId === "gemini-pro-agent") return "gemini-3.1-pro";
  if (runtimeId.startsWith("gemini-3.1-pro-")) return "gemini-3.1-pro";

  return runtimeId.replace(TIER_SUFFIX_PATTERN, "");
}

/**
 * Ordered candidate suffixes attempted when resolving a Runtime Model ID for an effort.
 * Canonical suffix comes first, followed by fallbacks.
 */
const TIER_FALLBACKS: Record<string, readonly string[]> = Object.freeze({
  minimal: Object.freeze(["-low", "-extra-low", ""]),
  low: Object.freeze(["-extra-low", ""]),
  medium: Object.freeze(["", "-high"]), // Gemini 3.1 Pro lists no -medium: up to high, never down
  high: Object.freeze(["-thinking", "-agent", ""]), // Claude's high tier is -thinking
  xhigh: Object.freeze(["-high", "-thinking", "-agent", ""]),
  max: Object.freeze(["-high", "-thinking", "-agent", ""]),
});

const DEFAULT_TIER_ORDER: readonly string[] = Object.freeze([
  CANONICAL_TIER_SUFFIXES.high,
  ...TIER_ALIASES.high,
  "",
]);

function tierCandidateOrder(effort?: string): readonly string[] {
  if (!effort) return DEFAULT_TIER_ORDER;
  const canonical = effort in CANONICAL_TIER_SUFFIXES
    ? [CANONICAL_TIER_SUFFIXES[effort as CanonicalTier]]
    : [`-${effort}`];
  const fallbacks = TIER_FALLBACKS[effort] ?? DEFAULT_TIER_ORDER;
  return [...new Set([...canonical, ...fallbacks])];
}

type StoreEntry = NonNullable<RefreshModelsContext["stored"]>;

/**
 * Context passed to refreshModels by Pi Core, minus internal fields the
 * extension does not touch.
 */
export type RefreshContext = Omit<RefreshModelsContext, "stored" | "publish"> & {
  stored?: Readonly<StoreEntry> & { [PRIVATE_SNAPSHOT_KEY]?: PersistedSnapshot };
  publish?(publication: {
    persist?: (StoreEntry & { [PRIVATE_SNAPSHOT_KEY]?: PersistedSnapshot }) | null;
    update?: () => void;
  }): Promise<boolean>;
};

export interface CatalogRefreshOutcome {
  status: "fresh" | "stale" | "failed";
  catalog?: AvailableModelsCatalog;
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
  /** Server-directed renames: old Runtime Model ID → current Runtime Model ID. */
  deprecated?: Record<string, string>;
}

export interface CatalogThinking {
  budget?: number;
  supportsThinking: boolean;
}

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

// Catalog Persistence codec: the private entry this provider keeps inside its
// own Pi store entry (PRIVATE_SNAPSHOT_KEY). The key spells a snapshot's `enums`
// as `modelEnums` and must keep doing so — Pi persists unknown keys verbatim.
export interface PersistedSnapshot {
  modelEnums: Record<string, string>;
  runtimeIds: string[];
  thinking: Record<string, CatalogThinking>;
  deprecated: Record<string, string>;
}

export interface ModelPlan {
  runtimeModelId: string;
  modelEnum: string;
  thinkingConfig: { includeThoughts: boolean; thinkingBudget: number };
  isNonGemini: boolean;
  isClaude: boolean;
}

/**
 * The single deep Model Catalog interface. Encapsulates wire decoding, snapshot generations,
 * persistence codecs, network refresh, plan resolution, and CLI formatting behind one seam.
 */
export interface ModelCatalog {
  /**
   * Current generation. The snapshot is a copy the caller may keep; `items` is
   * shared, because readers only enumerate it and never mutate it.
   */
  generation(): CatalogGeneration;
  /**
   * Records one completed generation from parsed catalog or raw wire JSON payload:
   * automatically parses wire envelope, derives its snapshot, and bumps version.
   */
  record(catalogOrRaw: unknown): void;
  /**
   * Restores a persisted snapshot or raw store object into a pristine store.
   */
  restore(persistedOrSnapshot: unknown): void;
  /**
   * Encodes the current generation snapshot for Pi models-store.json persistence.
   */
  toPersisted(): PersistedSnapshot | undefined;
  /**
   * Pi SDK refreshModels entry point: restores stored snapshot, fetches wire
   * catalog when online, updates generation, and publishes to Pi store.
   */
  refresh(context: RefreshContext): Promise<Array<Model<any>>>;
  /**
   * Refreshes catalog via the provided hook and reports freshness verdict.
   */
  refreshGeneration(doRefresh: () => unknown): Promise<CatalogRefreshOutcome>;
  /**
   * Resolves one Model Plan for the requested model and effort against
   * the current snapshot generation.
   */
  resolvePlan(publicModelId: string, effort?: string): ModelPlan;
  /**
   * Formats the current catalog generation as a readable CLI table string.
   */
  formatList(): string;
}

export type CatalogStore = ModelCatalog;

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

export function parseAvailableModels(data: any): AvailableModelsCatalog {
  if (!data || typeof data !== "object") {
    return { models: [], modelEnums: {} };
  }

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
      thinkingBudget: typeof info.thinkingBudget === "number" ? info.thinkingBudget : undefined,
      minThinkingBudget: typeof info.minThinkingBudget === "number" ? info.minThinkingBudget : undefined,
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

  // Server-directed renames (old Runtime Model ID → current one).
  const deprecated: Record<string, string> = {};
  const rawDeprecated = (data as any).deprecatedModelIds;
  if (rawDeprecated && typeof rawDeprecated === "object") {
    for (const [oldId, info] of Object.entries<any>(rawDeprecated)) {
      if (info && typeof info.newModelId === "string") {
        deprecated[oldId] = info.newModelId;
      }
    }
  }

  return {
    models,
    modelEnums,
    ...(agentModelSorts.length > 0 ? { agentModelSorts } : {}),
    ...(Object.keys(deprecated).length > 0 ? { deprecated } : {}),
  };
}

async function fetchAvailableModelsCatalog(
  token: string | AntigravityCredentials,
  projectId: string,
  signal?: AbortSignal
): Promise<AvailableModelsCatalog> {
  const json = await postAntigravityJson<any>({
    auth: token,
    path: "v1internal:fetchAvailableModels",
    body: { project: projectId },
    signal,
  });
  return parseAvailableModels(json);
}

function toPersistedSnapshot(snapshot: CatalogSnapshot): PersistedSnapshot {
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

function fromPersistedSnapshot(raw: unknown): CatalogSnapshot | undefined {
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

function resolveRuntimeModelId(
  modelId: string,
  effort: string | undefined,
  availableRuntimeIds: string[]
): string {
  if (ALL_TIER_SUFFIXES.some((suffix) => modelId.endsWith(suffix))) {
    return modelId;
  }

  if (availableRuntimeIds.length > 0) {
    const variants = new Set(availableRuntimeIds.filter((id) => extractBaseModelId(id) === modelId));
    const order = tierCandidateOrder(effort);

    for (const suffix of order) {
      if (variants.has(`${modelId}${suffix}`)) {
        return `${modelId}${suffix}`;
      }
    }

    if (variants.size === 1) {
      return [...variants][0];
    }
  }

  return modelId;
}

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

function resolveThinkingConfig(
  runtimeModelId: string,
  snapshot: CatalogSnapshot
): { includeThoughts: boolean; thinkingBudget: number } {
  const budget = snapshot.thinking[runtimeModelId]?.budget;
  return typeof budget === "number"
    ? { includeThoughts: true, thinkingBudget: budget }
    : { includeThoughts: false, thinkingBudget: 0 };
}

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
    throw new Error(
      `Unknown model "${runtimeModelId}". ` +
        `Run /antigravity refresh, then pick a current model.`
    );
  }
  const profile = getModelProfile(runtimeModelId);
  return {
    runtimeModelId,
    modelEnum,
    thinkingConfig: resolveThinkingConfig(runtimeModelId, snapshot),
    isNonGemini: profile.isNonGemini,
    isClaude: profile.isClaude,
  };
}

function estimateModelCost(_baseId: string): Model<any>["cost"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function formatModelDisplayName(baseId: string, rawDisplayName?: string): string {
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

function synthesizeDynamicModel(baseId: string, items: AvailableModelItem[]): Model<any> {
  const repItem = items.find((it) => it.id === `${baseId}-high` || it.id === baseId) || items[0];

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

  const profile = getModelProfile(baseId);
  const defaultContext = profile.defaultContextWindow;
  const defaultMaxOutput = profile.defaultMaxOutputTokens;

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
    promptCache: profile.promptCache,
    contextWindow: repItem?.maxTokens || defaultContext,
    maxTokens: repItem?.maxOutputTokens || defaultMaxOutput,
  };
}

function buildDynamicPublicModels(catalog?: AvailableModelsCatalog): Array<Model<any>> {
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
    return [];
  }

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

function formatTokenCount(n?: number): string {
  if (typeof n !== "number") return "N/A";
  if (n % 1048576 === 0) return `${n / 1048576}M`;
  if (n % 1024 === 0) return `${n / 1024}k`;
  if (n % 1000 === 0) return `${n / 1000}k`;
  return `${Math.round(n / 1024)}k`;
}

function formatModelsList(catalog: AvailableModelsCatalog): string {
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

/**
 * Creates the authoritative deep Model Catalog interface.
 */
export function createModelCatalog(): ModelCatalog {
  let generation: CatalogGeneration = { snapshot: EMPTY_SNAPSHOT(), version: 0 };

  const record = (catalogOrRaw: unknown) => {
    let catalog: AvailableModelsCatalog;
    if (
      catalogOrRaw &&
      typeof catalogOrRaw === "object" &&
      "models" in catalogOrRaw &&
      Array.isArray((catalogOrRaw as any).models) &&
      "modelEnums" in catalogOrRaw &&
      typeof (catalogOrRaw as any).modelEnums === "object"
    ) {
      catalog = catalogOrRaw as AvailableModelsCatalog;
    } else {
      catalog = parseAvailableModels(catalogOrRaw);
    }
    generation = {
      snapshot: snapshotFromCatalog(catalog),
      items: catalog,
      version: generation.version + 1,
    };
  };

  const restore = (persistedOrSnapshot: unknown) => {
    if (generation.version > 0) return;
    if (!persistedOrSnapshot || typeof persistedOrSnapshot !== "object") return;

    if (
      "enums" in persistedOrSnapshot &&
      "runtimeIds" in persistedOrSnapshot &&
      Array.isArray((persistedOrSnapshot as any).runtimeIds)
    ) {
      generation = { snapshot: copySnapshot(persistedOrSnapshot as CatalogSnapshot), version: 0 };
      return;
    }

    const snapshot = fromPersistedSnapshot(persistedOrSnapshot);
    if (snapshot) {
      generation = { snapshot: copySnapshot(snapshot), version: 0 };
    }
  };

  const toPersisted = (): PersistedSnapshot | undefined => {
    if (generation.version === 0 && generation.snapshot.runtimeIds.length === 0) {
      return undefined;
    }
    return toPersistedSnapshot(generation.snapshot);
  };

  const refresh = async (context: RefreshContext): Promise<Array<Model<any>>> => {
    const persisted = context.stored?.[PRIVATE_SNAPSHOT_KEY];
    if (persisted) restore(persisted);

    const storedModels = () => [...(context.stored?.models ?? [])];
    if (!context.allowNetwork) return storedModels();

    try {
      const creds = await resolveCredentials(context);
      if (!creds) return storedModels();

      const catalog = await fetchAvailableModelsCatalog(creds, creds.projectId, context.signal);
      record(catalog);

      const dynamicModels = buildDynamicPublicModels(catalog);

      if (context.publish) {
        await context.publish({
          persist: {
            models: dynamicModels,
            checkedAt: Date.now(),
            [PRIVATE_SNAPSHOT_KEY]: toPersisted(),
          },
        });
      }

      return dynamicModels;
    } catch {
      return storedModels();
    }
  };

  const refreshGen = async (doRefresh: () => unknown): Promise<CatalogRefreshOutcome> => {
    const versionBefore = generation.version;
    await doRefresh();
    const { items, version } = generation;
    if (!items) return { status: "failed" };
    return { status: version === versionBefore ? "stale" : "fresh", catalog: items };
  };

  return {
    generation: () => ({ ...generation, snapshot: copySnapshot(generation.snapshot) }),
    record,
    restore,
    toPersisted,
    refresh,
    refreshGeneration: refreshGen,
    resolvePlan: (publicModelId, effort) => resolveModelPlan(publicModelId, effort, generation.snapshot),
    formatList: () => (generation.items ? formatModelsList(generation.items) : "No models available."),
  };
}

export const createCatalogStore = createModelCatalog;

export async function refreshCatalog(context: RefreshContext, store: ModelCatalog): Promise<Array<Model<any>>> {
  return store.refresh(context);
}
