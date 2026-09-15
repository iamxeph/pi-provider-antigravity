import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { newestCapture } from "./fixtures.mjs";
import {
  ALL_TIER_SUFFIXES,
  CANONICAL_TIER_SUFFIXES,
  classifyModelFamily,
  extractBaseModelId,
  isCompatibleFamily,
  SPECIAL_TIER_SUFFIXES,
  TIER_ALIASES,
  TIER_FALLBACKS,
  tierCandidateOrder,
  tierSpellings,
} from "../src/models.ts";
import {
  createModelCatalog,
  PRIVATE_SNAPSHOT_KEY,
} from "../src/model-catalog.ts";
import { buildAntigravityRequestBody } from "../src/builder.ts";

const modelsJson = JSON.parse(fs.readFileSync(newestCapture("models.resp.json"), "utf-8"));
const TEST_CREDENTIAL = { type: "oauth", access: JSON.stringify({ token: "test-token", projectId: "test-project" }) };

test("Seam 3: parseAvailableModels extracts models and model_enum", () => {
  const catalog = createModelCatalog();
  catalog.record(modelsJson);
  const items = catalog.generation().items;
  assert.ok(items, "record must retain parsed catalog items");

  assert.ok(items.models.length >= 10);

  const flash37 = items.models.find((m) => m.id === "gemini-3.7-flash-high");
  assert.ok(flash37);
  assert.equal(flash37.modelEnum, "MODEL_PLACEHOLDER_M298");
  assert.equal(flash37.supportsThinking, true);

  // thinkingBudget/minThinkingBudget ride the wire per Runtime Model ID
  // (the newest capture's models.resp.json) — parse must keep them.
  assert.equal(flash37.thinkingBudget, -1);
  assert.equal(flash37.minThinkingBudget, 32);

  const flash37med = items.models.find((m) => m.id === "gemini-3.7-flash-medium");
  assert.ok(flash37med);
  assert.equal(flash37med.thinkingBudget, 4000);

  const flash37low = items.models.find((m) => m.id === "gemini-3.7-flash-low");
  assert.ok(flash37low);
  assert.equal(flash37low.thinkingBudget, 1000);

  const claudeSonnet = items.models.find((m) => m.id === "claude-sonnet-4-6");
  assert.ok(claudeSonnet);
  assert.equal(claudeSonnet.modelEnum, "MODEL_PLACEHOLDER_M35");
  assert.equal(claudeSonnet.thinkingBudget, 1024);

  const gpt = items.models.find((m) => m.id === "gpt-oss-120b-medium");
  assert.ok(gpt);
  assert.equal(gpt.thinkingBudget, 8192);

  // Models the wire ships without thinking fields keep them undefined.
  const withoutThinking = items.models.filter((m) => m.thinkingBudget === undefined);
  assert.ok(withoutThinking.length > 0, "the capture must contain a model without thinking fields");

  // modelEnums dictionary mapping
  assert.equal(items.modelEnums["gemini-3.7-flash-high"], "MODEL_PLACEHOLDER_M298");
});

test("Seam 3: synthesizeDynamicModel static fallbacks match captured catalog (Claude 250000/64000)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" } },
      agentModelSorts: [{ groups: [{ modelIds: ["claude-sonnet-4-6"] }] }],
    }),
  });
  try {
    const catalog = createModelCatalog();
    const models = await catalog.refresh({
      allowNetwork: true,
      credential: TEST_CREDENTIAL,
      stored: {},
    });
    const claude = models.find((m) => m.id === "claude-sonnet-4-6");
    assert.ok(claude, "claude-sonnet-4-6 must be synthesized");
    assert.equal(claude.contextWindow, 250000);
    assert.equal(claude.maxTokens, 64000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam 3: formatModelsList formats clean table view", () => {
  const catalog = createModelCatalog();
  catalog.record(modelsJson);
  const output = catalog.formatList();

  assert.match(output, /gemini-3\.8-flash/);
  assert.match(output, /claude-sonnet-4-6/);
});

test("Seam 3: formatModelsList shows recommended-only detailed table in sort order", () => {
  const catalog = createModelCatalog();
  catalog.record(modelsJson);
  const output = catalog.formatList();

  assert.match(output, /\(14 recommended\)/);
  assert.match(output, /Model\s+Name\s+Context\s+Features\s+Rem/);
  // non-recommended runtimes excluded
  assert.doesNotMatch(output, /gemini-2\.5-flash/);
  // recommended order from agentModelSorts
  const idx38 = output.indexOf("gemini-3.8-flash-high");
  const idx37 = output.indexOf("gemini-3.7-flash-high");
  const idxSonnet = output.indexOf("claude-sonnet-4-6");
  assert.ok(idx38 !== -1 && idx37 !== -1 && idxSonnet !== -1 && idx38 < idx37 && idx37 < idxSonnet);
  // detail columns, no reset column
  assert.match(output, /Gemini 3\.8 Flash/);
  assert.match(output, /1M\/64k/);
  assert.doesNotMatch(output, /65\.5k/); // 65535 maxOutput rounds to nearest KiB
  assert.match(output, /thinking, images/);
  assert.doesNotMatch(output, /reset:/);
});

test("Seam 3: buildDynamicPublicModels generates models dynamically from agy models catalog", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
  try {
    const catalog = createModelCatalog();
    const publicModels = await catalog.refresh({
      allowNetwork: true,
      credential: TEST_CREDENTIAL,
      stored: {},
    });

    assert.equal(publicModels.length, 7);
    const ids = publicModels.map((m) => m.id);
    assert.ok(ids.includes("gemini-3.8-flash"));
    assert.ok(ids.includes("gemini-3.7-flash"));
    assert.ok(ids.includes("gemini-3.6-flash"));
    assert.ok(ids.includes("gemini-3.1-pro"));
    assert.ok(ids.includes("claude-sonnet-4-6"));
    assert.ok(ids.includes("claude-opus-4-6"));
    assert.ok(ids.includes("gpt-oss-120b"));

    // Verify ordering follows recommended agentModelSorts
    assert.equal(publicModels[0].id, "gemini-3.8-flash");
    assert.equal(publicModels[1].id, "gemini-3.7-flash");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam 3: buildDynamicPublicModels returns empty array on empty or missing catalog", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: {}, agentModelSorts: [] }) });
  try {
    const catalog = createModelCatalog();
    const emptyModels = await catalog.refresh({
      allowNetwork: true,
      credential: TEST_CREDENTIAL,
      stored: {},
    });
    assert.deepEqual(emptyModels, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam 3: isCompatibleFamily groups Runtime Model IDs by Model Family", () => {
  // same id always replays
  assert.equal(isCompatibleFamily("gemini-3.8-flash-high", "gemini-3.8-flash-high"), true);
  // any Gemini pair shares signatures across versions and tiers
  assert.equal(isCompatibleFamily("gemini-3.7-flash-low", "gemini-3.8-flash-high"), true);
  // Claude replays within the Claude family (1.1.27 stream_turn8/9)
  assert.equal(isCompatibleFamily("claude-sonnet-4-6", "claude-opus-4-6-thinking"), true);
  // GPT-OSS replays within its family
  assert.equal(isCompatibleFamily("gpt-oss-120b", "gpt-oss-120b-medium"), true);
  // cross-family never replays
  assert.equal(isCompatibleFamily("gemini-3.8-flash-high", "claude-sonnet-4-6"), false);
  assert.equal(isCompatibleFamily("claude-sonnet-4-6", "gpt-oss-120b"), false);
  assert.equal(isCompatibleFamily("gpt-oss-120b", "gemini-3.8-flash-high"), false);
  // missing history model defaults to replay (first turn)
  assert.equal(isCompatibleFamily(undefined, "gemini-3.8-flash-high"), true);
});

test("Seam 3: classifyModelFamily unifies identity across ID spaces", () => {
  assert.equal(classifyModelFamily("gemini-3.8-flash-high"), "gemini");
  assert.equal(classifyModelFamily("gemini-3.8-flash"), "gemini");
  assert.equal(classifyModelFamily("gemini-pro-agent"), "gemini");
  assert.equal(classifyModelFamily("antigravity/gemini-3-flash"), "gemini");
  assert.equal(classifyModelFamily("claude-sonnet-4-6"), "claude");
  assert.equal(classifyModelFamily("antigravity/claude-sonnet-4-6"), "claude");
  assert.equal(classifyModelFamily("gpt-oss-120b-medium"), "gpt");
  assert.equal(classifyModelFamily("nova-1"), "unknown");
  assert.equal(classifyModelFamily(undefined), "unknown");
  assert.equal(classifyModelFamily(""), "unknown");
});

test("Seam 3: formatModelDisplayName strips all parenthesized tiers", () => {
  const catalog = createModelCatalog();
  catalog.record({
    models: [
      { id: "gemini-99.9-flash-high", displayName: "Gemini 99.9 Flash (High)" },
      { id: "gemini-99.9-flash-low", displayName: undefined },
    ],
    modelEnums: { "gemini-99.9-flash-high": "E1", "gemini-99.9-flash-low": "E2" },
  });
  const output = catalog.formatList();
  assert.match(output, /Gemini 99\.9 Flash/);
  assert.doesNotMatch(output, /Gemini 99\.9 Flash \(High\)/);
});

test("Seam 3: buildDynamicPublicModels dynamically synthesizes unreleased future models without hardcoded counts", async () => {
  const testBaseId = "gemini-99.9-flash";
  const testHighId = `${testBaseId}-high`;
  const testMedId = `${testBaseId}-medium`;
  const testLowId = `${testBaseId}-low`;

  const simulatedModels = {
    ...modelsJson.models,
    [testHighId]: {
      id: testHighId,
      displayName: "Gemini 99.9 Flash (High)",
      model: "MODEL_PLACEHOLDER_M999",
      supportsThinking: true,
      supportsImages: true,
      maxTokens: 1048576,
      maxOutputTokens: 65536,
    },
    [testMedId]: {
      id: testMedId,
      displayName: "Gemini 99.9 Flash (Medium)",
      model: "MODEL_PLACEHOLDER_M1000",
      supportsThinking: true,
      supportsImages: true,
      maxTokens: 1048576,
      maxOutputTokens: 65536,
    },
    [testLowId]: {
      id: testLowId,
      displayName: "Gemini 99.9 Flash (Low)",
      model: "MODEL_PLACEHOLDER_M1001",
      supportsThinking: true,
      supportsImages: true,
      maxTokens: 1048576,
      maxOutputTokens: 65536,
    },
  };

  const simulatedSorts = [
    ...(modelsJson.agentModelSorts || []),
    { groups: [{ modelIds: [testHighId, testMedId, testLowId] }] },
  ];

  const simulatedJson = {
    ...modelsJson,
    models: simulatedModels,
    agentModelSorts: simulatedSorts,
  };

  const realFetch = globalThis.fetch;
  try {
    const catalogBase = createModelCatalog();
    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    const baseline = await catalogBase.refresh({ allowNetwork: true, credential: TEST_CREDENTIAL, stored: {} });

    const catalogSim = createModelCatalog();
    globalThis.fetch = async () => ({ ok: true, json: async () => simulatedJson });
    const publicModels = await catalogSim.refresh({ allowNetwork: true, credential: TEST_CREDENTIAL, stored: {} });

    assert.equal(publicModels.length, baseline.length + 1);

    const synthesized = publicModels.find((m) => m.id === testBaseId);
    assert.ok(synthesized, `${testBaseId} was dynamically discovered and synthesized`);
    assert.equal(synthesized.name, "Gemini 99.9 Flash");
    assert.equal(synthesized.provider, "antigravity");
    assert.equal(synthesized.contextWindow, 1048576);
    assert.equal(synthesized.maxTokens, 65536);
    assert.equal(synthesized.reasoning, true);
    assert.deepEqual(synthesized.input, ["text", "image"]);
    assert.deepEqual(synthesized.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(synthesized.thinkingLevelMap, { off: null, minimal: null });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam 3: synthesized models hide effort levels the snapshot has no variant for", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
  try {
    const catalog = createModelCatalog();
    const publicModels = await catalog.refresh({ allowNetwork: true, credential: TEST_CREDENTIAL, stored: {} });
    const byId = new Map(publicModels.map((m) => [m.id, m]));
    const hiddenLevels = (id) =>
      Object.entries(byId.get(id).thinkingLevelMap)
        .filter(([, mapped]) => mapped === null)
        .map(([level]) => level)
        .sort();

    assert.deepEqual(hiddenLevels("gemini-3.8-flash"), ["minimal", "off"]);
    assert.deepEqual(hiddenLevels("gemini-3.1-pro"), ["medium", "minimal", "off"]);
    assert.deepEqual(hiddenLevels("gpt-oss-120b"), ["high", "low", "minimal", "off"]);
    assert.deepEqual(hiddenLevels("claude-opus-4-6"), ["low", "medium", "minimal", "off"]);
    assert.deepEqual(hiddenLevels("claude-sonnet-4-6"), ["low", "medium", "minimal", "off"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam 3: unified tier vocabulary enforces canonical resolution order and picker invariants", () => {
  // 1. All tier suffixes union completeness
  for (const suffix of Object.values(CANONICAL_TIER_SUFFIXES)) {
    assert.ok(ALL_TIER_SUFFIXES.includes(suffix));
  }
  for (const suffixes of Object.values(TIER_ALIASES)) {
    for (const suffix of suffixes) {
      assert.ok(ALL_TIER_SUFFIXES.includes(suffix));
    }
  }
  for (const suffix of SPECIAL_TIER_SUFFIXES) {
    assert.ok(ALL_TIER_SUFFIXES.includes(suffix));
  }

  // 2. Base ID extraction strips all recognized suffixes
  for (const suffix of ALL_TIER_SUFFIXES) {
    assert.equal(extractBaseModelId(`gemini-model${suffix}`), "gemini-model");
  }

  // 3. Canonical suffixes are attempted first
  for (const [tier, canonicalSuffix] of Object.entries(CANONICAL_TIER_SUFFIXES)) {
    const order = tierCandidateOrder(tier);
    assert.equal(order[0], canonicalSuffix, `Canonical suffix must be first for ${tier}`);
  }

  // 4. Invariant: every advertised tier spelling is tested before cross-tier fallbacks
  for (const tier of ["low", "medium", "high"]) {
    const spellings = tierSpellings(tier);
    const order = tierCandidateOrder(tier);
    for (const spelling of spellings) {
      assert.ok(order.includes(spelling), `${spelling} must be in resolution order for ${tier}`);
    }
  }

  // 5. Fallback entries all belong to known suffixes or empty string
  for (const fallbacks of Object.values(TIER_FALLBACKS)) {
    for (const fb of fallbacks) {
      assert.ok(fb === "" || ALL_TIER_SUFFIXES.includes(fb), `unknown fallback suffix: ${fb}`);
    }
  }
});

test("Seam 3: resolveModelPlan dynamically resolves tiers for new models", () => {
  const snapshot = {
    enums: {
      "gemini-99.9-flash-high": "ENUM_99_HIGH",
      "gemini-99.9-flash-medium": "ENUM_99_MED",
      "gemini-99.9-flash-low": "ENUM_99_LOW",
    },
    runtimeIds: [
      "gemini-99.9-flash-high",
      "gemini-99.9-flash-medium",
      "gemini-99.9-flash-low",
    ],
    thinking: {},
    deprecated: {},
  };

  const catalog = createModelCatalog();
  catalog.restore(snapshot);

  assert.equal(catalog.resolvePlan("gemini-99.9-flash", "high").runtimeModelId, "gemini-99.9-flash-high");
  assert.equal(catalog.resolvePlan("gemini-99.9-flash", "medium").runtimeModelId, "gemini-99.9-flash-medium");
  assert.equal(catalog.resolvePlan("gemini-99.9-flash", "low").runtimeModelId, "gemini-99.9-flash-low");
  assert.equal(catalog.resolvePlan("gemini-99.9-flash", undefined).runtimeModelId, "gemini-99.9-flash-high");
  // No per-ID thinking data in this snapshot: disabled, never a guessed budget.
  assert.deepEqual(catalog.resolvePlan("gemini-99.9-flash", "medium").thinkingConfig, {
    includeThoughts: false,
    thinkingBudget: 0,
  });
});

test("Seam 3: resolveModelPlan resolves thinking from snapshot wire values", () => {
  const catalog = createModelCatalog();
  catalog.record(modelsJson);

  const cases = [
    ["gemini-3.7-flash", "high", "gemini-3.7-flash-high"],
    ["gemini-3.7-flash", "medium", "gemini-3.7-flash-medium"],
    ["gemini-3.7-flash", "low", "gemini-3.7-flash-low"],
    ["gemini-3.1-pro", "high", "gemini-pro-agent"],
    ["gemini-3.1-pro", "low", "gemini-3.1-pro-low"],
    ["claude-sonnet-4-6", undefined, "claude-sonnet-4-6"],
    ["gpt-oss-120b", undefined, "gpt-oss-120b-medium"],
  ];
  for (const [publicId, effort, runtimeId] of cases) {
    const wire = modelsJson.models[runtimeId];
    const plan = catalog.resolvePlan(publicId, effort);
    assert.equal(plan.runtimeModelId, runtimeId);
    assert.equal(plan.modelEnum, wire.model);
    assert.deepEqual(plan.thinkingConfig, {
      includeThoughts: true,
      thinkingBudget: wire.thinkingBudget,
    });
  }
});

test("Seam 3: resolveModelPlan disables thoughts for wire-marked non-thinking models", () => {
  const catalog = createModelCatalog();
  catalog.record(modelsJson);
  const plain = catalog.generation().items.models.find((m) => m.thinkingBudget === undefined);
  assert.ok(plain, "the capture must contain a model without thinking fields");
  const plan = catalog.resolvePlan(plain.id, undefined);
  assert.deepEqual(plan.thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
});

test("Seam 3: resolveModelPlan degrades to disabled thoughts without per-ID thinking data", () => {
  const enums = { "gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318" };
  const runtimeIds = ["gemini-3.8-flash-high"];
  const disabled = { includeThoughts: false, thinkingBudget: 0 };

  const catalog1 = createModelCatalog();
  catalog1.restore({ modelEnums: enums, runtimeIds });
  assert.deepEqual(catalog1.resolvePlan("gemini-3.8-flash", "high").thinkingConfig, disabled);

  const catalog2 = createModelCatalog();
  catalog2.restore({
    enums,
    runtimeIds,
    thinking: { "gemini-3.8-flash-high": { supportsThinking: true } },
    deprecated: {},
  });
  assert.deepEqual(catalog2.resolvePlan("gemini-3.8-flash", "high").thinkingConfig, disabled);
});

test("Seam 3: resolveModelPlan fails fast without runtime IDs instead of guessing a tier", () => {
  const enums = { "gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318" };
  const empty = { enums, runtimeIds: [], thinking: {}, deprecated: {} };

  const catalog = createModelCatalog();
  catalog.restore(empty);
  assert.throws(
    () => catalog.resolvePlan("gemini-3.8-flash", "high"),
    /Unknown model "gemini-3.8-flash".*\/antigravity refresh/
  );
  assert.equal(catalog.resolvePlan("gemini-3.8-flash-high", undefined).modelEnum, "MODEL_PLACEHOLDER_M318");
});

test("Seam 3: resolveModelPlan throws for IDs missing from the snapshot", () => {
  const catalog = createModelCatalog();
  catalog.restore({
    enums: { "gemini-3.7-flash-high": "MODEL_PLACEHOLDER_M298" },
    runtimeIds: ["gemini-3.7-flash-high"],
    thinking: {},
    deprecated: {},
  });
  assert.throws(
    () => catalog.resolvePlan("gemini-3.6-flash-high", undefined),
    /Unknown model "gemini-3.6-flash-high".*\/antigravity refresh/
  );
});

test("Seam 3: buildAntigravityRequestBody uses the plan model_enum", () => {
  const catalog = createModelCatalog();
  catalog.restore({
    enums: { "gemini-99.9-flash-high": "MODEL_PLACEHOLDER_M999" },
    runtimeIds: [],
    thinking: {},
    deprecated: {},
  });

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: catalog.resolvePlan("gemini-99.9-flash-high", undefined),
    context: {
      messages: [{ role: "user", content: "Hello Future Gemini" }],
    },
  });

  assert.equal(body.request.labels.model_enum, "MODEL_PLACEHOLDER_M999");
});

test("Seam 3: parseAvailableModels extracts server-directed renames", () => {
  const catalog = createModelCatalog();
  catalog.record(modelsJson);
  assert.deepEqual(catalog.generation().items.deprecated, {
    "gemini-3.1-pro-high": "gemini-pro-agent",
  });
});

test("Seam 3: resolveModelPlan follows server-directed renames", () => {
  const catalog = createModelCatalog();
  catalog.record(modelsJson);
  assert.equal(catalog.resolvePlan("gemini-3.1-pro", "high").runtimeModelId, "gemini-pro-agent");
  assert.equal(catalog.resolvePlan("gemini-3.1-pro-high", undefined).runtimeModelId, "gemini-pro-agent");
  assert.equal(
    catalog.resolvePlan("gemini-3.1-pro-high", undefined).modelEnum,
    modelsJson.models["gemini-pro-agent"].model
  );
});

test("Seam 3: unlisted 3.5 tiers fail fast instead of guessing", () => {
  const catalog = createModelCatalog();
  catalog.record(modelsJson);
  assert.equal(catalog.resolvePlan("gemini-3.5-flash", "low").runtimeModelId, "gemini-3.5-flash-low");
  assert.throws(() => catalog.resolvePlan("gemini-3.5-flash", "medium"), /Unknown model/);
});

// --- Consolidated Model Catalog Deep Module Tests ---

test("ModelCatalog deep interface: resolvePlan and formatList against current generation", () => {
  const catalog = createModelCatalog();
  catalog.record(modelsJson);

  const plan = catalog.resolvePlan("gemini-3.8-flash", "low");
  assert.equal(plan.runtimeModelId, "gemini-3.8-flash-low");
  assert.ok(plan.modelEnum);
  assert.equal(plan.thinkingConfig.includeThoughts, true);

  const formatted = catalog.formatList();
  assert.ok(formatted.includes("Available Antigravity Models"));
  assert.ok(formatted.includes("gemini-3.8-flash"));
});

test("Catalog freshness seam: failed when nothing is retained", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  try {
    const catalog = createModelCatalog();
    const { status, catalog: items } = await catalog.refreshGeneration(() =>
      catalog.refresh({
        allowNetwork: true,
        credential: TEST_CREDENTIAL,
        stored: {},
      }),
    );
    assert.equal(status, "failed");
    assert.equal(items, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog freshness seam: fresh lands a new generation", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
  try {
    const catalog = createModelCatalog();
    const { status, catalog: items } = await catalog.refreshGeneration(() =>
      catalog.refresh({
        allowNetwork: true,
        credential: TEST_CREDENTIAL,
        stored: {},
      }),
    );
    assert.equal(status, "fresh");
    assert.ok(items && items.models.length > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog freshness seam: stale keeps the retained generation", async () => {
  const realFetch = globalThis.fetch;
  const catalog = createModelCatalog();
  const doRefresh = () =>
    catalog.refresh({
      allowNetwork: true,
      credential: TEST_CREDENTIAL,
      stored: {},
    });
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    await catalog.refreshGeneration(doRefresh);

    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
    const { status, catalog: items } = await catalog.refreshGeneration(doRefresh);
    assert.equal(status, "stale");
    assert.ok(items && items.models.length > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

const storedModels = [{ id: "gemini-3.8-flash", name: "Cached" }];

test("Catalog refresh: offline returns stored models without fetching", async () => {
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("must not fetch offline");
  };
  try {
    const catalog = createModelCatalog();
    const models = await catalog.refresh({ allowNetwork: false, stored: { models: storedModels } });
    assert.deepEqual(models, storedModels);
    assert.equal(fetched, false);
    assert.deepEqual(catalog.generation().snapshot.enums, {});
    assert.equal(catalog.generation().version, 0);
    assert.equal(catalog.generation().items, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog refresh: missing credential falls back to stored models", async () => {
  const catalog = createModelCatalog();
  const models = await catalog.refresh({
    allowNetwork: true,
    credential: {},
    stored: { models: storedModels },
  });
  assert.deepEqual(models, storedModels);
  assert.equal(catalog.generation().version, 0);
});

test("Catalog refresh: stored enums and runtime IDs restore active state", async () => {
  const catalog = createModelCatalog();
  const models = await catalog.refresh({
    allowNetwork: false,
    stored: {
      models: storedModels,
      [PRIVATE_SNAPSHOT_KEY]: {
        modelEnums: { "x-high": "ENUM_X" },
        runtimeIds: ["x-high"],
        thinking: { "x-high": { budget: 4000, supportsThinking: true } },
        deprecated: { "old-high": "x-high" },
      },
    },
  });
  assert.deepEqual(models, storedModels);
  const { snapshot, version, items } = catalog.generation();
  assert.deepEqual(snapshot.enums, { "x-high": "ENUM_X" });
  assert.deepEqual(snapshot.runtimeIds, ["x-high"]);
  assert.deepEqual(snapshot.thinking["x-high"], { budget: 4000, supportsThinking: true });
  assert.deepEqual(snapshot.deprecated, { "old-high": "x-high" });
  assert.equal(version, 0);
  assert.equal(items, undefined);
});

test("Catalog refresh: fresh fetch builds dynamic models and publishes", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
  try {
    const published = [];
    const catalog = createModelCatalog();
    const models = await catalog.refresh({
      allowNetwork: true,
      credential: TEST_CREDENTIAL,
      stored: {},
      publish: async (arg) => {
        published.push(arg);
      },
    });

    const expectedCatalog = createModelCatalog();
    expectedCatalog.record(modelsJson);
    const expected = expectedCatalog.generation().items;

    assert.ok(models.length > 0, "fixture catalog must yield public models");
    assert.ok(models.every((m) => m.provider === "antigravity"));
    const { snapshot, items, version } = catalog.generation();
    assert.ok(snapshot.runtimeIds.length > 0, "active runtime IDs must populate");
    assert.equal(version, 1, "one recorded refresh is one generation");
    assert.ok(items && items.models.length > 0, "record must retain the full catalog");
    assert.deepEqual(items.modelEnums, expected.modelEnums);

    assert.equal(published.length, 1);
    const persist = published[0].persist;
    assert.deepEqual(persist.models, models);
    assert.equal(typeof persist.checkedAt, "number");
    assert.deepEqual(persist[PRIVATE_SNAPSHOT_KEY], catalog.toPersisted());
    assert.deepEqual(persist[PRIVATE_SNAPSHOT_KEY].modelEnums, expected.modelEnums);
    assert.equal(persist[PRIVATE_SNAPSHOT_KEY].thinking["gemini-3.7-flash-medium"].budget, 4000);
    assert.deepEqual(persist[PRIVATE_SNAPSHOT_KEY].deprecated, expected.deprecated);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Catalog refresh: fetch failure falls back to stored models", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  try {
    const catalog = createModelCatalog();
    const models = await catalog.refresh({
      allowNetwork: true,
      credential: TEST_CREDENTIAL,
      stored: { models: storedModels },
    });
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
  try {
    const catalog = createModelCatalog();
    globalThis.fetch = async () => ({ ok: true, json: async () => staleJson });
    await catalog.refresh({ allowNetwork: true, credential: TEST_CREDENTIAL, stored: {} });
    assert.equal(catalog.generation().snapshot.enums["stale-model-high"], "MODEL_STALE");

    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    await catalog.refresh({ allowNetwork: true, credential: TEST_CREDENTIAL, stored: {} });
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
  try {
    const catalog = createModelCatalog();
    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    await catalog.refresh({ allowNetwork: true, credential: TEST_CREDENTIAL, stored: {} });
    assert.equal(catalog.generation().version, 1);

    await catalog.refresh({
      allowNetwork: false,
      stored: {
        models: storedModels,
        [PRIVATE_SNAPSHOT_KEY]: {
          modelEnums: { "stale-model-high": "MODEL_STALE" },
          runtimeIds: ["stale-model-high"],
          thinking: {},
          deprecated: {},
        },
      },
    });
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
  try {
    const catalog = createModelCatalog();
    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    await catalog.refresh({ allowNetwork: true, credential: TEST_CREDENTIAL, stored: {} });
    assert.ok("gemini-3.6-flash-high" in catalog.generation().snapshot.enums);

    globalThis.fetch = async () => ({ ok: true, json: async () => prunedJson });
    await catalog.refresh({ allowNetwork: true, credential: TEST_CREDENTIAL, stored: {} });
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
  const catalog = createModelCatalog();
  catalog.restore(snapshot);
  const persisted = catalog.toPersisted();
  assert.deepEqual(Object.keys(persisted).sort(), ["deprecated", "modelEnums", "runtimeIds", "thinking"]);

  const restoredCatalog = createModelCatalog();
  restoredCatalog.restore(persisted);
  assert.deepEqual(restoredCatalog.generation().snapshot, snapshot);

  const empty1 = createModelCatalog();
  empty1.restore(undefined);
  assert.deepEqual(empty1.generation().snapshot.runtimeIds, []);

  const empty2 = createModelCatalog();
  empty2.restore("nope");
  assert.deepEqual(empty2.generation().snapshot.runtimeIds, []);

  const empty3 = createModelCatalog();
  empty3.restore({});
  assert.deepEqual(empty3.generation().snapshot.runtimeIds, []);

  const empty4 = createModelCatalog();
  empty4.restore({ modelEnums: 42 });
  assert.deepEqual(empty4.generation().snapshot.runtimeIds, []);

  const malformedCatalog = createModelCatalog();
  malformedCatalog.restore({ modelEnums: { a: 1 }, runtimeIds: ["x", 2] });
  assert.deepEqual(malformedCatalog.generation().snapshot, {
    enums: {},
    runtimeIds: ["x"],
    thinking: {},
    deprecated: {},
  });
});
