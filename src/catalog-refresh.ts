import { postAntigravity } from "./protocol.ts";
import { parseStoredCredentials } from "./auth.ts";
import type {
  AvailableModelItem,
  AvailableModelsCatalog,
  CatalogStore,
  PersistedSnapshot,
} from "./model-catalog.ts";
import {
  buildDynamicPublicModels,
  fromPersistedSnapshot,
  toPersistedSnapshot,
} from "./model-catalog.ts";
import type { Model } from "@earendil-works/pi-ai";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";

/**
 * The provider-private snapshot kept inside this provider's own store entry.
 * Pi persists unknown keys verbatim, and the canonical store entry carries only
 * pi `Model`s — which do not hold the Wire-side data an offline restart needs
 * (model enums, per-Runtime-ID thinking budgets, server-directed renames).
 * Shape and codec: model-catalog.ts.
 */
const PRIVATE_SNAPSHOT_KEY = "pi-provider-antigravity";

type StoreEntry = NonNullable<RefreshModelsContext["stored"]>;

/**
 * `RefreshModelsContext` plus the private key above: the canonical type covers
 * pi's own fields (no `any`), this adds what this provider writes into the entry.
 * The persisted value is typed through the codec's own shape, so a rename on
 * either side fails the typecheck instead of silently disabling the offline
 * restore.
 */
type RefreshContext = Omit<RefreshModelsContext, "stored" | "publish"> & {
  stored?: Readonly<StoreEntry> & { [PRIVATE_SNAPSHOT_KEY]?: PersistedSnapshot };
  publish(publication: {
    persist?: (StoreEntry & { [PRIVATE_SNAPSHOT_KEY]?: PersistedSnapshot }) | null;
    update?: () => void;
  }): Promise<boolean>;
};

/**
 * Model Catalog refresh (wire, ports & adapters): fetchAvailableModels fetch,
 * Capture Fixture-shaped parse, and Catalog Persistence publish.
 * Produces AvailableModelsCatalog values and records them through the injected
 * CatalogStore; the store, the snapshot types and the persistence codec live in
 * model-catalog.ts.
 */
export async function refreshCatalog(context: RefreshContext, store: CatalogStore): Promise<Array<Model<any>>> {
  // Restore the persisted snapshot first for offline restart support. The store
  // keeps it out of a recorded generation, so a later restore in the same
  // process can never clobber fresher in-memory data with older persisted data.
  const persisted = fromPersistedSnapshot(context.stored?.[PRIVATE_SNAPSHOT_KEY]);
  if (persisted) store.restore(persisted);

  // The stored models are pi's own (readonly) array: hand the caller its own copy.
  const storedModels = () => [...(context.stored?.models ?? [])];

  if (!context.allowNetwork) {
    return storedModels();
  }

  try {
    // Pi hands one credential per provider: this provider's own flow stores an
    // OAuth credential whose `access` is the JSON envelope with the project id.
    const credential = context.credential;
    const apiKey = credential?.type === "oauth" ? credential.access : undefined;
    if (!apiKey) {
      return storedModels();
    }

    const { token, projectId } = parseStoredCredentials(apiKey);
    const catalog = await fetchAvailableModelsCatalog(token, projectId, context.signal);
    store.record(catalog);

    const dynamicModels = buildDynamicPublicModels(catalog);

    // Publish to Pi models-store.json from the recorded generation (not the
    // transient parse), so stored and published are always one generation.
    if (context.publish) {
      await context.publish({
        persist: {
          models: dynamicModels,
          checkedAt: Date.now(),
          [PRIVATE_SNAPSHOT_KEY]: toPersistedSnapshot(store.generation().snapshot),
        },
      });
    }

    return dynamicModels;
  } catch {
    return storedModels();
  }
}

/**
 * Freshness outcome behind the single catalog seam: whether a refresh
 * landed a new Catalog Generation. `commands.ts` reads only this —
 * the snapshot version never crosses the seam.
 * fresh = a new generation landed (a bump also lands when the content is
 * identical: the version is a fetch-success signal, not a change signal).
 * stale = the fetch failed but a retained generation exists.
 * failed = the fetch failed and nothing is retained.
 */
export interface CatalogRefreshOutcome {
  status: "fresh" | "stale" | "failed";
  catalog?: AvailableModelsCatalog;
}

/**
 * Runs one refresh through the given Pi refresh hook and reports which
 * Catalog Generation the callers must show. The hook keeps its own
 * contract (swallow-and-fallback); only the freshness verdict moves here.
 */
export async function refreshCatalogGeneration(
  store: CatalogStore,
  doRefresh: () => unknown,
): Promise<CatalogRefreshOutcome> {
  const versionBefore = store.generation().version;
  await doRefresh();
  const { items, version } = store.generation();
  if (!items) return { status: "failed" };
  return { status: version === versionBefore ? "stale" : "fresh", catalog: items };
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

export async function fetchAvailableModelsCatalog(
  token: string,
  projectId: string,
  signal?: AbortSignal
): Promise<AvailableModelsCatalog> {
  const res = await postAntigravity({
    token,
    path: "v1internal:fetchAvailableModels",
    body: { project: projectId },
    signal,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to fetch models (${res.status}): ${errText}`);
  }
  const json = await res.json();
  return parseAvailableModels(json);
}


