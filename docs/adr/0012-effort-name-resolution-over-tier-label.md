# 12. Effort-Name Resolution Keeps Winning over the Wire's Tier Label

We decided that Runtime Model ID resolution stays name-driven — a variant spelled after the
requested effort wins, then `TIER_FALLBACKS` — and that the wire's `displayName` tier
declaration is not consulted. One catalog entry therefore resolves to a variant the wire
labels with a different tier, deliberately, until it becomes reachable.

Evidence: the wire lists `gemini-3.5-flash-low` as `"Gemini 3.5 Flash (Medium)"` with
`thinkingBudget: 4000`, while its low tier is `gemini-3.5-flash-extra-low`
(`"… (Low)"`, `1000`) — identical in all three captured catalogues. Under name-first
resolution, `low` lands on the medium-declared variant. The base is absent from
`agentModelSorts` in all three versions, so the model is never offered, and `/model`
resolves references against the registry only (`findExactModelReferenceMatch`), so it
cannot be selected by typing the id either; the remaining path is a `models-store.json`
generation written while the server still listed the base.

A label-driven preference was implemented and reverted during the wire-fidelity audit: it
resolved this one case from `displayName`, at the cost of a presentation-string dependency
in the path every model resolution takes, to correct a model no user can pick.

Consequences:

- `tests/catalog.test.mjs` pins `gemini-3.5-flash-low` as the low answer for that base,
  which contradicts the wire's own label. That is this decision, not an oversight.
- Nothing enforces the effort/label relationship, so the mismatch is recorded here instead
  of guarded in code. Revisit gate: the server lists the base in `agentModelSorts` (the
  mismatch then becomes user-visible and must be resolved properly — a label-driven rule or
  an explicit override), or a capture shows a different tier vocabulary.
