import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newestCapture } from "./fixtures.mjs";
import {
  createQuotaStatus,
  FOOTER_MODES,
  FOOTER_MODE_NOTES,
  FOOTER_MODE_OPTIONS,
  normalizeFooterMode,
  resolveFooterMode,
  QUOTA_STATUS_KEY,
  QuotaStatusCoordinator,
  fileQuotaStatusStore,
  createQuotaFooterField,
  isAntigravityModel,
} from "../src/quota-status.ts";

const quotaJson = JSON.parse(fs.readFileSync(newestCapture("quota.resp.json"), "utf-8"));

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

test("parseQuotaSummary parses 5h and weekly buckets for Gemini and Claude", async () => {
  const coord = createQuotaStatus(memStore("smart").store);
  coord.ingest(quotaJson);

  // Gemini model selects Gemini pool
  const geminiFooter = coord.renderFooter("antigravity/gemini-3-flash", "smart").plain;
  assert.match(geminiFooter, fiveHourRe(gemini5hPct));

  // Claude model selects 3p pool
  const claudeFooter = coord.renderFooter("antigravity/claude-sonnet-4-6", "smart").plain;
  assert.match(claudeFooter, fiveHourRe(thirdParty5hPct));
});

test("formatQuotaSummary renders clear progress bar text", async () => {
  const coord = createQuotaStatus({
    store: memStore("smart").store,
    fetchQuotaSummary: async () => quotaJson,
  });
  const statuses = [];
  const ctx = makeCtx(statuses);
  const output = await coord.inspectUsage(ctx);

  assert.match(output, /Gemini Models/);
  assert.match(output, /Claude and GPT models/);
  assert.match(output, /\[.*\]/); // progress bar
  assert.match(output, pctRe(gemini5hPct));
  assert.match(output, pctRe(thirdParty5hPct));
});

test("formatQuotaSummary renders pretty grouped gauge view", async () => {
  const coord = createQuotaStatus({
    store: memStore("smart").store,
    fetchQuotaSummary: async () => quotaJson,
  });
  const statuses = [];
  const ctx = makeCtx(statuses);
  const output = await coord.inspectUsage(ctx);
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
  const coord = createQuotaStatus(memStore("smart").store);
  // No displayName at all: window + bucketId alone decide.
  const summary = { groups: [{ displayName: "", buckets: [
    { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.87 },
    { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.22 },
  ] }] };
  coord.ingest(summary);
  assert.equal(coord.renderFooter("gemini-flash").plain, "5h 22%");

  // Machine fields beat misleading prose (renamed upstream strings).
  const tricky = { groups: [{ displayName: "Renamed Pool", buckets: [
    { bucketId: "gemini-5h", displayName: "Weekly-sounding Reword", window: "5h", remainingFraction: 0.22 },
    { bucketId: "gemini-weekly", displayName: "Five-sounding Reword", window: "weekly", remainingFraction: 0.87 },
  ] }] };
  coord.ingest(tricky);
  assert.equal(coord.renderFooter("gemini-flash").plain, "5h 22%");
});

test("Footer both: 5h first, each part stands alone", () => {
  const coord = createQuotaStatus(memStore("all").store);
  const summary = {
    groups: [
      group("Gemini Models", [
        bucket({ bucketId: "x-wk", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0.87 }),
        bucket({ remainingFraction: 0.22 }),
      ]),
    ],
  };
  coord.ingest(summary);
  assert.equal(coord.renderFooter("gemini-flash", "all").plain, "5h 22% · Wk 87%");

  const emptyCoord = createQuotaStatus(memStore("all").store);
  emptyCoord.ingest({ groups: [] });
  assert.equal(emptyCoord.renderFooter("gemini-flash", "all").plain, undefined);

  // Colored threshold rendering across multiple windows
  const alertCoord = createQuotaStatus(memStore("all").store);
  alertCoord.ingest({
    groups: [
      group("Gemini Models", [
        bucket({ bucketId: "g-5h", window: "5h", remainingFraction: 0.08, resetTime: new Date(Date.now() + 20 * 60 * 1000).toISOString() }),
        bucket({ bucketId: "g-wk", window: "weekly", remainingFraction: 0.9 }),
      ]),
    ],
  });
  const colored = alertCoord.renderFooter("gemini-flash", "all").colored;
  assert.match(colored, /\x1b\[31m5h 8% \(20m\)\x1b\[39m/);
  assert.match(colored, /\x1b\[90mWk 90%\x1b\[39m/);
});

test("Footer: gemini model shows Gemini pool bottleneck", () => {
  const coord = createQuotaStatus(memStore("smart").store);
  coord.ingest(quotaJson);
  const footer = coord.renderFooter("antigravity/gemini-3-flash").plain;
  assert.match(footer, fiveHourRe(gemini5hPct));
});

test("Footer: claude model shows 3p pool bottleneck", () => {
  const coord = createQuotaStatus(memStore("smart").store);
  coord.ingest(quotaJson);
  const footer = coord.renderFooter("antigravity/claude-sonnet-4-6").plain;
  assert.match(footer, fiveHourRe(thirdParty5hPct));
});

test("Footer modes table: every mode defines consistent render behavior", () => {
  const coord = createQuotaStatus(memStore("smart").store);
  coord.ingest(quotaJson);
  assert.deepEqual(FOOTER_MODE_OPTIONS, ["off", "smart", "all"]);

  // off mode
  assert.deepEqual(coord.renderFooter("gemini-3-flash", "off"), {});

  // smart mode
  const smartRender = coord.renderFooter("gemini-3-flash", "smart");
  assert.match(smartRender.plain, fiveHourRe(gemini5hPct));
  assert.ok(smartRender.colored.includes(smartRender.plain));

  // all mode
  const allRender = coord.renderFooter("gemini-3-flash", "all");
  assert.ok(allRender.plain.includes(" · "));
  assert.ok(allRender.colored.includes(" · "));
});

test("Footer: no model defaults to the Gemini pool", () => {
  const coord = createQuotaStatus(memStore("smart").store);
  coord.ingest(quotaJson);
  assert.equal(coord.renderFooter().plain, coord.renderFooter("antigravity/gemini-3-flash").plain);
});

test("Footer: compact reset suffix and full-quota form", () => {
  const coord = createQuotaStatus(memStore("smart").store);
  const summary = {
    groups: [
      group("Gemini Models", [
        bucket({ remainingFraction: 0.22, resetTime: in25m }),
        bucket({ bucketId: "x-wk", window: "weekly", remainingFraction: 0.87, resetTime: in25m }),
      ]),
    ],
  };
  coord.ingest(summary);
  assert.equal(coord.renderFooter("gemini-flash").plain, "5h 22% (25m)");

  const full = { groups: [group("Gemini Models", [bucket({ remainingFraction: 1 })])] };
  coord.ingest(full);
  assert.equal(coord.renderFooter().plain, "5h 100%");
});

test("Footer: empty summary yields no text", () => {
  const coord = createQuotaStatus(memStore("smart").store);
  coord.ingest({ groups: [] });
  assert.equal(coord.renderFooter("gemini").plain, undefined);
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
  const prev = { groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.5 },
    { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.9 },
  ] }] };
  const curr = { groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.38 },
    { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.88 },
  ] }] };
  // dFiveHour=0.12, dWeekly=0.02 → R=6
  const coord = createQuotaStatus(memStore("smart").store);
  coord.ingest(prev);
  coord.ingest(curr);
  assert.equal(coord.ratio, 6);

  // Out-of-bounds observation keeps the current ratio
  const tiny = { groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.49 },
    { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.88 },
  ] }] };
  coord.ingest(tiny);
  assert.equal(coord.ratio, 6);
});

test("extractWindowFractionPairs: keys are pool slugs, not display names", () => {
  const coord = createQuotaStatus(memStore("smart").store);
  const prev = { groups: [
    { displayName: "Gemini Models", buckets: [
      { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.5 },
      { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.9 },
    ] },
    { displayName: "Odd Pool", buckets: [
      { bucketId: "mystery-5h", window: "5h", remainingFraction: 0.5 },
      { bucketId: "mystery-weekly", window: "weekly", remainingFraction: 0.9 },
    ] },
  ] };
  const curr = { groups: [
    { displayName: "Gemini Models", buckets: [
      { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.38 },
      { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.88 },
    ] },
    { displayName: "Odd Pool", buckets: [
      { bucketId: "mystery-5h", window: "5h", remainingFraction: 0.38 },
      { bucketId: "mystery-weekly", window: "weekly", remainingFraction: 0.88 },
    ] },
  ] };
  coord.ingest(prev);
  coord.ingest(curr);
  assert.equal(coord.ratio, 6);
});

test("Footer: urgency compares pool volumes, not raw fractions", () => {
  const coord = createQuotaStatus(memStore("smart").store);
  const summary = { groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "g-5h", displayName: "5h", window: "5h", remainingFraction: 0.25 },
    { bucketId: "g-wk", displayName: "Wk", window: "weekly", remainingFraction: 0.2 },
  ] }] };
  coord.ingest(summary);
  // Naive min would show Wk 20%; volume-adjusted (0.2×6=1.2 > 0.25) shows 5h
  assert.equal(coord.renderFooter("gemini-flash").plain, "5h 25%");
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
    coord.paint(ctx);

    assert.equal(counter.calls, 1);
    assert.match(coord.footerFor(ctx.model.id), fiveHourRe(gemini5hPct));
    assert.deepEqual(statuses.at(-1), [QUOTA_STATUS_KEY, coord.renderFooter(ctx.model.id, "smart").colored]);

    // Fresh: second refresh is a no-op without network.
    await coord.refresh(ctx);
    assert.equal(counter.calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("colorizeQuotaFooter: alert/warn/dim thresholds", () => {
  const coord = createQuotaStatus(memStore("smart").store);
  const mkSummary = (fraction) => ({
    groups: [group("Gemini Models", [bucket({ remainingFraction: fraction })])],
  });

  coord.ingest(mkSummary(0.08));
  assert.equal(coord.renderFooter("gemini-flash", "smart").colored, "\x1b[31m5h 8%\x1b[39m");

  coord.ingest(mkSummary(0.22));
  assert.equal(coord.renderFooter("gemini-flash", "smart").colored, "\x1b[33m5h 22%\x1b[39m");

  coord.ingest(mkSummary(0.91));
  assert.equal(coord.renderFooter("gemini-flash", "smart").colored, "\x1b[90m5h 91%\x1b[39m");

  coord.ingest(mkSummary(1.0));
  assert.equal(coord.renderFooter("gemini-flash", "smart").colored, "\x1b[90m5h 100%\x1b[39m");
});

test("colorizeQuotaFooter: adapts to active Theme/Colorizer when provided", () => {
  const customTheme = {
    fg: (tone, text) => `<${tone}>${text}</${tone}>`,
  };
  const coord = createQuotaStatus(memStore("smart").store);
  const mkSummary = (fraction) => ({
    groups: [group("Gemini Models", [bucket({ remainingFraction: fraction })])],
  });

  coord.ingest(mkSummary(0.08));
  assert.equal(coord.renderFooter("gemini-flash", "smart", customTheme).colored, "<error>5h 8%</error>");

  coord.ingest(mkSummary(0.22));
  assert.equal(coord.renderFooter("gemini-flash", "smart", customTheme).colored, "<warning>5h 22%</warning>");

  coord.ingest(mkSummary(0.91));
  assert.equal(coord.renderFooter("gemini-flash", "smart", customTheme).colored, "<dim>5h 91%</dim>");
});

test("Coordinator: paint adapts to ctx.ui.theme", () => {
  const coord = new QuotaStatusCoordinator(memStore("smart").store);
  coord.ingest(quotaJson);
  const statuses = [];
  const theme = { fg: (tone, text) => `{${tone}}${text}{/${tone}}` };
  const ctx = {
    ...makeCtx(statuses),
    ui: { setStatus: (key, text) => statuses.push([key, text]), theme },
  };
  coord.paint(ctx);
  assert.match(statuses.at(-1)[1], /^\{dim\}5h /);
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
    coord.paint(ctx);
    assert.deepEqual(statuses.at(-1), [QUOTA_STATUS_KEY, undefined]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Coordinator: a dead session ctx is ignored instead of throwing", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  globalThis.fetch = stubQuotaFetch(quotaJson, counter);
  try {
    const coord = new QuotaStatusCoordinator(memStore("smart").store);
    const statuses = [];
    // Mirrors the ctx Pi hands an event handler after teardown invalidated the
    // runtime: every property read asserts liveness and throws.
    const stale = new Proxy({}, {
      get: () => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    });

    assert.equal(await coord.refresh(stale), undefined);
    coord.paint(stale);
    await coord.refreshAndPaint(stale);
    assert.equal(counter.calls, 0);
    assert.deepEqual(statuses, []);

    // Same coordinator keeps working once a live ctx arrives.
    const live = makeCtx(statuses);
    await coord.refreshAndPaint(live);
    assert.equal(counter.calls, 1);
    assert.deepEqual(statuses.at(-1), [QUOTA_STATUS_KEY, coord.renderFooter(live.model.id, "smart").colored]);
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
    coord.paint(ctx);
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
    coord.paint(ctx);
    assert.deepEqual(statuses.at(-1), [
      QUOTA_STATUS_KEY,
      "\x1b[33m5h 22%\x1b[39m\x1b[90m · \x1b[39m\x1b[90mWk 87%\x1b[39m",
    ]);
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
  coord.paint(ctx);
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

    assert.equal(coord.ratio, 6);
    await coord.refresh(ctx);
    assert.equal(coord.ratio, 6); // single snapshot: nothing to learn from
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
    assert.equal(backing.state.weeklyTo5hRatio, 6);
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
    assert.equal(coord2.ratio, 6);
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
      [QUOTA_STATUS_KEY, coord.renderFooter(ctx.model.id, "smart").colored],
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

test("Coordinator: paint updates status slot directly", () => {
  const coord = new QuotaStatusCoordinator(memStore("smart").store);
  const statuses = [];
  const ctx = makeCtx(statuses);
  coord.paint(ctx);
  assert.deepEqual(statuses, [[QUOTA_STATUS_KEY, undefined]]);
});

test("Coordinator: inspectUsage atomically refreshes, paints footer, and formats summary", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  globalThis.fetch = stubQuotaFetch(quotaJson, counter);
  try {
    const coord = new QuotaStatusCoordinator(memStore("smart").store);
    const statuses = [];
    const ctx = makeCtx(statuses);
    const text = await coord.inspectUsage(ctx);
    assert.equal(counter.calls, 1);
    assert.ok(text.includes("Gemini Models"));
    assert.ok(statuses.length > 0);
    assert.deepEqual(statuses.at(-1), [QUOTA_STATUS_KEY, coord.renderFooter(ctx.model.id, "smart").colored]);
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

test("Footer mode: settings.quotaFooter or off", () => {
  assert.equal(resolveFooterMode(undefined), "off");
  assert.equal(resolveFooterMode({}), "off");
  assert.equal(resolveFooterMode({ settings: { quotaFooter: " ALL " } }), "all");
  assert.equal(resolveFooterMode({ settings: { quotaFooter: "smart" } }), "smart");
  assert.equal(resolveFooterMode({ settings: { quotaFooter: "everything" } }), "off");
  assert.equal(resolveFooterMode({ settings: {} }), "off");
  assert.equal(normalizeFooterMode(42), undefined);
});

test("Footer mode table: createQuotaFooterField derives options from FOOTER_MODES and notes from FOOTER_MODE_NOTES", () => {
  const coord = new QuotaStatusCoordinator(memStore("smart").store);
  const quotaField = createQuotaFooterField(coord);
  assert.ok(quotaField);
  assert.deepEqual(quotaField.options, Object.keys(FOOTER_MODES));
  assert.deepEqual(quotaField.optionNotes, FOOTER_MODE_NOTES);
});

test("fileQuotaStatusStore: state merges without clobbering", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-store-"));
  const file = path.join(dir, "pi-provider-antigravity.json");
  fs.writeFileSync(file, JSON.stringify({ settings: { quotaFooter: "all" }, states: { other: { x: 1 } } }));
  const store = fileQuotaStatusStore(file);

  assert.equal(store.loadMode(), "all");
  assert.equal(store.loadQuotaState(), undefined);
  assert.equal(store.saveQuotaState({ weeklyTo5hRatio: 4, previousObservation: {}, updatedAt: 1 }), true);

  const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(saved.settings.quotaFooter, "all"); // settings preserved
  assert.deepEqual(saved.states.other, { x: 1 }); // sibling entries preserved
  assert.equal(saved.states.quota.weeklyTo5hRatio, 4);
});

test("fileQuotaStatusStore: garbage file is never clobbered", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-store-"));
  const file = path.join(dir, "pi-provider-antigravity.json");
  fs.writeFileSync(file, "{oops");
  const store = fileQuotaStatusStore(file);

  assert.equal(store.loadMode(), "off");
  assert.equal(store.loadQuotaState(), undefined);
  assert.equal(store.saveQuotaState({ weeklyTo5hRatio: 4, previousObservation: {}, updatedAt: 1 }), false);
  assert.equal(fs.readFileSync(file, "utf-8"), "{oops"); // untouched
});

test("Preview renders the footer sample per mode", async () => {
  const lowQuotaJson = structuredClone(quotaJson);
  const setBucket = (group, bucketId, fraction) => {
    lowQuotaJson.groups
      .find((g) => g.displayName === group)
      .buckets.find((b) => b.bucketId === bucketId).remainingFraction = fraction;
  };
  setBucket("Gemini Models", "gemini-5h", 0.22);
  setBucket("Gemini Models", "gemini-weekly", 0.87);
  setBucket("Claude and GPT models", "3p-5h", 0.84);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /retrieveUserQuotaSummary/);
    return { ok: true, json: async () => lowQuotaJson };
  };
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-set-"));
    const file = path.join(dir, "pi-provider-antigravity.json");
    fs.writeFileSync(file, JSON.stringify({ settings: { quotaFooter: "smart" } }));
    const coord = createQuotaStatus({ configFile: file });
    await coord.ensurePreview(makeCtx([]));
    const field = coord.createSettingsField();
    assert.match(field.renderPreview("smart", makeCtx([])), /5h 22%/);
    assert.match(field.renderPreview("all", makeCtx([])), /Wk 87%/);
    assert.match(field.renderPreview("smart", { ...makeCtx([]), model: { id: "claude-sonnet-4-6", provider: "antigravity" } }), /5h 84%/);
    assert.equal(field.renderPreview("off", makeCtx([])), "hidden");
    const fresh = createQuotaStatus({ configFile: file });
    assert.equal(fresh.createSettingsField().renderPreview("smart", makeCtx([])), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

