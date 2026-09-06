import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_USER_AGENT } from "../src/protocol.ts";
import { parseAvailableModels } from "../src/catalog.ts";
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
