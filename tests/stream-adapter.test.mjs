import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { streamAntigravity } from "../src/stream.ts";
import { buildAntigravityRequestBody } from "../src/builder.ts";
import { resolveModelPlan, createCatalogStore } from "../src/model-catalog.ts";
import { parseAvailableModels } from "../src/catalog-refresh.ts";

const sseTurn5 = fs.readFileSync("captures/agy_cli_1.2.0/stream_turn5_multiturn.resp.sse", "utf-8");
// A lone-signature turn: visible text plus a signature carrier, nothing else.
const sseLoneSig = fs.readFileSync(
  "captures/agy_cli_1.2.0/stream_turn4_thinking.resp.sse",
  "utf-8"
);
// Expected values straight from the fixture text — independent of the parser, and
// stable across captures because they are the capture.
const textOf = (sse) =>
  [...sse.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
const usageOf = (sse) => JSON.parse([...sse.matchAll(/"usageMetadata": (\{[^}]*\})/g)].pop()[1]);
const loneSig = sseLoneSig.match(/"thoughtSignature":\s*"([^"]+)"/)[1];
const loneText = textOf(sseLoneSig);

const FIXTURE_CATALOG = parseAvailableModels(
  JSON.parse(fs.readFileSync("captures/agy_cli_1.2.0/models.resp.json", "utf-8"))
);
// streamAntigravity resolves against the store the extension wires up: record
// one generation into a local store, as a completed refresh would, so these
// adapter tests exercise parsing — not catalog misses.
const store = createCatalogStore();
store.record(FIXTURE_CATALOG);

function stubFetchWithSse(rawSse, chunkBytes = 4096) {
  const bytes = new TextEncoder().encode(rawSse);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkBytes) {
    chunks.push(bytes.slice(i, i + chunkBytes));
  }
  return async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
  });
}

test("Seam 2: stream adapter translates feeder events to Pi message", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchWithSse(sseTurn5, 1024); // tiny chunks: chunk boundaries land mid-line
  try {
    const model = {
      id: "gemini-3.8-flash",
      provider: "antigravity",
      api: "antigravity-api",
      maxTokens: 65536,
      cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
    };
    const message = await streamAntigravity(
      model,
      { messages: [{ role: "user", content: "hi" }] },
      { apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) },
      store
    ).result();

    const text = message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    assert.equal(text, textOf(sseTurn5));
    assert.equal(message.stopReason, "stop");
    assert.ok(message.usage.totalTokens > 0, "usage must flow through the adapter");
    assert.equal(
      message.usage.reasoning,
      usageOf(sseTurn5).thoughtsTokenCount ?? 0,
      "thinking tokens surface as reasoning (fixture count)",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam 2 (#16): lone thoughtSignature surfaces on the message and replays in builder continuation", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchWithSse(sseLoneSig, 1024); // tiny chunks: chunk boundaries land mid-line
  let message;
  try {
    message = await streamAntigravity(
      {
        id: "gemini-3.8-flash",
        provider: "antigravity",
        api: "antigravity-api",
        maxTokens: 65536,
        cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
      },
      { messages: [{ role: "user", content: "hi" }] },
      { apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) },
      store
    ).result();
  } finally {
    globalThis.fetch = realFetch;
  }

  // Lone signature: text stays, no thinking block, signature rides the text
  // block's canonical textSignature (#26: no message-level extra).
  assert.equal(message.content.length, 1);
  assert.equal(message.content[0].type, "text");
  assert.equal(message.content[0].text, loneText);
  assert.equal(message.content[0].textSignature, loneSig);
  assert.equal("thoughtSignature" in message, false);

  // Builder continuation replays it as [{text, thoughtSignature}] (agy CLI shape).
  const body = buildAntigravityRequestBody({
    projectId: "test-project",
    plan: resolveModelPlan("gemini-3.8-flash-high", undefined, store.generation().snapshot),
    context: {
      messages: [{ role: "user", content: "hi" }, message, { role: "user", content: "next" }],
    },
  });
  assert.deepEqual(body.request.contents[1], {
    role: "model",
    parts: [{ text: loneText, thoughtSignature: loneSig }],
  });
});
