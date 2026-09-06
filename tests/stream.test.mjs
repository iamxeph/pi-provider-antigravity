import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { streamAntigravity } from "../src/stream.ts";

const sseTurn5 = fs.readFileSync("captures/agy_cli_1.1.26/stream_turn5_multiturn.resp.sse", "utf-8");

function sseOkResponse(rawSse, chunkBytes = 4096) {
  const bytes = new TextEncoder().encode(rawSse);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkBytes) {
    chunks.push(bytes.slice(i, i + chunkBytes));
  }
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
  };
}

function httpError(status, body = "error") {
  return { ok: false, status, text: async () => body };
}

const model = {
  id: "gemini-3.8-flash",
  provider: "antigravity",
  api: "antigravity-api",
  maxTokens: 65536,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const options = { apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }) };
const context = { messages: [{ role: "user", content: "hi" }] };

function messageText(message) {
  return message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

test("Stream retry: 503-then-success recovers", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? httpError(503, "Service Unavailable") : sseOkResponse(sseTurn5, 1024);
  };
  try {
    const message = await streamAntigravity(model, context, options).result();
    assert.equal(calls, 2);
    assert.match(messageText(message), /SHA-256/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Stream retry: 401 fails fast with the re-login hint", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return httpError(401, "unauthorized");
  };
  try {
    const message = await streamAntigravity(model, context, options).result();
    assert.equal(calls, 1);
    assert.match(message.errorMessage || "", /\/login antigravity/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Stream retry: persistent 429 retries twice, then shows the quota hint", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return httpError(429, "too many requests");
  };
  try {
    const message = await streamAntigravity(model, context, options).result();
    assert.equal(calls, 3);
    assert.match(message.errorMessage || "", /\/antigravity usage/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
