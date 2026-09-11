# 14. Canonical Effort-Named Tier Suffixes and Declared Exceptions

We decided that Model Catalog tier resolution and picker advertisement derive from a single
canonical effort-suffix mapping (`-low`, `-medium`, `-high`), with non-canonical wire variants
isolated as declared aliases (`-thinking`, `-agent`, `-extra-low`, unsuffixed bare ID),
special tokens (`-tiered`), or upward escalation fallbacks (`TIER_FALLBACKS`).

Across all four captured agy versions (1.1.26 to 1.2.0), 11 of the 14 recommended model IDs
strictly follow the canonical effort-named suffix pattern (`gemini-3.8-flash-{high,medium,low}`,
`gemini-3.7-flash-*`, `gemini-3.6-flash-*`, `gemini-3.1-pro-low`, `gpt-oss-120b-medium`).
The remaining three offered models are stable exceptions: `gemini-pro-agent` (a server-directed
rename of `-high`), `claude-opus-4-6-thinking` (a `-thinking` alias for the high tier), and
`claude-sonnet-4-6` (a single-variant model with an unsuffixed bare identifier).

Previously, the tier vocabulary was restated across four separate locations in `model-catalog.ts`
(the strip regex in `extractBaseModelId`, the `endsWith` chain in `resolveRuntimeModelId`,
`TIER_FALLBACKS`, and `hasVariant` arrays in `synthesizeDynamicModel`), allowing the request-side
resolver and the picker-side advertiser to diverge silently.

Consequences:

- The canonical mapping (`CANONICAL_TIER_SUFFIXES`), aliases (`TIER_ALIASES`), and special
  strip-only tokens (`SPECIAL_TIER_SUFFIXES`) are declared once. Suffix strip patterns and
  `endsWith` recognition sets are derived from their union (`ALL_TIER_SUFFIXES`).
- Resolution candidate order (`tierCandidateOrder`) tries canonical suffixes first, followed by
  aliases, and finally upward fallbacks (`TIER_FALLBACKS`).
- Picker effort advertisement (`tierSpellings`) only checks canonical and alias spellings,
  preserving ADR-0009's invariant that Gemini 3.1 Pro hides the `medium` effort level even though
  the resolver safely escalates unadvertised medium requests to high.
- `synthesizeDynamicModel` uses `classifyModelFamily` instead of duplicating prefix checks
  for Claude and GPT models.
- Revisit gate: agy captures introduce a new effort level (e.g. `minimal` or `off`), or the wire
  alters the suffix naming convention for current canonical tiers.
