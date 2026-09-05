import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runAntigravitySubcommand } from "../src/commands.ts";

const quotaJson = JSON.parse(fs.readFileSync("captures/agy_cli_1.1.26/quota.resp.json", "utf-8"));
const modelsJson = JSON.parse(fs.readFileSync("captures/agy_cli_1.1.26/models.resp.json", "utf-8"));

function stubFetchRouter() {
  return async (url) => {
    const u = String(url);
    if (u.includes("retrieveUserQuotaSummary")) return { ok: true, json: async () => quotaJson };
    if (u.includes("fetchAvailableModels")) return { ok: true, json: async () => modelsJson };
    throw new Error(`unexpected fetch: ${u}`);
  };
}

function makeCtx(outputs, { authed = true, refresh } = {}) {
  return {
    hasUI: true,
    ui: { notify: (msg) => outputs.push(String(msg)) },
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
    await runAntigravitySubcommand("usage", makeCtx(outputs));
    const all = outputs.join("\n");
    assert.match(all, /Fetching quota summary/);
    assert.match(all, /Gemini Models/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Subcommand: models prints Model Catalog", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetchRouter();
  try {
    const outputs = [];
    await runAntigravitySubcommand("models", makeCtx(outputs));
    assert.match(outputs.join("\n"), /Available Antigravity Models/);
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
  const calls = [];
  const outputs = [];
  const ctx = makeCtx(outputs, {
    refresh: async (opts) => {
      calls.push(opts);
    },
  });
  await runAntigravitySubcommand("refresh", ctx);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].providers, ["antigravity"]);
  assert.match(outputs.join("\n"), /refreshed successfully/);
});

test("Subcommand: unknown subcommand shows usage", async () => {
  const outputs = [];
  await runAntigravitySubcommand("bogus", makeCtx(outputs));
  assert.match(outputs.join("\n"), /Usage: \/antigravity/);
});
