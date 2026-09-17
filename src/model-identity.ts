/**
 * Pure domain module encapsulating Model Family classification across
 * Turn Trace request construction, Quota Pool grouping, and Model Catalog resolution.
 */

export type ModelFamily = "gemini" | "claude" | "gpt" | "unknown";

/**
 * The single model-identity predicate: which
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

/**
 * Checks Model Family compatibility for thoughtSignature replay.
 * Protocol specifications demonstrate that:
 * - Gemini models (gemini-3.7, gemini-3.8, etc.) share thoughtSignatures seamlessly.
 * - Claude models replay thoughtSignatures within the Claude family, part-split like Gemini.
 * - Non-Gemini models (Claude, GPT-OSS) do NOT share signatures with Gemini models.
 */
export function isCompatibleFamily(msgModel?: string, targetModelId?: string): boolean {
  if (!msgModel || !targetModelId) return true;
  if (msgModel === targetModelId) return true;

  const msgFamily = classifyModelFamily(msgModel);
  if (msgFamily !== "unknown" && msgFamily === classifyModelFamily(targetModelId)) return true;

  return false;
}
