import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAntigravitySubcommand } from "../src/commands.ts";
import { refreshCatalog } from "../src/catalog-refresh.ts";
import initExtension from "../src/index.ts";
import { QuotaStatusCoordinator } from "../src/quota-status.ts";
import { fileQuotaStatusStore } from "../src/settings.ts";

const quotaJson = JSON.parse(fs.readFileSync("captures/agy_cli_1.2.0/quota.resp.json", "utf-8"));
// Fixture-derived: the capture rotates every agy release, the command plumbing does not.
const gemini5hBucket = quotaJson.groups
  .find((g) => g.displayName === "Gemini Models")
  .buckets.find((b) => b.bucketId === "gemini-5h");
const gemini5h = String(Math.round(gemini5hBucket.remainingFraction * 100));
const modelsJson = JSON.parse(fs.readFileSync("captures/agy_cli_1.2.0/models.resp.json", "utf-8"));

function stubFetchRouter() {
  return async (url) => {
    const u = String(url);
    if (u.includes("retrieveUserQuotaSummary")) return { ok: true, json: async () => quotaJson };
    if (u.includes("fetchAvailableModels")) return { ok: true, json: async () => modelsJson };
    throw new Error(`unexpected fetch: ${u}`);
  };
}

function memStore(mode = "smart") {
  return {
    loadMode: () => mode,
    loadQuotaState: () => undefined,
    saveQuotaState: () => true,
  };
}

function makeCtx(outputs, { authed = true, refresh, hasUI = true, mode, selectImpl, customImpl } = {}) {
  return {
    hasUI,
    mode,
    ui: {
      notify: (msg) => outputs.push(String(msg)),
      setStatus: (k, v) => outputs.push(`[${k}] ${v}`),
      select: async (title, options) => (selectImpl ? selectImpl(title, options) : undefined),
      custom: async (factory) => (customImpl ? customImpl(factory) : undefined),
    },
    model: { id: "gemini-3-flash", provider: "antigravity" },
    modelRegistry: {
      getApiKeyForProvider: async () =>
        authed ? JSON.stringify({ token: "test-token", projectId: "test-project" }) : undefined,
      ...(refresh ? { refresh } : {}),
    },
  };
}

test("Subcommand: usage prints Quota Pool groups", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchRouter();
  try {
    const outputs = [];
    await runAntigravitySubcommand("usage", makeCtx(outputs), new QuotaStatusCoordinator(memStore()));
    const all = outputs.join("\n");
    assert.match(all, /Fetching quota summary/);
    assert.match(all, /Gemini Models/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Order matters: this runs before any ingesting test in this file, so no
// generation sits behind the catalog seam yet and the failure must surface.
test("Subcommand: models without a cached generation reports fetch failure", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  try {
    const outputs = [];
    const ctx = makeCtx(outputs, {
      refresh: async () =>
        refreshCatalog({
          allowNetwork: true,
          credential: { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) },
          stored: {},
        }),
    });
    await runAntigravitySubcommand("models", ctx);
    assert.match(outputs.join("\n"), /Failed to fetch models/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Subcommand: models prints Model Catalog", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchRouter();
  try {
    const outputs = [];
    const refreshCalls = [];
    const ctx = makeCtx(outputs, {
      refresh: async (opts) => {
        refreshCalls.push(opts);
        await refreshCatalog({
          allowNetwork: true,
          credential: { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) },
          stored: {},
        });
      },
    });
    await runAntigravitySubcommand("models", ctx);
    assert.equal(refreshCalls.length, 1);
    assert.deepEqual(refreshCalls[0].providers, ["antigravity"]);
    assert.match(outputs.join("\n"), /Available Antigravity Models/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Subcommand: models shows the retained list with a warning when refresh fails", async () => {
  const realFetch = globalThis.fetch;
  const credential = { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) };
  try {
    // Prime one generation through the real refresh path first (self-contained:
    // does not rely on other tests having ingested anything).
    globalThis.fetch = stubFetchRouter();
    await refreshCatalog({ allowNetwork: true, credential, stored: {} });
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
    const outputs = [];
    const ctx = makeCtx(outputs, {
      refresh: async () => refreshCatalog({ allowNetwork: true, credential, stored: {} }),
    });
    await runAntigravitySubcommand("models", ctx);
    const all = outputs.join("\n");
    assert.match(all, /showing last known list/);
    assert.match(all, /Available Antigravity Models/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Subcommand: fetch twins share the auth guard", async () => {
  const outputs = [];
  await runAntigravitySubcommand("usage", makeCtx(outputs, { authed: false }));
  assert.match(outputs.join("\n"), /Not logged in/);
});

test("Subcommand: refresh delegates to the model registry", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchRouter();
  try {
    const calls = [];
    const outputs = [];
    const ctx = makeCtx(outputs, {
      refresh: async (opts) => {
        calls.push(opts);
        await refreshCatalog({
          allowNetwork: true,
          credential: { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) },
          stored: {},
        });
      },
    });
    await runAntigravitySubcommand("refresh", ctx);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].providers, ["antigravity"]);
    assert.match(outputs.join("\n"), /refreshed successfully/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Subcommand: refresh warns but keeps the retained list when refresh fails", async () => {
  const realFetch = globalThis.fetch;
  const credential = { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) };
  try {
    // Prime one generation through the real refresh path first.
    globalThis.fetch = stubFetchRouter();
    await refreshCatalog({ allowNetwork: true, credential, stored: {} });
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
    const calls = [];
    const outputs = [];
    const ctx = makeCtx(outputs, {
      refresh: async (opts) => {
        calls.push(opts);
        await refreshCatalog({ allowNetwork: true, credential, stored: {} });
      },
    });
    await runAntigravitySubcommand("refresh", ctx);
    assert.equal(calls.length, 1);
    assert.match(outputs.join("\n"), /keeping last known list/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Subcommand: settings picks mode in a dialog and applies it", async () => {
  await withAgentDir(async (dir) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = stubFetchRouter();
    try {
      const file = path.join(dir, "pi-provider-antigravity.json");
      fs.writeFileSync(file, JSON.stringify({ states: { quota: { weeklyTo5hRatio: 4 } } }));
      const seen = [];
      const selectImpl = async (title, options) => {
        seen.push([title, options]);
        return "smart";
      };
      const coord = new QuotaStatusCoordinator(fileQuotaStatusStore(file));
      const outputs = [];
      await runAntigravitySubcommand("settings", makeCtx(outputs, { selectImpl }), coord);
      assert.deepEqual(seen, [["Quota footer (current: off)", ["off", "smart", "all"]]]);
      const all = outputs.join("\n");
      assert.match(all, /Quota footer set to smart\./);
      assert.match(all, new RegExp(`\\[pi-provider-antigravity-footer-usage\\].*5h ${gemini5h}`));
      const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
      assert.equal(saved.settings.quotaFooter, "smart");
      assert.equal(saved.states.quota.weeklyTo5hRatio, 4); // state preserved
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("Subcommand: settings dismiss changes nothing", async () => {
  await withAgentDir(async (dir) => {
    const file = path.join(dir, "pi-provider-antigravity.json");
    const outputs = [];
    await runAntigravitySubcommand("settings", makeCtx(outputs), new QuotaStatusCoordinator(fileQuotaStatusStore(file)));
    assert.equal(outputs.length, 0);
    assert.equal(fs.existsSync(file), false);
  });
});

test("Subcommand: settings without UI prints text", async () => {
  await withAgentDir(async () => {
    let called = false;
    const logs = [];
    const originalLog = console.log;
    console.log = (msg) => logs.push(String(msg));
    try {
      const ctx = makeCtx([], {
        hasUI: false,
        selectImpl: async () => {
          called = true;
          return "all";
        },
      });
      await runAntigravitySubcommand("settings", ctx);
    } finally {
      console.log = originalLog;
    }
    assert.equal(called, false);
    const all = logs.join("\n");
    assert.match(all, /Quota footer: off/);
    assert.match(all, /Edit .*pi-provider-antigravity\.json to change/);
  });
});

test("Subcommand: settings opens the cycling dialog in TUI mode", async () => {
  await withAgentDir(async (dir) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = stubFetchRouter();
    try {
      const file = path.join(dir, "pi-provider-antigravity.json");
      let factory;
      const outputs = [];
      const ctx = makeCtx(outputs, { mode: "tui", customImpl: async (f) => { factory = f; } });
      await runAntigravitySubcommand("settings", ctx, new QuotaStatusCoordinator(fileQuotaStatusStore(file)));
      assert.ok(factory);
      let closed = 0;
      const comp = await factory({ requestRender() {} }, { fg: (c, s) => s, bold: (s) => s }, {}, () => { closed++; });
      assert.match(comp.render(80).join("\n"), /Quota footer/);
      comp.handleInput("\x1b");
      assert.equal(closed, 1);
      // Open + esc writes no settings (preview state may persist).
      assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).settings, undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("Subcommand: setting is an alias of settings", async () => {
  await withAgentDir(async () => {
    const seen = [];
    const outputs = [];
    const selectImpl = async (title, options) => {
      seen.push([title, options]);
      return undefined;
    };
    await runAntigravitySubcommand("setting", makeCtx(outputs, { selectImpl }));
    assert.equal(seen.length, 1);
    assert.match(seen[0][0], /Quota footer/);
  });
});

test("Command: tab completion offers subcommands", () => {
  let def;
  const mockPi = {
    registerProvider: () => {},
    on: () => {},
    registerCommand: (name, d) => {
      if (name === "antigravity") def = d;
    },
  };
  initExtension(mockPi);
  assert.ok(def.getArgumentCompletions);
  assert.deepEqual(
    def.getArgumentCompletions("").map((i) => i.value),
    ["usage", "models", "refresh", "settings", "login"],
  );
  assert.deepEqual(def.getArgumentCompletions("set").map((i) => i.value), ["settings"]);
  assert.deepEqual(def.getArgumentCompletions("x"), []);
  assert.equal(def.getArgumentCompletions("set x"), null);
});

test("Subcommand: unknown subcommand shows usage", async () => {
  const outputs = [];
  await runAntigravitySubcommand("bogus", makeCtx(outputs));
  assert.match(outputs.join("\n"), /Usage: \/antigravity/);
});

test("Subcommand: usage feeds the shared cache and footer", async () => {
  await withAgentDir(async (dir) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = stubFetchRouter();
    try {
      const file = path.join(dir, "pi-provider-antigravity.json");
      fs.writeFileSync(file, JSON.stringify({ settings: { quotaFooter: "smart" } }));
      const coord = new QuotaStatusCoordinator(fileQuotaStatusStore(file));
      const outputs = [];
      await runAntigravitySubcommand("usage", makeCtx(outputs), coord);
      const all = outputs.join("\n");
      assert.match(all, /Gemini Models/); // full quota text still printed
      assert.match(all, new RegExp(`\\[pi-provider-antigravity-footer-usage\\].*5h ${gemini5h}`)); // footer repainted from the same fetch
      const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
      assert.equal(saved.states.quota.previousObservation["gemini"]["5h"], gemini5hBucket.remainingFraction);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

async function withAgentDir(fn) {
  const prev = process.env.PI_CODING_AGENT_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
}

test("Subcommand: settings picks the value via select fallback", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchRouter();
  try {
    await withAgentDir(async (dir) => {
      const file = path.join(dir, "pi-provider-antigravity.json");
      const calls = [];
      const selectImpl = async (title, options) => {
        calls.push([title, options]);
        return "smart";
      };
      const outputs = [];
      await runAntigravitySubcommand(
        "settings",
        makeCtx(outputs, { selectImpl }),
        new QuotaStatusCoordinator(fileQuotaStatusStore(file)),
      );
      assert.deepEqual(calls, [["Quota footer (current: off)", ["off", "smart", "all"]]]);
      const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
      assert.equal(saved.settings.quotaFooter, "smart");
      assert.match(outputs.join("\n"), /Quota footer set to smart\./);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
