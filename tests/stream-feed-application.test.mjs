import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { streamAntigravity } from "../src/stream.ts";
import { createSseFeed } from "../src/parser.ts";
import { buildThinkingMap, updateCatalogStore } from "../src/model-catalog.ts";
import { parseAvailableModels } from "../src/catalog-refresh.ts";

// Mixed turn: thinking + text + toolCall in one feed (positional-alignment pin).
const sseMixed = fs.readFileSync(
  "captures/agy_cli_1.1.26/stream_turn1_initial.resp.sse",
  "utf-8"
);

const FIXTURE_CATALOG = parseAvailableModels(
  JSON.parse(fs.readFileSync("captures/agy_cli_1.1.26/models.resp.json", "utf-8"))
);
updateCatalogStore(
  FIXTURE_CATALOG.modelEnums,
  FIXTURE_CATALOG.models.map((m) => m.id),
  buildThinkingMap(FIXTURE_CATALOG.models),
  FIXTURE_CATALOG.deprecated || {}
);

function stubFetchWithSse(rawSse, chunkBytes = 1024) {
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

test("Seam 2 (feed-application): final message mirrors close() content order and signatures", async () => {
  // Reference straight from the parser: the single driver of the final message.
  const ref = createSseFeed();
  ref.feed(sseMixed);
  const expected = ref.close().content;
  assert.ok(
    expected.some((b) => b.type === "thinking"),
    "fixture must carry a thinking block"
  );
  assert.ok(
    expected.some((b) => b.type === "toolCall"),
    "fixture must carry a toolCall block"
  );

  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchWithSse(sseMixed);
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

  assert.equal(message.content.length, expected.length, "positional alignment: same block count");
  message.content.forEach((block, index) => {
    const want = expected[index];
    assert.equal(block.type, want.type, `block ${index} type`);
    if (block.type === "thinking" && want.type === "thinking") {
      assert.equal(block.thinking, want.thinking, `block ${index} thinking`);
      assert.equal(block.thinkingSignature, want.thinkingSignature, `block ${index} thinkingSignature`);
    } else if (block.type === "text" && want.type === "text") {
      assert.equal(block.text, want.text, `block ${index} text`);
      assert.equal(block.textSignature, want.textSignature, `block ${index} textSignature`);
    } else if (block.type === "toolCall" && want.type === "toolCall") {
      assert.equal(block.id, want.id, `block ${index} id`);
      assert.equal(block.name, want.name, `block ${index} name`);
      assert.deepEqual(block.arguments, want.arguments, `block ${index} arguments`);
      assert.equal(block.thoughtSignature, want.thoughtSignature, `block ${index} thoughtSignature`);
    } else {
      assert.fail(`block ${index} type mismatch: ${block.type} vs ${want.type}`);
    }
  });
});
