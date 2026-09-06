import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { streamAntigravity } from "../src/stream.ts";
import { buildAntigravityRequestBody } from "../src/builder.ts";
import { resolveModelPlan, STATIC_MODEL_ENUMS } from "../src/catalog.ts";

const sseTurn5 = fs.readFileSync("captures/agy_cli_1.1.26/stream_turn5_multiturn.resp.sse", "utf-8");
const sseLoneSig = fs.readFileSync(
  "captures/agy_cli_1.1.27/stream_turn1_initial.resp.sse",
  "utf-8"
);
// Expected signature straight from the fixture text — independent of the parser.
const loneSig = sseLoneSig.match(/"thoughtSignature":\s*"([^"]+)"/)[1];

const STATIC_SNAPSHOT = { enums: STATIC_MODEL_ENUMS, runtimeIds: [], version: 0 };

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
      { apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) }
    ).result();

    const text = message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    assert.match(text, /SHA-256/);
    assert.equal(message.stopReason, "stop");
    assert.ok(message.usage.totalTokens > 0, "usage must flow through the adapter");
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
      { apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) }
    ).result();
  } finally {
    globalThis.fetch = realFetch;
  }

  // Lone signature: text stays, no thinking block, signature rides top-level.
  assert.equal(message.content.length, 1);
  assert.equal(message.content[0].type, "text");
  assert.equal(message.content[0].text, "ok");
  assert.equal(message.thoughtSignature, loneSig);

  // Builder continuation replays it as [{text, thoughtSignature}] (agy CLI shape).
  const body = buildAntigravityRequestBody({
    projectId: "test-project",
    plan: resolveModelPlan("gemini-3.8-flash-high", undefined, STATIC_SNAPSHOT),
    context: {
      messages: [{ role: "user", content: "hi" }, message, { role: "user", content: "next" }],
    },
  });
  assert.deepEqual(body.request.contents[1], {
    role: "model",
    parts: [{ text: "ok", thoughtSignature: loneSig }],
  });
});
