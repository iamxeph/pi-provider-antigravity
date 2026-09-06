import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createSseFeed } from "../src/parser.ts";

const sseTurn1 = fs.readFileSync("captures/agy_cli_1.1.26/stream_turn1_initial.resp.sse", "utf-8");
const sseTurn4 = fs.readFileSync("captures/agy_cli_1.1.26/stream_turn4_thinking.resp.sse", "utf-8");

// Production-path whole-input parse: feed() + close(), the same exits
// streamAntigravity uses. Assert on the returned result().
function parseWhole(rawSse) {
  const feed = createSseFeed();
  feed.feed(rawSse);
  feed.close();
  return feed.result();
}

test("Seam 2: parseWhole extracts thinking and thoughtSignature from Turn 1", () => {
  const result = parseWhole(sseTurn1);

  // Turn 1 has thinking and a functionCall
  assert.ok(result.content.length >= 2, "Expected at least thinking and toolCall blocks");

  const thinkingBlock = result.content.find((c) => c.type === "thinking");
  assert.ok(thinkingBlock, "Should have a thinking block");
  assert.match(thinkingBlock.thinking, /Creating a new scratch file/);

  const toolCallBlock = result.content.find((c) => c.type === "toolCall");
  assert.ok(toolCallBlock, "Should have a toolCall block");
  assert.equal(toolCallBlock.name, "list_dir");
  assert.equal(toolCallBlock.id, "call_123908");
  assert.equal(toolCallBlock.arguments.DirectoryPath, "/home/user/.gemini/antigravity-cli/scratch");

  // Critical: thoughtSignature must be captured!
  assert.ok(toolCallBlock.thoughtSignature || thinkingBlock.thoughtSignature, "thoughtSignature must be present");
  const sig = toolCallBlock.thoughtSignature || thinkingBlock.thoughtSignature;
  assert.ok(sig.startsWith("EtUOCtIOARFN"), "Signature should match base64 fixture");
});

test("Seam 2: parseWhole extracts usage metadata", () => {
  const result = parseWhole(sseTurn1);

  assert.ok(result.usage);
  assert.equal(result.usage.input, 15615 - 8137);
  // output includes thinking tokens (candidates 50 + thoughts 381, per fixture)
  assert.equal(result.usage.output, 50 + 381);
  assert.equal(result.usage.cacheRead, 8137);
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
  feed.close();
  assert.equal(feed.result().stopReason, "error");
});

test("Seam 2: parseWhole handles text responses from Turn 4", () => {
  const sseTurn5 = fs.readFileSync("captures/agy_cli_1.1.26/stream_turn5_multiturn.resp.sse", "utf-8");
  const result = parseWhole(sseTurn5);

  assert.ok(result.content.some((c) => c.type === "text"));
  const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  assert.match(text, /SHA-256/);
  assert.equal(result.stopReason, "stop");
});
