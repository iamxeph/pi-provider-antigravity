# 8. Catalog Snapshot as the Single Thinking-Budget Source

We decided the Model Catalog snapshot's per-Runtime-Model-ID thinking data is the only source of thinking budgets, deleting the hardcoded family heuristics (`getThinkingConfig` and the `flash`/`pro`/`claude-`/`gpt-` suffix guesses in runtime-ID resolution) that predated it (#36).

A refresh carries `thinkingBudget` for every model the wire marks as thinking and none for the models it does not, so a Model Plan reads its budget from the same Catalog Generation as its enum and runtime ID. The heuristics were written before that per-ID data shipped (v0.3.0) and only stayed reachable for a pre-budget persist — and, contrary to the assumption that a full snapshot already covered every case, for models whose listed variant sits outside the effort candidate suffixes.

Consequences:

- A snapshot with no per-ID thinking data degrades to `{ includeThoughts: false, thinkingBudget: 0 }` rather than a guessed budget, and self-heals on the next refresh. Models the wire marks non-thinking (`gemini-2.5-flash`) resolve to the same disabled config.
- Resolution stays snapshot-driven instead of name-guessed: a model the server lists under exactly one runtime variant (`claude-opus-4-6-thinking`, `gpt-oss-120b-medium`) serves every effort from that variant, Gemini 3.1 Pro (no medium tier on the wire) falls back to its high variant instead of a lower tier, and a requested tier the server does not list (`gemini-3.5-flash` + medium) fails fast with the `Unknown model … /antigravity refresh` guidance.
- A refresh is the only heal path for a stale pre-budget persist; no migration step is added, because the disabled fallback is inert rather than wrong.
