import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  refreshCatalog,
  parseAvailableModels,
} from "../src/catalog-refresh.ts";
import {
  createCatalogStore,
  fromPersistedSnapshot,
  toPersistedSnapshot,
} from "../src/model-catalog.ts";

const modelsJson = JSON.parse(fs.readFileSync("captures/agy_cli_1.2.0/models.resp.json", "utf-8"));

const storedModels = [{ id: "gemini-3.8-flash", name: "Cached" }];

// The catalog seam is injected, so each test owns its store and none of them
// depends on what another one left behind.
const store = () => createCatalogStore();

test("Catalog refresh: offline returns stored models without fetching", async () => {
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("must not fetch offline");
  };
  try {
    const catalog = store();
    const models = await refreshCatalog({ allowNetwork: false, stored: { models: storedModels } }, catalog);
    assert.deepEqual(models, storedModels);
    assert.equal(fetched, false);
    // Before any refresh the generation is empty: enums come only from fetch or restore.
    assert.deepEqual(catalog.generation().snapshot.enums, {});
    assert.equal(catalog.generation().version, 0);
    assert.equal(catalog.generation().items, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog refresh: missing credential falls back to stored models", async () => {
  const catalog = store();
  const models = await refreshCatalog(
    { allowNetwork: true, credential: {}, stored: { models: storedModels } },
    catalog,
  );
  assert.deepEqual(models, storedModels);
  assert.equal(catalog.generation().version, 0);
});

test("Catalog refresh: stored enums and runtime IDs restore active state", async () => {
  const catalog = store();
  const models = await refreshCatalog({
    allowNetwork: false,
    stored: {
      models: storedModels,
      "pi-provider-antigravity": {
        modelEnums: { "x-high": "ENUM_X" },
        runtimeIds: ["x-high"],
        thinking: { "x-high": { budget: 4000, supportsThinking: true } },
        deprecated: { "old-high": "x-high" },
      },
    },
  }, catalog);
  assert.deepEqual(models, storedModels);
  const { snapshot, version, items } = catalog.generation();
  assert.deepEqual(snapshot.enums, { "x-high": "ENUM_X" });
  assert.deepEqual(snapshot.runtimeIds, ["x-high"]);
  assert.deepEqual(snapshot.thinking["x-high"], { budget: 4000, supportsThinking: true });
  assert.deepEqual(snapshot.deprecated, { "old-high": "x-high" });
  // A restore is not a fetch: nothing may read it as a new Catalog Generation.
  assert.equal(version, 0);
  assert.equal(items, undefined);
});

test("Catalog refresh: fresh fetch builds dynamic models and publishes", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
  try {
    const published = [];
    const catalog = store();
    const models = await refreshCatalog({
      allowNetwork: true,
      credential: { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) },
      stored: {},
      publish: async (arg) => {
        published.push(arg);
      },
    }, catalog);

    const expected = parseAvailableModels(modelsJson);
    assert.ok(models.length > 0, "fixture catalog must yield public models");
    assert.ok(models.every((m) => m.provider === "antigravity"));
    const { snapshot, items, version } = catalog.generation();
    assert.ok(snapshot.runtimeIds.length > 0, "active runtime IDs must populate");
    assert.equal(version, 1, "one recorded refresh is one generation");
    // The single seam retains the full generation the models table formats.
    assert.ok(items && items.models.length > 0, "record must retain the full catalog");
    assert.deepEqual(items.modelEnums, expected.modelEnums);

    assert.equal(published.length, 1);
    const persist = published[0].persist;
    assert.deepEqual(persist.models, models);
    assert.equal(typeof persist.checkedAt, "number");
    // The persisted entry is exactly the codec's output: the file shape is a
    // property of one function, not of this call site.
    assert.deepEqual(persist["pi-provider-antigravity"], toPersistedSnapshot(snapshot));
    assert.deepEqual(persist["pi-provider-antigravity"].modelEnums, expected.modelEnums);
    assert.equal(persist["pi-provider-antigravity"].thinking["gemini-3.7-flash-medium"].budget, 4000);
    assert.deepEqual(persist["pi-provider-antigravity"].deprecated, expected.deprecated);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog refresh: fetch failure falls back to stored models", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  try {
    const catalog = store();
    const models = await refreshCatalog({
      allowNetwork: true,
      credential: { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) },
      stored: { models: storedModels },
    }, catalog);
    assert.deepEqual(models, storedModels);
    assert.equal(catalog.generation().version, 0);
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
  const credential = { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) };
  try {
    const catalog = store();
    globalThis.fetch = async () => ({ ok: true, json: async () => staleJson });
    await refreshCatalog({ allowNetwork: true, credential, stored: {} }, catalog);
    assert.equal(catalog.generation().snapshot.enums["stale-model-high"], "MODEL_STALE");

    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    await refreshCatalog({ allowNetwork: true, credential, stored: {} }, catalog);
    const { snapshot, version } = catalog.generation();
    assert.ok(!("stale-model-high" in snapshot.enums), "stale enum must be evicted by the fresh generation");
    assert.ok(snapshot.runtimeIds.length > 0);
    assert.equal(version, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog refresh: persisted state never clobbers a fresher snapshot", async () => {
  const realFetch = globalThis.fetch;
  const credential = { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) };
  try {
    const catalog = store();
    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    await refreshCatalog({ allowNetwork: true, credential, stored: {} }, catalog);
    assert.equal(catalog.generation().version, 1);

    await refreshCatalog({
      allowNetwork: false,
      stored: {
        models: storedModels,
        "pi-provider-antigravity": {
          modelEnums: { "stale-model-high": "MODEL_STALE" },
          runtimeIds: ["stale-model-high"],
        },
      },
    }, catalog);
    const { snapshot, version } = catalog.generation();
    assert.ok(!("stale-model-high" in snapshot.enums), "older persisted data must not clobber the snapshot");
    assert.ok(snapshot.runtimeIds.length > 0, "fresher runtime IDs must survive");
    assert.equal(version, 1, "a restore must not bump the fetch counter");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog refresh: server-removed models evict uniformly, no pinned fallbacks", async () => {
  const realFetch = globalThis.fetch;
  const prunedJson = {
    ...modelsJson,
    models: { ...modelsJson.models },
  };
  delete prunedJson.models["gemini-3.6-flash-high"];
  const credential = { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) };
  try {
    const catalog = store();
    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    await refreshCatalog({ allowNetwork: true, credential, stored: {} }, catalog);
    assert.ok("gemini-3.6-flash-high" in catalog.generation().snapshot.enums);

    globalThis.fetch = async () => ({ ok: true, json: async () => prunedJson });
    await refreshCatalog({ allowNetwork: true, credential, stored: {} }, catalog);
    const { snapshot } = catalog.generation();
    assert.ok(!("gemini-3.6-flash-high" in snapshot.enums), "retired IDs must evict like any other");
    assert.ok(!snapshot.runtimeIds.includes("gemini-3.6-flash-high"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog Persistence codec: the file spelling round-trips, garbage restores as absent", () => {
  const snapshot = {
    enums: { "gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M18" },
    runtimeIds: ["gemini-3.8-flash-high"],
    thinking: { "gemini-3.8-flash-high": { budget: 4000, supportsThinking: true } },
    deprecated: { "gemini-3.1-pro-high": "gemini-pro-agent" },
  };
  const persisted = toPersistedSnapshot(snapshot);
  // The private entry names the snapshot's `enums` field `modelEnums`, and must
  // keep that spelling: installed providers already have it on disk (ADR-0004).
  assert.deepEqual(Object.keys(persisted).sort(), ["deprecated", "modelEnums", "runtimeIds", "thinking"]);
  assert.deepEqual(fromPersistedSnapshot(persisted), snapshot);

  // Nothing usable restores as absent, so the refresh path re-fetches instead of
  // resolving models against an empty catalog.
  assert.equal(fromPersistedSnapshot(undefined), undefined);
  assert.equal(fromPersistedSnapshot("nope"), undefined);
  assert.equal(fromPersistedSnapshot({}), undefined);
  assert.equal(fromPersistedSnapshot({ modelEnums: 42 }), undefined);
  // A malformed field restores empty rather than as garbage.
  assert.deepEqual(fromPersistedSnapshot({ modelEnums: { a: 1 }, runtimeIds: ["x", 2] }), {
    enums: {},
    runtimeIds: ["x"],
    thinking: {},
    deprecated: {},
  });
});
