import type { AnyModel, Model, RefreshModelsContext, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { type CredentialSource, type AntigravityCredentials } from "./auth.ts";
import {
  type AntigravityClient,
  defaultAntigravityClient,
  DEFAULT_ENDPOINT,
  PROVIDER_ID,
} from "./protocol.ts";
import { getModelProfile } from "./model-identity.ts";

export const PRIVATE_SNAPSHOT_KEY = "pi-provider-antigravity";

/**
 * Tier suffixes: exactly the efforts `agy --effort` accepts, all of them Pi level names,
 * so a tier the server ships under one of them (e.g. -xhigh, -max) needs no code change.
 */
const THINKING_LEVELS: readonly ThinkingLevel[] = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

const TIER_SUFFIX_PATTERN = new RegExp(`-(?:${THINKING_LEVELS.join("|")})$`);

function extractBaseModelId(runtimeId: string): string {
  return runtimeId.replace(TIER_SUFFIX_PATTERN, "");
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
  supportsThinking?: boolean;
  thinkingBudget?: number;
  /**
   * Named effort rank from the catalog (1 LOW / 2 MEDIUM / 3 HIGH). Present on most
   * entries, including ones that also carry a thinkingBudget — see
   * resolveThinkingConfig for which one agy actually puts on the wire.
   */
  thinkingLevel?: number;
  supportsImages?: boolean;
  maxTokens?: number;
  maxOutputTokens?: number;
}

export interface AvailableModelsCatalog {
  models: AvailableModelItem[];
  modelEnums: Record<string, string>;
  agentModelSorts?: string[];
}

export interface CatalogThinking {
  budget?: number;
  /** Catalog thinkingLevel rank, when the entry carries one. */
  level?: number;
}

export interface CatalogSnapshot {
  enums: Record<string, string>;
  runtimeIds: string[];
  thinking: Record<string, CatalogThinking>;
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
}

export interface ModelPlan {
  runtimeModelId: string;
  modelEnum: string;
  thinkingConfig: { includeThoughts: boolean; thinkingBudget?: number; thinkingLevel?: string };
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
   * Returns the provider-scoped catalog of every model type (Pi 1.0 persists
   * chat, image, and classifier entries alike), so a chat-only consumer narrows
   * by `model.type ?? "chat"` at its own call site.
   */
  refresh(context: RefreshContext): Promise<Array<AnyModel>>;
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

export function buildThinkingMap(models: AvailableModelItem[]): Record<string, CatalogThinking> {
  return Object.fromEntries(
    models.map((m) => [
      m.id,
      {
        ...(typeof m.thinkingBudget === "number" ? { budget: m.thinkingBudget } : {}),
        ...(typeof m.thinkingLevel === "number" ? { level: m.thinkingLevel } : {}),
      },
    ]),
  );
}

function snapshotFromCatalog(catalog: AvailableModelsCatalog): CatalogSnapshot {
  return {
    enums: { ...catalog.modelEnums },
    runtimeIds: [...new Set(catalog.models.map((m) => m.id))],
    thinking: buildThinkingMap(catalog.models),
  };
}

function copySnapshot(snapshot: CatalogSnapshot): CatalogSnapshot {
  return {
    enums: { ...snapshot.enums },
    runtimeIds: [...snapshot.runtimeIds],
    thinking: Object.fromEntries(
      Object.entries(snapshot.thinking).map(([id, info]) => [id, { ...info }]),
    ),
  };
}

const EMPTY_SNAPSHOT = (): CatalogSnapshot => ({ enums: {}, runtimeIds: [], thinking: {} });

export function parseAvailableModels(data: any): AvailableModelsCatalog {
  if (!data || typeof data !== "object") {
    return { models: [], modelEnums: {} };
  }

  const models: AvailableModelItem[] = [];
  const modelEnums: Record<string, string> = {};

  const modelsObj = data.models || {};
  for (const [id, info] of Object.entries<any>(modelsObj)) {
    if (id.startsWith("tab_") || id.startsWith("chat_")) continue; // hide internal completions
    // Server-gated for this account (e.g. plan-locked): agy hides these too.
    if (info?.disabled === true) continue;

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
      supportsThinking: Boolean(info.supportsThinking),
      thinkingBudget: typeof info.thinkingBudget === "number" ? info.thinkingBudget : undefined,
      thinkingLevel: typeof info.thinkingLevel === "number" ? info.thinkingLevel : undefined,
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

async function fetchAvailableModelsCatalog(
  source: CredentialSource,
  signal?: AbortSignal,
  client: AntigravityClient = defaultAntigravityClient,
): Promise<AvailableModelsCatalog> {
  const json = await client.fetchAvailableModels(source, signal);
  return parseAvailableModels(json);
}

function toPersistedSnapshot(snapshot: CatalogSnapshot): PersistedSnapshot {
  return {
    modelEnums: { ...snapshot.enums },
    runtimeIds: [...snapshot.runtimeIds],
    thinking: { ...snapshot.thinking },
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
  if (!enums && !runtimeIds && !thinking) return undefined;
  return { enums: enums ?? {}, runtimeIds: runtimeIds ?? [], thinking: thinking ?? {} };
}

/**
 * Runtime Model ID for a public ID and an effort Pi has already clamped to the model's
 * thinkingLevelMap (stream.ts). The tier named after the effort wins; otherwise an exact
 * runtime ID, or a base with a single variant, serves every effort.
 */
function resolveRuntimeModelId(modelId: string, effort: string | undefined, runtimeIds: string[]): string {
  const tiered = `${modelId}-${effort ?? "high"}`;
  if (runtimeIds.includes(tiered)) return tiered;
  const variants = runtimeIds.filter((id) => extractBaseModelId(id) === modelId);
  return variants.length === 1 ? variants[0] : modelId;
}

/**
 * Catalog thinkingLevel rank -> wire effort name. The catalog is the only source: the
 * runtime ID's tier suffix and this rank are two spellings of the same fact (Claude 5.5
 * pairs -low/-medium/-high with 1/2/3), and reading it off the ID instead was a second
 * path that could disagree with what the server actually said.
 *
 * Only the ranks a capture has actually shown are mapped: agy 1.3.5 sends LOW for rank 1
 * (Claude 5.5 low, and the gemini-3.5-flash-lite checkpoint call) and HIGH for rank 3
 * (Claude 5.5 high); rank 2 sits between them. No capture has shown a rank above 3 — every
 * entry across agy_cli_1.3.3/1.3.4/1.3.5 reports 1, 2 or 3. A rank outside this table is
 * not guessed: resolution falls through to the budget, and an entry with neither runs
 * without thoughts until a capture spells the rank and the row is added here.
 */
const CATALOG_LEVEL_NAMES: Record<number, string> = { 1: "LOW", 2: "MEDIUM", 3: "HIGH" };

function resolveThinkingConfig(
  runtimeModelId: string,
  snapshot: CatalogSnapshot
): { includeThoughts: boolean; thinkingBudget?: number; thinkingLevel?: string } {
  const entry = snapshot.thinking[runtimeModelId];
  // The named effort outranks the token budget when an entry carries both. agy 1.3.5's
  // checkpoint call is the evidence: gemini-3.5-flash-lite is catalogued with
  // thinkingBudget -1 AND thinkingLevel 1, and agy puts thinkingLevel LOW on the wire —
  // never thinkingBudget -1. Entries carrying only one field resolve the same either way
  // (gemini-3.8-flash-high: budget -1 alone -> thinkingBudget -1; claude-sonnet-5-5-*:
  // level alone -> thinkingLevel).
  const named = entry?.level != null ? CATALOG_LEVEL_NAMES[entry.level] : undefined;
  if (named) {
    return { includeThoughts: true, thinkingLevel: named };
  }
  if (typeof entry?.budget === "number") {
    return { includeThoughts: true, thinkingBudget: entry.budget };
  }
  // The catalog named no effort at all: stay disabled rather than read one off the runtime
  // ID. The ID's tier suffix and the catalog's rank are the same fact, so the catalog is
  // where it comes from; when a rank this table cannot spell ships, the capture that spells
  // it adds the row here, and until then the entry runs without thoughts.
  return { includeThoughts: false, thinkingBudget: 0 };
}

export function resolveModelPlan(
  publicModelId: string,
  effort: string | undefined,
  snapshot: CatalogSnapshot
): ModelPlan {
  const runtimeModelId = resolveRuntimeModelId(publicModelId, effort, snapshot.runtimeIds);
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

/** Smallest positive value across variants, or undefined when none carries one. */
function minAcrossVariants(values: Array<number | undefined>): number | undefined {
  const known = values.filter((n): n is number => typeof n === "number" && n > 0);
  return known.length > 0 ? Math.min(...known) : undefined;
}

function synthesizeDynamicModel(baseId: string, items: AvailableModelItem[]): Model<any> {
  const repItem = items.find((it) => it.id === `${baseId}-high` || it.id === baseId) || items[0];

  // Offer exactly the levels the catalog has a variant for; an unsuffixed runtime ID
  // serves the default (high) effort. agy has no off or minimal effort, and Pi treats an
  // absent key as supported, so both are hidden explicitly.
  const tiers = new Set(items.map((it) => (it.id === baseId ? "high" : it.id.slice(baseId.length + 1))));
  const thinkingLevelMap: ThinkingLevelMap = { off: null, minimal: null };
  for (const level of THINKING_LEVELS) thinkingLevelMap[level] = tiers.has(level) ? level : null;

  const profile = getModelProfile(baseId);
  const defaultContext = profile.defaultContextWindow;
  const defaultMaxOutput = profile.defaultMaxOutputTokens;

  return {
    id: baseId,
    name: formatModelDisplayName(baseId, repItem?.displayName),
    provider: PROVIDER_ID,
    api: "antigravity-api",
    baseUrl: DEFAULT_ENDPOINT,
    // One Pi Model stands for every tier variant, and any of them may serve a request,
    // so capabilities and limits are the ones every variant honors.
    // ponytail: limits are the minimum across variants, so a larger tier's ceiling is
    // under-reported when tiers differ; upgrade path is clamping per resolved variant.
    reasoning: items.some((it) => it.supportsThinking),
    thinkingLevelMap,
    input: items.every((it) => it.supportsImages) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    promptCache: profile.promptCache,
    contextWindow: minAcrossVariants(items.map((it) => it.maxTokens)) ?? defaultContext,
    maxTokens: minAcrossVariants(items.map((it) => it.maxOutputTokens)) ?? defaultMaxOutput,
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
export function createModelCatalog(deps?: { client?: AntigravityClient }): ModelCatalog {
  const client = deps?.client ?? defaultAntigravityClient;
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

  const refresh = async (context: RefreshContext): Promise<Array<AnyModel>> => {
    const persisted = context.stored?.[PRIVATE_SNAPSHOT_KEY];
    if (persisted) restore(persisted);

    // Provider-scoped persisted catalog: Pi 1.0 keeps entries of every model type
    // here (chat, image, classifier), so pass the stored entries through unchanged.
    const storedModels = (): Array<AnyModel> => [...(context.stored?.models ?? [])];
    if (!context.allowNetwork) return storedModels();

    try {
      const catalog = await fetchAvailableModelsCatalog(context, context.signal, client);
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
