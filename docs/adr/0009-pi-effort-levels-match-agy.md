# 9. Pi Effort Levels Mirror agy's (No off, No minimal)

We decided the provider advertises exactly the effort levels agy offers — `low`, `medium`, `high` — and only those a model actually has a wire variant for, by deriving `thinkingLevelMap` from the snapshot's variant list (#36 follow-up).

`agy --effort` accepts only `low|medium|high` and its `/effort` picker offers the same; there is no way for an agy user to request a model call with thinking off or at minimal effort. Pi, however, offers `off` and `minimal` to any model with `reasoning: true`, and Pi signals `off` by *omitting* `reasoning` from the provider options — which a provider cannot tell apart from "no level given". Before this change, a Pi user picking `off` silently got the default (high variant, thinking on). The per-model half is the same principle: Gemini 3.1 Pro lists no `-medium` variant, so offering `medium` would silently resolve to the high tier.

Considered alternative: honour `off` by sending `{ includeThoughts: false, thinkingBudget: 0 }`. The wire does have that shape — agy itself uses it for its internal title-summarizer call — but no capture covers it on a user-selected model, and agy never emits it for a user turn, so shipping it would be an unverified divergence from ADR-0001's strict-parity rule. Hiding the level keeps Pi's and agy's effort surfaces identical without inventing wire behavior.

Consequences:

- Pi's picker shows only the tiers the snapshot lists: `low`/`medium`/`high` for the Flash family, `low`/`high` for Gemini 3.1 Pro, `medium` alone for gpt-oss, and `high` alone for the single-variant Claude models (their only variant is the default/high tier).
- A saved level the model cannot serve is clamped down by Pi (e.g. `medium` → `high` on Pro), and `off`/`minimal` clamps to `low`.
- The resolver's `minimal → low` fallback stays as defense for callers that bypass the picker (the value is inside Pi's `ThinkingLevel` type, and older Pi builds may pass it literally), but no user-facing path produces it.
- Revisit if agy ever ships an off/minimal effort (capture it first), if a model's variants stop matching the suffix vocabulary, or if a verified thinking-off capture on a user-selected model makes the divergence worth taking.
