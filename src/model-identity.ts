/**
 * Pure domain module encapsulating Model Identity, Family classification,
 * quota pool mapping, capabilities, and replay compatibility across
 * Turn Trace request construction, Quota Pool grouping, and Model Catalog resolution.
 */

export type ModelFamily = "gemini" | "claude" | "gpt" | "unknown";
export type QuotaPoolKind = "gemini" | "3p";

export interface ModelProfile {
  readonly id?: string;
  readonly family: ModelFamily;
  readonly isGemini: boolean;
  readonly isClaude: boolean;
  readonly isGpt: boolean;
  readonly isNonGemini: boolean;
  readonly quotaPoolKind: QuotaPoolKind;
  readonly replaysReasoningHistory: boolean;
  readonly defaultContextWindow: number;
  readonly defaultMaxOutputTokens: number;
  readonly promptCache: { short: number; long?: number };
  isReplayCompatible(candidateModel?: string): boolean;
}

/**
 * Derives a complete ModelProfile for any model ID space — Public or Runtime
 * Model ID, with or without a `provider/` prefix — by stripping the prefix
 * before matching.
 */
export function getModelProfile(modelId?: string): ModelProfile {
  const bare = ((modelId || "").split("/").pop() || "").toLowerCase();
  let family: ModelFamily = "unknown";
  if (bare.startsWith("gemini-")) family = "gemini";
  else if (bare.startsWith("claude-")) family = "claude";
  else if (bare.startsWith("gpt-")) family = "gpt";

  const isGemini = family === "gemini";
  const isClaude = family === "claude";
  const isGpt = family === "gpt";
  const isNonGemini = family !== "gemini";

  const quotaPoolKind: QuotaPoolKind = isClaude || isGpt ? "3p" : "gemini";
  const replaysReasoningHistory = family !== "gpt";

  const isFlash = bare.includes("flash");
  const defaultContextWindow = isFlash ? 1048576 : isClaude ? 250000 : isGpt ? 128000 : 1048576;
  const defaultMaxOutputTokens = isClaude ? 64000 : isGpt ? 32768 : 65536;
  const promptCache = isClaude ? { short: 300, long: 3600 } : { short: 300 };

  return {
    id: modelId,
    family,
    isGemini,
    isClaude,
    isGpt,
    isNonGemini,
    quotaPoolKind,
    replaysReasoningHistory,
    defaultContextWindow,
    defaultMaxOutputTokens,
    promptCache,
    isReplayCompatible(candidateModel?: string): boolean {
      if (!candidateModel || !modelId) return true;
      if (candidateModel === modelId) return true;

      const other = getModelProfile(candidateModel);
      if (other.family !== "unknown" && other.family === family) return true;

      return false;
    },
  };
}
