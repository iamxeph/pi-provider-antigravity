# Pi Provider Antigravity - Agent Guidelines

## 1. Ground Truth First (Pi SDK & Type Definitions)
Always inspect Pi's official type definitions, documentation, and reference examples before writing or editing extension code. Do not guess API shapes or method names.

- **Type Definitions (Primary Reference)**:
  - `ModelRegistry` & Extension Context: `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts`, `dist/core/extensions/types.d.ts`
  - Model & Auth interfaces: `node_modules/@earendil-works/pi-ai/dist/models.d.ts`, `dist/auth/types.d.ts`
- **Official Docs & Examples**:
  - Provider & Extension Guides: `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, `docs/custom-provider.md`
  - Canonical Examples: `node_modules/@earendil-works/pi-coding-agent/examples/extensions/`
- **Zero `as any` Bypasses on Core Interfaces**:
  If a method or property is missing on `ctx.modelRegistry`, `ctx.ui`, or callback contexts, inspect the `.d.ts` declaration to locate the canonical API (e.g. `getApiKeyForProvider(provider)` instead of non-existent `getApiKey(provider)`). Never use `as any` to silence type errors on Pi interfaces.

## 2. Strict `agy` CLI Parity (Behavioral & Wire Ground Truth)
- **Strict Parity with Official `agy` CLI**: All provider behaviors—authentication flows, request headers, payload envelopes, session/trajectory labels, model identifier mapping, and quota inspection—must strictly match the official Cloud Code Assist (`agy`) CLI. Never introduce speculative API shapes or deviate from official agy CLI behavior.
- **Captures as Ground Truth**: Wire fixtures in `captures/agy_cli_1.1.26/` represent authoritative agy CLI behavior. Header casing, payload structures, sequence counters, and query parameters must conform to these captures.
- **Mandatory Capture Sanitization**: When capturing network traffic from new `agy` CLI versions into `captures/`:
  - Always run `npm run sanitize:captures <dir>` immediately after capturing.
  - Never commit unmasked OAuth refresh tokens (`1//0...`), access tokens (`ya29...`), personal emails, local paths (`/home/<user>`), or private user rules.
  - `npm test` and `npm run prepublishOnly` enforce zero-leakage via `npm run lint:captures` (`scripts/lint-captures.mjs`).
  - Standard secrets are monitored in CI via Gitleaks (`.github/workflows/security.yml` and `.gitleaks.toml`).
- **Verification against Capture Fixtures**: Changes to request builders, streaming logic, or auth serialization must include regression tests verified against real agy capture fixtures in `tests/`.
- **Capture Before Changing Protocol**: When modifying anything that touches Antigravity/Google API communication (endpoints, headers, `functionCall`/`functionResponse` shapes, error payloads, image parts), first verify how the official `agy` CLI behaves with `mitmproxy` and base the change on the capture — never on speculation. Existing fixtures only cover what was captured before; uncovered cases (e.g. error tool results, image results) need a fresh targeted capture. Follow the runbook in `captures/README.md` (scenario matrix, fixture extraction, mandatory sanitize/lint, proxy shutdown). See the `wire-fingerprint` skill for the workflow.
- **Multi-Turn Live Wire Verification (10-Turn Parity Test)**:
  When `agy` CLI behavior is ambiguous, or after modifying code that touches request building, session management, or stream translation, verify live wire equivalence against official `agy` CLI across a **10-turn session** through `mitmproxy` (`mitmdump -p 18080`):
  - **Scenario Matrix**: The 10 turns must cover:
    1. Initial conversational turns
    2. Tool call execution and success (e.g. `bash`, `read`, `write`)
    3. Tool call execution errors and failures (e.g. missing file `ENOENT`, non-zero exit codes)
    4. Multi-turn reasoning and follow-up over past tool results
    5. Final multi-turn summary consolidating prior steps
  - **Field-by-Field Wire Diff**: Compare captured `v1internal:streamGenerateContent` flows between `agy` and `pi`:
    - Headers (Host, exact User-Agent casing, Auth Bearer token)
    - Envelope structure (`project`, `userAgent`, `requestType`, `model`)
    - Labels (`model_enum`, `last_step_index`, `request_id` sequence `<trajectory_id>-N`)
    - Session invariants (100% invariant numeric `sessionId` and v5 UUID `trajectory_id` across all turns)
    - Tool results (`functionResponse` with `{ output: string }` envelope for both success and failure)
    - Thought Signature replay across consecutive turns
  - **Proxy Teardown**: Always terminate `mitmdump` (`pkill -f 'mitmdump.*18080'`), verify port 18080 is free (`port free`), and remove scratch artifacts.

## 3. Provider Authentication Invariants
- Command handlers (`/antigravity usage`, `/antigravity models`) resolve credentials using `await ctx.modelRegistry?.getApiKeyForProvider(PROVIDER_ID)`.
- `refreshModels(context)` receives `RefreshModelsContext` where `context.credential?.access` carries the stored OAuth token string.
- StreamingSimple receives resolved credentials via `options?.apiKey`.

## 4. Verification & Build
All changes must pass:
```bash
npm run prepublishOnly # tsc --noEmit && npm test && build
```
- Ensure `dist/index.js` is rebuilt whenever `src/` files change.
- Any new or modified logic must include test coverage in `tests/`.
