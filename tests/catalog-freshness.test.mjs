import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { refreshCatalog, refreshCatalogGeneration } from "../src/catalog-refresh.ts";

const modelsJson = JSON.parse(fs.readFileSync("captures/agy_cli_1.1.26/models.resp.json", "utf-8"));
const credential = { access: JSON.stringify({ token: "t", projectId: "p" }) };

function doRefresh() {
  return refreshCatalog({ allowNetwork: true, credential, stored: {} });
}

// Order matters: this file starts with no ingested generation behind the
// catalog seam, so the failed case must run first — afterwards a generation
// is retained for the rest of the file.
test("Catalog freshness seam: failed when nothing is retained", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  try {
    const { status, catalog } = await refreshCatalogGeneration(doRefresh);
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
    const { status, catalog } = await refreshCatalogGeneration(doRefresh);
    assert.equal(status, "fresh");
    assert.ok(catalog && catalog.models.length > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog freshness seam: stale keeps the retained generation", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  try {
    const { status, catalog } = await refreshCatalogGeneration(doRefresh);
    assert.equal(status, "stale");
    assert.ok(catalog && catalog.models.length > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
