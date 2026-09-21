import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { newestCapture } from "./fixtures.mjs";
import { parseAntigravitySseResponse } from "../src/stream.ts";

const sseTurn1 = fs.readFileSync(newestCapture("stream_turn1_initial.resp.sse"), "utf-8");
const sseTurn4 = fs.readFileSync(newestCapture("stream_turn4_thinking.resp.sse"), "utf-8");

// Production-path whole-input parse: uses canonical parseAntigravitySseResponse seam.
function parseWhole(rawSse) {
  return parseAntigravitySseResponse(rawSse);
}

// The fixture rotates with every agy release, so the expected values are read off the
// SSE itself: these tests pin the parser's mapping, not one capture's numbers.
const sseUsage = JSON.parse([...sseTurn1.matchAll(/"usageMetadata": (\{[^}]*\})/g)].pop()[1]);
const sseToolName = sseTurn1.match(/"functionCall":\s*\{\s*"name":\s*"([^"]+)"/)[1];
const sseThoughtText = [...sseTurn1.matchAll(/"thought":\s*true\s*,\s*"text":\s*"((?:[^"\\]|\\.)*)"/g)]
  .map((m) => JSON.parse(`"${m[1]}"`))
  .join("");
const sseSignature = [...sseTurn1.matchAll(/"thoughtSignature":\s*"([^"]+)"/g)].pop()[1];

test("Seam 2: parseWhole extracts thinking and thoughtSignature from Turn 1", () => {
  const result = parseWhole(sseTurn1);

  // Turn 1 has thinking and a functionCall
  assert.ok(result.content.length >= 2, "Expected at least thinking and toolCall blocks");

  const thinkingBlock = result.content.find((c) => c.type === "thinking");
  assert.ok(thinkingBlock, "Should have a thinking block");
  assert.equal(thinkingBlock.thinking, sseThoughtText, "thinking text must match the wire parts");

  const toolCallBlock = result.content.find((c) => c.type === "toolCall");
  assert.ok(toolCallBlock, "Should have a toolCall block");
  assert.equal(toolCallBlock.name, sseToolName);
  // The wire id is passed through; the call_<n> fallback covers parts agy sends without one.
  assert.match(toolCallBlock.id, /^call_/);
  assert.ok(Object.keys(toolCallBlock.arguments).length > 0, "args must survive the parse");

  // Critical: thoughtSignature must be captured, SDK-spelled by the parser:
  // toolCalls keep thoughtSignature, thinking blocks take thinkingSignature.
  assert.ok(toolCallBlock.thoughtSignature || thinkingBlock.thinkingSignature, "thoughtSignature must be present");
  assert.equal("thoughtSignature" in thinkingBlock, false, "thinking blocks must not carry the wire spelling");
  const sig = toolCallBlock.thoughtSignature || thinkingBlock.thinkingSignature;
  assert.equal(sig, sseSignature, "signature must be the wire value verbatim");
});

test("Seam 2: parseWhole extracts usage metadata", () => {
  const result = parseWhole(sseTurn1);

  assert.ok(result.usage);
  // pi's mapping: input excludes the cached prefix, output carries candidates plus
  // thinking, and the wire's cache count becomes cacheRead (see src/parser.ts).
  const cached = sseUsage.cachedContentTokenCount ?? 0;
  assert.equal(result.usage.input, sseUsage.promptTokenCount - cached);
  assert.equal(result.usage.output, sseUsage.candidatesTokenCount + (sseUsage.thoughtsTokenCount ?? 0));
  assert.equal(result.usage.reasoning, sseUsage.thoughtsTokenCount ?? 0);
  assert.equal(result.usage.cacheRead, cached);
  assert.equal(result.stopReason, "toolUse");
});

test("Seam 2: non-STOP finish reasons map to error and stick", () => {
  const line = (reason, text = "x") =>
    `data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"text": "${text}"}]}, "finishReason": "${reason}"}]}}\n`;
  for (const reason of ["SAFETY", "RECITATION", "BLOCKLIST", "MALFORMED_FUNCTION_CALL", "OTHER"]) {
    const result = parseWhole(line(reason));
    assert.equal(result.stopReason, "error", `${reason} must map to error`);
  }
  const lengthResult = parseWhole(line("MAX_TOKENS"));
  assert.equal(lengthResult.stopReason, "length");

  // A later STOP must not downgrade an earlier error.
  const final = parseAntigravitySseResponse([line("RECITATION", "a"), line("STOP", "b")]);
  assert.equal(final.stopReason, "error");
});

test("Seam 2: parseWhole handles text responses from Turn 4", () => {
  const sseTurn5 = fs.readFileSync(newestCapture("stream_turn5_multiturn.resp.sse"), "utf-8");
  const result = parseWhole(sseTurn5);

  assert.ok(result.content.some((c) => c.type === "text"));
  const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  // Compared against the SSE's own text parts: the fixture's wording changes per capture.
  const wireText = [...sseTurn5.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => JSON.parse(`"${m[1]}"`))
    .join("");
  assert.equal(text, wireText);
  assert.equal(result.stopReason, "stop");
});

test("Seam 2: parseWhole attaches lone thoughtSignature to text block when no thinking block was emitted", () => {
  const rawSse = [
    'data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"text": "ok"}]}}], "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 1, "thoughtsTokenCount": 123}}}\n\n',
    'data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"thoughtSignature": "lone_sig_xyz", "text": ""}]}, "finishReason": "STOP"}]}}\n\n',
  ].join("");

  const result = parseWhole(rawSse);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[0].text, "ok");
  assert.equal(result.content[0].textSignature, "lone_sig_xyz");
  // Ensure no empty thinking block was created
  assert.equal(result.content.some((b) => b.type === "thinking"), false);
  assert.equal(result.usage.reasoning, 123);
  assert.equal(result.stopReason, "stop");
});

// The wire shape behind the no-answer guard: a turn that ends with thinking and
// nothing else. Parsing stays faithful to the wire (`stop`), because only the
// delivery module can tell "the model answered with thinking" from "the model
// answered at all" — that verdict is the adapter's, not the parser's.
test("Seam 2: parseWhole keeps a thinking-only STOP turn as wire-faithful thinking", () => {
  const rawSse = [
    'data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"thought": true, "text": "Ready to present the candidates. "}]}}], "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 0, "thoughtsTokenCount": 310}}, "traceId": "thinking-only"}\n\n',
    'data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"thought": true, "text": "Still deliberating.", "thoughtSignature": "sig_thinking_only"}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 0, "thoughtsTokenCount": 62911}}, "traceId": "thinking-only"}\n\n',
  ].join("");

  const result = parseWhole(rawSse);

  assert.equal(result.stopReason, "stop");
  assert.equal(result.usage.reasoning, 62911);
  assert.equal(result.usage.output, 62911);
  assert.equal(result.content.length, 1, "one block, and it is not an answer");
  assert.equal(result.content[0].type, "thinking");
  assert.equal(result.content[0].thinking, "Ready to present the candidates. Still deliberating.");
  assert.equal(result.content[0].thinkingSignature, "sig_thinking_only");
  assert.equal(result.content.some((b) => b.type === "text" || b.type === "toolCall"), false);
});
