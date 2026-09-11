# Capture Guide — `agy` CLI wire fixtures

Each `captures/agy_cli_<version>/` directory is a frozen fingerprint of what the official
`agy` CLI actually sent for that version. When a new `agy` releases (or an uncovered case
needs evidence), re-capture by following this procedure.

**The scenario is not improvised any more.** `captures/scenarios.json` declares the
canonical slots — file name, session, mode, prompt, model, effort, expected request and
response shapes, and the replay chain between slots — and
`tests/wire-parity.test.mjs` fails if a directory does not match its declaration. Capture
against the manifest, not against memory; adding a slot is a manifest edit, not a new
convention. Theory: `docs/adr/0001-strict-wire-fingerprint-fixtures.md`,
`docs/adr/0003-multi-turn-session-fixtures.md`,
`docs/adr/0007-sentinel-divergence-for-foreign-calls.md`; the cross-provider probe has its
own runbook in `pi_probe_sentinel/README.md`.

**Retention.** Only the current capture is kept in the tree (`captures/agy_cli_<version>/`); when a
new version lands, the previous directory is deleted — git history keeps the old wire shapes for
anyone who needs to diff them, and the per-directory loops in `tests/wire-parity.test.mjs` assert
the newest capture on every dimension. Cross-version delta assertions do not survive a deletion:
if a delta matters, encode it as a fixture (a slot or a probe pair), not as a test that needs two
version directories.

## 0. When to (re-)capture

- `agy update` changed behavior (check `agy --version` and the `User-Agent` in new traffic).
- A protocol change is planned and no slot covers it — add the slot to
  `captures/scenarios.json` first, then capture it (the gate then demands it from every
  future version).
- The backend retired or renamed a model the manifest pins: `npm run capture:plan`
  preflights the pinned ids against the newest catalog and lists the candidates. Update
  `model`/`wireModel` in `captures/scenarios.json`, plus `thinkingBudget` if the new family
  prices thinking differently. The pins are intentional — a rename moves the manifest, not
  the assertion; `tests/wire-parity.test.mjs` fails with the same candidate list if an old
  pin survives into a capture.

  Generation policy: the canonical Gemini pins follow the newest generation —
  `gemini-3.8-flash` since agy 1.2.0, so the tool trace, the effort matrix and the tool-error
  turn all run on it — and every directory frozen earlier declares
  `dirs.<id>.models: { "gemini-3.8-flash": "gemini-3.7-flash" }` so it keeps matching the
  generation it actually captured. When the next generation lands, move the pins and add one
  remap entry per existing directory; `agy models` (or the newest
  `captures/*/models.resp.json`) says which ids exist today.
- The case is one `agy` cannot produce at all (replaying a tool call authored by another
  provider mid-session): probe it with this extension's own builder and freeze the A/B
  flows under `captures/pi_probe_sentinel/`.
- A competitor/derivative claims a different wire shape — settle it with a capture, not opinions.

A version bump itself is cheap: capture the canonical slots, then add the one
`EXPECTED_UA` row the extractor prints and point `DEFAULT_USER_AGENT` at it. Header casing,
endpoint shapes, effort matrix, chains, seams and part coverage are inherited from the
manifest and asserted per directory — a version that changes any of them fails the suites
instead of drifting.

## 1. Proxy setup

```bash
mkdir -p /tmp/agy-capture && cd /tmp/agy-capture
# Dump addon MUST gzip-decode raw_content before UTF-8 decode:
# SSE/JSON bodies arrive gzipped, otherwise the flows are garbage.
cat > dump.py <<'EOF'
import gzip, json
def _body(c):
    if not c:
        return ""
    try:
        raw = gzip.decompress(c)
    except Exception:
        raw = c
    try:
        return raw.decode("utf-8")
    except Exception:
        return f"<binary {len(raw)} bytes>"
def _json_or_text(raw):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return raw[:2000]

def response(flow):
    try:
        rec = {
            "req": {"method": flow.request.method, "url": flow.request.pretty_url,
                    "headers": dict(flow.request.headers),
                    "body": _json_or_text(_body(flow.request.raw_content))},
            "resp": {"status": flow.response.status_code, "body": _body(flow.response.raw_content)},
        }
        open("/tmp/agy-capture/flows.jsonl", "a").write(json.dumps(rec) + "\n")
    except Exception as e:
        open("/tmp/agy-capture/addon-errors.log", "a").write(f"addon error: {e}\n")
EOF
rm -f flows.jsonl
setsid nohup mitmdump -p 18080 -s dump.py > mitmdump.log 2>&1 < /dev/null &
# Plain `&` dies with the next pkill; setsid+nohup survives.
ss -ltn | grep 18080  # must LISTEN
ps aux | grep mitmdump | grep -v grep  # no stale instance on the same port
```

Run `agy` through it (Go binary honors env proxies; nothing else needed):

```bash
export HTTPS_PROXY=http://127.0.0.1:18080 HTTP_PROXY=http://127.0.0.1:18080
export SSL_CERT_FILE=~/.mitmproxy/mitmproxy-ca-cert.pem  # first run: `mitmproxy` once to generate
```

Red gate: `jq -c '.req.url' flows.jsonl | sort -u` must show `...streamGenerateContent?alt=sse`.
If nothing appears, the app ignores env proxies or pins TLS — stop, don't fake it.

## 2. Capture the canonical scenario

```bash
npm run capture:plan -- --version 1.2.0   # ordered commands, exact prompts, target file names
```

The plan is `captures/scenarios.json` in capture order — one command per line, already
carrying `--model`, `--effort` and `--dangerously-skip-permissions`. Five sessions:

| Session | Slots | What it proves |
|---|---|---|
| `tooltrace` | `turn1_initial`, `turn2_toolresult`, `turn4_thinking`, `turn5_multiturn` | One closed 4-slot trace: fresh tool call → `{output}` functionResponse → `-c` thinking replay → the parser→builder seam pair. Also the tool-turn divergence (agy drops the replayed thought part — re-confirmed on 3.8-flash in 1.2.0). |
| `effort-matrix` | `turn7_initial_low`, `turn3_medium` (+ `turn1_initial` as high) | Runtime ID suffix + integer `thinkingBudget` per effort level (never `-tiered`/`thinkingLevel`). |
| `toolerror` | `turn6_toolerror` | Failed tool result: error text inside `response.output`, no `error` key. |
| `claude` | `turn8_claude_thinking`, `turn8b_claude_followup1`, `turn9_claude_followup` | Claude counter-capture: `thought: true` parts and part-split signature replay inside the Claude family. |
| `pro` | `turn10_pro_high`, `turn11_pro_followup` | Pro/agent runtime-ID rename and Gemini-family thinking replay with a visible thought part. |
| `gpt` | `turn12_gpt_initial`, `turn13_gpt_followup` | Third wire family (`gpt-oss-120b`, single `-medium` variant). 1.2.0 verdict: agy replays a gpt turn as plain text — no thought part, no signature — and `src/builder.ts` drops same-family gpt reasoning to match, so the seam test is strict. |

Traps the manifest repeats on purpose:

- **`-c` does not inherit `--model`.** A bare `-c` follow-up silently resets to the default
  model (observed 1.1.28: a Claude session continued without `--model` came back as
  `gemini-3.7-flash-high`). Repeat the flag on every continued command.
- **One tool prompt is a request chain.** `agy -p "<tool prompt>"` sends one request per tool
  round trip until the model answers; the manifest names which of them to freeze. Counters
  therefore skip (+2 per tool round trip), which is normal.
- **Keep prompts trivial** except where a slot says otherwise — every turn spends real quota.

Expect extra flows that are not slots: agy's internal title summarizer
(`gemini-3.1-flash-lite`, `{includeThoughts:false,thinkingBudget:0}`) and system-injected
`SYSTEM_MESSAGE` user contents (e.g. server-restart notices). Both are genuine wire behavior —
keep them in the fixture, don't scrub them.

### Why three families and not every model

Coverage is per wire **branch**, not per model id. The provider's family-dependent behavior is
exactly three-way — sentinel injection on Gemini only (`src/builder.ts`), the
`used_claude`/`used_non_gemini_model` label triple, the thinking/signature replay shape, and the
third-party quota pool for `claude`/`gpt` (`src/quota-status.ts`) — while everything else about a
model (runtime id, enum, thinking budget, context limits) comes from the captured catalog
snapshot. The picked ids classify into those three and nothing else (29 picker ids in the 1.2.0
catalog: 26 gemini, 2 claude, 1 gpt, zero unknown), so one chain per family is complete
coverage, and a new id inside a family is a re-capture with zero new slots. A fourth family, or a
new part/replay shape inside one, is a new branch — add the slots to `captures/scenarios.json` and
the gate will demand them from every later version.

### 2.1 Auth lifecycle + endpoint fixtures

Five non-stream fixtures must exist in every version directory; three of them come for free,
the OAuth pair needs the auth lifecycle:

| Fixture | How it lands in `flows.jsonl` |
|---|---|
| `load_code_assist.*`, `models.*`, `quota.*` | Any proxied `agy` startup (`agy models`, or the first `-p` run). |
| `auth_token_refresh.*` | POST `oauth2.googleapis.com/token` with `grant_type=refresh_token`. agy keeps its live token in the **OS keyring** (`gnome-keyring`); `~/.gemini/antigravity-cli/antigravity-oauth-token` is a cache it ignores, so editing that file's `expiry` changes nothing. The refresh fires on the first proxied command after the keyring's access token expires. |
| `auth_login_params.json` | The browser-login authorize URL, sent only when agy has **no** stored refresh token: remove the agy entry from the keyring, run `agy` through the proxy, complete the login in the browser. |

Observed startup endpoints with no provider counterpart (`fetch_admin_controls`, `fetch_user_info`,
`list_experiments`, `write_trajectory_acls`) are frozen too, but as **reference only**: the
extractor writes them when they are in the flows, the gate only checks that a present fixture has
both halves, and a version that stops sending one is not a failure. Deliberately not frozen —
reasons in `captures/scenarios.json`: `unleash` register/features (third-party 369KB flag payload,
empty 202), `oauth2/v2/userinfo` and the avatar fetch (account PII), `play.googleapis.com/log`
(telemetry).

Never hand-edit a fixture to look complete; if a lifecycle is not reproducible in this
capture, record the gap under `dirs.<id>` in the manifest instead.

## 3. Extract fixtures

```bash
npm run capture:extract -- /tmp/agy-capture/flows.jsonl --dir captures/agy_cli_1.2.0
```

The script matches flows to slots by the manifest's declared facts (model, fresh vs `-c`,
prompt, required part types, and the replay chain), writes each slot's `.req.json` +
`.resp.sse`, and reports what it could not match, which flows remain unconsumed, and the
`EXPECTED_UA` row to paste into `tests/wire-parity.test.mjs`. It refuses to overwrite a
frozen directory without `--force`.

Ad-hoc inspection while capturing:

```bash
jq -c 'select(.req.url? | contains("streamGenerateContent")) | select(.req.body|type=="object")
  | {rid: .req.body.requestId, model: .req.body.model, status: .resp.status,
     budget: .req.body.request.generationConfig.thinkingConfig.thinkingBudget}' flows.jsonl
```

`npm run capture:self-check` re-derives flows from the frozen directories and proves the
matcher reproduces them byte for byte — offline, no quota. It also runs inside `npm test`.

## 4. Mandatory hygiene (in this order)

```bash
npm run sanitize:captures captures/agy_cli_<version>  # tokens, emails, /home/<user>, user rules
npm run lint:captures                                 # must pass; also runs inside npm test
```

Then shut down and clean up:

```bash
# `setsid nohup mitmdump … &` records the *wrapper's* PID in `$!`, not the proxy's:
ps -eo pid,cmd | grep '[m]itmdump'   # read the real PID here
kill <pid>
ss -ltn | grep 18080 || echo "port free"   # a forgotten proxy burns quota on later runs
rm -f /tmp/agy-capture/flows.jsonl        # raw flows hold Bearer tokens — never commit
```

Never `pkill -f` with a pattern that also appears in your own command line — it kills the
shell you are typing in.

## 5. Pin it in tests

Capture result → manifest, in one direction:

- New version: `npm run capture:extract` wrote the canonical slots; add the `EXPECTED_UA` row
  the script printed to `tests/wire-parity.test.mjs` and point `DEFAULT_USER_AGENT` at the
  newest capture.
- Deliberate deviation: declare it under `dirs.<id>` (`omit` for slots this capture cannot
  produce, `patch` + `reason` for slots whose session/model/effort differ). Undeclared,
  ignored drift is what the gate exists to stop — do not silence it.
- GPT: measured, not pending. The 1.2.0 capture pinned the gpt replay shape (plain text, no
  thought part, no signature) and probe E/F (`captures/pi_probe_sentinel/`) measured the sentinel
  half — unsigned foreign `functionCall` → 200, sentinel → 200. If a future capture shows a gpt
  signature, unpin `absent` on `stream_turn13_gpt_followup` and revisit ADR-0007's gpt paragraph.
- Add version-delta assertions only for genuine behavior changes, and only while both versions are
  in the tree — never a new test file per version, never a per-version row for something the
  manifest already states once.

The gates that now run on their own, so a re-capture cannot regress them silently:
coverage of all three replayable part types per directory (`text`, `thinking`,
`functionCall` + `functionResponse`), the declared-slot/session/chain gate against
`captures/scenarios.json`, the ADR-0007 sentinel premise (agy traffic never carries it, the
probe pairs stay single-variable), and the extractor self-check.

```bash
npm test  # lint:captures + capture:self-check + all suites (incl. the scenario gate)
```
