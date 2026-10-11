import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { newestCapture } from "./fixtures.mjs";
import { streamAntigravity } from "../src/stream.ts";
import { createModelCatalog } from "../src/model-catalog.ts";

const store = createModelCatalog();
store.record(JSON.parse(fs.readFileSync(newestCapture("models.resp.json"), "utf-8")));

const model = {
  id: "gemini-3.8-flash",
  provider: "antigravity",
  api: "antigravity-api",
  maxTokens: 65536,
  cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
};
const options = { apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) };

const event = (parts, finishReason, finishMessage) =>
  "data: " +
  JSON.stringify({
    response: {
      candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}), ...(finishMessage ? { finishMessage } : {}) }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      modelVersion: "gemini-3.8-flash",
      responseId: "inline-malformed",
    },
    traceId: "inline-malformed",
    metadata: {},
  });

// The shape captured from the live backend: a thinking part, then an empty function call.
const malformedThinking = (label) =>
  [
    event([{ thought: true, text: label }]),
    event([{ thoughtSignature: "U2lnbmF0dXJlRm9yVGVzdA==", text: "" }], "MALFORMED_FUNCTION_CALL", "Malformed function call: Function call is empty"),
  ].join("\n");
const malformedAfterText = [
  event([{ text: "partial answer" }]),
  event([{ text: "" }], "MALFORMED_FUNCTION_CALL", "Malformed function call: Function call is empty"),
].join("\n");
const okTurn = [event([{ text: "ok" }]), event([{ text: "" }], "STOP")].join("\n");

/** fetch stub serving one SSE body per call; the last body repeats once the list runs out. */
function stubFetchSequence(bodies) {
  const calls = { n: 0 };
  const fn = async () => {
    const body = bodies[Math.min(calls.n, bodies.length - 1)];
    calls.n++;
    const bytes = new TextEncoder().encode(body);
    return {
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    };
  };
  return { fn, calls };
}

async function run(bodies) {
  const realFetch = globalThis.fetch;
  const { fn, calls } = stubFetchSequence(bodies);
  globalThis.fetch = fn;
  try {
    const message = await streamAntigravity(model, { messages: [{ role: "user", content: "hi" }] }, options, store).result();
    return { message, calls: calls.n };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("MALFORMED_FUNCTION_CALL after thinking only: retried, recovers, failed attempts leave no blocks", async () => {
  const { message, calls } = await run([malformedThinking("attempt-1"), malformedThinking("attempt-2"), okTurn]);
  assert.equal(calls, 3);
  assert.equal(message.stopReason, "stop");
  assert.equal(message.rawStopReason, undefined);
  assert.deepEqual(
    message.content.map((c) => c.type),
    ["text"],
    "thinking from the failed attempts must not leak into the final message",
  );
  assert.equal(message.content[0].text, "ok");
});

test("MALFORMED_FUNCTION_CALL: gives up after 2 retries and surfaces the provider error", async () => {
  const { message, calls } = await run([malformedThinking("same")]);
  assert.equal(calls, 3, "1 attempt + 2 retries");
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage, /MALFORMED_FUNCTION_CALL/);
});

test("MALFORMED_FUNCTION_CALL after streamed text: retried, text from the failed attempt is discarded", async () => {
  const { message, calls } = await run([malformedAfterText, okTurn]);
  assert.equal(calls, 2);
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content.map((c) => c.text), ["ok"]);
});

test("nameless functionCall part is not a tool call: no toolCall block, retried", async () => {
  const emptyCall = [
    event([{ thought: true, text: "hmm" }]),
    event([{ functionCall: {}, thoughtSignature: "U2lnbmF0dXJlRm9yVGVzdA==" }], "MALFORMED_FUNCTION_CALL", "Function call is empty"),
  ].join("\n");
  const { message, calls } = await run([emptyCall, okTurn]);
  assert.equal(calls, 2);
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content.map((c) => c.type), ["text"]);
});

test("MALFORMED_FUNCTION_CALL after a real tool call: not retried, the real call is kept as toolUse", async () => {
  const realCall = [
    event([{ functionCall: { name: "bash", args: { command: "ls" } } }]),
    event([{ text: "" }], "MALFORMED_FUNCTION_CALL", "Function call is empty"),
  ].join("\n");
  const { message, calls } = await run([realCall, okTurn]);
  assert.equal(calls, 1);
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(message.content.map((c) => c.type), ["toolCall"]);
});
