import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseQuotaSummary,
  formatQuotaSummary,
} from "../src/quota.ts";

const quotaJson = JSON.parse(fs.readFileSync("captures/agy_cli_1.1.26/quota.resp.json", "utf-8"));

test("Seam 3: parseQuotaSummary parses 5h and weekly buckets for Gemini and Claude", () => {
  const summary = parseQuotaSummary(quotaJson);

  assert.equal(summary.groups.length, 2);

  const geminiGroup = summary.groups.find((g) => g.displayName === "Gemini Models");
  assert.ok(geminiGroup);
  assert.equal(geminiGroup.buckets.length, 2);

  const gemini5h = geminiGroup.buckets.find((b) => b.window === "5h");
  assert.ok(gemini5h);
  assert.equal(Math.round(gemini5h.remainingFraction * 100), 22);

  const claudeGroup = summary.groups.find((g) => g.displayName === "Claude and GPT models");
  assert.ok(claudeGroup);
  const claude5h = claudeGroup.buckets.find((b) => b.window === "5h");
  assert.ok(claude5h);
  assert.equal(Math.round(claude5h.remainingFraction * 100), 84);
});

test("Seam 3: formatQuotaSummary renders clear progress bar text", () => {
  const summary = parseQuotaSummary(quotaJson);
  const output = formatQuotaSummary(summary);

  assert.match(output, /Gemini Models/);
  assert.match(output, /Claude and GPT models/);
  assert.match(output, /\[.*\]/); // progress bar
  assert.match(output, /22(\.2)?%/);
  assert.match(output, /84%/);
});

test("Seam 3: formatQuotaSummary renders pretty grouped gauge view", () => {
  const summary = parseQuotaSummary(quotaJson);
  const output = formatQuotaSummary(summary);
  const lines = output.split("\n");

  assert.match(output, /Gemini Models/);
  assert.match(output, /Claude and GPT models/);
  assert.match(output, /5h\s+\[[#\-]+\]/); // short label + ascii gauge
  assert.match(output, /Wk\s+\[[#\-]+\]/);
  assert.doesNotMatch(output, /[^\x00-\x7F]/); // ascii only, no tofu glyphs
  assert.match(output, /\(in [^)]+\)|\(ready\)/); // reset suffix
  assert.doesNotMatch(output, /Five Hour Limit Remaining/); // no verbose labels

  // 5h sorts before weekly within each group
  const idx5h = lines.findIndex((l) => /^\s*5h\s/.test(l));
  const idxWk = lines.findIndex((l) => /^\s*Wk\s/.test(l));
  assert.ok(idx5h !== -1 && idxWk !== -1 && idx5h < idxWk);
});
