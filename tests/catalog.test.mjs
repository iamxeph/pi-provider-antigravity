import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseAvailableModels,
  formatModelsList,
  buildDynamicPublicModels,
  formatModelDisplayName,
  estimateModelCost,
  synthesizeDynamicModel,
  resolveModelPlan,
  extractBaseModelId,
} from "../src/catalog.ts";
import { buildAntigravityRequestBody } from "../src/builder.ts";

const modelsJson = JSON.parse(fs.readFileSync("captures/agy_cli_1.1.26/models.resp.json", "utf-8"));

test("Seam 3: parseAvailableModels extracts models and model_enum", () => {
  const catalog = parseAvailableModels(modelsJson);

  assert.ok(catalog.models.length >= 10);

  const flash37 = catalog.models.find((m) => m.id === "gemini-3.7-flash-high");
  assert.ok(flash37);
  assert.equal(flash37.modelEnum, "MODEL_PLACEHOLDER_M298");
  assert.equal(flash37.supportsThinking, true);

  const claudeSonnet = catalog.models.find((m) => m.id === "claude-sonnet-4-6");
  assert.ok(claudeSonnet);
  assert.equal(claudeSonnet.modelEnum, "MODEL_PLACEHOLDER_M35");

  // modelEnums dictionary mapping
  assert.equal(catalog.modelEnums["gemini-3.7-flash-high"], "MODEL_PLACEHOLDER_M298");
});

test("Seam 3: synthesizeDynamicModel static fallbacks match captured catalog (Claude 250000/64000)", () => {
  // Offline path (no maxTokens/maxOutputTokens): must mirror
  // captures/agy_cli_1.1.27/models.resp.json, also seen on the wire (turn8/9).
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

test("Seam 3: extractBaseModelId strips tier suffixes accurately", () => {
  assert.equal(extractBaseModelId("gemini-99.9-flash-high"), "gemini-99.9-flash");
  assert.equal(extractBaseModelId("gemini-99.9-flash-medium"), "gemini-99.9-flash");
  assert.equal(extractBaseModelId("gemini-99.9-flash-low"), "gemini-99.9-flash");
  assert.equal(extractBaseModelId("gemini-99.9-flash-tiered"), "gemini-99.9-flash");
  assert.equal(extractBaseModelId("claude-opus-4-6-thinking"), "claude-opus-4-6");
  assert.equal(extractBaseModelId("gemini-pro-agent"), "gemini-3.1-pro");
  assert.equal(extractBaseModelId("claude-sonnet-4-7"), "claude-sonnet-4-7");
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
});

test("Seam 3: resolveModelPlan dynamically resolves tiers for new models", () => {
  const snapshot = {
    enums: {},
    runtimeIds: [
      "gemini-99.9-flash-high",
      "gemini-99.9-flash-medium",
      "gemini-99.9-flash-low",
    ],
    version: 0,
  };

  assert.equal(resolveModelPlan("gemini-99.9-flash", "high", snapshot).runtimeModelId, "gemini-99.9-flash-high");
  assert.equal(resolveModelPlan("gemini-99.9-flash", "medium", snapshot).runtimeModelId, "gemini-99.9-flash-medium");
  assert.equal(resolveModelPlan("gemini-99.9-flash", "low", snapshot).runtimeModelId, "gemini-99.9-flash-low");
  assert.equal(resolveModelPlan("gemini-99.9-flash", "off", snapshot).runtimeModelId, "gemini-99.9-flash-low");
  assert.equal(resolveModelPlan("gemini-99.9-flash", undefined, snapshot).runtimeModelId, "gemini-99.9-flash-high");
});

test("Seam 3: buildAntigravityRequestBody uses the plan model_enum", () => {
  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: resolveModelPlan("gemini-99.9-flash-high", undefined, {
      enums: { "gemini-99.9-flash-high": "MODEL_PLACEHOLDER_M999" },
      runtimeIds: [],
      version: 0,
    }),
    context: {
      messages: [{ role: "user", content: "Hello Future Gemini" }],
    },
  });

  assert.equal(body.request.labels.model_enum, "MODEL_PLACEHOLDER_M999");
});
