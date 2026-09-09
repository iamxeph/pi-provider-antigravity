# Capture Guide — `agy` CLI wire fixtures

Each `agy_cli_<version>/` directory is a frozen fingerprint of what the official
`agy` CLI actually sent for that version. When a new `agy` releases (or an
uncovered case needs evidence), re-capture by following this procedure.
Theory lives in `docs/adr/0001-strict-wire-fingerprint-fixtures.md` and
`docs/adr/0003-multi-turn-session-fixtures.md`; this file is the hands-on runbook.

## 0. When to (re-)capture

- `agy update` changed behavior (check `agy --version` and the `User-Agent` in any new traffic).
- A protocol change is planned and no fixture covers the case (error tool results,
  image results, new model families, new thinking levels).
- A competitor/derivative claims a different wire shape — settle it with a capture, not opinions.

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

## 2. Scenario matrix (one minimal turn each — quota is real)

Keep prompts trivial (`reply with exactly this one word: ok`) and `--effort low`
unless the scenario needs otherwise. Every run ends with `--dangerously-skip-permissions`.

| Scenario | Command | What it proves |
|---|---|---|
| thinking level | `agy -p "reply with exactly this one word: ok" --model gemini-3.7-flash --effort {low,medium,high}` | runtime ID + `thinkingConfig` per level (ref: 1.1.27 `stream_turn{7,3,1}` pins low=1000, medium=4000, high=-1 with `-low/-medium/-high` suffix + integer `thinkingBudget`, never `-tiered`/`thinkingLevel`) |
| tool success | prompt that creates/lists a file | `functionResponse` role, merge behavior, `{output}` key, `id` on Gemini calls |
| tool error | `agy -p "Read the file /tmp/agy-no-such-file-xyz.txt and tell me its exact contents"` | failed `view_file` shape (ref: 1.1.26 embeds `Encountered error in tool execution: ...` in `response.output`, no `error` key) |
| thinking | two turns in the SAME session: `agy -p "<reasoning prompt>" --model <m> --effort high` then `agy -c -p "reply with exactly this one word: done"` (or two `{"event":"user",…}` lines via `--input-format stream-json --output-format stream-json`) | thinking envelope, signature placement — the replay shape only appears in the follow-up request, never the first |
| multiturn | follow-up in same session (`-c`/`--continue`) | signature + tool-state propagation across turns (min 5 turns for a Turn Trace). `-c` appends to the SAME session: verify by shared `requestId` prefix (`agent/<sid>/…`) with a grown turn counter, not by a new session id. Counters skip: +2 after tool execution (`/1`→`/3`), so gaps are normal |

Expect one extra `gemini-3.1-flash-lite` + `{includeThoughts:false,thinkingBudget:0}`
request per run — agy's internal title summarizer, not your scenario.
System-injected `SYSTEM_MESSAGE` user contents (e.g. server-restart notices) are genuine
wire behavior — keep them in the fixture, don't scrub.

`-c` does NOT inherit `--model`: a bare `-c` follow-up silently resets to the
default model, so repeat `--model <m>` on every `-c` when the chain must stay
on a non-default model (observed 1.1.28: a Claude session continued without
`--model` came back as `gemini-3.7-flash-high`). Always verify the follow-up's
`.body.model` before freezing the fixture.

## 3. Extract fixtures

Request envelopes nest under `.body` (`{project, requestId, request:{...}, model, ...}`),
top-level `requestId` identifies the flow:

```bash
# List stream turns:
jq -c 'select(.req.url? | contains("streamGenerateContent")) | select(.req.body|type=="object")
  | {rid: .req.body.requestId, model: .req.body.model,
     gen: .req.body.request.generationConfig, status: .resp.status}' flows.jsonl
# Save one turn as fixture pair:
RID="<requestId of the turn>"
jq --arg r "$RID" 'select(.req.body.requestId?==$r) | .req' flows.jsonl \
  > captures/agy_cli_<version>/stream_turn<N>_<desc>.req.json
jq --arg r "$RID" -r 'select(.req.body.requestId?==$r) | .resp.body' flows.jsonl \
  > captures/agy_cli_<version>/stream_turn<N>_<desc>.resp.sse
```

Spot-check before sanitizing:

```bash
jq '{model: .body.model, gen: .body.request.generationConfig}' captures/.../*.req.json
jq -c '.body.request.contents[] | {role, p: [.parts[] | keys_unsorted]}' captures/.../*.req.json
```

Red gate for the thinking replay — a first turn alone never replays, so empty
output here means the follow-up turn is missing and you must rerun §2:

```bash
jq -c 'select(.req.body.requestId?) | .req.body.requestId as $r
  | .req.body.request.contents[] | select(.role=="model") | .parts[]
  | select(.thought==true) | {rid: $r, hasSig: has("thoughtSignature")}' flows.jsonl
# Must print ≥1 line. hasSig tells you the version's placement:
# false = signature rides the next part (1.1.27 shape), true = combined shape.
# Either way, eyeball it against tests/wire-parity before freezing the fixture.
```

## 4. Mandatory hygiene (in this order)

```bash
npm run sanitize:captures captures/agy_cli_<version>  # tokens, emails, /home/<user>, user rules
npm run lint:captures                                 # must pass; also runs inside npm test
```

Then shut down and clean up:

```bash
pkill -f 'mitmdump.*18080'
ss -ltn | grep 18080 || echo "port free"   # a forgotten proxy burns quota on later runs
rm -f /tmp/agy-capture/flows.jsonl        # raw flows hold Bearer tokens — never commit
```

## 5. Pin it in tests

A fixture without an assertion rots. Extend `tests/wire-parity.test.mjs`
with one `EXPECTED_UA` row — endpoint, header casing, auth/quota/load shapes,
and builder envelope reproduction apply automatically per version directory.
Add version-delta assertions only for genuine behavior changes — never a new test file per version.

```bash
npm test  # lint:captures + all suites
```
