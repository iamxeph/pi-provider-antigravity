import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { newestCapture } from "./fixtures.mjs";
import os from "node:os";
import path from "node:path";
import {
  applySettingValue,
  buildSettingsItems,
  defaultConfigFile,
  FOOTER_MODE_NOTES,
  FOOTER_MODES,
  loadProviderConfig,
  normalizeFooterMode,
  previewQuotaFooterText,
  resolveFooterMode,
  saveSettingValue,
  SETTINGS_FIELDS,
  QuotaStatusCoordinator,
  fileQuotaStatusStore,
} from "../src/quota-status.ts";
import { runAntigravitySubcommand } from "../src/commands.ts";
import { createCatalogStore } from "../src/model-catalog.ts";

function makeConf(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-set-"));
  const file = path.join(dir, "pi-provider-antigravity.json");
  fs.writeFileSync(file, JSON.stringify(settings === undefined ? {} : { settings }));
  return file;
}

function stubFetchRouter(payload) {
  return async (url) => {
    assert.match(String(url), /retrieveUserQuotaSummary/);
    return { ok: true, json: async () => payload };
  };
}

const quotaJson = JSON.parse(fs.readFileSync(newestCapture("quota.resp.json"), "utf-8"));
// Preview and threshold tests need a deterministic low window: the live capture holds
// whatever the account happened to have that day (99% here, which renders plain — no
// threshold color to assert). Clone the capture's shape and pin the numbers the sample
// logic is about.
const lowQuotaJson = structuredClone(quotaJson);
const setBucket = (group, bucketId, fraction) => {
  lowQuotaJson.groups
    .find((g) => g.displayName === group)
    .buckets.find((b) => b.bucketId === bucketId).remainingFraction = fraction;
};
setBucket("Gemini Models", "gemini-5h", 0.22);
setBucket("Gemini Models", "gemini-weekly", 0.87);
setBucket("Claude and GPT models", "3p-5h", 0.84);

function makeCtx(outputs, { authed = true } = {}) {
  return {
    hasUI: true,
    mode: "tui",
    ui: {
      notify: (msg) => outputs.push(String(msg)),
      setStatus: (k, v) => outputs.push(`[${k}] ${v}`),
      custom: async (factory) => {
        factories.push(factory);
      },
    },
    model: { id: "gemini-3-flash", provider: "antigravity" },
    modelRegistry: {
      getApiKeyForProvider: async () =>
        authed ? JSON.stringify({ token: "test-token", projectId: "test-project" }) : undefined,
    },
  };
}

const factories = [];
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("Footer mode: settings.quotaFooter or off", () => {
  assert.equal(resolveFooterMode(undefined), "off");
  assert.equal(resolveFooterMode({}), "off");
  assert.equal(resolveFooterMode({ settings: { quotaFooter: " ALL " } }), "all");
  assert.equal(resolveFooterMode({ settings: { quotaFooter: "smart" } }), "smart");
  assert.equal(resolveFooterMode({ settings: { quotaFooter: "everything" } }), "off");
  assert.equal(resolveFooterMode({ settings: {} }), "off");
  assert.equal(normalizeFooterMode(42), undefined);
});

test("Footer mode table: SETTINGS_FIELDS derives options from FOOTER_MODES and notes from FOOTER_MODE_NOTES", () => {
  const quotaField = SETTINGS_FIELDS.find((f) => f.key === "quotaFooter");
  assert.ok(quotaField);
  assert.deepEqual(quotaField.options, Object.keys(FOOTER_MODES));
  assert.deepEqual(quotaField.optionNotes, FOOTER_MODE_NOTES);
});

test("File config: default path mirrors Pi, garbage is unconfigured", () => {
  assert.match(defaultConfigFile({ PI_CODING_AGENT_DIR: "/tmp/x" }), /\/tmp\/x\/pi-provider-antigravity\.json$/);
  assert.match(defaultConfigFile({}), /\.pi\/agent\/pi-provider-antigravity\.json$/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-conf-"));
  const file = path.join(dir, "pi-provider-antigravity.json");
  assert.equal(loadProviderConfig(file), undefined); // missing
  fs.writeFileSync(file, JSON.stringify({ settings: { quotaFooter: "all" }, other: 1 }));
  assert.deepEqual(loadProviderConfig(file), { settings: { quotaFooter: "all" }, other: 1 });
  assert.equal(resolveFooterMode(loadProviderConfig(file)), "all");
  fs.writeFileSync(file, "{oops");
  assert.equal(loadProviderConfig(file), undefined);
  fs.writeFileSync(file, "[1,2]");
  assert.equal(loadProviderConfig(file), undefined);
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

// The sibling of the quota writer's guard: both writers go through the same
// rule, so an unreadable file (the file users are told to hand-edit) is never
// overwritten by either of them.
test("saveSettingValue: garbage file is never clobbered and reports failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-set-garbage-"));
  const file = path.join(dir, "pi-provider-antigravity.json");
  const handEdited = `{\n  // my note\n  "settings": { "quotaFooter": "all" },\n  "states": { "quota": { "weeklyTo5hRatio": 6.4 } }\n}\n`;
  fs.writeFileSync(file, handEdited);

  assert.equal(saveSettingValue(SETTINGS_FIELDS[0], "off", file), false);
  assert.equal(fs.readFileSync(file, "utf-8"), handEdited); // untouched
});

// One file, two writers: neither section may be lost by the other's write, in
// either order (settings first on a fresh file, then the quota state on top).
test("File config: settings and quota state survive each other's writes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-both-"));
  const file = path.join(dir, "pi-provider-antigravity.json");
  const store = fileQuotaStatusStore(file);
  const quotaState = { weeklyTo5hRatio: 4, previousObservation: {}, updatedAt: 1 };

  assert.equal(saveSettingValue(SETTINGS_FIELDS[0], "all", file), true); // creates the file
  assert.equal(store.saveQuotaState(quotaState), true);
  assert.equal(loadProviderConfig(file).settings.quotaFooter, "all");
  assert.equal(store.loadQuotaState().weeklyTo5hRatio, 4);

  assert.equal(saveSettingValue(SETTINGS_FIELDS[0], "smart", file), true);
  assert.equal(loadProviderConfig(file).settings.quotaFooter, "smart");
  assert.equal(store.loadQuotaState().weeklyTo5hRatio, 4); // quota state kept

  // Atomic write leaves no scratch file behind.
  assert.deepEqual(fs.readdirSync(dir), ["pi-provider-antigravity.json"]);
});

// A refused write must not look like a success: the dialog keeps the file as it
// is and tells the user, instead of rendering a value the file never received.
test("TUI dialog reports a refused write instead of faking success", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agent-garbage-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const file = path.join(dir, "pi-provider-antigravity.json");
    fs.writeFileSync(file, "{oops"); // hand-edited into invalid JSON
    const outputs = [];
    factories.length = 0;
    // No quotaStatus: the preview path would fetch, and this case is about the write.
    await runAntigravitySubcommand("settings", makeCtx(outputs), undefined, createCatalogStore());
    const list = await factories[0](
      { requestRender() {} },
      { fg: (c, s) => s, bold: (s) => s },
      {},
      () => {},
    );

    list.handleInput("\r"); // off → smart
    await flush();
    await flush();

    assert.match(outputs.join("\n"), /Failed to write .*pi-provider-antigravity\.json/);
    assert.match(outputs.join("\n"), /fix or delete it/); // recovery, not just refusal
    // The row must not keep showing the value the file refused.
    assert.match(list.render(80).join("\n"), /Quota footer\s+off/);
    assert.equal(fs.readFileSync(file, "utf-8"), "{oops"); // untouched
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test("Settings items carry current values and options", () => {
  const items = buildSettingsItems({ settings: { quotaFooter: "all" } });
  assert.deepEqual(items, [
    { id: "quotaFooter", label: "Quota footer", description: "Show remaining quota in Pi's status footer", currentValue: "all", values: ["off", "smart", "all"] },
  ]);
  assert.deepEqual(buildSettingsItems(undefined)[0].currentValue, "off");
});

test("Preview renders the footer sample per mode", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchRouter(lowQuotaJson);
  try {
    const coord = new QuotaStatusCoordinator(fileQuotaStatusStore(makeConf({ quotaFooter: "smart" })));
    await coord.ensurePreview(makeCtx([]));
    assert.match(previewQuotaFooterText(coord, "gemini-3-flash", "smart"), /5h 22%/);
    assert.match(previewQuotaFooterText(coord, "gemini-3-flash", "all"), /Wk 87%/);
    assert.match(previewQuotaFooterText(coord, "claude-sonnet-4-6", "smart"), /5h 84%/);
    assert.equal(previewQuotaFooterText(coord, "gemini-3-flash", "off"), undefined);
    assert.equal(previewQuotaFooterText(undefined, "gemini-3-flash", "smart"), undefined);
    const fresh = new QuotaStatusCoordinator(fileQuotaStatusStore(makeConf({ quotaFooter: "smart" })));
    assert.equal(previewQuotaFooterText(fresh, "gemini-3-flash", "smart"), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("TUI dialog cycles the value with the real SettingsList", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchRouter(lowQuotaJson);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agent-"));
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const file = path.join(dir, "pi-provider-antigravity.json");
      const coord = new QuotaStatusCoordinator(fileQuotaStatusStore(file));
      const outputs = [];
      factories.length = 0;
      await runAntigravitySubcommand("settings", makeCtx(outputs), coord, createCatalogStore());
      assert.equal(factories.length, 1);

      let renders = 0;
      let closed = 0;
      const list = await factories[0](
        { requestRender() { renders++; } },
        { fg: (c, s) => `<${c}>${s}</>`, bold: (s) => `*${s}*` },
        {},
        () => { closed++; },
      );
      assert.match(list.render(80).join("\n"), /Quota footer/);
      assert.match(list.render(80).join("\n"), /→.*Quota footer/); // Pi-native cursor
      assert.match(list.render(80).join("\n"), /<accent>/); // fallback theme roles apply
      assert.match(list.render(80).join("\n"), /Show remaining quota in Pi's status footer/);
      assert.match(list.render(80).join("\n"), /hidden/); // off-mode preview

      list.handleInput("\r"); // off → smart
      await flush();
      await flush();
      assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).settings.quotaFooter, "smart");
      assert.match(list.render(80).join("\n"), /smart/);
      assert.match(list.render(80).join("\n"), /5h 22%/); // live preview in description
      // smart's selection logic is spelled out in the dialog, not just the sample
      const rendered = list.render(80).join("\n").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
      assert.match(rendered, /weighting the weekly pool by a ratio learned from your usage/);

      // The colorized sample ends with an fg reset, so the note must own its own
      // line: appended after the sample it would lose the description color.
      const ansiList = await factories[0](
        { requestRender() {} },
        { fg: (c, s) => `\x1b[38;5;240m${s}\x1b[39m`, bold: (s) => s }, // real Theme.fg shape
        {},
        () => {},
      );
      const noteLine = ansiList.render(200).find((l) => l.includes("weighting the weekly pool by a ratio"));
      assert.ok(noteLine?.startsWith("\x1b[38;5;240m"), "note keeps the description color");
      assert.ok(!noteLine.includes("5h 22%"), "note is not appended after the colorized sample");

      // The sample drops the description color so it reads like the footer:
      // plain foreground for healthy windows, yellow/red only for low ones.
      const smartLine = ansiList.render(200).find((l) => l.includes("Show remaining quota"));
      assert.match(smartLine, /\x1b\[39m\x1b\[33m5h 22%/, "sample keeps the footer's threshold color, not dim");

      ansiList.handleInput("\r"); // smart → all
      await flush();
      await flush();
      const allLine = ansiList.render(200).find((l) => l.includes("Show remaining quota"));
      assert.match(allLine, /\x1b\[39m · Wk/, "healthy window stays plain like the footer's");
      assert.ok(!/\x1b\[38;5;240m · Wk/.test(allLine), "no description color inside the sample");
      assert.match(outputs.join("\n"), /\[pi-provider-antigravity-footer-usage\].*5h 22%/);
      assert.ok(renders > 0);

      list.handleInput("\x1b");
      assert.equal(closed, 1);
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Settings preview samples quota while another provider's model is selected", async () => {
  const realFetch = globalThis.fetch;
  const counter = { calls: 0 };
  globalThis.fetch = async (url) => {
    counter.calls++;
    assert.match(String(url), /retrieveUserQuotaSummary/);
    return { ok: true, json: async () => lowQuotaJson };
  };
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agent-"));
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const file = path.join(dir, "pi-provider-antigravity.json");
      const outputs = [];
      const ctx = makeCtx(outputs);
      ctx.model = { id: "deepseek-flash", provider: "opencode-go" };
      factories.length = 0;
      await runAntigravitySubcommand("settings", ctx, new QuotaStatusCoordinator(fileQuotaStatusStore(file)), createCatalogStore());
      const list = await factories[0]({ requestRender() {} }, { fg: (c, s) => `<${c}>${s}</>`, bold: (s) => `*${s}*` }, {}, () => {});
      assert.equal(counter.calls, 1); // opening the dialog fetches despite the foreign model
      assert.match(list.render(80).join("\n"), /hidden/); // off-mode preview

      list.handleInput("\r"); // off → smart
      await flush();
      await flush();
      assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).settings.quotaFooter, "smart");
      assert.match(list.render(80).join("\n"), /5h 22%/); // real sample, same cache
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Settings rows follow the field definitions", async () => {
  const probe = { key: "probe", label: "Probe", options: ["a", "b"], defaultValue: "a" };
  const items = buildSettingsItems({ settings: { quotaFooter: "all" } }, [...SETTINGS_FIELDS, probe]);
  const text = items.map((i) => `${i.label}: ${i.currentValue}`).join("\n");
  assert.match(text, /Quota footer: all/);
  assert.match(text, /Probe: a/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agent-"));
  const file = path.join(dir, "pi-provider-antigravity.json");
  assert.equal(await applySettingValue(probe, "b", file, {}, undefined), true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).settings.probe, "b");
});

test("TUI dialog frames the list with border lines like /settings", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchRouter(lowQuotaJson);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agent-"));
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const file = path.join(dir, "pi-provider-antigravity.json");
      const outputs = [];
      factories.length = 0;
      await runAntigravitySubcommand("settings", makeCtx(outputs), new QuotaStatusCoordinator(fileQuotaStatusStore(file)), createCatalogStore());
      const comp = await factories[0]({ requestRender() {} }, { fg: (c, s) => `<${c}>${s}</>`, bold: (s) => `*${s}*` }, {}, () => {});
      const lines = comp.render(80);
      assert.match(lines[0], /<border>─+<\/>/); // top border, pi /settings parity
      assert.match(lines[lines.length - 1], /<border>─+<\/>/); // bottom border
      assert.match(lines.join("\n"), /Quota footer/); // list still inside the frame
      comp.handleInput("\r"); // wrapper delegates to the inner SettingsList
      await flush();
      await flush();
      assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).settings.quotaFooter, "smart");
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
