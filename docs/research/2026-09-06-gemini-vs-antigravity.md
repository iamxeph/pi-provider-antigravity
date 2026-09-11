# Gemini API vs Antigravity API — Are the Specs Different, and Why?

> Dated research note (2026-09-06, agy 1.1.27 era). Version capture directories rotate:
> only the newest stays in the tree, so the `captures/agy_cli_1.1.27/...` citations below
> refer to that version's fixtures as they were — git history keeps them.

## TL;DR

- Yes: different hosts, auth, envelope, model IDs, and auxiliary APIs — same Gemini content-part vocabulary underneath. [1][2]
- Gemini API is a public per-key LLM API (`generativelanguage.googleapis.com/v1beta`, `x-goog-api-key`); Antigravity is an internal IDE-agent backend (`daily-cloudcode-pa.googleapis.com/v1internal`, OAuth Bearer + project). [1][3]
- Antigravity wraps the request in `{project, requestId, request:{...}, model, userAgent, requestType}` with session/trajectory labels; Gemini takes `contents` + `generationConfig` bare. [3][4]
- Runtime model IDs (`gemini-3.7-flash-high`, `claude-sonnet-4-6`) and quota pools have no Gemini-API equivalent — they exist for routing and subscription metering. [5][6]
- Thinking (`thought`/`thoughtSignature`) and `functionCall`/`functionResponse` shapes are shared concepts, but Antigravity pins stricter placement rules (part-split replay, `id` on calls, `{output}` envelope). [7][8]

## Spec comparison table

| Axis | Gemini API (public) | Antigravity API (internal IDE backend) |
|---|---|---|
| Endpoint host | `generativelanguage.googleapis.com` [1] | `daily-cloudcode-pa.googleapis.com` (prod: `cloudcode-pa.googleapis.com`) [3][9] |
| Method + version | `POST /v1beta/models/{model}:generateContent` / `:streamGenerateContent` [1] | `POST /v1internal:streamGenerateContent?alt=sse` [3] |
| Auth | `x-goog-api-key: KEY` header (or `?key=`) per API key [2] | `Authorization: Bearer <OAuth>` + `project: "aicode-consumers"` in body [3] |
| Envelope | Bare `GenerateContentRequest`: `contents`, `systemInstruction`, `tools`, `generationConfig` at top level [4] | Wrapper `{project, requestId: "agent/<sid>/…", request:{contents,…}, model, userAgent:"antigravity", requestType:"agent"}` [3] |
| Session tracking | None (stateless; client resends history) [4] | `requestId` sequence `agent/<sid>/<ts>/<traj>/<n>`; `labels{trajectory_id, request_id, last_step_index, model_enum, used_claude*, used_non_gemini_model}`; numeric `sessionId` [3] |
| Model IDs | Public (`models/gemini-2.5-pro`) in URL path [1] | Runtime IDs in body (`gemini-3.7-flash-high`, `claude-sonnet-4-6`); `-low/-medium/-high` suffix encodes effort [3][5] |
| Thinking | `thinkingConfig{includeThoughts, thinkingBudget}` in `generationConfig`; `thoughtSignature` must be replayed verbatim on follow-ups [7] | Same keys, but pinned per-level budgets (flash low=1000, medium=4000, high=-1; claude=1024) and part-split replay: bare `{thought:true,text}` part, signature rides the NEXT text/`functionCall` part [3][5] |
| Tools | `functionCall{name,args[,id]}` (Gemini 3 adds `id`); `functionResponse{name,response}`; result `role` is `user` [8] | `functionCall{id,name,args}` always has `id`; `functionResponse{id,name,response:{output:string}}` with `role:"model"`; errors also use `{output}` with `Encountered error in tool execution: …`, no `error` key [3] |
| Tool declarations | `functionDeclarations{name,description,parameters}` [8] | Same, but legacy `parameters` only (never `parametersJsonSchema`), `$schema/$defs` stripped [3] |
| Auxiliary APIs | None (billing per key in AI Studio) [2] | `v1internal:fetchAvailableModels`, `v1internal:loadCodeAssist{metadata:{ideType:ANTIGRAVITY}}`, `v1internal:retrieveUserQuotaSummary` (5h/weekly pools per model group) [6] |

## Evidence

- [1] Endpoint + bare body: `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent` with `-H "x-goog-api-key"` and `-d '{"contents":[…]}'` — https://ai.google.dev/gemini-api/docs/generate-content/get-started ; method table `POST /v1beta/{model=models/*}:generateContent` — https://ai.google.dev/api/all-methods ; body = `contents[]`, `systemInstruction`, `tools`, `generationConfig` — https://ai.google.dev/api/generate-content
- [2] Auth via API key: "All requests to the Gemini API must include a `x-goog-api-key` header" — https://ai.google.dev/api ; key lifecycle — https://ai.google.dev/gemini-api/docs/api-key
- [3] Antigravity wire (captures = official `agy` CLI 1.1.27 traffic via mitmproxy): URL `https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`, headers `Authorization: Bearer`, body keys `[model,project,request,requestId,requestType,userAgent]`, `project:"aicode-consumers"`, `model:"gemini-3.7-flash-high"`, `requestId:"agent/<sid>/…"` — `captures/agy_cli_1.1.27/stream_turn1_initial.req.json`; thinking part-split (`{thought:true}` bare, sig on next part) — `stream_turn4_thinking.req.json`; multiturn replay — `stream_turn5_multiturn.req.json`; error `{output:"…Encountered error in tool execution:…"}`, no `error` key, `role:"model"`, `id` on call+response — `stream_turn6_toolerror.req.json`, `stream_turn2_toolresult.req.json`; low budget `thinkingBudget:1000` on `-low` — `stream_turn6_toolerror.req.json`; procedure — `captures/README.md` §§1–3
- [4] Bare vs wrapped: Gemini body has `contents` at top level [1]; Antigravity nests under `.body.request` (`{project, requestId, request:{…}, model, …}`) — `captures/README.md` §3; builder reproduces it — `src/builder.ts` `buildAntigravityRequestBody`; headers — `src/protocol.ts` (`DEFAULT_ENDPOINT`, `buildAntigravityHeaders`); POST `…/v1internal:streamGenerateContent?alt=sse` — `src/stream.ts`
- [5] Runtime IDs + budgets: `model:"gemini-3.7-flash-high"` + `thinkingConfig{includeThoughts:true,thinkingBudget:-1}` (turn1/4/5), `-low`→1000 (turn6), `claude-sonnet-4-6` + budget 1024 + `used_claude:"true"` labels (turn8) — `captures/agy_cli_1.1.27/stream_turn{1,4,5,6,8}_*.req.json`; effort→suffix/budget mapping — `src/catalog.ts` `getThinkingConfig`/`resolveRuntimeModelId`; domain terms — `CONTEXT.md` (Runtime Model ID, Model Plan, Model Catalog)
- [6] Auxiliary APIs: `POST …/v1internal:fetchAvailableModels{project}`, `…/v1internal:retrieveUserQuotaSummary{project}` (pools `gemini-5h`/`gemini-weekly`, `3p-5h`/`3p-weekly`), `…/v1internal:loadCodeAssist{metadata:{ideType:ANTIGRAVITY}}` — `captures/agy_cli_1.1.27/{models,quota,load_code_assist}.req.json` + `.resp.json`; domain term — `CONTEXT.md` (Quota Pool)
- [7] Thinking shared concept: "handled automatically… only manage manually with REST/multi-turn" and signature "always present" — https://ai.google.dev/gemini-api/docs/thought-signatures ; "Gemini 3 models enforce stricter validation" — https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures ; replay/validation rules — `src/builder.ts` (`isValidThoughtSignature`, part-split pending-sig); why fixtures must be ≥5 turns — `docs/adr/0003-multi-turn-session-fixtures.md`
- [8] Tools shared concept: "Gemini 3… unique `id` for every function call… pass matching `id` in `functionResponse`" — https://ai.google.dev/gemini-api/docs/function-calling ; modes `AUTO/NONE/ANY` — https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/Shared.Types/FunctionCallingConfig ; Antigravity pins (`id` always, `{output}`, legacy `parameters`) — `src/builder.ts` (`normalizeToolCallId`, `convertTools`, toolResult `{output}`); strict-parity policy — `docs/adr/0001-strict-wire-fingerprint-fixtures.md`; single deep builder — `docs/adr/0006-deep-turn-trace-request-builder.md`
- [9] Cloud Code Assist lineage (third-party corroboration; first-party docs for `v1internal` are thin — see Open questions): `CODE_ASSIST_ENDPOINT='https://cloudcode-pa.googleapis.com'`, `CODE_ASSIST_API_VERSION='v1internal'` — https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/server.ts ; daily-vs-prod endpoints — https://docs.rs/crate/claude-proxy/latest/source/src/gemini/provider.rs ; endpoint table — https://github.com/tccpc/opencode-antigravity-auth/blob/main/docs/ANTIGRAVITY_API_SPEC.md (unofficial)

## Why it diverges (numbered reasons)

1. Internal IDE-agent backend, not a public LLM API. `v1internal` + `loadCodeAssist{ideType:ANTIGRAVITY}` + `userAgent:"antigravity"` scope the caller as an IDE agent install, so the server can gate features and abuse per install rather than per API key [3][6][9]. (Lineage to Cloud Code Assist [9] is corroborated but unofficial — speculation that Google will ever document `v1internal`.)
2. User/project scoping replaces API keys. OAuth Bearer + `project:"aicode-consumers"` ties usage to a Google account/subscription instead of a metered key, which is what enables quota pools rather than per-token billing [3][6].
3. Session/trajectory tracking for agentic loops. `requestId agent/<sid>/…`, `labels{trajectory_id, request_id, last_step_index, last_execution_id}`, numeric `sessionId` let the backend stitch tool-error retries and multi-turn continuations into one trajectory — the public API is stateless [3][4].
4. Quota pooling per account tier. `retrieveUserQuotaSummary` returns 5h/weekly buckets per model group (Gemini vs Claude/GPT); `fetchAvailableModels` carries per-model `remainingFraction` — a subscription construct with no Gemini-API counterpart [6].
5. Model routing/abstraction behind one endpoint. Runtime IDs (`-high/-low`, `claude-sonnet-4-6`, `gpt-oss-120b-medium`) plus `labels{model_enum, used_claude*, used_non_gemini_model}` let one endpoint serve Gemini + Claude + GPT-OSS with per-family thinking budgets — the public API addresses one `models/{model}` per call [1][3][5].
6. IDE system-context + side requests. Every turn carries a ~15k-char `systemInstruction` and each run emits a `gemini-3.1-flash-lite` title-summarizer request — agent UX the bare API leaves to the client [3] (`stream_turn1_initial.req.json` `systemInstruction`; `captures/README.md` §2).

## What this means for pi-provider-antigravity

- Keep strict wire fingerprinting: any envelope/header/label drift breaks against `v1internal`, so new behavior needs a fresh capture first — policy in `docs/adr/0001-strict-wire-fingerprint-fixtures.md`, runbook `captures/README.md`, package `pi-provider-antigravity@0.2.0` (`package.json`).
- Keep the deep builder as the single seam (`src/builder.ts` → `src/stream.ts` → `src/protocol.ts`): session derivation, signature replay, and `{output}` enforcement stay in one place per `docs/adr/0006-deep-turn-trace-request-builder.md`.
- Never send public model IDs or omit `thoughtSignature` replay: map via catalog (`src/catalog.ts`) and test replays over ≥5-turn traces per `docs/adr/0003-multi-turn-session-fixtures.md`.
- Treat Gemini docs as vocabulary, not wire truth: `thought`/`thinkingConfig`/`functionCall` concepts transfer [7][8]; endpoint, auth, envelope, and quota do not [1][2][6].

## Open questions

- No first-party public reference for `daily-cloudcode-pa.googleapis.com/v1internal` was found (only gemini-cli source [9] and forum TLS/timeout threads); Antigravity side stays grounded in capture fixtures until Google publishes docs.
- Exact server-side semantics of `last_execution_id` / `last_step_index` counter skips (+2 after tool execution, `captures/README.md` §2) are observed, not specified.
- Whether `used_claude_conservative` ever differs from `used_claude` (always equal in current fixtures) is uncovered — needs a targeted capture.
