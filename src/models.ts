/**
 * Pure domain module encapsulating Model Family classification, base model identifier
 * extraction, and thinking effort tier vocabularies across Turn Trace request construction,
 * Quota Pool grouping, and Model Catalog resolution.
 */

export type CanonicalTier = "low" | "medium" | "high";

/**
 * Canonical Tier Suffix: The wire suffix that mirrors the user-requested thinking
 * effort by name (-low, -medium, -high), attempted first when resolving a Runtime Model ID.
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
 */
export const TIER_ALIASES: Record<CanonicalTier, readonly string[]> = Object.freeze({
  low: Object.freeze(["-extra-low"]),
  medium: Object.freeze([]),
  high: Object.freeze(["-thinking", "-agent"]),
});

/**
 * Special suffixes in the catalog that designate non-effort variant types (e.g. server-directed
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
 * Ordered candidate suffixes attempted when resolving a Runtime Model ID for an effort.
 * Canonical suffix comes first, followed by fallbacks.
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

export function tierCandidateOrder(effort?: string): readonly string[] {
  if (!effort) return DEFAULT_TIER_ORDER;
  const canonical = effort in CANONICAL_TIER_SUFFIXES
    ? [CANONICAL_TIER_SUFFIXES[effort as CanonicalTier]]
    : [`-${effort}`];
  const fallbacks = TIER_FALLBACKS[effort] ?? DEFAULT_TIER_ORDER;
  return [...new Set([...canonical, ...fallbacks])];
}


/**
 * Checks Model Family compatibility for thoughtSignature replay.
 * Protocol specifications demonstrate that:
 * - Gemini models (gemini-3.7, gemini-3.8, etc.) share thoughtSignatures seamlessly.
 * - Claude models replay thoughtSignatures within the Claude family, part-split
 *   like Gemini.
 * - Non-Gemini models (Claude, GPT-OSS) do NOT share signatures with Gemini models.
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

export function isCompatibleFamily(msgModel?: string, targetModelId?: string): boolean {
  if (!msgModel || !targetModelId) return true;
  if (msgModel === targetModelId) return true;

  const msgFamily = classifyModelFamily(msgModel);
  if (msgFamily !== "unknown" && msgFamily === classifyModelFamily(targetModelId)) return true;

  return extractBaseModelId(msgModel) === extractBaseModelId(targetModelId);
}
