import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { refreshCatalog, refreshCatalogGeneration } from "../src/catalog-refresh.ts";
import { createCatalogStore } from "../src/model-catalog.ts";

const modelsJson = JSON.parse(fs.readFileSync("captures/agy_cli_1.2.0/models.resp.json", "utf-8"));
const credential = { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) };

// Each case owns its store, so the freshness verdict is decided by this call
// alone — the pre-injection suite had to run `failed` first to mean anything.
function makeSeam() {
  const store = createCatalogStore();
  return {
    store,
    doRefresh: () => refreshCatalog({ allowNetwork: true, credential, stored: {} }, store),
  };
}

test("Catalog freshness seam: failed when nothing is retained", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  try {
    const { store, doRefresh } = makeSeam();
    const { status, catalog } = await refreshCatalogGeneration(store, doRefresh);
    assert.equal(status, "failed");
    assert.equal(catalog, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog freshness seam: fresh lands a new generation", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
  try {
    const { store, doRefresh } = makeSeam();
    const { status, catalog } = await refreshCatalogGeneration(store, doRefresh);
    assert.equal(status, "fresh");
    assert.ok(catalog && catalog.models.length > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog freshness seam: stale keeps the retained generation", async () => {
  const realFetch = globalThis.fetch;
  const { store, doRefresh } = makeSeam();
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    await refreshCatalogGeneration(store, doRefresh);

    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
    const { status, catalog } = await refreshCatalogGeneration(store, doRefresh);
    assert.equal(status, "stale");
    assert.ok(catalog && catalog.models.length > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
