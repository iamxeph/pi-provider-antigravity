import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_USER_AGENT } from "../src/protocol.ts";
import { parseAvailableModels } from "../src/catalog-refresh.ts";
import {
  resolveModelPlan,
  buildThinkingMap,
} from "../src/model-catalog.ts";
import { buildAntigravityRequestBody, SKIP_THOUGHT_SIGNATURE_VALIDATOR } from "../src/builder.ts";
import { createSseFeed } from "../src/parser.ts";

// Cross-version wire parity: every captures/agy_cli_<version>/ dir must satisfy
// the same invariants. A new agy release means a new fixture dir + one row in
// EXPECTED below — never a new test file.
const DIRS = fs
  .readdirSync("captures", { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("agy_cli_"))
  .map((d) => d.name)
  .sort();

// Fingerprint rows captured live via mitmdump (one row per agy release).
const EXPECTED_UA = {
  "agy_cli_1.1.26":
    "antigravity/cli/1.1.26 (aidev_client; os_type=linux; arch=amd64; cl=976013059; auth_method=consumer)",
  "agy_cli_1.1.27":
    "antigravity/cli/1.1.27 (aidev_client; os_type=linux; arch=amd64; cl=976543523; auth_method=consumer)",
  "agy_cli_1.1.28":
    "antigravity/cli/1.1.28 (aidev_client; os_type=linux; arch=amd64; cl=978129418; auth_method=consumer)",
};
const load = (dir, name) => {
  const p = `captures/${dir}/${name}.req.json`;
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null;
};

// agy's constant sessionId, frozen here so a drifting capture fails loudly.
const AGY_SESSION_ID = "-3750763034362895579";

// Production-path whole-input parse: feed() + close(), the same exits
// streamAntigravity uses. Assert on the returned close().
function parseWhole(rawSse) {
  const feed = createSseFeed();
  feed.feed(rawSse);
  return feed.close();
}

// Canonical form for fixture comparison: JSON object key order is a builder
// detail (thought before text, functionResponse inner keys), never a wire fact.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
      : value;

// Inverse of translateTurnTrace for one captured request: rebuilds the pi
// messages that would produce these contents, so the builder can be handed the
// history agy itself replayed.
function piMessagesFromContents(contents, runtimeModelId) {
  const messages = [];
  for (const c of contents) {
    if (c.role === "user") {
      messages.push({
        role: "user",
        content: (c.parts ?? []).map((p) =>
          p.text !== undefined
            ? { type: "text", text: p.text }
            : { type: "image", mimeType: p.inlineData?.mimeType, data: p.inlineData?.data },
        ),
      });
      continue;
    }
    const response = (c.parts ?? []).find((p) => p.functionResponse);
    if (response) {
      messages.push({
        role: "toolResult",
        toolCallId: response.functionResponse.id,
        toolName: response.functionResponse.name,
        content: [{ type: "text", text: response.functionResponse.response?.output ?? "" }],
      });
      continue;
    }
    // Signature placement the parser produces: a turn's last signature rides its
    // thinking block, else the text block it belongs to.
    const lastSignature = (c.parts ?? []).map((p) => p.thoughtSignature).filter(Boolean).pop();
    const blocks = [];
    for (const p of c.parts ?? []) {
      if (p.thought) {
        blocks.push({
          type: "thinking",
          thinking: p.text ?? "",
          thinkingSignature: p.thoughtSignature || lastSignature,
        });
      } else if (p.functionCall) {
        blocks.push({
          type: "toolCall",
          id: p.functionCall.id,
          name: p.functionCall.name,
          arguments: p.functionCall.args ?? {},
          thoughtSignature: p.thoughtSignature,
        });
      } else if (p.text !== undefined) {
        blocks.push({ type: "text", text: p.text, ...(p.thoughtSignature ? { textSignature: p.thoughtSignature } : {}) });
      }
    }
    messages.push({ role: "assistant", provider: "antigravity", model: runtimeModelId, content: blocks });
  }
  return messages;
}

// One assistant message assembled by the production parser from a captured
// response: the parser→builder seam no test crossed before.
function assistantMessageFromResponse(dir, name, runtimeModelId, expectedStopReason) {
  const feed = createSseFeed();
  feed.feed(fs.readFileSync(`captures/${dir}/${name}.resp.sse`, "utf-8"));
  const out = feed.close();
  assert.equal(out.stopReason, expectedStopReason, `${dir}/${name}: payload stop reason`);
  return {
    role: "assistant",
    provider: "antigravity",
    model: runtimeModelId,
    stopReason: out.stopReason,
    content: out.content,
  };
}

// Rebuilds a captured request from reconstructed history, taking the capture's
// own project/systemPrompt/session/trajectory/limits so everything except the
// history stays comparable.
function replayCapture(dir, name, messages) {
  const { body } = load(dir, name);
  return buildAntigravityRequestBody({
    projectId: body.project,
    plan: {
      runtimeModelId: body.model,
      modelEnum: body.request.labels.model_enum,
      thinkingConfig: body.request.generationConfig.thinkingConfig,
      isClaude: body.model.startsWith("claude-"),
      isNonGemini: !body.model.startsWith("gemini-"),
    },
    context: { systemPrompt: body.request.systemInstruction?.parts?.[0]?.text, messages },
    sessionId: body.request.sessionId,
    trajectoryId: body.request.labels.trajectory_id,
    maxOutputTokens: body.request.generationConfig.maxOutputTokens,
  });
}

for (const dir of DIRS) {
  const turn1 = load(dir, "stream_turn1_initial");
  const turn2 = load(dir, "stream_turn2_toolresult");
  const turn4 = load(dir, "stream_turn4_thinking");
  const turn5 = load(dir, "stream_turn5_multiturn");
  const turn6 = load(dir, "stream_turn6_toolerror");

  test(`Wire parity (${dir}): User-Agent matches fingerprinted row`, () => {
    assert.ok(turn1, "stream_turn1_initial required");
    assert.equal(turn1.headers["User-Agent"], EXPECTED_UA[dir]);
  });

  test(`Wire parity (${dir}): functionResponse rides on {output}`, () => {
    for (const turn of [turn2, turn6].filter(Boolean)) {
      const frTurn = turn.body.request.contents.find((c) =>
        c.parts?.some((p) => p.functionResponse)
      );
      assert.ok(frTurn, "must contain a functionResponse turn");
      assert.equal(frTurn.role, "model");
      const fr = frTurn.parts.find((p) => p.functionResponse).functionResponse;
      assert.deepEqual(Object.keys(fr.response), ["output"]);
    }
  });

  test(`Wire parity (${dir}): tool declarations use legacy parameters only`, () => {
    // Every frozen turn (not just the five named ones) pins this: agy sends
    // legacy `parameters` on all models, zero `parametersJsonSchema` anywhere.
    const files = fs
      .readdirSync(`captures/${dir}`)
      .filter((f) => f.startsWith("stream_turn") && f.endsWith(".req.json"));
    assert.ok(files.length > 0, `${dir} must ship stream turn fixtures`);
    let decls = 0;
    for (const f of files) {
      const turn = JSON.parse(fs.readFileSync(`captures/${dir}/${f}`, "utf-8"));
      for (const tool of turn.body.request.tools ?? []) {
        for (const decl of tool.functionDeclarations ?? []) {
          assert.ok(decl.parameters, `${f}/${decl.name}: must carry legacy parameters`);
          assert.equal(
            decl.parametersJsonSchema,
            undefined,
            `${f}/${decl.name}: parametersJsonSchema diverges from every capture`
          );
          decls++;
        }
      }
    }
    assert.ok(decls > 0, `${dir}: no tool declarations frozen to pin`);
  });

  test(`Wire parity (${dir}): thoughtSignature replays across turns`, () => {
    const replayed = (turn) =>
      (turn?.body.request.contents ?? [])
        .flatMap((c) => c.parts ?? [])
        .filter((p) => p.thoughtSignature);
    assert.ok(replayed(turn4).length >= 1, "turn4 must replay thoughtSignature");
    assert.ok(replayed(turn5).length >= 1, "continued turn5 must keep thoughtSignature");
  });
}

const STREAM_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
// Header names as Go's HTTP client sent them (casing pinned, values redacted).
const EXPECTED_STREAM_HEADERS = [
  "Accept-Encoding",
  "Authorization",
  "Content-Type",
  "Host",
  "Transfer-Encoding",
  "User-Agent",
];
const EXPECTED_ENVELOPE_KEYS = [
  "model",
  "project",
  "request",
  "requestId",
  "requestType",
  "userAgent",
];
const EXPECTED_LABEL_KEYS = [
  "last_step_index",
  "model_enum",
  "request_id",
  "trajectory_id",
  "used_claude",
  "used_claude_conservative",
  "used_non_gemini_model",
];
const EXPECTED_LOGIN_PARAM_KEYS = [
  "access_type",
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "prompt",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
];
const sortedKeys = (o) => Object.keys(o).sort();
const streamReqs = (dir) =>
  fs
    .readdirSync(`captures/${dir}`)
    .filter((f) => f.startsWith("stream_turn") && f.endsWith(".req.json"))
    .map((f) => `${dir}/${f}`);

for (const dir of DIRS) {
  test(`Wire parity (${dir}): stream endpoint + header casing`, () => {
    const files = streamReqs(dir);
    assert.ok(files.length > 0, `${dir} must ship stream turn fixtures`);
    for (const f of files) {
      const req = JSON.parse(fs.readFileSync(`captures/${f}`, "utf-8"));
      assert.equal(req.method, "POST", `${f}: method`);
      assert.equal(req.url, STREAM_URL, `${f}: endpoint`);
      assert.deepEqual(sortedKeys(req.headers), EXPECTED_STREAM_HEADERS, `${f}: header names/casing`);
    }
  });

  test(`Wire parity (${dir}): request envelope keys`, () => {
    const files = streamReqs(dir);
    let continuations = 0;
    for (const f of files) {
      const body = JSON.parse(fs.readFileSync(`captures/${f}`, "utf-8")).body;
      assert.deepEqual(sortedKeys(body), EXPECTED_ENVELOPE_KEYS, `${f}: top-level keys`);
      assert.equal(body.project, "aicode-consumers", `${f}: project`);
      assert.equal(body.userAgent, "antigravity", `${f}: userAgent`);
      assert.equal(body.requestType, "agent", `${f}: requestType`);
      assert.ok(Array.isArray(body.request.contents) && body.request.contents.length > 0, `${f}: contents`);
      // Base labels always present; session continuations (`-c`) add a
      // last_execution_id UUID, same-execution tool turns do not.
      for (const k of EXPECTED_LABEL_KEYS) {
        assert.ok(k in body.request.labels, `${f}: label ${k}`);
      }
      for (const k of sortedKeys(body.request.labels)) {
        assert.ok(
          EXPECTED_LABEL_KEYS.includes(k) || k === "last_execution_id",
          `${f}: unexpected label ${k}`
        );
      }
      if ("last_execution_id" in body.request.labels) {
        assert.match(body.request.labels.last_execution_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, `${f}: last_execution_id`);
        continuations++;
      }
      assert.equal(body.request.sessionId, AGY_SESSION_ID, `${f}: sessionId`);
      const tc = body.request.generationConfig?.thinkingConfig;
      assert.equal(typeof tc?.includeThoughts, "boolean", `${f}: includeThoughts`);
      assert.equal(typeof tc?.thinkingBudget, "number", `${f}: thinkingBudget`);
    }
    // Each version must freeze both a fresh turn and a `-c` continuation.
    assert.ok(continuations >= 1, `${dir}: no continuation fixture pins last_execution_id`);
    assert.ok(continuations < files.length, `${dir}: no fresh-turn fixture without last_execution_id`);
  });

  test(`Wire parity (${dir}): auth shapes (login params + token refresh)`, () => {
    const login = JSON.parse(fs.readFileSync(`captures/${dir}/auth_login_params.json`, "utf-8"));
    assert.equal(login.endpoint, "https://accounts.google.com/o/oauth2/auth");
    assert.deepEqual(sortedKeys(login.params), EXPECTED_LOGIN_PARAM_KEYS);
    // Per-run random values (state, code_challenge) are structure-only, but the
    // code constants must reproduce exactly.
    assert.equal(login.params.response_type, "code");
    assert.equal(login.params.code_challenge_method, "S256");
    assert.equal(login.params.access_type, "offline");
    assert.equal(login.params.prompt, "consent");
    assert.equal(login.params.redirect_uri, "https://antigravity.google/oauth-callback");

    const tokenReq = JSON.parse(fs.readFileSync(`captures/${dir}/auth_token_refresh.req.json`, "utf-8"));
    assert.equal(tokenReq.method, "POST");
    assert.equal(tokenReq.url, "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(tokenReq.body);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.ok((form.get("client_id") ?? "").endsWith(".apps.googleusercontent.com"));

    const tokenResp = JSON.parse(fs.readFileSync(`captures/${dir}/auth_token_refresh.resp.json`, "utf-8"));
    for (const k of ["access_token", "expires_in", "token_type"]) {
      assert.ok(k in tokenResp, `token resp missing ${k}`);
    }
  });

  test(`Wire parity (${dir}): quota + load shapes (structure only)`, () => {
    const quotaReq = JSON.parse(fs.readFileSync(`captures/${dir}/quota.req.json`, "utf-8"));
    assert.equal(quotaReq.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary");
    assert.deepEqual(quotaReq.body, { project: "aicode-consumers" });
    // No state-dependent values (percentages, reset times) — keys and types only.
    const quotaResp = JSON.parse(fs.readFileSync(`captures/${dir}/quota.resp.json`, "utf-8"));
    assert.ok(Array.isArray(quotaResp.groups), "quota groups");
    for (const g of quotaResp.groups) {
      assert.ok(Array.isArray(g.buckets), "quota buckets");
      for (const b of g.buckets) {
        assert.equal(typeof b.bucketId, "string");
        if ("remainingFraction" in b) assert.equal(typeof b.remainingFraction, "number");
      }
    }

    const modelsReq = JSON.parse(fs.readFileSync(`captures/${dir}/models.req.json`, "utf-8"));
    assert.equal(modelsReq.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    assert.deepEqual(modelsReq.body, { project: "aicode-consumers" });

    const loadReq = JSON.parse(fs.readFileSync(`captures/${dir}/load_code_assist.req.json`, "utf-8"));
    assert.equal(loadReq.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    assert.deepEqual(loadReq.body, { metadata: { ideType: "ANTIGRAVITY" } });
    const loadResp = JSON.parse(fs.readFileSync(`captures/${dir}/load_code_assist.resp.json`, "utf-8"));
    assert.equal(typeof loadResp?.cloudaicompanionProject, "string");
  });

  test(`Wire parity (${dir}): builder reproduces the captured envelope`, () => {
    const turn1 = load(dir, "stream_turn1_initial");
    const fixtureCatalog = parseAvailableModels(
      JSON.parse(fs.readFileSync(`captures/${dir}/models.resp.json`, "utf-8"))
    );
    const plan = resolveModelPlan(turn1.body.model, undefined, {
      enums: fixtureCatalog.modelEnums,
      runtimeIds: fixtureCatalog.models.map((m) => m.id),
      thinking: buildThinkingMap(fixtureCatalog.models),
      deprecated: fixtureCatalog.deprecated,
      version: 0,
    });
    // 9 assistant turns + trailing user turn, mirroring the Turn 4/5 shape.
    const messages = [];
    for (let i = 0; i < 9; i++) {
      messages.push({ role: "user", content: `user step ${i}` });
      messages.push({ role: "assistant", content: `assistant step ${i}` });
    }
    messages.push({ role: "user", content: "follow-up" });
    const body = buildAntigravityRequestBody({ projectId: "aicode-consumers", plan, context: { messages } });
    const traj = body.request.labels.trajectory_id;
    assert.deepEqual(sortedKeys(body), sortedKeys(turn1.body), "top-level keys");
    assert.deepEqual(sortedKeys(body.request.labels), sortedKeys(turn1.body.request.labels), "label keys");
    assert.deepEqual(body.request.generationConfig, turn1.body.request.generationConfig, "thinking config");
    assert.equal(body.request.labels.last_step_index, String(body.request.contents.length - 1));
    assert.equal(body.request.labels.request_id, `${traj}-9`);
    assert.match(body.requestId, new RegExp(`/${traj}/${body.request.contents.length}$`));
    assert.equal(body.request.sessionId, turn1.body.request.sessionId, "sessionId byte parity");
  });

  // Every captured turn must be reproducible from the history agy replayed. The
  // envelope test above compares key sets and the generation config only, so
  // `contents` itself was unpinned until now.
  test(`Wire parity (${dir}): replaying a captured history reproduces its request`, () => {
    for (const f of fs
      .readdirSync(`captures/${dir}`)
      .filter((x) => x.startsWith("stream_") && x.endsWith(".req.json"))) {
      const name = f.replace(/\.req\.json$/, "");
      const { body } = load(dir, name);
      const built = replayCapture(dir, name, piMessagesFromContents(body.request.contents, body.model));
      const at = `${dir}/${name}`;

      assert.deepEqual(canonical(built.request.contents), canonical(body.request.contents), `${at}: contents`);
      assert.deepEqual(built.request.systemInstruction, body.request.systemInstruction, `${at}: systemInstruction`);
      assert.deepEqual(built.request.generationConfig, body.request.generationConfig, `${at}: generationConfig`);
      assert.equal(built.request.sessionId, body.request.sessionId, `${at}: sessionId`);
      assert.equal(built.project, body.project, `${at}: project`);
      assert.equal(built.model, body.model, `${at}: model`);
      assert.equal(built.userAgent, body.userAgent, `${at}: userAgent`);
      assert.equal(built.requestType, body.requestType, `${at}: requestType`);
      assert.equal(built.requestId.split("/").pop(), String(body.request.contents.length), `${at}: requestId step count`);

      // last_execution_id is the one label agy sends that this provider cannot
      // reproduce (no wire-visible source); everything else must match.
      const labels = { ...body.request.labels };
      delete labels.last_execution_id;
      assert.deepEqual(built.request.labels, labels, `${at}: labels`);
    }
  });
}

// Seams where one captured response, parsed by the production feed, is the
// assistant turn the next captured request replays: parser output → builder →
// agy's own bytes. A parser change that moved a signature or a block shows up
// here even though the reconstruction test above still passes.
const PARSER_SEAMS = [
  { dir: "agy_cli_1.1.27", from: "stream_turn4_thinking", to: "stream_turn5_multiturn", stopReason: "stop" },
  { dir: "agy_cli_1.1.28", from: "stream_turn4_thinking", to: "stream_turn5_multiturn", stopReason: "stop" },
  { dir: "agy_cli_1.1.28", from: "stream_turn8_claude_thinking", to: "stream_turn8b_claude_followup1", stopReason: "stop" },
  { dir: "agy_cli_1.1.28", from: "stream_turn8b_claude_followup1", to: "stream_turn9_claude_followup", stopReason: "stop" },
];

for (const seam of PARSER_SEAMS) {
  test(`Wire parity (${seam.dir}): ${seam.from} → ${seam.to} survives parser→builder replay`, () => {
    const from = load(seam.dir, seam.from).body;
    const to = load(seam.dir, seam.to).body;
    assert.equal(from.request.labels.trajectory_id, to.request.labels.trajectory_id, `${seam.to}: same trajectory`);

    // Seam premise: the later request is this history plus one replayed turn.
    const tail = to.request.contents.slice(from.request.contents.length);
    assert.deepEqual(
      canonical(to.request.contents.slice(0, from.request.contents.length)),
      canonical(from.request.contents),
      `${seam.to}: prefix must be the previous request's history`,
    );
    assert.equal(tail[0]?.role, "model", `${seam.to}: first new content is the replayed model turn`);
    assert.ok(!(tail[0].parts ?? []).some((p) => p.functionResponse), `${seam.to}: not a tool result`);

    const built = replayCapture(seam.dir, seam.to, [
      ...piMessagesFromContents(from.request.contents, from.model),
      assistantMessageFromResponse(seam.dir, seam.from, from.model, seam.stopReason),
      ...piMessagesFromContents(tail.slice(1), to.model),
    ]);
    assert.deepEqual(
      canonical(built.request.contents),
      canonical(to.request.contents),
      `${seam.from} → ${seam.to}: contents`,
    );
  });
}

// Known divergence, pinned rather than guessed: when a turn ends in a tool call,
// agy 1.1.26 replays the functionCall with its signature but omits the thinking
// part, while this builder keeps it. 1.1.27/1.1.28 freeze no thinking+tools turn,
// so resolving it needs a capture (captures/README.md §2, tool success + effort).
test("Wire parity (agy_cli_1.1.26): the tool-turn seam omits only agy's dropped thinking part", () => {
  const dir = "agy_cli_1.1.26";
  const from = load(dir, "stream_turn1_initial").body;
  const to = load(dir, "stream_turn2_toolresult").body;
  const tail = to.request.contents.slice(from.request.contents.length);
  assert.equal(tail[0]?.role, "model", "first new content is the replayed model turn");

  const built = replayCapture(dir, "stream_turn2_toolresult", [
    ...piMessagesFromContents(from.request.contents, from.model),
    assistantMessageFromResponse(dir, "stream_turn1_initial", from.model, "toolUse"),
    ...piMessagesFromContents(tail.slice(1), to.model),
  ]);

  const ours = built.request.contents;
  assert.equal(ours.length, to.request.contents.length, "same step count");
  assert.equal(
    ours.flatMap((c) => c.parts ?? []).filter((p) => p.thought).length,
    1,
    "exactly one replayed thinking part is the whole difference",
  );
  assert.deepEqual(
    canonical(ours.map((c) => ({ ...c, parts: (c.parts ?? []).filter((p) => !p.thought) }))),
    canonical(to.request.contents),
    "everything but the thinking part must match agy's replay",
  );
});

for (const dir of DIRS) {
  test(`Wire parity (${dir}): Claude thinking replays part-split (counter-capture #14)`, (t) => {
    const claudeTurns = streamReqs(dir)
      .map((f) => ({ file: f, req: JSON.parse(fs.readFileSync(`captures/${f}`, "utf-8")) }))
      .filter(({ req }) => String(req.body?.model ?? "").startsWith("claude-"));
    if (claudeTurns.length === 0) return t.skip("no Claude turns frozen in this version");
    const sseBodies = streamReqs(dir).map((f) =>
      fs.readFileSync(`captures/${f.replace(/\.req\.json$/, ".resp.sse")}`, "utf-8")
    );
    const replayed = [];
    for (const { file, req } of claudeTurns) {
      const labels = req.body.request.labels;
      assert.equal(labels.used_claude, "true", `${file}: used_claude`);
      assert.equal(labels.used_claude_conservative, "true", `${file}: used_claude_conservative`);
      assert.equal(labels.used_non_gemini_model, "true", `${file}: used_non_gemini_model`);
      assert.ok(labels.model_enum, `${file}: model_enum`);
      for (const c of req.body.request.contents) {
        for (const p of c.parts ?? []) {
          // Same part-split as Gemini (#15): a thought:true part never carries
          // the signature — it rides the following visible-text part.
          if (p.thought === true) assert.equal("thoughtSignature" in p, false, `${file}: thought part`);
          if (p.thoughtSignature) replayed.push([file, p.thoughtSignature]);
        }
      }
    }
    // The fixture must prove replay, not drop: at least one follow-up turn
    // carries a signature, and every replayed value matches the thinking
    // response SSE verbatim (Claude sends it combined on the closing thought part).
    assert.ok(replayed.length >= 1, `${dir}: no Claude turn replays a thoughtSignature`);
    for (const [file, sig] of replayed) {
      assert.ok(sseBodies.some((sse) => sse.includes(sig)), `${file}: replayed sig missing from Claude SSE`);
    }
  });
}

test("Wire parity: DEFAULT_USER_AGENT tracks the newest capture", () => {
  const newest = DIRS[DIRS.length - 1];
  assert.equal(DEFAULT_USER_AGENT, EXPECTED_UA[newest]);
});

test("Wire parity: every captured SSE parses with usage and stop reason", () => {
  for (const dir of DIRS) {
    const files = fs.readdirSync(`captures/${dir}`).filter((f) => f.endsWith(".resp.sse"));
    assert.ok(files.length > 0, `${dir} must ship response fixtures`);
    for (const f of files) {
      const sse = fs.readFileSync(`captures/${dir}/${f}`, "utf-8");
      const parsed = parseWhole(sse);
      assert.ok(parsed.content.length >= 1, `${dir}/${f}: at least one block`);
      assert.ok(parsed.usage, `${dir}/${f}: usage metadata`);
      // Reasoning tokens ride `output` but are reported separately (pi-ai
      // Usage.reasoning). The wire's own count is the source; a turn that omits
      // it reports 0, exactly as pi-ai's Google adapter reads a missing count.
      const thoughts = [...sse.matchAll(/"thoughtsTokenCount": (\d+)/g)].pop();
      assert.equal(parsed.usage.reasoning, thoughts ? Number(thoughts[1]) : 0, `${dir}/${f}: reasoning tokens`);
      const empties = parsed.content.filter(
        (b) => (b.type === "text" && b.text === "") || (b.type === "thinking" && b.thinking === ""),
      );
      assert.equal(empties.length, 0, `${dir}/${f}: no empty block (empty parts are signature carriers)`);
      assert.ok(["stop", "toolUse"].includes(parsed.stopReason), `${dir}/${f}: stop reason`);
    }
  }
});

test("Wire parity: the three counters follow what each request carries", () => {
  // Every captured turn satisfies all three: the envelope counts steps, the step
  // index is that count minus one, and the label counts model turns (a
  // functionResponse-only step is a tool result, not a model turn).
  for (const dir of DIRS) {
    for (const f of fs
      .readdirSync(`captures/${dir}`)
      .filter((x) => x.startsWith("stream_") && x.endsWith(".req.json"))) {
      const { body } = JSON.parse(fs.readFileSync(`captures/${dir}/${f}`, "utf-8"));
      const contents = body.request.contents;
      const modelTurns = contents.filter(
        (c) => c.role === "model" && !(c.parts ?? []).some((p) => p.functionResponse),
      ).length;
      const at = `${dir}/${f}`;
      assert.equal(body.request.labels.last_step_index, String(contents.length - 1), `${at}: last_step_index`);
      assert.equal(body.requestId.split("/").pop(), String(contents.length), `${at}: requestId step count`);
      assert.equal(
        body.request.labels.request_id,
        `${body.request.labels.trajectory_id}-${modelTurns}`,
        `${at}: request_id model turns`,
      );
    }
  }
});

test("Wire parity (agy_cli_1.1.27): thinkingBudget matrix low/medium/high", () => {
  // Medium effort had no 1.1.26 fixture; 1.1.27 pins it via stream_turn3_medium.
  const budgetOf = (dir, name) =>
    load(dir, name)?.body.request.generationConfig.thinkingConfig.thinkingBudget;
  assert.equal(budgetOf("agy_cli_1.1.27", "stream_turn7_initial_low"), 1000);
  assert.equal(budgetOf("agy_cli_1.1.27", "stream_turn3_medium"), 4000);
  assert.equal(budgetOf("agy_cli_1.1.27", "stream_turn1_initial"), -1);
});

test("Wire parity (agy_cli_1.1.27): pro request follows the deprecated rename", () => {
  const turn = load("agy_cli_1.1.27", "stream_turn10_pro_high");
  const catalog = parseAvailableModels(
    JSON.parse(fs.readFileSync("captures/agy_cli_1.1.27/models.resp.json", "utf-8"))
  );
  // User-facing selection is gemini-3.1-pro + high; the wire must carry the
  // renamed runtime ID, its enum, and its budget — exactly what agy sent.
  const plan = resolveModelPlan("gemini-3.1-pro", "high", {
    enums: catalog.modelEnums,
    runtimeIds: catalog.models.map((m) => m.id),
    thinking: buildThinkingMap(catalog.models),
    deprecated: catalog.deprecated,
    version: 0,
  });
  assert.equal(plan.runtimeModelId, turn.body.model);
  assert.equal(plan.modelEnum, turn.body.request.labels.model_enum);
  assert.deepEqual(plan.thinkingConfig, turn.body.request.generationConfig.thinkingConfig);
});

test("Wire parity (agy_cli_1.1.27): catalog delta vs 1.1.26", () => {
  const cat = (dir) =>
    parseAvailableModels(
      JSON.parse(fs.readFileSync(`captures/${dir}/models.resp.json`, "utf-8"))
    );
  const oldIds = new Set(cat("agy_cli_1.1.26").models.map((m) => m.id));
  const added = cat("agy_cli_1.1.27").models.filter((m) => !oldIds.has(m.id));
  assert.deepEqual(added.map((m) => [m.id, m.modelEnum]), [
    ["gemini-3.5-flash-lite", "MODEL_PLACEHOLDER_M277"],
  ]);
});

test("Wire parity (#15): thought:true parts never carry thoughtSignature (part-split shape)", () => {
  for (const dir of DIRS) {
    const files = fs
      .readdirSync(`captures/${dir}`)
      .filter((f) => f.endsWith(".req.json"));
    for (const f of files) {
      const req = JSON.parse(fs.readFileSync(`captures/${dir}/${f}`, "utf-8"));
      const contents = req.body?.request?.contents ?? [];
      for (const c of contents) {
        for (const p of c.parts ?? []) {
          if (p.thought === true) {
            assert.equal(
              "thoughtSignature" in p,
              false,
              `${dir}/${f}: thought part must not carry a signature`
            );
          }
        }
      }
    }
  }
});

// Live-verification contract (AGENTS.md §2): replaying a conversation across model families
// only means something if the frozen requests actually exercise every replayable part type.
// A fixture set that quietly stops covering one of them (thinking turns dropped, tool turns
// trimmed) would still pass every behavioural suite, so the coverage itself is asserted here.
const PART_TYPES = ["text", "thought", "functionCall", "functionResponse"];

const capturedRequests = (dir) =>
  fs
    .readdirSync(`captures/${dir}`)
    .filter((f) => f.endsWith(".req.json"))
    .map((f) => JSON.parse(fs.readFileSync(`captures/${dir}/${f}`, "utf-8")));

const capturedParts = (dir) =>
  capturedRequests(dir)
    .flatMap((req) => req.body?.request?.contents ?? [])
    .flatMap((c) => c.parts ?? []);

test("Wire parity (coverage): every fixture dir replays text, thinking, functionCall and functionResponse", () => {
  for (const dir of DIRS) {
    const parts = capturedParts(dir);
    for (const type of PART_TYPES) {
      assert.ok(
        parts.some((p) => type in p),
        `${dir}: no ${type} part in any captured request — the scenario matrix lost coverage`
      );
    }
  }
});

// ADR-0007 gate: the sentinel divergence is only justified as long as agy-comparable traffic
// never needs it, and the A/B probe only proves anything while it stays a single-variable
// experiment. Both premises are asserted, so a future agy release that replays an unsigned
// functionCall (or a probe re-capture that changes more than one field) fails loudly.
test("Wire parity (ADR-0007): agy traffic carries no sentinel and the probe pairs stay single-variable", () => {
  for (const dir of DIRS) {
    const raw = fs
      .readdirSync(`captures/${dir}`)
      .filter((f) => f.endsWith(".req.json"))
      .map((f) => fs.readFileSync(`captures/${dir}/${f}`, "utf-8"))
      .join("\n");
    assert.equal(
      raw.includes(SKIP_THOUGHT_SIGNATURE_VALIDATOR),
      false,
      `${dir}: agy never sends the sentinel — a capture that does voids ADR-0007's premise`
    );
  }

  const probeRequest = (name) => {
    const req = JSON.parse(
      fs.readFileSync(`captures/pi_probe_sentinel/${name}.req.json`, "utf-8")
    );
    delete req.body.requestId; // per-call timestamp, differs by design
    delete req.headers["content-length"]; // derived from the body
    return req;
  };
  const withoutSignatures = (req) => {
    const clone = structuredClone(req);
    for (const c of clone.body.request.contents ?? []) {
      for (const p of c.parts ?? []) delete p.thoughtSignature;
    }
    return clone;
  };

  for (const [unsigned, sentinel] of [
    ["stream_probeA_unsigned", "stream_probeB_sentinel"],
    ["stream_probeC_claude_unsigned", "stream_probeD_claude_sentinel"],
  ]) {
    const a = probeRequest(unsigned);
    const b = probeRequest(sentinel);
    assert.deepEqual(
      withoutSignatures(a),
      withoutSignatures(b),
      `${sentinel}: probe pair must differ only in thoughtSignature`
    );
    assert.notDeepEqual(a, b, `${sentinel}: sentinel run must actually differ`);
    assert.equal(
      a.body.request.contents.flatMap((c) => c.parts).some((p) => "thoughtSignature" in p),
      false,
      `${unsigned}: baseline probe must stay unsigned`
    );
    assert.equal(
      b.body.request.contents
        .flatMap((c) => c.parts)
        .filter((p) => p.thoughtSignature === SKIP_THOUGHT_SIGNATURE_VALIDATOR).length,
      1,
      `${sentinel}: exactly one part may carry the sentinel`
    );
  }
});
