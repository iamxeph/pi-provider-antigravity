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
| thinking level | `agy -p "reply with exactly this one word: ok" --model gemini-3.7-flash --effort {low,medium,high}` | runtime ID + `thinkingConfig` per level (ref: 1.1.26 sends `-low/-medium/-high` + integer `thinkingBudget`, never `-tiered`/`thinkingLevel`) |
| tool success | prompt that creates/lists a file | `functionResponse` role, merge behavior, `{output}` key, `id` on Gemini calls |
| tool error | `agy -p "Read the file /tmp/agy-no-such-file-xyz.txt and tell me its exact contents"` | failed `view_file` shape (ref: 1.1.26 embeds `Encountered error in tool execution: ...` in `response.output`, no `error` key) |
| thinking | prompt needing reasoning, then inspect `thought` parts + `thoughtSignature` replay | thinking envelope, signature placement |
| multiturn | follow-up in same session (`-c`/`--continue`) | signature + tool-state propagation across turns (min 5 turns for a Turn Trace) |

Expect one extra `gemini-3.1-flash-lite` + `{includeThoughts:false,thinkingBudget:0}`
request per run — agy's internal title summarizer, not your scenario.

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

A fixture without an assertion rots. Add a `test()` in `tests/` that reads the new
fixture and asserts the exact wire shape it was captured for (see the turn6
`output`-key test in `tests/request-builder.test.mjs`). Run the full gate:

```bash
npm test  # lint:captures + all suites
```
