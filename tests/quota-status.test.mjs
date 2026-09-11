import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildQuotaFooter,
  buildQuotaFooterBoth,
  calibrateWeeklyTo5hRatio,
  colorizeQuotaFooter,
  colorizeQuotaFooterBoth,
  DEFAULT_WEEKLY_TO_5H_RATIO,
  extractWindowFractionPairs,
  formatQuotaSummary,
  formatQuotaWindowPart,
  parseQuotaSummary,
  selectQuotaGroup,
  QUOTA_STATUS_KEY,
  QuotaStatusCoordinator,
  isAntigravityModel,
  paintQuotaStatus,
} from "../src/quota-status.ts";

const quotaJson = JSON.parse(fs.readFileSync("captures/agy_cli_1.2.0/quota.resp.json", "utf-8"));

// The capture rotates with every agy release: derive its percentages instead of
// hardcoding them, so these tests pin the formatting/routing logic, not one capture.
const fixturePct = (group, bucketId) => {
  const buckets = quotaJson.groups.find((g) => g.displayName === group).buckets;
  return Math.round(buckets.find((b) => b.bucketId === bucketId).remainingFraction * 100);
};
const gemini5hPct = fixturePct("Gemini Models", "gemini-5h");
const thirdParty5hPct = fixturePct("Claude and GPT models", "3p-5h");
const fixtureFraction = (group, bucketId) => {
  const buckets = quotaJson.groups.find((g) => g.displayName === group).buckets;
  return buckets.find((b) => b.bucketId === bucketId).remainingFraction;
};
const geminiObservation = {
  "5h": fixtureFraction("Gemini Models", "gemini-5h"),
  weekly: fixtureFraction("Gemini Models", "gemini-weekly"),
};
const pctRe = (pct) => new RegExp(`${pct}(?:\\.\\d)?%`);
const fiveHourRe = (pct) => new RegExp(`^5h ${pct}(?:\\.\\d)?%`);

// In-memory adapter behind the coordinator seam: no files, no network setup.
// Shared backing lets two coordinators act as two processes on one file.
function memStore(mode = "smart", state) {
  const backing = { state };
  return {
    store: {
      loadMode: () => mode,
      loadQuotaState: () => backing.state,
      saveQuotaState: (s) => { backing.state = s; return true; },
    },
    backing,
  };
}

function bucket(overrides) {
  return {
    bucketId: "x",
    displayName: "",
    window: "5h",
    remainingFraction: 1,
    ...overrides,
  };
}

function group(displayName, buckets) {
  return { displayName, buckets };
}

const in25m = new Date(Date.now() + 25 * 60 * 1000).toISOString();

test("parseQuotaSummary parses 5h and weekly buckets for Gemini and Claude", () => {
  const summary = parseQuotaSummary(quotaJson);

  assert.equal(summary.groups.length, 2);

  const geminiGroup = summary.groups.find((g) => g.displayName === "Gemini Models");
  assert.ok(geminiGroup);
  assert.equal(geminiGroup.buckets.length, 2);

  const gemini5h = geminiGroup.buckets.find((b) => b.window === "5h");
  assert.ok(gemini5h);
  assert.equal(Math.round(gemini5h.remainingFraction * 100), gemini5hPct);

  const claudeGroup = summary.groups.find((g) => g.displayName === "Claude and GPT models");
  assert.ok(claudeGroup);
  const claude5h = claudeGroup.buckets.find((b) => b.window === "5h");
  assert.ok(claude5h);
  assert.equal(Math.round(claude5h.remainingFraction * 100), thirdParty5hPct);
});

test("formatQuotaSummary renders clear progress bar text", () => {
  const summary = parseQuotaSummary(quotaJson);
  const output = formatQuotaSummary(summary);

  assert.match(output, /Gemini Models/);
  assert.match(output, /Claude and GPT models/);
  assert.match(output, /\[.*\]/); // progress bar
  assert.match(output, pctRe(gemini5hPct));
  assert.match(output, pctRe(thirdParty5hPct));
});

test("formatQuotaSummary renders pretty grouped gauge view", () => {
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

test("quota windows classify from wire fields, not display prose", () => {
  // No displayName at all: window + bucketId alone decide.
  const summary = { groups: [{ displayName: "", buckets: [
    { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.87 },
    { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.22 },
  ] }] };
  assert.equal(buildQuotaFooter(summary, "gemini-flash"), "5h 22%");
  // Machine fields beat misleading prose (renamed upstream strings).
  const tricky = { groups: [{ displayName: "Renamed Pool", buckets: [
    { bucketId: "gemini-5h", displayName: "Weekly-sounding Reword", window: "5h", remainingFraction: 0.22 },
    { bucketId: "gemini-weekly", displayName: "Five-sounding Reword", window: "weekly", remainingFraction: 0.87 },
  ] }] };
  assert.equal(buildQuotaFooter(tricky, "gemini-flash"), "5h 22%");
});

test("Footer both: 5h first, each part stands alone", () => {
  const summary = {
    groups: [
      group("Gemini Models", [
        bucket({ bucketId: "x-wk", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0.87 }),
        bucket({ remainingFraction: 0.22 }),
      ]),
    ],
  };
  assert.equal(buildQuotaFooterBoth(summary, "gemini-flash"), "5h 22% · Wk 87%");
  assert.equal(buildQuotaFooterBoth({ groups: [] }), undefined);
  assert.equal(
    colorizeQuotaFooterBoth("5h 8% (20m) · Wk 90%"),
    "\x1b[31m5h 8% (20m)\x1b[39m · Wk 90%",
  );
  assert.equal(colorizeQuotaFooterBoth(undefined), undefined);
  assert.equal(
    formatQuotaWindowPart(bucket({ window: "monthly", displayName: "Monthly Limit", remainingFraction: 0.8 })),
    "Monthly Limit 80%",
  );
});

test("Footer: gemini model shows Gemini pool bottleneck", () => {
  const summary = parseQuotaSummary(quotaJson);
  const footer = buildQuotaFooter(summary, "antigravity/gemini-3-flash");
  assert.match(footer, fiveHourRe(gemini5hPct));
});

test("Footer: claude model shows 3p pool bottleneck", () => {
  const summary = parseQuotaSummary(quotaJson);
  const footer = buildQuotaFooter(summary, "antigravity/claude-sonnet-4-6");
  assert.match(footer, fiveHourRe(thirdParty5hPct));
});

test("Footer: no model defaults to the Gemini pool", () => {
  const summary = parseQuotaSummary(quotaJson);
  assert.equal(buildQuotaFooter(summary), buildQuotaFooter(summary, "antigravity/gemini-3-flash"));
});

test("Footer: compact reset suffix and full-quota form", () => {
  const summary = {
    groups: [
      group("Gemini Models", [
        bucket({ remainingFraction: 0.22, resetTime: in25m }),
        bucket({ bucketId: "x-wk", window: "weekly", remainingFraction: 0.87, resetTime: in25m }),
      ]),
    ],
  };
  assert.equal(buildQuotaFooter(summary, "gemini-flash"), "5h 22% (25m)");

  const full = { groups: [group("Gemini Models", [bucket({ remainingFraction: 1 })])] };
  assert.equal(buildQuotaFooter(full), "5h 100%");
});

test("Footer: empty summary yields no text", () => {
  assert.equal(buildQuotaFooter({ groups: [] }), undefined);
  assert.equal(selectQuotaGroup([], "gemini"), undefined);
});

function stubQuotaFetch(quotaPayload, counter) {
  return async (url) => {
    counter.calls++;
    assert.match(String(url), /retrieveUserQuotaSummary/);
    const payload = typeof quotaPayload === "function" ? quotaPayload(counter.calls) : quotaPayload;
    if (payload instanceof Error) throw payload;
    return { ok: true, json: async () => payload };
  };
}

function makeCtx(statuses, { authed = true } = {}) {
  return {
    ui: { setStatus: (k, v) => statuses.push([k, v]) },
    modelRegistry: {
      getApiKeyForProvider: async () =>
        authed ? JSON.stringify({ token: "test-token", projectId: "test-project" }) : undefined,
    },
    model: { id: "gemini-3-flash", provider: "antigravity" },
  };
}

test("calibrateWeeklyTo5hRatio: delta ratio, guards, and fallbacks", () => {
  const prev = extractWindowFractionPairs({ groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.5 },
    { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.9 },
  ] }] });
  const curr = extractWindowFractionPairs({ groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.38 },
    { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.88 },
  ] }] });
  // dFiveHour=0.12, dWeekly=0.02 → R=6
  assert.equal(calibrateWeeklyTo5hRatio(prev, curr), 6);

  // Out-of-bounds observation keeps the current ratio
  const tiny = extractWindowFractionPairs({ groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.49 },
    { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.88 },
  ] }] });
  assert.equal(calibrateWeeklyTo5hRatio(prev, tiny, 7.5), 7.5);

  // No previous report, unknown group, or no consumption → current ratio
  assert.equal(calibrateWeeklyTo5hRatio(undefined, curr, 7.5), 7.5);
  assert.equal(calibrateWeeklyTo5hRatio(prev, prev), DEFAULT_WEEKLY_TO_5H_RATIO);
  assert.equal(
    calibrateWeeklyTo5hRatio(extractWindowFractionPairs({ groups: [] }), curr),
    DEFAULT_WEEKLY_TO_5H_RATIO,
  );
});

test("extractWindowFractionPairs: keys are pool slugs, not display names", () => {
  const pairs = extractWindowFractionPairs({ groups: [
    { displayName: "Gemini Models", buckets: [
      { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.5 },
      { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.9 },
    ] },
    { displayName: "Odd Pool", buckets: [
      { bucketId: "mystery", window: "5h", remainingFraction: 0.5 },
      { bucketId: "mystery-limits", window: "weekly", remainingFraction: 0.9 },
    ] },
  ] });
  assert.deepEqual(pairs, {
    gemini: { "5h": 0.5, weekly: 0.9 },
    mystery: { "5h": 0.5, weekly: 0.9 },
  });
});

test("Footer: urgency compares pool volumes, not raw fractions", () => {
  const summary = { groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.25 },
    { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.2 },
  ] }] };
  // Naive min would show Wk 20%; volume-adjusted (0.2×6=1.2 > 0.25) shows 5h
  assert.equal(buildQuotaFooter(summary, "gemini-flash"), "5h 25%");
  assert.equal(buildQuotaFooter(summary, "gemini-flash", 1), "Wk 20%");

  // Exact tie (0.125×4 = 0.5) breaks toward 5h, mirroring usage.ts
  const tied = { groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.5 },
    { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.125 },
  ] }] };
  assert.equal(buildQuotaFooter(tied, "gemini-flash", 4), "5h 50%");
});

test("Coordinator: refresh paints footer and throttles refetch", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  globalThis.fetch = stubQuotaFetch(quotaJson, counter);
  try {
    const coord = new QuotaStatusCoordinator(memStore("smart").store);
    const statuses = [];
    const ctx = makeCtx(statuses);

    assert.equal(coord.footerFor(ctx.model.id), undefined);
    await coord.refresh(ctx);
    paintQuotaStatus(coord, ctx);

    assert.equal(counter.calls, 1);
    assert.match(coord.footerFor(ctx.model.id), fiveHourRe(gemini5hPct));
    assert.deepEqual(statuses.at(-1), [QUOTA_STATUS_KEY, colorizeQuotaFooter(coord.footerFor(ctx.model.id))]);

    // Fresh: second refresh is a no-op without network.
    await coord.refresh(ctx);
    assert.equal(counter.calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("colorizeQuotaFooter: alert/warn/plain thresholds", () => {
  assert.equal(colorizeQuotaFooter("Wk 6% (2d 15h)"), "\x1b[31mWk 6% (2d 15h)\x1b[39m");
  assert.equal(colorizeQuotaFooter("5h 10% (25m)"), "\x1b[31m5h 10% (25m)\x1b[39m");
  assert.equal(colorizeQuotaFooter("5h 22% (25m)"), "\x1b[33m5h 22% (25m)\x1b[39m");
  assert.equal(colorizeQuotaFooter("5h 91% (4h 14m)"), "5h 91% (4h 14m)");
  assert.equal(colorizeQuotaFooter("5h 100%"), "5h 100%");
  assert.equal(colorizeQuotaFooter(undefined), undefined);
});

test("Coordinator: foreign model fetches nothing and clears the slot", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  globalThis.fetch = stubQuotaFetch(quotaJson, counter);
  try {
    const coord = new QuotaStatusCoordinator(memStore("smart").store);
    const statuses = [];
    const ctx = {
      ...makeCtx(statuses),
      model: { id: "opencode-go/zen", provider: "opencode-go" },
    };

    assert.equal(await coord.refresh(ctx), undefined);
    assert.equal(counter.calls, 0);
    paintQuotaStatus(coord, ctx);
    assert.deepEqual(statuses.at(-1), [QUOTA_STATUS_KEY, undefined]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("isAntigravityModel: provider field only", () => {
  assert.equal(isAntigravityModel({ provider: "antigravity" }), true);
  assert.equal(isAntigravityModel({ provider: "opencode-go" }), false);
  assert.equal(isAntigravityModel({}), false);
  assert.equal(isAntigravityModel(undefined), false);
});

test("Coordinator: off mode fetches nothing and clears the slot", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  globalThis.fetch = stubQuotaFetch(quotaJson, counter);
  try {
    const coord = new QuotaStatusCoordinator(memStore("off").store);
    const statuses = [];
    const ctx = makeCtx(statuses);

    assert.equal(await coord.refresh(ctx), undefined);
    assert.equal(counter.calls, 0);
    paintQuotaStatus(coord, ctx);
    assert.deepEqual(statuses.at(-1), [QUOTA_STATUS_KEY, undefined]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Coordinator: all mode paints both windows", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  const payload = { groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.87 },
    { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.22 },
  ] }] };
  globalThis.fetch = stubQuotaFetch(payload, counter);
  try {
    const coord = new QuotaStatusCoordinator(memStore("all").store);
    const statuses = [];
    const ctx = makeCtx(statuses);

    await coord.refresh(ctx);
    assert.equal(coord.footerFor(ctx.model.id, "all"), "5h 22% · Wk 87%");
    paintQuotaStatus(coord, ctx);
    assert.deepEqual(statuses.at(-1), [QUOTA_STATUS_KEY, "\x1b[33m5h 22%\x1b[39m · Wk 87%"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Coordinator: ignoreMode fetches for usage even when the slot is off", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  globalThis.fetch = stubQuotaFetch(quotaJson, counter);
  try {
    const coord = new QuotaStatusCoordinator(memStore("off").store);
    const ctx = makeCtx([]);
    const summary = await coord.refresh(ctx, { force: true, ignoreMode: true });
    assert.ok(summary);
    assert.equal(counter.calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ensurePreview fetches even when the slot is off", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  globalThis.fetch = stubQuotaFetch(quotaJson, counter);
  try {
    const coord = new QuotaStatusCoordinator(memStore("off").store);
    const ctx = makeCtx([]);
    const summary = await coord.ensurePreview(ctx);
    assert.ok(summary);
    assert.equal(counter.calls, 1);
    await coord.ensurePreview(ctx);
    assert.equal(counter.calls, 1); // cached
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ensurePreview fetches for foreign models: the dialog is an explicit look", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  globalThis.fetch = stubQuotaFetch(quotaJson, counter);
  try {
    const coord = new QuotaStatusCoordinator(memStore("off").store);
    const ctx = { ...makeCtx([]), model: { id: "zen", provider: "opencode-go" } };
    // The preview is the only place quota is visible while a foreign model is
    // selected, so opening settings must fetch rather than stay silent.
    assert.ok(await coord.ensurePreview(ctx));
    assert.equal(counter.calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Coordinator: unauthenticated refresh stays silent", async () => {
  const coord = new QuotaStatusCoordinator(memStore("smart").store);
  const statuses = [];
  const ctx = makeCtx(statuses, { authed: false });

  assert.equal(await coord.refresh(ctx), undefined);
  paintQuotaStatus(coord, ctx);
  assert.deepEqual(statuses.at(-1), [QUOTA_STATUS_KEY, undefined]);
});

test("Coordinator: two fetches calibrate the ratio and persist it", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  const payloads = [
    { groups: [{ displayName: "Gemini Models", buckets: [
      { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.5 },
      { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.9 },
    ] }] },
    { groups: [{ displayName: "Gemini Models", buckets: [
      { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.38 },
      { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.87 },
    ] }] },
  ];
  globalThis.fetch = stubQuotaFetch((call) => payloads[Math.min(call, 2) - 1], counter);
  try {
    const { store, backing } = memStore("smart");
    const coord = new QuotaStatusCoordinator(store);
    const ctx = makeCtx([]);

    assert.equal(coord.ratio, DEFAULT_WEEKLY_TO_5H_RATIO);
    await coord.refresh(ctx);
    assert.equal(coord.ratio, DEFAULT_WEEKLY_TO_5H_RATIO); // single snapshot: nothing to learn from
    await coord.refresh(ctx, { force: true });
    // dFiveHour=0.12, dWeekly=0.03 → R=4
    assert.equal(coord.ratio, 4);
    assert.equal(backing.state.weeklyTo5hRatio, 4);

    // A fresh coordinator restores the calibrated ratio without fetching
    const restored = new QuotaStatusCoordinator(store);
    assert.equal(restored.ratio, 4);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Coordinator: fetch failure keeps stale footer", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  globalThis.fetch = stubQuotaFetch(quotaJson, counter);
  try {
    const coord = new QuotaStatusCoordinator(memStore("smart").store);
    const ctx = makeCtx([]);
    await coord.refresh(ctx);
    const stale = coord.footerFor(ctx.model.id);
    assert.match(stale, fiveHourRe(gemini5hPct));

    globalThis.fetch = stubQuotaFetch(new Error("boom"), counter);
    assert.equal(await coord.refresh(ctx, { force: true }), undefined);
    assert.equal(coord.footerFor(ctx.model.id), stale);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Coordinator: first fetch persists its observation", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubQuotaFetch(quotaJson, { calls: 0 });
  try {
    const { store, backing } = memStore("smart");
    const coord = new QuotaStatusCoordinator(store);
    await coord.refresh(makeCtx([]));
    assert.equal(backing.state.weeklyTo5hRatio, DEFAULT_WEEKLY_TO_5H_RATIO);
    assert.deepEqual(backing.state.previousObservation["gemini"], geminiObservation);
    assert.equal(typeof backing.state.updatedAt, "number");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Coordinator: calibration works across processes via persisted pairs", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  const payloads = [
    { groups: [{ displayName: "Gemini Models", buckets: [
      { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.5 },
      { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.9 },
    ] }] },
    { groups: [{ displayName: "Gemini Models", buckets: [
      { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.38 },
      { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.87 },
    ] }] },
  ];
  globalThis.fetch = stubQuotaFetch((call) => payloads[Math.min(call, 2) - 1], counter);
  try {
    // One shared backing: two coordinators act as two processes on one file.
    const { store, backing } = memStore("smart");
    await new QuotaStatusCoordinator(store).refresh(makeCtx([]));
    const coord2 = new QuotaStatusCoordinator(store);
    assert.equal(coord2.ratio, DEFAULT_WEEKLY_TO_5H_RATIO);
    await coord2.refresh(makeCtx([]), { force: true });
    assert.equal(coord2.ratio, 4);
    assert.ok(backing.state);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Coordinator: stale persisted pairs are ignored", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubQuotaFetch(quotaJson, { calls: 0 });
  try {
    const { store, backing } = memStore("smart", {
      weeklyTo5hRatio: 9,
      previousObservation: { "gemini": { "5h": 0.9, weekly: 0.9 } },
      updatedAt: Date.now() - 6 * 60 * 60 * 1000,
    });
    const coord = new QuotaStatusCoordinator(store);
    assert.equal(coord.ratio, 9); // ratio itself survives
    await coord.refresh(makeCtx([]), { force: true });
    assert.equal(coord.ratio, 9); // stale baseline calibrates nothing
    // Rebaselined to the fresh capture, not the 6-hour-old synthetic baseline.
    assert.equal(backing.state.previousObservation["gemini"]["5h"], geminiObservation["5h"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Coordinator: hour-old baseline still calibrates", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  const payload = { groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "test-5h", displayName: "5h", window: "5h", remainingFraction: 0.38 },
    { bucketId: "test-weekly", displayName: "Wk", window: "weekly", remainingFraction: 0.87 },
  ] }] };
  globalThis.fetch = stubQuotaFetch(payload, counter);
  try {
    const { store, backing } = memStore("smart", {
      previousObservation: { "test": { "5h": 0.5, weekly: 0.9 } },
      updatedAt: Date.now() - 30 * 60 * 1000,
    });
    const coord = new QuotaStatusCoordinator(store);
    await coord.refresh(makeCtx([]), { force: true });
    // dFiveHour=0.12, dWeekly=0.03 → R=4
    assert.equal(coord.ratio, 4);
    assert.deepEqual(Object.keys(backing.state.previousObservation["test"]).sort(), ["5h", "weekly"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Coordinator: refreshAndPaint paints, refreshes when stale, repaints", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  globalThis.fetch = stubQuotaFetch(quotaJson, counter);
  try {
    const coord = new QuotaStatusCoordinator(memStore("smart").store);
    const statuses = [];
    const ctx = makeCtx(statuses);
    await coord.refreshAndPaint(ctx);
    // Instant paint (empty slot) → one fetch → repaint with fresh text.
    assert.deepEqual(statuses, [
      [QUOTA_STATUS_KEY, undefined],
      [QUOTA_STATUS_KEY, colorizeQuotaFooter(coord.footerFor(ctx.model.id))],
    ]);
    assert.match(statuses[1][1], pctRe(gemini5hPct));
    assert.equal(counter.calls, 1);

    // Fresh cache: still paints twice, fetches zero times.
    statuses.length = 0;
    await coord.refreshAndPaint(ctx);
    assert.equal(statuses.length, 2);
    assert.equal(counter.calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The status key is a documented contract: users hand this key to Pi when they
// ask it to rearrange their footer (README "Footer placement"). Renaming the
// constant without updating the README would silently break those prompts.
test("README documents the footer status key verbatim", () => {
  const readme = fs.readFileSync("README.md", "utf-8");
  assert.ok(
    readme.includes(QUOTA_STATUS_KEY),
    `README must document the footer slot key "${QUOTA_STATUS_KEY}"`,
  );
});
