import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { newestCapture } from "./fixtures.mjs";
import { streamAntigravity, normalizeOverflowError } from "../src/stream.ts";
import { buildAntigravityRequestBody } from "../src/builder.ts";
import { createModelCatalog } from "../src/model-catalog.ts";
import { normalizeContext } from "@earendil-works/pi-ai";
import { isContextOverflow, isRecoverableLength, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";

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

test("Seam 2: normalizeOverflowError adds context_length_exceeded prefix for overflow patterns and ignores rate limits", () => {
  // Google Gemini overflow message
  assert.equal(
    normalizeOverflowError("The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"),
    "context_length_exceeded: The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
  );

  // agy CLI prompt token count hard cap
  assert.equal(
    normalizeOverflowError("overall prompt token count 150000 exceeds hard cap of 128000 tokens"),
    "context_length_exceeded: overall prompt token count 150000 exceeds hard cap of 128000 tokens",
  );

  // Claude on Antigravity overflow message
  assert.equal(
    normalizeOverflowError("Prompt is too long: 213462 tokens > 200000 maximum"),
    "context_length_exceeded: Prompt is too long: 213462 tokens > 200000 maximum",
  );

  // Already prefixed — idempotent
  assert.equal(
    normalizeOverflowError("context_length_exceeded: input token count exceeds the maximum"),
    "context_length_exceeded: input token count exceeds the maximum",
  );

  // Rate limit / quota exceeded — must NOT be treated as context overflow
  assert.equal(
    normalizeOverflowError("Rate limit exceeded: 60 requests per minute"),
    "Rate limit exceeded: 60 requests per minute",
  );
  assert.equal(
    normalizeOverflowError("RESOURCE_EXHAUSTED: quota exceeded for day"),
    "RESOURCE_EXHAUSTED: quota exceeded for day",
  );
  assert.equal(
    normalizeOverflowError("Too many requests, please slow down"),
    "Too many requests, please slow down",
  );
});

test("Seam 2: calculateCost updates usage.cost with model pricing", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseTurn5));
        controller.close();
      },
    }),
  });

  try {
    const message = await streamAntigravity(
      {
        id: "gemini-3.8-flash",
        provider: "antigravity",
        api: "antigravity-api",
        maxTokens: 65536,
        cost: { input: 1.0, output: 2.0, cacheRead: 0.25, cacheWrite: 1.0 },
      },
      normalizeContext({ messages: [{ role: "user", content: "hello" }] }),
      { apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) },
      store,
    ).result();

    assert.equal(message.stopReason, "stop");
    // Verify calculateCost populated usage.cost based on model.cost
    assert.ok(message.usage.cost, "usage.cost must be populated");
    assert.ok(message.usage.cost.total > 0, "usage.cost.total must be > 0 when model has non-zero cost");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam 2 (H1 Fix): streamAntigravity throws error on non-STOP finishReason", async () => {
  const realFetch = globalThis.fetch;
  const safetySse = 'data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "blocked"}]},"finishReason": "SAFETY"}]}}\n';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(safetySse));
        controller.close();
      },
    }),
  });

  try {
    const stream = streamAntigravity(
      {
        id: "gemini-3.8-flash",
        provider: "antigravity",
        api: "antigravity-api",
        maxTokens: 65536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      normalizeContext({ messages: [{ role: "user", content: "hello" }] }),
      { apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) },
      store,
    );

    const message = await stream.result();
    assert.equal(message.stopReason, "error");
    assert.equal(message.rawStopReason, "SAFETY");
    assert.ok(message.errorMessage?.includes("SAFETY"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam 2 (H2 Fix): stream ending without finishReason is rejected as truncated", async () => {
  const realFetch = globalThis.fetch;
  const truncatedSse = 'data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "halfway"}]}}]}}\n';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(truncatedSse));
        controller.close();
      },
    }),
  });

  try {
    const stream = streamAntigravity(
      {
        id: "gemini-3.8-flash",
        provider: "antigravity",
        api: "antigravity-api",
        maxTokens: 65536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      normalizeContext({ messages: [{ role: "user", content: "hello" }] }),
      { apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) },
      store,
    );

    const message = await stream.result();
    assert.equal(message.stopReason, "error");
    assert.ok(message.errorMessage?.includes("Provider stream ended without a stop reason"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam 2 (H3 & H4 Fix): streamAntigravity invokes onPayload, onResponse, and applies baseUrl/headers", async () => {
  const realFetch = globalThis.fetch;
  let capturedUrl = null;
  let capturedHeaders = null;
  let capturedBody = null;
  let onPayloadCalled = false;
  let onResponseStatus = null;
  let onResponseHeaders = null;

  globalThis.fetch = async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream", "x-goog-test": "header-val" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseTurn5));
          controller.close();
        },
      }),
    };
  };

  try {
    const message = await streamAntigravity(
      {
        id: "gemini-3.8-flash",
        provider: "antigravity",
        api: "antigravity-api",
        baseUrl: "https://custom-gateway.example.com",
        headers: { "X-Model-Header": "model-val" },
        maxTokens: 65536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      normalizeContext({ messages: [{ role: "user", content: "hello" }] }),
      {
        apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
        headers: { "X-Request-Header": "request-val" },
        onPayload: async (payload, _model) => {
          onPayloadCalled = true;
          return { ...payload, customTransformed: true };
        },
        onResponse: async (res, _model) => {
          onResponseStatus = res.status;
          onResponseHeaders = res.headers;
        },
      },
      store,
    ).result();

    assert.equal(message.stopReason, "stop");
    assert.ok(onPayloadCalled, "onPayload must be invoked");
    assert.equal(capturedBody.customTransformed, true, "replacement payload from onPayload must be used");
    assert.equal(capturedUrl, "https://custom-gateway.example.com/v1internal:streamGenerateContent?alt=sse");
    assert.equal(capturedHeaders["X-Model-Header"], "model-val");
    assert.equal(capturedHeaders["X-Request-Header"], "request-val");
    assert.equal(onResponseStatus, 200);
    assert.equal(onResponseHeaders["x-goog-test"], "header-val");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam 2 (M2 Fix): streamAntigravity throws on in-stream SSE error payload", async () => {
  const realFetch = globalThis.fetch;
  const errorSse = 'data: {"error": {"code": 400, "message": "Invalid argument on stream", "status": "INVALID_ARGUMENT"}}\n';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(errorSse));
        controller.close();
      },
    }),
  });

  try {
    const stream = streamAntigravity(
      {
        id: "gemini-3.8-flash",
        provider: "antigravity",
        api: "antigravity-api",
        maxTokens: 65536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      normalizeContext({ messages: [{ role: "user", content: "hello" }] }),
      { apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) },
      store,
    );

    const message = await stream.result();
    assert.equal(message.stopReason, "error");
    assert.ok(message.errorMessage?.includes("Invalid argument on stream"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The two wire spellings of one pathology: a turn that spends its output budget on
// thinking and returns no answer. Pi recovers the MAX_TOKENS spelling on its own
// (recoverable-length compaction + one retry); the STOP spelling used to slip
// through as a completed turn whose only content was hidden thinking, ending the
// session in silence. This pins the guard to exactly the complement of Pi's
// recovery: `length` must stay untouched, and the error must stay non-retryable
// so a deliberate-to-the-budget turn is not re-requested over and over.
const thinkingOnlySse = (finishReason) =>
  [
    'data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"thought": true, "text": "Ready to present the candidates. "}]}}], "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 0, "thoughtsTokenCount": 310}, "responseId": "inline-thinking-only"}, "traceId": "inline-thinking-only"}',
    `data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"thought": true, "text": "Still deliberating.", "thoughtSignature": "sig_thinking_only"}]}, "finishReason": "${finishReason}"}], "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 0, "thoughtsTokenCount": 62911}, "responseId": "inline-thinking-only"}, "traceId": "inline-thinking-only"}`,
  ].join("\n");

const runThinkingOnly = async (finishReason) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchWithSse(thinkingOnlySse(finishReason), 64); // tiny chunks: boundaries land mid-line
  try {
    return await streamAntigravity(
      {
        id: "gemini-3.8-flash",
        provider: "antigravity",
        api: "antigravity-api",
        maxTokens: 65536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      normalizeContext({ messages: [{ role: "user", content: "hello" }] }),
      { apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) },
      store,
    ).result();
  } finally {
    globalThis.fetch = realFetch;
  }
};

test("Seam 2: thinking-only STOP is rejected as no answer, MAX_TOKENS keeps length recovery", async () => {
  const stopped = await runThinkingOnly("STOP");

  assert.equal(stopped.stopReason, "error");
  assert.ok(stopped.errorMessage?.includes("Antigravity returned no answer"), "error must name the failure");
  assert.ok(stopped.errorMessage?.includes("reasoning 62911"), "error must carry the reasoning count");
  assert.ok(stopped.errorMessage?.includes("Lower the thinking level"), "error must say what to do next");
  // Pi retries only errors matching its retryable patterns; this failure is deterministic.
  assert.equal(isRetryableAssistantError(stopped), false, "no-answer must not trigger Pi's auto-retry");
  // The wording must stay out of Pi's other error routers too, or this failure would be
  // silently rerouted: overflow patterns send it into compaction, length into a retry.
  assert.equal(isContextOverflow(stopped, 1048576), false, "no-answer must not read as context overflow");
  assert.equal(isRecoverableLength(stopped, 65536), false, "no-answer must not read as a recoverable length stop");
  // The thinking that was streamed stays on the message, so the UI can show it next to the error.
  assert.equal(stopped.content.length, 1);
  assert.equal(stopped.content[0].type, "thinking");
  assert.equal(stopped.content[0].thinkingSignature, "sig_thinking_only");
  assert.equal(stopped.usage.reasoning, 62911);

  const truncated = await runThinkingOnly("MAX_TOKENS");

  assert.equal(truncated.stopReason, "length", "MAX_TOKENS must still reach Pi's compaction recovery");
  assert.equal(truncated.rawStopReason, "MAX_TOKENS");
});

test("Seam 2: premature or empty STOP with no answer triggers auto-retryable error", async () => {
  const runWithSse = async (sse) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = stubFetchWithSse(sse, 64);
    try {
      return await streamAntigravity(
        {
          id: "gemini-3.8-flash",
          provider: "antigravity",
          api: "antigravity-api",
          maxTokens: 65536,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        normalizeContext({ messages: [{ role: "user", content: "hello" }] }),
        { apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) },
        store,
      ).result();
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  // Case 1: completely empty STOP (reasoning 0, no content)
  const emptySse = [
    'data: {"response": {"candidates": [{"finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 0, "thoughtsTokenCount": 0}, "responseId": "inline-empty"}, "traceId": "inline-empty"}',
  ].join("\n");

  const emptyStopped = await runWithSse(emptySse);
  assert.equal(emptyStopped.stopReason, "error");
  assert.ok(emptyStopped.errorMessage?.includes("Antigravity returned an empty response with no answer"));
  assert.ok(emptyStopped.errorMessage?.includes("reasoning 0 of 65536"));
  assert.ok(emptyStopped.errorMessage?.includes("Please retry your request"));
  assert.equal(isRetryableAssistantError(emptyStopped), true, "empty STOP must trigger Pi's auto-retry");
  assert.equal(isContextOverflow(emptyStopped, 1048576), false);
  assert.equal(isRecoverableLength(emptyStopped, 65536), false);

  // Case 2: small reasoning + whitespace text STOP (reasoning 1522, text "\n")
  const whitespaceSse = [
    'data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"thought": true, "text": "Deliberating briefly.", "thoughtSignature": "sig_brief"}]}}], "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 0, "thoughtsTokenCount": 1522}, "responseId": "inline-ws"}, "traceId": "inline-ws"}',
    'data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"text": "\\n"}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 1, "thoughtsTokenCount": 1522}, "responseId": "inline-ws"}, "traceId": "inline-ws"}',
  ].join("\n");

  const wsStopped = await runWithSse(whitespaceSse);
  assert.equal(wsStopped.stopReason, "error");
  assert.ok(wsStopped.errorMessage?.includes("Antigravity returned an empty response with no answer"));
  assert.ok(wsStopped.errorMessage?.includes("reasoning 1522 of 65536"));
  assert.ok(wsStopped.errorMessage?.includes("Please retry your request"));
  assert.equal(isRetryableAssistantError(wsStopped), true, "whitespace STOP must trigger Pi's auto-retry");
  assert.equal(isContextOverflow(wsStopped, 1048576), false);
  assert.equal(isRecoverableLength(wsStopped, 65536), false);
});

test("Seam 2 (M4 Fix): streamAntigravity stops with aborted reason on AbortSignal", async () => {
  const realFetch = globalThis.fetch;
  const controller = new AbortController();

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "chunk1"}]}}]}}\n'));
        controller.abort();
        ctrl.close();
      },
    }),
  });

  try {
    const stream = streamAntigravity(
      {
        id: "gemini-3.8-flash",
        provider: "antigravity",
        api: "antigravity-api",
        maxTokens: 65536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      normalizeContext({ messages: [{ role: "user", content: "hello" }] }),
      {
        apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
        signal: controller.signal,
      },
      store,
    );

    const message = await stream.result();
    assert.equal(message.stopReason, "aborted");
  } finally {
    globalThis.fetch = realFetch;
  }
});
