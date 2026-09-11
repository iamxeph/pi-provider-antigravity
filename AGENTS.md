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
- **Strict Parity with Official `agy` CLI**: All provider behaviors—authentication flows, request headers, payload envelopes, session/trajectory labels, model identifier mapping, and quota inspection—must strictly match the official `agy` CLI. Never introduce speculative API shapes or deviate from official agy CLI behavior.
- **Captures as Ground Truth**: Wire fixtures in `captures/agy_cli_<version>/` (only the current capture is kept in the tree; older versions live in git history) represent authoritative agy CLI behavior. Header casing, payload structures, sequence counters, and query parameters must conform to these captures.
- **Capture Before Changing Protocol**: When touching endpoints, headers, `functionCall`/`functionResponse` shapes, error payloads, or image parts, verify against the official `agy` CLI via `mitmproxy` first — never speculate. Uncovered cases (e.g. error tool results, image results) need a fresh targeted capture; new or changed scenarios are declared in `captures/scenarios.json` (the gate in `tests/wire-parity.test.mjs` enforces them per version directory). Runbook: `captures/README.md`. Skill: `wire-fingerprint`.
- **Capture Hygiene**: After capturing into `captures/`, run `npm run sanitize:captures <dir>` then `npm run lint:captures` (also enforced by `npm test`; standard secrets monitored by Gitleaks). Never commit OAuth tokens, emails, local paths, or private user rules.
- **Pin Fixtures in Tests**: Changes to request builders, streaming logic, or auth serialization need regression tests against real capture fixtures in `tests/`.
- **Multi-Turn Live Verification (10-Turn Parity Test)**: When `agy` behavior is ambiguous, or after touching request building, session management, or stream translation, verify live wire equivalence across a 10-turn session (`mitmdump -p 18080`) covering conversational turns, tool success, tool failure, follow-up reasoning, and final summary — the canonical scenario is `captures/scenarios.json` (plan: `npm run capture:plan`; runbook: `captures/README.md` §2). Diff `v1internal:streamGenerateContent` flows field-by-field (headers, envelope, labels/`request_id` sequence, session invariants, `functionResponse` `{ output }` envelope, thought-signature replay).
  - **Part coverage**: the diff must cover all three replayable part types — `text`, `thinking`, and `functionCall` with its `functionResponse` — and confirm each one replays as captured. A run that never exercises one of them is not verification; `tests/wire-parity.test.mjs` fails if a fixture directory loses one (machine gate, not a reminder).
  - **Cross-provider replay (pi-side only)**: `agy` cannot switch providers mid-session, so a foreign-authored tool turn has no agy wire shape. Verify it with the probe procedure in `captures/pi_probe_sentinel/README.md` (build with `buildAntigravityRequestBody`, POST live, A/B with and without `skip_thought_signature_validator` on the one part) and keep ADR-0007's gate: probe B must still answer 200; A stays 400, C/D stay 200.
  - **Teardown**: `echo $! > proxy.pid` records the `setsid` wrapper, **not** the proxy — kill the real PID (`ps -eo pid,cmd | grep '[m]itmdump'`), confirm `ss -ltn | grep 18080` is empty, remove scratch artifacts. Never `pkill -f` with a pattern that also appears in your own command line, it kills your own shell.

## 3. Verification & Build
All changes must pass:
```bash
npm run prepublishOnly # tsc --noEmit && npm test && build
```
- Ensure `dist/index.js` is rebuilt whenever `src/` files change.
- Any new or modified logic must include test coverage in `tests/`.

## 4. English on GitHub
This is an open-source project: everything GitHub-facing must be in English — issue titles and bodies, PR titles and descriptions, review/discussion comments, and commit messages. Code, code comments, and docs in the repo are English too. (Direct conversation with the maintainer may be in Korean; translate before posting anything to GitHub.)

## 5. Agent Docs

- Issues live in GitHub Issues (via the `gh` CLI) — see `docs/agents/issue-tracker.md`.
- Triage labels: default five canonical labels used as-is — see `docs/agents/triage-labels.md`.
- Domain: single-context, root `CONTEXT.md` + `docs/adr/` — see `docs/agents/domain.md`.

## 6. Issue Batch Workflow

- Never work on `main`. One `feat/<batch>` worktree per batch (`git worktree add ~/Projects/<repo>-<batch> -b feat/<batch> main`), issues implemented inside it in dependency order, one commit per issue. Remove the worktree when the batch squash-merges to `main`.
- One worktree per batch, not per issue: per-issue worktrees only pay off for disjoint files. Shared hotspots: `protocol.ts`, `stream.ts`, `catalog.ts` (check overlap before parallelizing).
- Sequential by default. Dependent issues (e.g. error-mapping before retry) chain on the same branch in order.
- Light direct edits by the maintainer may use a plain branch instead.
- Commit and push only after maintainer confirmation.
- Stacked PRs: retarget dependents onto `main` (`gh pr edit <n> --base main`) BEFORE merging or deleting the base branch. Deleting a base branch auto-closes every PR stacked on it, and a closed PR whose base is gone can neither be reopened nor retargeted — the only recovery is a replacement PR.

## 7. GitHub Identity

Agents must not act as another person on GitHub. Every PR, comment, review, merge, and commit belongs to the identity you were given: your own account, or the bot identity the maintainer provisioned for automation (`…-release[bot]` and friends). Never post or commit as the maintainer, and never reuse credentials you were not given.

Maintainer commits stay the maintainer's; agent commits carry the bot. The switch is per-shell, not per-repo: a session-scoped `GH_TOKEN` plus git author/committer env vars, with `git config user.*` left at its default here and globally. Pinning the bot into git config would apply to every commit in the working copy — the maintainer's own included.
