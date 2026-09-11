# Antigravity Provider Context

The domain model behind the Google Antigravity extension for Pi Coding Agent.

## Language

### Wire & Protocol

**Wire Fingerprint**:
The observable shape of requests and responses as they appear on the network while the official `agy` CLI talks to the backend (endpoints, HTTP headers, envelope structure).
_Avoid_: Wire format, API schema, traffic dump

**Capture Fixture**:
Raw request/response data extracted from a specific version of the official `agy` CLI with `mitmproxy` and frozen under `captures/agy_cli_{version}/`.
_Avoid_: Mock data, dummy payload, test sample

**Capture Scenario**:
The canonical, version-independent capture plan declared once in `captures/scenarios.json`: the ordered Capture Slots, the sessions and exact commands that produce them, the replay chains between slots, and what each slot must prove.
_Avoid_: Test plan, capture checklist, scenario matrix

**Capture Slot**:
One frozen fixture pair (`<slot>.req.json` + `<slot>.resp.sse`) declared by the Capture Scenario, carrying its session, mode (fresh / same invocation / `-c` continuation) and expected request and response shapes.
_Avoid_: Fixture name, capture step, turn number

**Capture Deviation**:
A declared and reasoned exception (omit or patch) that a version directory records in the Capture Scenario when its capture could not follow the canonical slots.
_Avoid_: Exception, override, legacy special case

**Turn Trace**:
Captured data of one consecutive conversation of at least 5 turns, used to verify how `thoughtSignature` and tool-call state (`functionCall`/`functionResponse`) propagate.
_Avoid_: Chat history, message log, turn dump

**Thought Signature**:
The verification token a Gemini 3.x family model must hand back on multi-turn conversations and tool calls as proof that the previous thinking block continues.
_Avoid_: Thought token, thinking hash, thought checksum

**Turn Trace Request Builder**:
The module that takes a Turn Trace and a Model Plan and assembles the single Wire Fingerprint request envelope the backend requires, encapsulating session-identity derivation, Thought Signature validation, and tool-schema conversion.
_Avoid_: Request serializer, payload generator, message mapper

**Sentinel Divergence**:
The intentional Wire Fingerprint exception that carries `skip_thought_signature_validator` on an unsigned `functionCall`, and only where `agy` cannot produce the situation (a tool call authored by another provider/model family). It is never applied to a lost signature from the same provider and family, so that failure stays visible (ADR-0007).
_Avoid_: Sentinel injection, signature bypass, validation skip

### Models & Routing

**Public Model ID**:
The normalized model identifier exposed to users in Pi's model picker (`/model`) (e.g. `gemini-3.8-flash`, `claude-sonnet-4-6`).
_Avoid_: Display name, UI alias

**Runtime Model ID**:
The internal model identifier the Google Antigravity backend API actually requires in the request body (e.g. `gemini-3.8-flash-high`, `gemini-pro-agent`).
_Avoid_: Backend model, internal model, actual ID

**Model Catalog**:
The model set produced by querying the backend's `fetchAvailableModels` API dynamically and mapping it onto Pi's `Public Model ID` ↔ `Runtime Model ID` pairs.
_Avoid_: Model registry, model list, model table

**Catalog Persistence**:
The standard local cache and offline-restore mechanism for the remote model catalog that Pi Core provides through `~/.config/pi/models-store.json`.
_Avoid_: Model cache, local storage, custom catalog file

**Catalog Generation**:
The bundle one successful refresh leaves behind (snapshot + full items). fresh is the state after a new generation has landed, stale is showing a retained generation labelled as such after a fetch failure, and failed is having nothing retained either.
_Avoid_: Catalog version, snapshot number

**Model Plan**:
The bundle a `Model Catalog` resolves in one shot for a single `Public Model ID` + thinking-effort combination (`Runtime Model ID`, model enum, thinking budget, non-Gemini flag, Claude flag).
_Avoid_: Resolved model, model config, runtime bundle

**Model Family**:
The `Runtime Model ID` grouping that decides whether Thought Signature replay is possible (`gemini-`/`claude-`/`gpt-` prefix plus base-id equality). Signatures are carried forward only inside the same family.
_Avoid_: Model group, vendor prefix

### Quota & Account

**Quota Pool**:
The usage limit a model group (Gemini pool, Claude/GPT-OSS pool, …) shares per 5-hour and weekly window, according to the Google account's tier.
_Avoid_: Rate limit, token bucket, credit

**Quota Status**:
The Quota Pool remaining summary shown in the footer slot, plus the refresh and correction responsibility behind it.
_Avoid_: Quota widget

### Interface

**Subcommand**:
An argument appended to the single root `/antigravity` command that selects a detail action (`usage`, `models`, `refresh`, `login`).
_Avoid_: Command flag, option, action
