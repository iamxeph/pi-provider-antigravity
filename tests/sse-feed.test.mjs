import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createSseFeed } from "../src/parser.ts";

const sseTurn1 = fs.readFileSync("captures/agy_cli_1.1.26/stream_turn1_initial.resp.sse", "utf-8");
const sseTurn5 = fs.readFileSync("captures/agy_cli_1.1.26/stream_turn5_multiturn.resp.sse", "utf-8");

test("Seam 2: feeding in split chunks equals one-shot feed", () => {
  for (const raw of [sseTurn1, sseTurn5]) {
    const whole = createSseFeed();
    whole.feed(raw);
    const { events: _wholeEvents, ...expected } = whole.close();

    for (const cut of [1, Math.floor(raw.length / 2), raw.length - 1]) {
      const split = createSseFeed();
      split.feed(raw.slice(0, cut));
      split.feed(raw.slice(cut));
      const { events: _splitEvents, ...actual } = split.close();
      assert.deepEqual(actual, expected, `split at ${cut} must match one-shot`);
    }
  }
});

test("Seam 2: start/end events balance and deltas reconstruct blocks", () => {
  const feed = createSseFeed();
  const fedEvents = feed.feed(sseTurn5).events;
  const closing = feed.close();
  const events = [...fedEvents, ...closing.events];

  const starts = events.filter((e) => e.kind === "text_start" || e.kind === "thinking_start");
  const ends = events.filter((e) => e.kind === "text_end" || e.kind === "thinking_end");
  assert.equal(starts.length, ends.length, "every opened block must close");
  assert.ok(starts.length >= 1, "turn5 must open at least one block");
  for (const [s, e] of starts.map((st, i) => [st, ends[i]])) {
    assert.equal(s.index, e.index, "start/end indices must pair");
  }

  // Deltas joined per block must equal the accumulated block content.
  const { content } = closing;
  const deltas = new Map();
  for (const e of events) {
    if (e.kind === "text_delta" || e.kind === "thinking_delta") {
      deltas.set(e.index, (deltas.get(e.index) || "") + e.delta);
    }
  }
  for (const [index, joined] of deltas) {
    const block = content[index];
    const full = block.type === "text" ? block.text : block.thinking;
    assert.equal(joined, full, `block ${index} deltas must reconstruct content`);
  }
});

test("Seam 2: close() flushes an unterminated trailing line", () => {
  const firstDataLine = sseTurn1
    .split("\n")
    .find((l) => l.trim().startsWith("data:"))
    .trim();

  const feed = createSseFeed();
  const out = feed.feed(firstDataLine); // no trailing newline: stays buffered
  assert.equal(out.events.length, 0, "partial line must not emit yet");
  const closing = feed.close();
  assert.ok(closing.events.length > 0, "close must flush the buffered line");
  assert.ok(closing.content.length >= 1, "flushed line must produce a block");
});

test("Seam 2: every feed() output carries the live content ref its indices are valid into", () => {
  for (const raw of [sseTurn1, sseTurn5]) {
    const feed = createSseFeed();
    const decoder = new TextDecoder();
    const bytes = new TextEncoder().encode(raw);
    let first = null;
    for (let i = 0; i < bytes.length; i += 997) {
      const out = feed.feed(decoder.decode(bytes.slice(i, i + 997), { stream: true }));
      if (first === null) first = out.content;
      assert.equal(out.content, first, "content is the single store, not a copy");
      for (const e of out.events) {
        assert.ok(e.index < out.content.length, `event index ${e.index} valid into live content`);
        if (e.kind === "text_start" || e.kind === "text_delta" || e.kind === "text_end") {
          assert.equal(out.content[e.index].type, "text");
        } else if (e.kind === "thinking_start" || e.kind === "thinking_delta" || e.kind === "thinking_end") {
          assert.equal(out.content[e.index].type, "thinking");
        } else {
          assert.equal(out.content[e.index].type, "toolCall");
        }
      }
    }
    feed.close();
  }
});

