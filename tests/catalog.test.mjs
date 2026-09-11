import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ALL_TIER_SUFFIXES,
  buildDynamicPublicModels,
  buildThinkingMap,
  CANONICAL_TIER_SUFFIXES,
  classifyModelFamily,
  createCatalogStore,
  createModelCatalog,
  estimateModelCost,
  extractBaseModelId,
  formatModelDisplayName,
  formatModelsList,
  fromPersistedSnapshot,
  isCompatibleFamily,
  parseAvailableModels,
  refreshCatalog,
  refreshCatalogGeneration,
  resolveModelPlan,
  SPECIAL_TIER_SUFFIXES,
  synthesizeDynamicModel,
  TIER_ALIASES,
  TIER_FALLBACKS,
  tierCandidateOrder,
  tierSpellings,
  toPersistedSnapshot,
} from "../src/model-catalog.ts";
import { buildAntigravityRequestBody } from "../src/builder.ts";

const modelsJson = JSON.parse(fs.readFileSync("captures/agy_cli_1.2.0/models.resp.json", "utf-8"));

// The Catalog Snapshot a recorded generation hands to a request path.
const snapshotOf = (catalog) => ({
  enums: catalog.modelEnums,
  runtimeIds: catalog.models.map((m) => m.id),
  thinking: buildThinkingMap(catalog.models),
  deprecated: catalog.deprecated ?? {},
});

test("Seam 3: parseAvailableModels extracts models and model_enum", () => {
  const catalog = parseAvailableModels(modelsJson);

  assert.ok(catalog.models.length >= 10);

  const flash37 = catalog.models.find((m) => m.id === "gemini-3.7-flash-high");
  assert.ok(flash37);
  assert.equal(flash37.modelEnum, "MODEL_PLACEHOLDER_M298");
  assert.equal(flash37.supportsThinking, true);

  // thinkingBudget/minThinkingBudget ride the wire per Runtime Model ID
  // (captures/agy_cli_1.2.0/models.resp.json) — parse must keep them.
  assert.equal(flash37.thinkingBudget, -1);
  assert.equal(flash37.minThinkingBudget, 32);

  const flash37med = catalog.models.find((m) => m.id === "gemini-3.7-flash-medium");
  assert.ok(flash37med);
  assert.equal(flash37med.thinkingBudget, 4000);

  const flash37low = catalog.models.find((m) => m.id === "gemini-3.7-flash-low");
  assert.ok(flash37low);
  assert.equal(flash37low.thinkingBudget, 1000);

  const claudeSonnet = catalog.models.find((m) => m.id === "claude-sonnet-4-6");
  assert.ok(claudeSonnet);
  assert.equal(claudeSonnet.modelEnum, "MODEL_PLACEHOLDER_M35");
  assert.equal(claudeSonnet.thinkingBudget, 1024);

  const gpt = catalog.models.find((m) => m.id === "gpt-oss-120b-medium");
  assert.ok(gpt);
  assert.equal(gpt.thinkingBudget, 8192);

  // Models the wire ships without thinking fields keep them undefined. Derived from the
  // capture: which ids lack the field changes between agy releases (2.5-flash gained one),
  // the rule does not.
  const withoutThinking = catalog.models.filter((m) => m.thinkingBudget === undefined);
  assert.ok(withoutThinking.length > 0, "the capture must contain a model without thinking fields");

  // modelEnums dictionary mapping
  assert.equal(catalog.modelEnums["gemini-3.7-flash-high"], "MODEL_PLACEHOLDER_M298");
});

test("Seam 3: synthesizeDynamicModel static fallbacks match captured catalog (Claude 250000/64000)", () => {
  // Offline path (no maxTokens/maxOutputTokens): must mirror
  // captures/agy_cli_1.2.0/models.resp.json, also seen on the wire (turn8/9).
  const claude = synthesizeDynamicModel("claude-sonnet-4-6", [{ id: "claude-sonnet-4-6" }]);
  assert.equal(claude.contextWindow, 250000);
  assert.equal(claude.maxTokens, 64000);
});

test("Seam 3: formatModelsList formats clean table view", () => {
  const catalog = parseAvailableModels(modelsJson);
  const output = formatModelsList(catalog);

  assert.match(output, /gemini-3\.8-flash/);
  assert.match(output, /claude-sonnet-4-6/);
});

test("Seam 3: formatModelsList shows recommended-only detailed table in sort order", () => {
  const catalog = parseAvailableModels(modelsJson);
  const output = formatModelsList(catalog);

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

test("Seam 3: buildDynamicPublicModels generates models dynamically from agy models catalog", () => {
  const catalog = parseAvailableModels(modelsJson);
  const publicModels = buildDynamicPublicModels(catalog);

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
});

test("Seam 3: buildDynamicPublicModels returns empty array on empty or missing catalog", () => {
  const fallbackEmpty = buildDynamicPublicModels({ models: [], modelEnums: {} });
  assert.deepEqual(fallbackEmpty, []);

  const fallbackUndefined = buildDynamicPublicModels(undefined);
  assert.deepEqual(fallbackUndefined, []);
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
  assert.equal(
    formatModelDisplayName("gemini-99.9-flash", "Gemini 99.9 Flash (High)"),
    "Gemini 99.9 Flash"
  );
  assert.equal(
    formatModelDisplayName("gemini-99.9-flash", undefined),
    "Gemini 99.9 Flash"
  );
});

test("Seam 3: buildDynamicPublicModels dynamically synthesizes unreleased future models without hardcoded counts", () => {
  const catalog = parseAvailableModels(modelsJson);
  const baselineCount = buildDynamicPublicModels(catalog).length;

  const testBaseId = "gemini-99.9-flash";
  const testHighId = `${testBaseId}-high`;
  const testMedId = `${testBaseId}-medium`;
  const testLowId = `${testBaseId}-low`;

  // Simulate Google releasing an unreleased future model in fetchAvailableModels response
  const simulatedCatalog = {
    ...catalog,
    models: [
      ...catalog.models,
      {
        id: testHighId,
        displayName: "Gemini 99.9 Flash (High)",
        modelEnum: "MODEL_PLACEHOLDER_M999",
        supportsThinking: true,
        supportsImages: true,
        maxTokens: 1048576,
        maxOutputTokens: 65536,
      },
      {
        id: testMedId,
        displayName: "Gemini 99.9 Flash (Medium)",
        modelEnum: "MODEL_PLACEHOLDER_M1000",
        supportsThinking: true,
        supportsImages: true,
        maxTokens: 1048576,
        maxOutputTokens: 65536,
      },
      {
        id: testLowId,
        displayName: "Gemini 99.9 Flash (Low)",
        modelEnum: "MODEL_PLACEHOLDER_M1001",
        supportsThinking: true,
        supportsImages: true,
        maxTokens: 1048576,
        maxOutputTokens: 65536,
      },
    ],
    agentModelSorts: [
      ...(catalog.agentModelSorts || []),
      testHighId,
      testMedId,
      testLowId,
    ],
  };

  const publicModels = buildDynamicPublicModels(simulatedCatalog);
  assert.equal(publicModels.length, baselineCount + 1);

  const synthesized = publicModels.find((m) => m.id === testBaseId);
  assert.ok(synthesized, `${testBaseId} was dynamically discovered and synthesized`);
  assert.equal(synthesized.name, "Gemini 99.9 Flash");
  assert.equal(synthesized.provider, "antigravity");
  assert.equal(synthesized.contextWindow, 1048576);
  assert.equal(synthesized.maxTokens, 65536);
  assert.equal(synthesized.reasoning, true);
  assert.deepEqual(synthesized.input, ["text", "image"]);
  assert.deepEqual(synthesized.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  // agy has no off/minimal effort, so Pi must not offer them (ADR-0009).
  assert.deepEqual(synthesized.thinkingLevelMap, { off: null, minimal: null });
});

test("Seam 3: synthesized models hide effort levels the snapshot has no variant for", () => {
  const catalog = parseAvailableModels(modelsJson);
  const byId = new Map(buildDynamicPublicModels(catalog).map((m) => [m.id, m]));
  const hiddenLevels = (id) =>
    Object.entries(byId.get(id).thinkingLevelMap)
      .filter(([, mapped]) => mapped === null)
      .map(([level]) => level)
      .sort();

  // agy has no off/minimal at all (ADR-0009); the tiers below come from the
  // snapshot's own variant list per model.
  assert.deepEqual(hiddenLevels("gemini-3.8-flash"), ["minimal", "off"]);
  // Gemini 3.1 Pro lists no -medium variant (captures: -high/-low only).
  assert.deepEqual(hiddenLevels("gemini-3.1-pro"), ["medium", "minimal", "off"]);
  // gpt-oss has only -medium; Claude only -thinking (the default/high tier).
  assert.deepEqual(hiddenLevels("gpt-oss-120b"), ["high", "low", "minimal", "off"]);
  assert.deepEqual(hiddenLevels("claude-opus-4-6"), ["low", "medium", "minimal", "off"]);
  assert.deepEqual(hiddenLevels("claude-sonnet-4-6"), ["low", "medium", "minimal", "off"]);
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

  assert.equal(resolveModelPlan("gemini-99.9-flash", "high", snapshot).runtimeModelId, "gemini-99.9-flash-high");
  assert.equal(resolveModelPlan("gemini-99.9-flash", "medium", snapshot).runtimeModelId, "gemini-99.9-flash-medium");
  assert.equal(resolveModelPlan("gemini-99.9-flash", "low", snapshot).runtimeModelId, "gemini-99.9-flash-low");
  assert.equal(resolveModelPlan("gemini-99.9-flash", undefined, snapshot).runtimeModelId, "gemini-99.9-flash-high");
  // No per-ID thinking data in this snapshot: disabled, never a guessed budget.
  assert.deepEqual(resolveModelPlan("gemini-99.9-flash", "medium", snapshot).thinkingConfig, {
    includeThoughts: false,
    thinkingBudget: 0,
  });
});

test("Seam 3: resolveModelPlan resolves thinking from snapshot wire values", () => {
  const catalog = parseAvailableModels(modelsJson);
  const snapshot = snapshotOf(catalog);

  // Expected values read from the fixture itself, never hardcoded here.
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
    const plan = resolveModelPlan(publicId, effort, snapshot);
    assert.equal(plan.runtimeModelId, runtimeId);
    assert.equal(plan.modelEnum, wire.model);
    assert.deepEqual(plan.thinkingConfig, {
      includeThoughts: true,
      thinkingBudget: wire.thinkingBudget,
    });
  }
});

test("Seam 3: resolveModelPlan disables thoughts for wire-marked non-thinking models", () => {
  const catalog = parseAvailableModels(modelsJson);
  const snapshot = snapshotOf(catalog);
  // A wire-marked non-thinking model (no thinking fields at all): absent means off.
  // Derived from the capture so a server-side change to one id cannot break the rule.
  const plain = catalog.models.find((m) => m.thinkingBudget === undefined);
  assert.ok(plain, "the capture must contain a model without thinking fields");
  const plan = resolveModelPlan(plain.id, undefined, snapshot);
  assert.deepEqual(plan.thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
});

test("Seam 3: resolveModelPlan degrades to disabled thoughts without per-ID thinking data", () => {
  const enums = { "gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318" };
  const runtimeIds = ["gemini-3.8-flash-high"];
  const disabled = { includeThoughts: false, thinkingBudget: 0 };

  // Legacy pre-budget persist: enums + runtime IDs, no thinking data. The codec
  // materializes the maps, so this is the snapshot a restart actually produces.
  assert.deepEqual(
    resolveModelPlan("gemini-3.8-flash", "high", fromPersistedSnapshot({ modelEnums: enums, runtimeIds }))
      .thinkingConfig,
    disabled
  );
  // Entry present but no wire budget (incomplete info): still disabled.
  assert.deepEqual(
    resolveModelPlan("gemini-3.8-flash", "high", {
      enums,
      runtimeIds,
      thinking: { "gemini-3.8-flash-high": { supportsThinking: true } },
      deprecated: {},
    }).thinkingConfig,
    disabled
  );
});

test("Seam 3: resolveModelPlan fails fast without runtime IDs instead of guessing a tier", () => {
  const enums = { "gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318" };
  const empty = { enums, runtimeIds: [], thinking: {}, deprecated: {} };
  // The suffixed ID exists, but a snapshot with no runtime-ID list cannot map
  // the bare public ID onto it — fail with refresh guidance, do not guess.
  assert.throws(
    () => resolveModelPlan("gemini-3.8-flash", "high", empty),
    /Unknown model "gemini-3.8-flash".*\/antigravity refresh/
  );
  // An exact (already-suffixed) ID still resolves from the same snapshot.
  assert.equal(resolveModelPlan("gemini-3.8-flash-high", undefined, empty).modelEnum, "MODEL_PLACEHOLDER_M318");
});

test("Seam 3: resolveModelPlan throws for IDs missing from the snapshot", () => {
  const snapshot = {
    enums: { "gemini-3.7-flash-high": "MODEL_PLACEHOLDER_M298" },
    runtimeIds: ["gemini-3.7-flash-high"],
    thinking: {},
    deprecated: {},
  };
  assert.throws(
    () => resolveModelPlan("gemini-3.6-flash-high", undefined, snapshot),
    /Unknown model "gemini-3.6-flash-high".*\/antigravity refresh/
  );
});

test("Seam 3: buildAntigravityRequestBody uses the plan model_enum", () => {
  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: resolveModelPlan("gemini-99.9-flash-high", undefined, {
      enums: { "gemini-99.9-flash-high": "MODEL_PLACEHOLDER_M999" },
      runtimeIds: [],
      thinking: {},
      deprecated: {},
    }),
    context: {
      messages: [{ role: "user", content: "Hello Future Gemini" }],
    },
  });

  assert.equal(body.request.labels.model_enum, "MODEL_PLACEHOLDER_M999");
});

test("Seam 3: parseAvailableModels extracts server-directed renames", () => {
  const catalog = parseAvailableModels(modelsJson);
  assert.deepEqual(catalog.deprecated, {
    "gemini-3.1-pro-high": "gemini-pro-agent",
  });
});

test("Seam 3: resolveModelPlan follows server-directed renames", () => {
  const catalog = parseAvailableModels(modelsJson);
  const snapshot = snapshotOf(catalog);
  // Redirect applies uniformly, whether the old ID was derived or passed directly.
  assert.equal(resolveModelPlan("gemini-3.1-pro", "high", snapshot).runtimeModelId, "gemini-pro-agent");
  assert.equal(resolveModelPlan("gemini-3.1-pro-high", undefined, snapshot).runtimeModelId, "gemini-pro-agent");
  assert.equal(
    resolveModelPlan("gemini-3.1-pro-high", undefined, snapshot).modelEnum,
    modelsJson.models["gemini-pro-agent"].model
  );
});

test("Seam 3: unlisted 3.5 tiers fail fast instead of guessing", () => {
  const catalog = parseAvailableModels(modelsJson);
  const snapshot = snapshotOf(catalog);
  // gemini-3.5-flash-low exists on the wire so low resolves; -medium/-high
  // were never listed (3.5 sits outside Recommended sorts) → throw, don't guess.
  assert.equal(resolveModelPlan("gemini-3.5-flash", "low", snapshot).runtimeModelId, "gemini-3.5-flash-low");
  assert.throws(() => resolveModelPlan("gemini-3.5-flash", "medium", snapshot), /Unknown model/);
});

// --- Consolidated Model Catalog Deep Module Tests ---

test("ModelCatalog deep interface: resolvePlan and formatList against current generation", () => {
  const catalog = createModelCatalog();
  catalog.record(parseAvailableModels(modelsJson));

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
        credential: { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) },
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
        credential: { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) },
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
      credential: { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) },
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
      "pi-provider-antigravity": {
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
      credential: { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) },
      stored: {},
      publish: async (arg) => {
        published.push(arg);
      },
    });

    const expected = parseAvailableModels(modelsJson);
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
    const catalog = createModelCatalog();
    const models = await catalog.refresh({
      allowNetwork: true,
      credential: { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) },
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
  const credential = { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) };
  try {
    const catalog = createModelCatalog();
    globalThis.fetch = async () => ({ ok: true, json: async () => staleJson });
    await catalog.refresh({ allowNetwork: true, credential, stored: {} });
    assert.equal(catalog.generation().snapshot.enums["stale-model-high"], "MODEL_STALE");

    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    await catalog.refresh({ allowNetwork: true, credential, stored: {} });
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
    const catalog = createModelCatalog();
    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    await catalog.refresh({ allowNetwork: true, credential, stored: {} });
    assert.equal(catalog.generation().version, 1);

    await catalog.refresh({
      allowNetwork: false,
      stored: {
        models: storedModels,
        "pi-provider-antigravity": {
          modelEnums: { "stale-model-high": "MODEL_STALE" },
          runtimeIds: ["stale-model-high"],
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
  const credential = { type: "oauth", access: JSON.stringify({ token: "t", projectId: "p" }) };
  try {
    const catalog = createModelCatalog();
    globalThis.fetch = async () => ({ ok: true, json: async () => modelsJson });
    await catalog.refresh({ allowNetwork: true, credential, stored: {} });
    assert.ok("gemini-3.6-flash-high" in catalog.generation().snapshot.enums);

    globalThis.fetch = async () => ({ ok: true, json: async () => prunedJson });
    await catalog.refresh({ allowNetwork: true, credential, stored: {} });
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
  assert.deepEqual(Object.keys(persisted).sort(), ["deprecated", "modelEnums", "runtimeIds", "thinking"]);
  assert.deepEqual(fromPersistedSnapshot(persisted), snapshot);

  assert.equal(fromPersistedSnapshot(undefined), undefined);
  assert.equal(fromPersistedSnapshot("nope"), undefined);
  assert.equal(fromPersistedSnapshot({}), undefined);
  assert.equal(fromPersistedSnapshot({ modelEnums: 42 }), undefined);
  assert.deepEqual(fromPersistedSnapshot({ modelEnums: { a: 1 }, runtimeIds: ["x", 2] }), {
    enums: {},
    runtimeIds: ["x"],
    thinking: {},
    deprecated: {},
  });
});
