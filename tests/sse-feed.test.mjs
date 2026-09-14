import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { newestCapture } from "./fixtures.mjs";
import { parseAntigravitySseResponse } from "../src/stream.ts";

const sseTurn1 = fs.readFileSync(newestCapture("stream_turn1_initial.resp.sse"), "utf-8");
const sseTurn5 = fs.readFileSync(newestCapture("stream_turn5_multiturn.resp.sse"), "utf-8");

test("Seam 2: feeding in split chunks equals one-shot feed", () => {
  for (const raw of [sseTurn1, sseTurn5]) {
    const expected = parseAntigravitySseResponse(raw);

    for (const cut of [1, Math.floor(raw.length / 2), raw.length - 1]) {
      const actual = parseAntigravitySseResponse([raw.slice(0, cut), raw.slice(cut)]);
      assert.deepEqual(actual, expected, `split at ${cut} must match one-shot`);
    }
  }
});

test("Seam 2: start/end events balance and deltas reconstruct blocks", () => {
  const events = [];
  const result = parseAntigravitySseResponse(sseTurn5, (ev) => events.push(ev));

  const starts = events.filter((e) => e.type === "text_start" || e.type === "thinking_start");
  const ends = events.filter((e) => e.type === "text_end" || e.type === "thinking_end");
  assert.equal(starts.length, ends.length, "every opened block must close");
  assert.ok(starts.length >= 1, "turn5 must open at least one block");
  for (const [s, e] of starts.map((st, i) => [st, ends[i]])) {
    assert.equal(s.contentIndex, e.contentIndex, "start/end indices must pair");
  }

  // Deltas joined per block must equal the accumulated block content.
  const { content } = result;
  const deltas = new Map();
  for (const e of events) {
    if (e.type === "text_delta" || e.type === "thinking_delta") {
      deltas.set(e.contentIndex, (deltas.get(e.contentIndex) || "") + e.delta);
    }
  }
  for (const [index, joined] of deltas) {
    const block = content[index];
    const full = block.type === "text" ? block.text : block.thinking;
    assert.equal(joined, full, `block ${index} deltas must reconstruct content`);
  }
});

// Empty parts are Thought Signature carriers (or streamed artifacts), not
// content: they must not open a block. 7 of the 26 frozen responses and 91% of
// the antigravity turns in this machine's session history carried the empty text
// block an eager create used to leave behind.
test("Seam 2: empty parts open no block, and a signature never loses its carrier", () => {
  const line = (parts) =>
    `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts } }] } })}\n`;
  const emptyBlocks = (content) =>
    content.filter(
      (b) => (b.type === "text" && b.text === "") || (b.type === "thinking" && b.thinking === ""),
    );

  for (const [name, parts] of [
    ["empty text", [{ text: "" }]],
    ["empty thought", [{ thought: true, text: "" }]],
    ["empty text after a tool call (1.1.26 turn1/2 shape)", [{ functionCall: { id: "c1", name: "bash", args: {} } }, { text: "" }]],
    ["empty text before a thought (Claude turn shape)", [{ text: "" }, { thought: true, text: "why" }]],
    ["empty thought after visible text", [{ text: "answer" }, { thought: true, text: "" }]],
  ]) {
    assert.equal(
      emptyBlocks(parseAntigravitySseResponse(line(parts)).content).length,
      0,
      `${name}: no empty block may be created`,
    );
  }

  // A signature that arrives with no content still needs somewhere to live: the
  // builder drops the empty part and replays the signature on the following one.
  for (const [name, parts] of [
    ["empty text carrying a signature", [{ text: "", thoughtSignature: "SIG_ONLY" }]],
    ["empty thought carrying a signature", [{ thought: true, text: "", thoughtSignature: "SIG_ONLY" }]],
  ]) {
    const signatures = parseAntigravitySseResponse(line(parts))
      .content.map((b) =>
        b.type === "text" ? b.textSignature : b.type === "thinking" ? b.thinkingSignature : b.thoughtSignature,
      )
      .filter(Boolean);
    assert.deepEqual(signatures, ["SIG_ONLY"], `${name}: the signature must survive`);
  }
});

test("Seam 2: unterminated trailing line is flushed at end of response", () => {
  const firstDataLine = sseTurn1
    .split("\n")
    .find((l) => l.trim().startsWith("data:"))
    .trim();

  const events = [];
  const result = parseAntigravitySseResponse(firstDataLine, (ev) => events.push(ev));
  assert.ok(events.length > 0, "trailing line must be flushed on completion");
  assert.ok(result.content.length >= 1, "flushed line must produce a block");
});

test("Seam 2: live content indices are valid for every emitted event", () => {
  for (const raw of [sseTurn1, sseTurn5]) {
    const decoder = new TextDecoder();
    const bytes = new TextEncoder().encode(raw);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 997) {
      chunks.push(decoder.decode(bytes.slice(i, i + 997), { stream: true }));
    }
    const events = [];
    const result = parseAntigravitySseResponse(chunks, (ev) => events.push(ev));
    for (const e of events) {
      assert.ok(e.contentIndex < result.content.length, `event index ${e.contentIndex} valid into live content`);
      if (e.type === "text_start" || e.type === "text_delta" || e.type === "text_end") {
        assert.equal(result.content[e.contentIndex].type, "text");
      } else if (e.type === "thinking_start" || e.type === "thinking_delta" || e.type === "thinking_end") {
        assert.equal(result.content[e.contentIndex].type, "thinking");
      } else {
        assert.equal(result.content[e.contentIndex].type, "toolCall");
      }
    }
  }
});
