import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  refreshCatalog,
  getCatalogSnapshot,
} from "../src/catalog.ts";
import { parseAvailableModels } from "../src/catalog.ts";

const modelsJson = JSON.parse(fs.readFileSync("captures/agy_cli_1.1.26/models.resp.json", "utf-8"));

const storedModels = [{ id: "gemini-3.8-flash", name: "Cached" }];

test("Catalog refresh: offline returns stored models without fetching", async () => {
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("must not fetch offline");
  };
  try {
    const models = await refreshCatalog({
      allowNetwork: false,
      stored: { models: storedModels },
    });
    assert.deepEqual(models, storedModels);
    assert.equal(fetched, false);
    // Static fallback enums ship in the snapshot even before any refresh.
    assert.ok(getCatalogSnapshot().enums["gemini-3.8-flash-high"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog refresh: missing credential falls back to stored models", async () => {
  const models = await refreshCatalog({
    allowNetwork: true,
    credential: {},
    stored: { models: storedModels },
  });
  assert.deepEqual(models, storedModels);
});

test("Catalog refresh: stored enums and runtime IDs restore active state", async () => {
  const models = await refreshCatalog({
    allowNetwork: false,
    stored: {
      models: storedModels,
      "pi-provider-antigravity": {
        modelEnums: { "x-high": "ENUM_X" },
        runtimeIds: ["x-high"],
      },
    },
  });
  assert.deepEqual(models, storedModels);
  const snap = getCatalogSnapshot();
  assert.ok(snap.runtimeIds.includes("x-high"));
  assert.equal(snap.enums["x-high"], "ENUM_X");
});

test("Catalog refresh: fresh fetch builds dynamic models and publishes", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
  try {
    const published = [];
    const models = await refreshCatalog({
      allowNetwork: true,
      credential: { access: JSON.stringify({ token: "t", projectId: "p" }) },
      stored: {},
      publish: async (arg) => {
        published.push(arg);
      },
    });

    const expected = parseAvailableModels(modelsJson);
    assert.ok(models.length > 0, "fixture catalog must yield public models");
    assert.ok(models.every((m) => m.provider === "antigravity"));
    const snap = getCatalogSnapshot();
    assert.ok(snap.runtimeIds.length > 0, "active runtime IDs must populate");
    assert.ok(snap.version > 0, "refresh must bump the snapshot version");

    assert.equal(published.length, 1);
    const persist = published[0].persist;
    assert.deepEqual(persist.models, models);
    assert.equal(typeof persist.checkedAt, "number");
    assert.deepEqual(persist["pi-provider-antigravity"].modelEnums, expected.modelEnums);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog refresh: fetch failure falls back to stored models", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  try {
    const models = await refreshCatalog({
      allowNetwork: true,
      credential: { access: JSON.stringify({ token: "t", projectId: "p" }) },
      stored: { models: storedModels },
    });
    assert.deepEqual(models, storedModels);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog refresh: sequential refreshes evict stale enums", async () => {
  const realFetch = globalThis.fetch;
  const staleJson = {
    ...modelsJson,
    models: {
      ...modelsJson.models,
      "stale-model-high": { model: "MODEL_STALE", displayName: "Stale" },
    },
  };
  const credential = { access: JSON.stringify({ token: "t", projectId: "p" }) };
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => staleJson });
    await refreshCatalog({ allowNetwork: true, credential, stored: {} });
    assert.equal(getCatalogSnapshot().enums["stale-model-high"], "MODEL_STALE");

    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    await refreshCatalog({ allowNetwork: true, credential, stored: {} });
    const snap = getCatalogSnapshot();
    assert.ok(!("stale-model-high" in snap.enums), "stale enum must be evicted by the fresh generation");
    assert.ok(snap.runtimeIds.length > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog refresh: persisted state never clobbers a fresher snapshot", async () => {
  const realFetch = globalThis.fetch;
  const credential = { access: JSON.stringify({ token: "t", projectId: "p" }) };
  try {
    // Ensure the in-memory snapshot is non-pristine first (order-independent).
    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    await refreshCatalog({ allowNetwork: true, credential, stored: {} });
    assert.ok(getCatalogSnapshot().version > 0);

    await refreshCatalog({
      allowNetwork: false,
      stored: {
        models: storedModels,
        "pi-provider-antigravity": {
          modelEnums: { "stale-model-high": "MODEL_STALE" },
          runtimeIds: ["stale-model-high"],
        },
      },
    });
    const snap = getCatalogSnapshot();
    assert.ok(!("stale-model-high" in snap.enums), "older persisted data must not clobber the snapshot");
    assert.ok(snap.runtimeIds.length > 0, "fresher runtime IDs must survive");
  } finally {
    globalThis.fetch = realFetch;
  }
});
