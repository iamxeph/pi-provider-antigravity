import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createSseFeed } from "../src/parser.ts";

const sseTurn1 = fs.readFileSync("captures/agy_cli_1.2.0/stream_turn1_initial.resp.sse", "utf-8");
const sseTurn4 = fs.readFileSync("captures/agy_cli_1.2.0/stream_turn4_thinking.resp.sse", "utf-8");

// Production-path whole-input parse: feed() + close(), the same exits
// streamAntigravity uses. Assert on the returned close().
function parseWhole(rawSse) {
  const feed = createSseFeed();
  feed.feed(rawSse);
  return feed.close();
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
  // agy 1.2.0 sends no functionCall id: the parser generates one.
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
  const feed = createSseFeed();
  feed.feed(line("RECITATION", "a"));
  const closing = feed.feed(line("STOP", "b"));
  assert.equal(closing.stopReason, "error");
  const final = feed.close();
  assert.equal(final.stopReason, "error");
});

test("Seam 2: parseWhole handles text responses from Turn 4", () => {
  const sseTurn5 = fs.readFileSync("captures/agy_cli_1.2.0/stream_turn5_multiturn.resp.sse", "utf-8");
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
