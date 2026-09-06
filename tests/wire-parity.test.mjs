import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_USER_AGENT } from "../src/protocol.ts";
import {
  parseAvailableModels,
  resolveModelPlan,
  STATIC_MODEL_ENUMS,
} from "../src/catalog.ts";
import { buildAntigravityRequestBody } from "../src/builder.ts";
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
};
const load = (dir, name) => {
  const p = `captures/${dir}/${name}.req.json`;
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null;
};

// Production-path whole-input parse: feed() + close(), the same exits
// streamAntigravity uses. Assert on the returned result().
function parseWhole(rawSse) {
  const feed = createSseFeed();
  feed.feed(rawSse);
  feed.close();
  return feed.result();
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
      assert.equal(typeof body.request.sessionId, "string", `${f}: sessionId`);
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
    const plan = resolveModelPlan(turn1.body.model, undefined, {
      enums: STATIC_MODEL_ENUMS,
      runtimeIds: [],
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
      assert.ok(["stop", "toolUse"].includes(parsed.stopReason), `${dir}/${f}: stop reason`);
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
