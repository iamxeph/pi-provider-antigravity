import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { newestCapture } from "./fixtures.mjs";
import { streamAntigravity } from "../src/stream.ts";
import { buildAntigravityRequestBody } from "../src/builder.ts";
import { createModelCatalog } from "../src/model-catalog.ts";
import { normalizeContext } from "@earendil-works/pi-ai";

const sseTurn5 = fs.readFileSync(newestCapture("stream_turn5_multiturn.resp.sse"), "utf-8");
// A lone-signature turn: visible text plus a signature carrier, nothing else. Whether a
// captured turn has that shape is sampling-dependent (1.2.2 froze it on turn4, 1.2.3 on
// turn5), so this edge case owns its input inline instead of asking the capture for it —
// the same pattern the request-builder "uncovered edge" tests use. Shape mirrors the
// exported turn5 response; only the signature is synthetic.
const sseLoneSig = [
  'data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "done"}]}}],"usageMetadata": {"promptTokenCount": 1,"candidatesTokenCount": 1,"totalTokenCount": 2},"modelVersion": "gemini-3.8-flash","responseId": "inline-lone-sig"},"traceId": "inline-lone-sig","metadata": {}}',
  'data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"thoughtSignature": "TG9uZVNpZ25hdHVyZUZvclRlc3QxNg==", "text": ""}]},"finishReason": "STOP"}],"usageMetadata": {"promptTokenCount": 1,"candidatesTokenCount": 1,"totalTokenCount": 2},"modelVersion": "gemini-3.8-flash","responseId": "inline-lone-sig"},"traceId": "inline-lone-sig","metadata": {}}',
].join("\n");
// Expected values straight from the fixture text — independent of the parser, and
// stable across fixtures.
const textOf = (sse) =>
  [...sse.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
const usageOf = (sse) => JSON.parse([...sse.matchAll(/"usageMetadata": (\{[^}]*\})/g)].pop()[1]);
const loneSig = sseLoneSig.match(/"thoughtSignature":\s*"([^"]+)"/)[1];
const loneText = textOf(sseLoneSig);

const RAW_MODELS_JSON = JSON.parse(fs.readFileSync(newestCapture("models.resp.json"), "utf-8"));
// streamAntigravity resolves against the store the extension wires up: record
// one generation into a local store, as a completed refresh would, so these
// adapter tests exercise parsing — not catalog misses.
const store = createModelCatalog();
store.record(RAW_MODELS_JSON);

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
    plan: store.resolvePlan("gemini-3.8-flash-high"),
    context: normalizeContext({
      messages: [{ role: "user", content: "hi" }, message, { role: "user", content: "next" }],
    }),
  });
  assert.deepEqual(body.request.contents[1], {
    role: "model",
    parts: [{ text: loneText, thoughtSignature: loneSig }],
  });
});

test("Seam 2 (0.86 Parity): streamAntigravity extracts systemPrompt and tools from TranscriptContext and captures responseId", async () => {
  const realFetch = globalThis.fetch;
  let capturedRequestBody = null;

  globalThis.fetch = async (_url, init) => {
    capturedRequestBody = JSON.parse(init.body);
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseLoneSig));
          controller.close();
        },
      }),
    };
  };

  try {
    const transcriptContext = normalizeContext({
      systemPrompt: "You are a test assistant.",
      tools: [
        {
          name: "test_tool",
          description: "A test tool",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });

    const message = await streamAntigravity(
      {
        id: "gemini-3.8-flash",
        provider: "antigravity",
        api: "antigravity-api",
        maxTokens: 65536,
        cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
      },
      transcriptContext,
      {
        apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
        maxTokens: 2048,
      },
      store,
    ).result();

    assert.equal(message.responseId, "inline-lone-sig");
    assert.ok(capturedRequestBody, "Request body must be sent");
    assert.equal(
      capturedRequestBody.request.systemInstruction.parts[0].text,
      "You are a test assistant.",
      "systemPrompt must be extracted from TranscriptContext and passed to systemInstruction",
    );
    assert.equal(
      capturedRequestBody.request.tools[0].functionDeclarations[0].name,
      "test_tool",
      "tools must be extracted from TranscriptContext and passed to tools",
    );
    assert.equal(
      capturedRequestBody.request.generationConfig.maxOutputTokens,
      2048,
      "options.maxTokens must be honored over model.maxTokens",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam 2 (0.86 Parity): deriveSessionId preserves trajectory_id regardless of systemPrompt", () => {
  const plan = store.resolvePlan("gemini-3.8-flash-high");
  const withPrompt = buildAntigravityRequestBody({
    projectId: "test-project",
    plan,
    context: normalizeContext({
      systemPrompt: "You are an assistant with a specific system prompt.",
      messages: [{ role: "user", content: "hello world session seed" }],
    }),
  });
  const withoutPrompt = buildAntigravityRequestBody({
    projectId: "test-project",
    plan,
    context: normalizeContext({
      messages: [{ role: "user", content: "hello world session seed" }],
    }),
  });
  assert.equal(
    withPrompt.request.labels.trajectory_id,
    withoutPrompt.request.labels.trajectory_id,
    "trajectory_id must be seeded from the first user turn, not the system message",
  );
  assert.equal(
    withPrompt.request.sessionId,
    withoutPrompt.request.sessionId,
    "sessionId must be identical regardless of systemPrompt presence",
  );
});

test("Seam 2 (0.86 Parity): mid-conversation system updates collapse into systemInstruction and never leak into contents", () => {
  const plan = store.resolvePlan("gemini-3.8-flash-high");
  // Transcript with initial system message + user + assistant + mid-conversation system message
  const context = {
    messages: [
      { role: "system", content: "Initial prompt", timestamp: 0 },
      { role: "user", content: "Turn 1" },
      { role: "assistant", content: [{ type: "text", text: "Answer 1" }] },
      { role: "system", content: "Updated mid-conversation rules", timestamp: 1 },
      { role: "user", content: "Turn 2" },
    ],
  };
  const body = buildAntigravityRequestBody({
    projectId: "test-project",
    plan,
    context,
  });

  assert.ok(
    body.request.systemInstruction.parts[0].text.includes("Initial prompt"),
    "systemInstruction must contain initial prompt",
  );
  assert.ok(
    body.request.systemInstruction.parts[0].text.includes("Updated mid-conversation rules"),
    "systemInstruction must contain mid-conversation system update",
  );
  // Wire contents must only contain 'user' and 'model' turns
  const roles = body.request.contents.map((c) => c.role);
  assert.deepEqual(roles, ["user", "model", "user"]);
  assert.ok(
    !body.request.contents.some((c) => c.role === "system"),
    "System messages must never leak into wire contents",
  );
});
