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

## 2. Antigravity Protocol Compatibility (Behavioral & Wire Ground Truth)
- **Strict Protocol Parity**: All provider behaviors—authentication flows, request headers, payload envelopes, session/trajectory labels, model identifier mapping, and quota inspection—must strictly conform to the Antigravity backend API protocol. Never introduce speculative API shapes or deviate from standard protocol behavior.
- **Fixtures as Ground Truth**: Wire fixtures in `tests/fixtures/` represent test ground truth for unit and regression tests. Header casing, payload structures, sequence counters, and query parameters must conform to these fixtures.
- **Pin Fixtures in Tests**: Changes to request builders, streaming logic, or auth serialization need regression tests against fixtures in `tests/fixtures/`.
- **Multi-Turn Verification**: When behavior is ambiguous, verify conversation turns, tool success, tool failure, follow-up reasoning, and thought-signature replay against the test fixtures in `tests/fixtures/`.
  - **Part coverage**: verification must cover all three replayable part types — `text`, `thinking`, and `functionCall` with its `functionResponse`.
  - **Cross-provider replay**: when foreign-authored tool turns are replayed, follow the sentinel procedure established in `src/builder.ts`.

## 3. Verification & Build
All changes must pass:
```bash
npm run prepublishOnly # tsc --noEmit && npm test && build
```
- Ensure `dist/index.js` is rebuilt whenever `src/` files change.
- Any new or modified logic must include test coverage in `tests/`.

## 4. English on GitHub
This is an open-source project: everything GitHub-facing must be in English — issue titles and bodies, PR titles and descriptions, review/discussion comments, and commit messages. Code, code comments, and docs in the repo are English too. (Direct conversation with the maintainer may be in Korean; translate before posting anything to GitHub.)

## 5. Issue Tracking
Issues live in GitHub Issues (via the `gh` CLI).

## 6. Issue Batch Workflow

- Never work on `main`. One `feat/<batch>` worktree per batch, created as a sibling of this checkout — outside the clone, never inside it: `git worktree add ../<batch> -b feat/<batch> main` (e.g. `../issue-42`). Issues are implemented inside it in dependency order, one commit per issue. Remove the worktree when the batch squash-merges to `main`.
- One worktree per batch, not per issue: per-issue worktrees only pay off for disjoint files. Shared hotspots: `protocol.ts`, `stream.ts`, `catalog.ts` (check overlap before parallelizing).
- Sequential by default. Dependent issues (e.g. error-mapping before retry) chain on the same branch in order.
- Light direct edits by the maintainer may use a plain branch instead.
- Commit and push only after maintainer confirmation.
- Stacked PRs: retarget dependents onto `main` (`gh pr edit <n> --base main`) BEFORE merging or deleting the base branch. Deleting a base branch auto-closes every PR stacked on it, and a closed PR whose base is gone can neither be reopened nor retargeted — the only recovery is a replacement PR.

## 7. GitHub Identity

Agents must not act as another person on GitHub. Every PR, comment, review, merge, and commit belongs to the identity you were given: your own account, or the bot identity the maintainer provisioned for automation (`…-release[bot]` and friends). Never post or commit as the maintainer, and never reuse credentials you were not given.

Maintainer commits stay the maintainer's; agent commits carry the bot. The switch is per-shell, not per-repo: a session-scoped `GH_TOKEN` plus git author/committer env vars, with `git config user.*` left at its default here and globally. Pinning the bot into git config would apply to every commit in the working copy — the maintainer's own included.
