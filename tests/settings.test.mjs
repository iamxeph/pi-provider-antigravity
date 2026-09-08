import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applySettingValue, buildSettingsItems, defaultConfigFile, fileQuotaStatusStore, loadProviderConfig, normalizeFooterMode, previewQuotaFooterText, resolveFooterMode, SETTINGS_FIELDS } from "../src/settings.ts";
import { runAntigravitySubcommand } from "../src/commands.ts";
import { QuotaStatusCoordinator } from "../src/usage-status.ts";

function makeConf(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-set-"));
  const file = path.join(dir, "pi-provider-antigravity.json");
  fs.writeFileSync(file, JSON.stringify(settings === undefined ? {} : { settings }));
  return file;
}

function stubFetchRouter(quotaJson) {
  return async (url) => {
    assert.match(String(url), /retrieveUserQuotaSummary/);
    return { ok: true, json: async () => quotaJson };
  };
}

const quotaJson = JSON.parse(fs.readFileSync("captures/agy_cli_1.1.26/quota.resp.json", "utf-8"));

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
  assert.equal(resolveFooterMode({ settings: { quotaFooter: " BOTH " } }), "both");
  assert.equal(resolveFooterMode({ settings: { quotaFooter: "single" } }), "single");
  assert.equal(resolveFooterMode({ settings: { quotaFooter: "everything" } }), "off");
  assert.equal(resolveFooterMode({ settings: {} }), "off");
  assert.equal(normalizeFooterMode(42), undefined);
});

test("File config: default path mirrors Pi, garbage is unconfigured", () => {
  assert.match(defaultConfigFile({ PI_CODING_AGENT_DIR: "/tmp/x" }), /\/tmp\/x\/pi-provider-antigravity\.json$/);
  assert.match(defaultConfigFile({}), /\.pi\/agent\/pi-provider-antigravity\.json$/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-conf-"));
  const file = path.join(dir, "pi-provider-antigravity.json");
  assert.equal(loadProviderConfig(file), undefined); // missing
  fs.writeFileSync(file, JSON.stringify({ settings: { quotaFooter: "both" }, other: 1 }));
  assert.deepEqual(loadProviderConfig(file), { settings: { quotaFooter: "both" }, other: 1 });
  assert.equal(resolveFooterMode(loadProviderConfig(file)), "both");
  fs.writeFileSync(file, "{oops");
  assert.equal(loadProviderConfig(file), undefined);
  fs.writeFileSync(file, "[1,2]");
  assert.equal(loadProviderConfig(file), undefined);
});

test("Settings items carry current values and options", () => {
  const items = buildSettingsItems({ settings: { quotaFooter: "both" } });
  assert.deepEqual(items, [
    { id: "quotaFooter", label: "Quota footer", description: "Show remaining quota in the footer", currentValue: "both", values: ["off", "single", "both"] },
  ]);
  assert.deepEqual(buildSettingsItems(undefined)[0].currentValue, "off");
});

test("Preview renders the footer sample per mode", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchRouter(quotaJson);
  try {
    const coord = new QuotaStatusCoordinator(fileQuotaStatusStore(makeConf({ quotaFooter: "single" })));
    await coord.ensurePreview(makeCtx([]));
    assert.match(previewQuotaFooterText(coord, "gemini-3-flash", "single"), /5h 22%/);
    assert.match(previewQuotaFooterText(coord, "gemini-3-flash", "both"), /Wk 87%/);
    assert.match(previewQuotaFooterText(coord, "claude-sonnet-4-6", "single"), /5h 84%/);
    assert.equal(previewQuotaFooterText(coord, "gemini-3-flash", "off"), undefined);
    assert.equal(previewQuotaFooterText(undefined, "gemini-3-flash", "single"), undefined);
    const fresh = new QuotaStatusCoordinator(fileQuotaStatusStore(makeConf({ quotaFooter: "single" })));
    assert.equal(previewQuotaFooterText(fresh, "gemini-3-flash", "single"), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("TUI dialog cycles the value with the real SettingsList", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchRouter(quotaJson);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agent-"));
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const file = path.join(dir, "pi-provider-antigravity.json");
      const coord = new QuotaStatusCoordinator(fileQuotaStatusStore(file));
      const outputs = [];
      factories.length = 0;
      await runAntigravitySubcommand("settings", makeCtx(outputs), coord);
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
      assert.match(list.render(80).join("\n"), /Show remaining quota in the footer/);
      assert.match(list.render(80).join("\n"), /hidden/); // off-mode preview

      list.handleInput("\r"); // off → single
      await flush();
      await flush();
      assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).settings.quotaFooter, "single");
      assert.match(list.render(80).join("\n"), /single/);
      assert.match(list.render(80).join("\n"), /5h 22%/); // live preview in description
      assert.match(outputs.join("\n"), /\[antigravity_quota\].*5h 22%/);
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

test("Settings rows follow the field definitions", async () => {
  const probe = { key: "probe", label: "Probe", options: ["a", "b"], defaultValue: "a" };
  const items = buildSettingsItems({ settings: { quotaFooter: "both" } }, [...SETTINGS_FIELDS, probe]);
  const text = items.map((i) => `${i.label}: ${i.currentValue}`).join("\n");
  assert.match(text, /Quota footer: both/);
  assert.match(text, /Probe: a/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agent-"));
  const file = path.join(dir, "pi-provider-antigravity.json");
  assert.equal(await applySettingValue(probe, "b", file, {}, undefined), true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).settings.probe, "b");
});

test("TUI dialog frames the list with border lines like /settings", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchRouter(quotaJson);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agent-"));
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const file = path.join(dir, "pi-provider-antigravity.json");
      const outputs = [];
      factories.length = 0;
      await runAntigravitySubcommand("settings", makeCtx(outputs), new QuotaStatusCoordinator(fileQuotaStatusStore(file)));
      const comp = await factories[0]({ requestRender() {} }, { fg: (c, s) => `<${c}>${s}</>`, bold: (s) => `*${s}*` }, {}, () => {});
      const lines = comp.render(80);
      assert.match(lines[0], /<border>─+<\/>/); // top border, pi /settings parity
      assert.match(lines[lines.length - 1], /<border>─+<\/>/); // bottom border
      assert.match(lines.join("\n"), /Quota footer/); // list still inside the frame
      comp.handleInput("\r"); // wrapper delegates to the inner SettingsList
      await flush();
      await flush();
      assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).settings.quotaFooter, "single");
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
