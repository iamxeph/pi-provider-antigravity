import { postAntigravity } from "./protocol.ts";
import { parseStoredCredentials } from "./auth.ts";
import type { AvailableModelItem, AvailableModelsCatalog } from "./model-catalog.ts";
import { buildDynamicPublicModels, getCatalogSnapshot, getStoredCatalog, ingestCatalog, updateCatalogStore } from "./model-catalog.ts";
import type { Model } from "@earendil-works/pi-ai";

/**
 * Model Catalog refresh (wire, ports & adapters): fetchAvailableModels fetch,
 * Capture Fixture-shaped parse, and Catalog Persistence publish.
 * Produces AvailableModelsCatalog values and records generations via
 * updateCatalogStore; all pure mapping and presentation lives in model-catalog.ts.
 */
export async function refreshCatalog(context: any): Promise<Array<Model<any>>> {
  // Restore from context.stored first for offline restart support,
  // but only into a pristine store: a failed refresh must not clobber a
  // fresher in-memory snapshot with older persisted data.
  const storedEnums = context.stored?.["pi-provider-antigravity"]?.modelEnums;
  const storedRuntimeIds = context.stored?.["pi-provider-antigravity"]?.runtimeIds;
  const storedThinking = context.stored?.["pi-provider-antigravity"]?.thinking;
  const storedDeprecated = context.stored?.["pi-provider-antigravity"]?.deprecated;
  if ((storedEnums || storedRuntimeIds || storedThinking || storedDeprecated) && getCatalogSnapshot().version === 0) {
    updateCatalogStore(storedEnums || {}, storedRuntimeIds || [], storedThinking || {}, storedDeprecated || {});
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
    const catalog = await fetchAvailableModelsCatalog(token, projectId, context.signal);
    ingestCatalog(catalog);

    const dynamicModels = buildDynamicPublicModels(catalog);

    // Publish to Pi models-store.json from the stored generation (not the
    // transient parse), so stored and published are always one generation.
    if (context.publish) {
      const snap = getCatalogSnapshot();
      await context.publish({
        persist: {
          models: dynamicModels,
          checkedAt: Date.now(),
          "pi-provider-antigravity": {
            modelEnums: { ...snap.enums },
            runtimeIds: [...snap.runtimeIds],
            thinking: { ...(snap.thinking ?? {}) },
            deprecated: { ...(snap.deprecated ?? {}) },
          },
        },
      });
    }

    return dynamicModels;
  } catch {
    return context.stored?.models || [];
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
  doRefresh: () => unknown,
): Promise<CatalogRefreshOutcome> {
  const before = getCatalogSnapshot().version;
  await doRefresh();
  const catalog = getStoredCatalog();
  if (!catalog) return { status: "failed" };
  if (getCatalogSnapshot().version === before) return { status: "stale", catalog };
  return { status: "fresh", catalog };
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


