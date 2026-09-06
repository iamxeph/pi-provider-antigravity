import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildAntigravityRequestBody,
} from "../src/builder.ts";
import {
  resolveModelPlan,
  getCatalogSnapshot,
  refreshCatalog,
  getThinkingConfig,
  STATIC_MODEL_ENUMS,
} from "../src/catalog.ts";

const STATIC_SNAPSHOT = { enums: STATIC_MODEL_ENUMS, runtimeIds: [], version: 0 };
const staticPlan = (runtimeModelId) =>
  resolveModelPlan(runtimeModelId, undefined, STATIC_SNAPSHOT);

const fixtureTurn1 = JSON.parse(
  fs.readFileSync("captures/agy_cli_1.1.26/stream_turn1_initial.req.json", "utf-8")
);
const fixtureTurn2 = JSON.parse(
  fs.readFileSync("captures/agy_cli_1.1.26/stream_turn2_toolresult.req.json", "utf-8")
);
const fixtureTurn4 = JSON.parse(
  fs.readFileSync("captures/agy_cli_1.1.26/stream_turn4_thinking.req.json", "utf-8")
);
const fixtureTurn5 = JSON.parse(
  fs.readFileSync("captures/agy_cli_1.1.26/stream_turn5_multiturn.req.json", "utf-8")
);
const fixtureTurn6 = JSON.parse(
  fs.readFileSync("captures/agy_cli_1.1.26/stream_turn6_toolerror.req.json", "utf-8")
);

test("Seam 1: buildAntigravityRequestBody creates strict envelope and PR #39 labels", () => {
  const context = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello Antigravity Turn 1" }],
      },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  // Strict wire envelope assertions based on capture fixture
  assert.equal(body.project, "aicode-consumers");
  assert.equal(body.model, "gemini-3.7-flash-high");
  assert.equal(body.userAgent, "antigravity");
  assert.equal(body.requestType, "agent");
  assert.match(body.requestId, /^agent\/[0-9a-f-]+\/\d+\/[0-9a-f-]+\/1$/);
  assert.match(body.request.sessionId, /^-?\d+$/);

  // PR #39 Wire labels check
  const labels = body.request.labels;
  assert.equal(labels.last_step_index, "0");
  assert.equal(labels.model_enum, "MODEL_PLACEHOLDER_M298");
  assert.match(labels.trajectory_id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(labels.request_id, `${labels.trajectory_id}-0`);
  assert.equal(labels.used_claude, "false");
  assert.equal(labels.used_claude_conservative, "false");
  assert.equal(labels.used_non_gemini_model, "false");

  // Thinking config check
  assert.deepEqual(body.request.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingBudget: -1,
  });
});

test("Seam 1: multi-turn tool call increments request_id sequence and preserves thoughtSignature", () => {
  const sampleSignature = fixtureTurn2.body.request.contents[1].parts[0].thoughtSignature;

  const context = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "List directory" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_123908",
            name: "list_dir",
            input: { DirectoryPath: "/test" },
            thoughtSignature: sampleSignature,
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_123908",
        content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
      },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  const trajectoryId = body.request.labels.trajectory_id;
  // Assistant turn count is 1, so request_id is <traj>-1
  assert.equal(body.request.labels.request_id, `${trajectoryId}-1`);
  // contents.length is 3, so last_step_index is "2"
  assert.equal(body.request.labels.last_step_index, "2");
  assert.match(body.requestId, new RegExp(`/${trajectoryId}/3$`));

  // Verify assistant tool call carries thoughtSignature exactly as in fixture
  const assistantContent = body.request.contents[1];
  assert.equal(assistantContent.role, "model");
  assert.equal(assistantContent.parts[0].functionCall.name, "list_dir");
  assert.equal(assistantContent.parts[0].thoughtSignature, sampleSignature);

  // Verify tool response is converted to functionResponse
  const toolContent = body.request.contents[2];
  assert.equal(toolContent.role, "model");
  assert.equal(toolContent.parts[0].functionResponse.name, "list_dir");
  assert.deepEqual(toolContent.parts[0].functionResponse.response, { output: "file1.txt\nfile2.txt" });
});

test("Seam 1: assistant thinking blocks serialize as thought: true with text property", () => {
  const context = {
    messages: [
      {
        role: "user",
        content: "Explain SHA-256",
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Deconstructing SHA-256 Algorithm...",
            thoughtSignature: "sig_12345",
          },
          {
            type: "text",
            text: "SHA-256 is a cryptographic hash function...",
          },
        ],
      },
      {
        role: "user",
        content: "Continue",
      },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  const assistantTurn = body.request.contents[1];
  assert.equal(assistantTurn.role, "model");
  assert.equal(assistantTurn.parts.length, 2);

  const thinkingPart = assistantTurn.parts[0];
  assert.equal(typeof thinkingPart.thought, "boolean");
  assert.equal(thinkingPart.thought, true);
  assert.equal(thinkingPart.text, "Deconstructing SHA-256 Algorithm...");
  // agy CLI part-split (#15): the thinking part never carries the signature —
  // it rides on the next visible-text part instead.
  assert.equal("thoughtSignature" in thinkingPart, false);
  assert.equal(assistantTurn.parts[1].thoughtSignature, "sig_12345");
});

test("Seam 1: toolResult role from pi-ai is properly formatted as functionResponse", () => {
  const context = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Run git status" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bash_1",
            name: "bash",
            arguments: { command: "git status && ls -la" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_bash_1",
        toolName: "bash",
        content: [{ type: "text", text: "On branch main\nnothing to commit" }],
        isError: false,
      },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  assert.equal(body.request.contents.length, 3);
  const toolTurn = body.request.contents[2];
  assert.equal(toolTurn.role, "model");
  assert.deepEqual(toolTurn.parts[0], {
    functionResponse: {
      id: "call_bash_1",
      name: "bash",
      response: { output: "On branch main\nnothing to commit" },
    },
  });
});

test("Seam 1: trailing model turn appends continuation user turn to prevent 400 rejection", () => {
  const context = {
    messages: [
      {
        role: "user",
        content: "Hello",
      },
      {
        role: "assistant",
        content: "Hi, I am ready to help.",
      },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  // Since last message was an assistant message without functionResponse,
  // a continuation user turn must be appended to avoid "Requests ending with a model turn are not supported"
  assert.equal(body.request.contents.length, 3);
  assert.equal(body.request.contents[2].role, "user");
  assert.equal(body.request.contents[2].parts[0].text, "continue");
});

test("Seam 1: integer thinkingBudget matches PR #39 / #36 matrix across models", () => {
  // Flash high -> -1
  assert.deepEqual(getThinkingConfig("gemini-3.8-flash-high"), { includeThoughts: true, thinkingBudget: -1 });
  // Flash medium -> 4000
  assert.deepEqual(getThinkingConfig("gemini-3.8-flash", "medium"), { includeThoughts: true, thinkingBudget: 4000 });
  // Flash low -> 1000
  assert.deepEqual(getThinkingConfig("gemini-3.8-flash", "low"), { includeThoughts: true, thinkingBudget: 1000 });
  // Live-captured 2026-09-06 (agy 1.1.26, --model gemini-3.7-flash --effort low|medium|high):
  // variant runtime ID + integer budget, never -tiered / thinkingLevel.
  assert.deepEqual(getThinkingConfig("gemini-3.7-flash-low"), { includeThoughts: true, thinkingBudget: 1000 });
  assert.deepEqual(getThinkingConfig("gemini-3.7-flash-medium"), { includeThoughts: true, thinkingBudget: 4000 });
  assert.deepEqual(getThinkingConfig("gemini-3.7-flash-high"), { includeThoughts: true, thinkingBudget: -1 });
  // Pro high -> 10001
  assert.deepEqual(getThinkingConfig("gemini-pro-agent", "high"), { includeThoughts: true, thinkingBudget: 10001 });
  // Pro low -> 1001
  assert.deepEqual(getThinkingConfig("gemini-3.1-pro-low"), { includeThoughts: true, thinkingBudget: 1001 });
  // Claude -> 1024
  assert.deepEqual(getThinkingConfig("claude-sonnet-4-6"), { includeThoughts: true, thinkingBudget: 1024 });
  // GPT-OSS -> 8192
  assert.deepEqual(getThinkingConfig("gpt-oss-120b-medium"), { includeThoughts: true, thinkingBudget: 8192 });
  // Off -> 0
  assert.deepEqual(getThinkingConfig("gemini-3.8-flash", "off"), { includeThoughts: false, thinkingBudget: 0 });
});

test("Seam 1: session trajectory and numeric sessionId are deterministic v5 UUID and int64", () => {
  const contextA = { messages: [{ role: "user", content: "session-seed-alpha" }] };
  const contextB = { messages: [{ role: "user", content: "session-seed-alpha" }] };
  const contextC = { messages: [{ role: "user", content: "session-seed-beta" }] };

  const bodyA = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: contextA,
  });
  const bodyB = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: contextB,
  });
  const bodyC = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: contextC,
  });

  // Same seed produces identical trajectory and numeric session ID
  assert.equal(bodyA.request.labels.trajectory_id, bodyB.request.labels.trajectory_id);
  assert.equal(bodyA.request.sessionId, bodyB.request.sessionId);

  // Different seed produces different trajectory and numeric session ID
  assert.notEqual(bodyA.request.labels.trajectory_id, bodyC.request.labels.trajectory_id);
  assert.notEqual(bodyA.request.sessionId, bodyC.request.sessionId);

  // Trajectory is v5 UUID
  assert.match(
    bodyA.request.labels.trajectory_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );

  // SessionId is signed 64-bit int string
  assert.match(bodyA.request.sessionId, /^-?\d+$/);
  const n = BigInt(bodyA.request.sessionId);
  const minInt64 = BigInt("-9223372036854775808");
  const maxInt64 = BigInt("9223372036854775807");
  assert.ok(n >= minInt64 && n <= maxInt64);
});

test("Seam 1: tool conversion formats parametersJsonSchema for Gemini and normalizes const", () => {
  const agentTool = {
    name: "Agent",
    description: "Launch a new agent",
    parameters: {
      type: "object",
      properties: {
        subagent_type: {
          type: "string",
          anyOf: [
            { const: "general-purpose" },
            { const: "Explore" },
          ],
        },
      },
    },
  };

  const todoTool = {
    name: "todo",
    description: "Manage task list",
    parameters: {
      type: "object",
      properties: {
        metadata: {
          type: "object",
          patternProperties: { "^.*$": {} },
          description: "Arbitrary metadata",
        },
      },
    },
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: { messages: [{ role: "user", content: "hi" }], tools: [agentTool, todoTool] },
  });

  const decls = body.request.tools[0].functionDeclarations;
  assert.equal(decls.length, 2);

  // Gemini must use parametersJsonSchema, not parameters
  assert.equal(decls[0].parameters, undefined);
  assert.ok(decls[0].parametersJsonSchema);
  assert.deepEqual(decls[0].parametersJsonSchema.properties.subagent_type, agentTool.parameters.properties.subagent_type);

  // patternProperties must be preserved in parametersJsonSchema for Gemini
  const todoSchema = decls[1].parametersJsonSchema;
  assert.ok(todoSchema.properties.metadata.patternProperties);
});

test("Seam 1: tool conversion formats legacy parameters for Claude/GPT-OSS and strips unsupported fields", () => {
  const agentTool = {
    name: "Agent",
    description: "Launch a new agent",
    parameters: {
      type: "object",
      properties: {
        subagent_type: {
          type: "string",
          anyOf: [
            { const: "general-purpose" },
            { const: "Explore" },
          ],
        },
        mode: {
          type: ["string", "null"],
          default: "auto",
        },
      },
    },
  };

  const todoTool = {
    name: "todo",
    description: "Manage task list",
    parameters: {
      type: "object",
      properties: {
        metadata: {
          type: "object",
          patternProperties: { "^.*$": {} },
          additionalProperties: true,
          description: "Arbitrary metadata",
        },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
        },
      },
    },
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("claude-sonnet-4-6"),
    context: { messages: [{ role: "user", content: "hi" }], tools: [agentTool, todoTool] },
  });

  const decls = body.request.tools[0].functionDeclarations;
  assert.equal(decls.length, 2);

  // Claude/GPT-OSS must use legacy parameters, not parametersJsonSchema
  assert.equal(decls[0].parametersJsonSchema, undefined);
  assert.ok(decls[0].parameters);

  // anyOf, patternProperties, additionalProperties, default must be stripped from legacy parameters
  const agentParams = decls[0].parameters;
  assert.equal(agentParams.properties.subagent_type.anyOf, undefined);
  assert.equal(agentParams.properties.subagent_type.type, "string");
  // Union type ["string", "null"] normalized to "string"
  assert.equal(agentParams.properties.mode.type, "string");
  assert.equal(agentParams.properties.mode.default, undefined);

  const todoParams = decls[1].parameters;
  assert.equal(todoParams.properties.metadata.patternProperties, undefined);
  assert.equal(todoParams.properties.metadata.additionalProperties, undefined);
  assert.equal(todoParams.properties.metadata.type, "object");
  assert.deepEqual(todoParams.properties.status.enum, ["pending", "in_progress", "completed"]);

  // Entire parameters must only contain allowlisted keys
  const allowedKeys = new Set(["type", "description", "properties", "required", "items", "enum"]);
  for (const key of Object.keys(agentParams)) {
    assert.ok(allowedKeys.has(key), `Disallowed key ${key} in root`);
  }
});

test("Seam 1: tool conversion strips $defs and $schema metadata", () => {
  const toolWithMeta = {
    name: "meta_tool",
    description: "Tool with $schema and $defs",
    parameters: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        theme: { type: "string" },
      },
      $defs: {
        Unused: { type: "string" },
      },
    },
  };

  const geminiBody = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: { messages: [{ role: "user", content: "hi" }], tools: [toolWithMeta] },
  });
  const geminiDecl = geminiBody.request.tools[0].functionDeclarations[0];
  assert.ok(geminiDecl?.parametersJsonSchema);
  assert.equal(geminiDecl.parametersJsonSchema.$schema, undefined);
  assert.equal(geminiDecl.parametersJsonSchema.$defs, undefined);

  const claudeBody = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("claude-sonnet-4-6"),
    context: { messages: [{ role: "user", content: "hi" }], tools: [toolWithMeta] },
  });
  const claudeDecl = claudeBody.request.tools[0].functionDeclarations[0];
  assert.ok(claudeDecl?.parameters);
  assert.equal(claudeDecl.parameters.$schema, undefined);
  assert.equal(claudeDecl.parameters.$defs, undefined);
});

test("Seam 1: resolveModelPlan maps Public Model IDs to Runtime Model IDs", () => {
  assert.equal(resolveModelPlan("gemini-3.8-flash", "high", STATIC_SNAPSHOT).runtimeModelId, "gemini-3.8-flash-high");
  assert.equal(resolveModelPlan("gemini-3.8-flash", "medium", STATIC_SNAPSHOT).runtimeModelId, "gemini-3.8-flash-medium");
  assert.equal(resolveModelPlan("gemini-3.8-flash", "low", STATIC_SNAPSHOT).runtimeModelId, "gemini-3.8-flash-low");
  assert.equal(resolveModelPlan("gemini-3.8-flash", "off", STATIC_SNAPSHOT).runtimeModelId, "gemini-3.8-flash-low");

  assert.equal(resolveModelPlan("gemini-3.1-pro", "high", STATIC_SNAPSHOT).runtimeModelId, "gemini-pro-agent");
  assert.equal(resolveModelPlan("gemini-3.1-pro", "low", STATIC_SNAPSHOT).runtimeModelId, "gemini-3.1-pro-low");

  assert.equal(resolveModelPlan("claude-opus-4-6", undefined, STATIC_SNAPSHOT).runtimeModelId, "claude-opus-4-6-thinking");
  assert.equal(resolveModelPlan("claude-sonnet-4-6", undefined, STATIC_SNAPSHOT).runtimeModelId, "claude-sonnet-4-6");
  assert.equal(resolveModelPlan("gpt-oss-120b", undefined, STATIC_SNAPSHOT).runtimeModelId, "gpt-oss-120b-medium");

  // Live-captured 2026-09-06 (agy 1.1.26): effort selects the variant runtime ID.
  assert.equal(resolveModelPlan("gemini-3.7-flash", "high", STATIC_SNAPSHOT).runtimeModelId, "gemini-3.7-flash-high");
  assert.equal(resolveModelPlan("gemini-3.7-flash", "medium", STATIC_SNAPSHOT).runtimeModelId, "gemini-3.7-flash-medium");
  assert.equal(resolveModelPlan("gemini-3.7-flash", "low", STATIC_SNAPSHOT).runtimeModelId, "gemini-3.7-flash-low");

  // If already suffixed, keep it unchanged
  assert.equal(resolveModelPlan("gemini-3.7-flash-high", undefined, STATIC_SNAPSHOT).runtimeModelId, "gemini-3.7-flash-high");
});

test("Seam 1: resolveModelPlan bundles enum, thinking budget, and non-Gemini flag", () => {
  const flash = resolveModelPlan("gemini-3.8-flash", "high", STATIC_SNAPSHOT);
  assert.equal(flash.modelEnum, "MODEL_PLACEHOLDER_M318");
  assert.deepEqual(flash.thinkingConfig, { includeThoughts: true, thinkingBudget: -1 });
  assert.equal(flash.isNonGemini, false);
  assert.equal(flash.isClaude, false);

  const claude = resolveModelPlan("claude-opus-4-6", undefined, STATIC_SNAPSHOT);
  assert.equal(claude.modelEnum, "MODEL_PLACEHOLDER_M26");
  assert.deepEqual(claude.thinkingConfig, { includeThoughts: true, thinkingBudget: 1024 });
  assert.equal(claude.isNonGemini, true);
  assert.equal(claude.isClaude, true);

  const unknown = resolveModelPlan("gemini-99.9-flash-high", undefined, STATIC_SNAPSHOT);
  assert.equal(unknown.modelEnum, "");
});

test("Seam 1: resolveModelPlan reads the passed snapshot, not live globals", async () => {
  const stale = getCatalogSnapshot();
  assert.equal(resolveModelPlan("x-high", undefined, stale).modelEnum, "");

  await refreshCatalog({
    allowNetwork: false,
    stored: {
      models: [],
      "pi-provider-antigravity": {
        modelEnums: { "x-high": "ENUM_X" },
        runtimeIds: ["x-high"],
      },
    },
  });

  const live = getCatalogSnapshot();
  assert.ok(live.version > stale.version);
  assert.equal(resolveModelPlan("x-high", undefined, stale).modelEnum, "");
  assert.equal(resolveModelPlan("x-high", undefined, live).modelEnum, "ENUM_X");
});

test("Seam 1: Turn Trace derives stable session identities across calls", () => {
  const context = { messages: [{ role: "user", content: "hello" }] };
  const a = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.8-flash-high"),
    context,
  });
  const b = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.8-flash-high"),
    context,
  });
  assert.equal(a.request.labels.trajectory_id, b.request.labels.trajectory_id);
  assert.equal(a.request.sessionId, b.request.sessionId);
  assert.deepEqual(a.request.contents, [{ role: "user", parts: [{ text: "hello" }] }]);
});

test("Seam 1: Turn Trace appends continuation after an incomplete model turn", () => {
  const context = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "partial" },
    ],
  };
  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.8-flash-high"),
    context,
  });
  const contents = body.request.contents;
  assert.deepEqual(contents[contents.length - 1], {
    role: "user",
    parts: [{ text: "continue" }],
  });
});

test("Seam 1: buildAntigravityRequestBody with complex tools generates valid payload without unknown const", () => {
  const context = {
    messages: [{ role: "user", content: "test" }],
    tools: [
      {
        name: "Agent",
        description: "Launch agent",
        parameters: {
          type: "object",
          properties: {
            subagent_type: {
              anyOf: [{ const: "general-purpose" }, { const: "Explore" }],
            },
          },
        },
      },
      {
        name: "todo",
        description: "Todo list",
        parameters: {
          type: "object",
          properties: {
            metadata: {
              type: "object",
              patternProperties: { "^.*$": {} },
            },
          },
        },
      },
    ],
  };

  // Gemini request
  const geminiBody = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.8-flash-high"),
    context,
  });
  assert.ok(geminiBody.request.tools);
  const geminiDecls = geminiBody.request.tools[0].functionDeclarations;
  assert.equal(geminiDecls.length, 2);
  assert.ok(geminiDecls[0].parametersJsonSchema);
  assert.equal(geminiDecls[0].parameters, undefined);
  assert.ok(geminiDecls[0].parametersJsonSchema.properties.subagent_type);

  // Claude request
  const claudeBody = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("claude-sonnet-4-6"),
    context,
  });
  assert.ok(claudeBody.request.tools);
  const claudeDecls = claudeBody.request.tools[0].functionDeclarations;
  assert.equal(claudeDecls.length, 2);
  assert.ok(claudeDecls[0].parameters);
  assert.equal(claudeDecls[0].parametersJsonSchema, undefined);
  const claudeStr = JSON.stringify(claudeBody);
  assert.ok(!claudeStr.includes('"patternProperties"'), "Claude request must not contain patternProperties");
  assert.ok(!claudeStr.includes('"const"'), "Claude request must not contain 'const'");
});

test("Seam 1: multi-turn conversation maintains fixed trajectoryId/sessionId and increments sequence counters", () => {
  const userPrompt = "Hello Antigravity, calculate fibonacci";

  // Turn 1 context
  const contextTurn1 = {
    messages: [
      { role: "user", content: [{ type: "text", text: userPrompt }] },
    ],
  };

  const body1 = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: contextTurn1,
  });

  const trajectoryId1 = body1.request.labels.trajectory_id;
  const sessionId1 = body1.request.sessionId;

  assert.equal(body1.request.labels.request_id, `${trajectoryId1}-0`);
  assert.equal(body1.request.labels.last_step_index, "0");
  assert.match(body1.requestId, new RegExp(`/${trajectoryId1}/1$`));

  // Turn 2 context (Assistant called tool, Tool returned result)
  const contextTurn2 = {
    messages: [
      ...contextTurn1.messages,
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_math_1",
            name: "calculate",
            arguments: { n: 10 },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_math_1",
        toolName: "calculate",
        content: "55",
      },
    ],
  };

  const body2 = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: contextTurn2,
  });

  // trajectoryId and numeric sessionId MUST remain constant across turns
  assert.equal(body2.request.labels.trajectory_id, trajectoryId1);
  assert.equal(body2.request.sessionId, sessionId1);

  // request_id sequence increments to 1
  assert.equal(body2.request.labels.request_id, `${trajectoryId1}-1`);
  // contents.length is 3, so last_step_index is 2
  assert.equal(body2.request.labels.last_step_index, "2");
  assert.match(body2.requestId, new RegExp(`/${trajectoryId1}/3$`));

  // Turn 3 context (Assistant completed answer, User asked follow-up)
  const contextTurn3 = {
    messages: [
      ...contextTurn2.messages,
      {
        role: "assistant",
        content: "Fibonacci(10) is 55.",
      },
      {
        role: "user",
        content: "Now what about 11?",
      },
    ],
  };

  const body3 = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: contextTurn3,
  });

  // Still strictly equal
  assert.equal(body3.request.labels.trajectory_id, trajectoryId1);
  assert.equal(body3.request.sessionId, sessionId1);

  // request_id sequence increments to 2
  assert.equal(body3.request.labels.request_id, `${trajectoryId1}-2`);
  // contents.length is 5 (user, assistant, toolResult, assistant, user), last_step_index is 4
  assert.equal(body3.request.labels.last_step_index, "4");
  assert.match(body3.requestId, new RegExp(`/${trajectoryId1}/5$`));

  // Different conversation prompt MUST produce a different trajectoryId
  const differentContext = {
    messages: [{ role: "user", content: "Write a poem about space" }],
  };
  const bodyDifferent = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: differentContext,
  });
  assert.notEqual(bodyDifferent.request.labels.trajectory_id, trajectoryId1);
  assert.notEqual(bodyDifferent.request.sessionId, sessionId1);
});

test("Seam 1 (Strict Wire Parity): All multi-turn capture fixtures (Turns 1, 2, 4, 5) share invariant session identities and proportional step indices", () => {
  const turns = [
    { name: "Turn 1", fixture: fixtureTurn1, expectedStepIndex: "0", expectedStepCount: 1, expectedReqIdSuffix: 0 },
    { name: "Turn 2", fixture: fixtureTurn2, expectedStepIndex: "2", expectedStepCount: 3, expectedReqIdSuffix: 1 },
    { name: "Turn 4", fixture: fixtureTurn4, expectedStepIndex: "20", expectedStepCount: 21, expectedReqIdSuffix: 9 },
    { name: "Turn 5", fixture: fixtureTurn5, expectedStepIndex: "26", expectedStepCount: 27, expectedReqIdSuffix: 11 },
  ];

  const baseTrajId = fixtureTurn1.body.request.labels.trajectory_id;
  const baseSessionId = fixtureTurn1.body.request.sessionId;

  for (const t of turns) {
    const body = t.fixture.body;
    // 1. Session ID & Trajectory ID never mutate across turns
    assert.equal(body.request.labels.trajectory_id, baseTrajId, `${t.name} trajectory_id drifted`);
    assert.equal(body.request.sessionId, baseSessionId, `${t.name} sessionId drifted`);
    assert.equal(body.project, "aicode-consumers");
    assert.equal(body.userAgent, "antigravity");
    assert.equal(body.requestType, "agent");

    // 2. Step index and step count match exactly
    assert.equal(body.request.labels.last_step_index, t.expectedStepIndex, `${t.name} last_step_index mismatch`);
    assert.equal(body.request.contents.length, t.expectedStepCount, `${t.name} contents.length mismatch`);
    assert.match(body.requestId, new RegExp(`/${baseTrajId}/${t.expectedStepCount}$`), `${t.name} requestId count mismatch`);
    assert.equal(body.request.labels.request_id, `${baseTrajId}-${t.expectedReqIdSuffix}`, `${t.name} request_id sequence mismatch`);
  }
});

test("Seam 1 (Strict Wire Parity): buildAntigravityRequestBody reproduces Turn 4 and Turn 5 wire envelope from capture data", () => {
  // Replay Turn 4 contents into builder
  const mockMessagesTurn4 = [];
  for (let i = 0; i < 9; i++) {
    mockMessagesTurn4.push({ role: "user", content: `user step ${i}` });
    mockMessagesTurn4.push({ role: "assistant", content: `assistant step ${i}` });
  }
  // Turn 4 has contents.length = 21, so 9 assistant turns gives request_id sequence 9
  const bodyTurn4 = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: { messages: mockMessagesTurn4 },
  });

  const trajId = bodyTurn4.request.labels.trajectory_id;
  const sessId = bodyTurn4.request.sessionId;

  assert.equal(bodyTurn4.request.labels.request_id, `${trajId}-9`);
  assert.match(trajId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(sessId, /^-?\d+$/);

  // Replay Turn 5: 11 assistant turns gives request_id sequence 11
  const mockMessagesTurn5 = [...mockMessagesTurn4];
  mockMessagesTurn5.push({ role: "user", content: "user step 9" });
  mockMessagesTurn5.push({ role: "assistant", content: "assistant step 9" });
  mockMessagesTurn5.push({ role: "user", content: "user step 10" });
  mockMessagesTurn5.push({ role: "assistant", content: "assistant step 10" });
  mockMessagesTurn5.push({ role: "user", content: "user step 11" });

  const bodyTurn5 = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: { messages: mockMessagesTurn5 },
  });

  assert.equal(bodyTurn5.request.labels.request_id, `${trajId}-11`);
  assert.equal(bodyTurn5.request.labels.trajectory_id, trajId);
  assert.equal(bodyTurn5.request.sessionId, sessId);
});

test("Seam 1 (400 fix, agy 1.1.26 capture 2026-09-05): toolResult wire shape matches agy", () => {
  const context = {
    messages: [
      { role: "user", content: "list" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_json_1", name: "bash", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_json_1",
        toolName: "bash",
        // Looks like JSON — must NOT be sent raw or the API 400s with
        // 'Proto field is not repeating, cannot start list'.
        content: '[{"foo":1},{"bar":2}]',
      },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  const toolTurn = body.request.contents[2];
  const fr = toolTurn.parts[0].functionResponse;
  assert.deepEqual(fr.response, { output: '[{"foo":1},{"bar":2}]' });

  // Captured call_308831: failed view_file still uses the "output" key
  // ({ output: "...Encountered error in tool execution: ..." }), never "error".
  const errContext = {
    messages: [
      { role: "user", content: "read missing" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_err_1", name: "bash", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_err_1",
        toolName: "bash",
        content: "exit 1: file not found",
        isError: true,
      },
    ],
  };
  const errBody = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: errContext,
  });
  assert.deepEqual(errBody.request.contents[2].parts[0].functionResponse.response, {
    output: "exit 1: file not found",
  });

  // Captured call_387703: images nest INSIDE functionResponse.parts as
  // [{ inlineData: { mimeType, data } }], not as sibling parts.
  const imgContext = {
    messages: [
      { role: "user", content: "shot" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_img_1", name: "snap", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_img_1",
        toolName: "snap",
        content: [
          { type: "text", text: "screenshot" },
          { type: "image", mimeType: "image/png", data: "iVBORw0=" },
        ],
      },
    ],
  };
  const imgBody = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: imgContext,
  });
  const imgTurn = imgBody.request.contents[2];
  assert.equal(imgTurn.parts.length, 1);
  assert.deepEqual(imgTurn.parts[0].functionResponse.response, { output: "screenshot" });
  assert.deepEqual(imgTurn.parts[0].functionResponse.parts, [
    { inlineData: { mimeType: "image/png", data: "iVBORw0=" } },
  ]);
});

test("Seam 1 (agy 1.1.26 capture 2026-09-06, turn6): failed tool uses output key", () => {
  // Live-captured view_file failure: error text rides on response.output,
  // never a sibling "error" key; role stays "model" with the call id kept.
  const contents = fixtureTurn6.body.request.contents;
  const frTurn = contents.find((c) => c.parts?.some((p) => p.functionResponse));
  assert.ok(frTurn, "turn6 must contain a functionResponse turn");
  assert.equal(frTurn.role, "model");
  const fr = frTurn.parts[0].functionResponse;
  assert.equal(fr.name, "view_file");
  assert.ok(fr.id, "agy keeps functionCall id on Gemini error results");
  assert.deepEqual(Object.keys(fr.response), ["output"]);
  assert.match(fr.response.output, /Encountered error in tool execution/);
});

test("Seam 1: Thought Signature validation accepts base64 and strips invalid/foreign reasoning envelopes", () => {
  const invalidSignatures = [
    undefined,
    null,
    "",
    12345,
    {},
    "{not_base64}",
    "invalid base64 with spaces",
    "sig:with:colons",
    JSON.stringify({
      id: "rs_6a9bd223f3963fc53d7f4ea6",
      type: "reasoning",
      encrypted_content: "Q-PaDgGtB1Aro5wGpI...",
    }),
  ];

  for (const badSig of invalidSignatures) {
    const body = buildAntigravityRequestBody({
      projectId: "aicode-consumers",
      plan: staticPlan("gemini-3.7-flash-high"),
      context: {
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [{ type: "text", text: "ans", thoughtSignature: badSig }],
          },
          { role: "user", content: "next" },
        ],
      },
    });
    const assistantPart = body.request.contents[1].parts[0];
    assert.equal(assistantPart.thoughtSignature, undefined, `Failed to strip bad signature: ${badSig}`);
  }

  const validSignatures = [
    "sig_12345",
    "EtUOCtIOARFNMg8lE2aQ3yiigw==",
  ];
  for (const goodSig of validSignatures) {
    const body = buildAntigravityRequestBody({
      projectId: "aicode-consumers",
      plan: staticPlan("gemini-3.7-flash-high"),
      context: {
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [{ type: "text", text: "ans", thoughtSignature: goodSig }],
          },
          { role: "user", content: "next" },
        ],
      },
    });
    const assistantPart = body.request.contents[1].parts[0];
    assert.equal(assistantPart.thoughtSignature, goodSig);
  }
});

test("Seam 1: buildAntigravityRequestBody ignores foreign JSON thoughtSignatures (OpenAI Responses) and converts thinking to plain text", () => {
  const openAiJsonSig = JSON.stringify({
    id: "rs_6a9bd223f3963fc53d7f4ea6:rs_01a070acd9f57f63ac229b9a658e398d",
    type: "reasoning",
    status: "completed",
    encrypted_content: "Q-PaDgGtB1Aro5wGpI-zyJbL7F2yuVheqOQ3qG4hy2ppjh9BYLs8ydbBFFN_OYYwTewMSGCa983qgoxTEFe631ty6R...",
    summary: [
      {
        type: "summary_text",
        text: "Evaluating dependency availability and formatting output.",
      },
    ],
  });

  const context = {
    messages: [
      {
        role: "user",
        content: "Run test",
      },
      {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.4",
        thoughtSignature: openAiJsonSig,
        content: [
          {
            type: "thinking",
            thinking: "Analyzing previous test runs...",
            thinkingSignature: openAiJsonSig,
          },
          {
            type: "toolCall",
            id: "call_tool_1",
            name: "bash",
            arguments: { command: "npm test" },
            thoughtSignature: openAiJsonSig,
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_tool_1",
        toolName: "bash",
        content: "test passed",
      },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  const serialized = JSON.stringify(body);
  // CRITICAL: Request contents must NEVER contain invalid JSON strings as thoughtSignature
  assert.equal(serialized.includes(openAiJsonSig), false);
  assert.equal(serialized.includes("thoughtSignature"), false);
  assert.equal(serialized.includes("thought_signature"), false);

  const modelTurn = body.request.contents[1];
  assert.equal(modelTurn.role, "model");
  // Foreign thinking was converted to plain text (no thought: true, no thoughtSignature)
  assert.equal(modelTurn.parts[0].thought, undefined);
  assert.equal(modelTurn.parts[0].thoughtSignature, undefined);
  assert.equal(modelTurn.parts[0].text, "Analyzing previous test runs...");

  // Tool call does not carry the foreign signature
  assert.equal(modelTurn.parts[1].functionCall.name, "bash");
  assert.equal(modelTurn.parts[1].thoughtSignature, undefined);
});

test("Seam 1: buildAntigravityRequestBody extracts summary from foreign JSON signature when thinking text is empty", () => {
  const openAiJsonSig = JSON.stringify({
    id: "rs_summary_only",
    type: "reasoning",
    status: "completed",
    summary: [
      {
        type: "summary_text",
        text: "Summary extracted from foreign reasoning item.",
      },
    ],
  });

  const context = {
    messages: [
      {
        role: "user",
        content: "Hello",
      },
      {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.4",
        content: [
          {
            type: "thinking",
            thinking: "",
            thinkingSignature: openAiJsonSig,
          },
          {
            type: "text",
            text: "Here is the response.",
          },
        ],
      },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  const modelTurn = body.request.contents[1];
  assert.equal(modelTurn.role, "model");
  assert.equal(modelTurn.parts.length, 2);
  assert.equal(modelTurn.parts[0].text, "Summary extracted from foreign reasoning item.");
  assert.equal(modelTurn.parts[0].thought, undefined);
  assert.equal(modelTurn.parts[0].thoughtSignature, undefined);
  assert.equal(modelTurn.parts[1].text, "Here is the response.");
});

test("Seam 1: buildAntigravityRequestBody drops cross-model thoughtSignature between Claude and Gemini", () => {
  const context = {
    messages: [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        provider: "antigravity",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "thinking",
            thinking: "Claude thinking...",
            thoughtSignature: "claude_sig_1234",
          },
        ],
      },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  const modelTurn = body.request.contents[1];
  assert.equal(modelTurn.role, "model");
  // Incompatible model: thinking converted to plain text, signature dropped
  assert.equal(modelTurn.parts[0].thought, undefined);
  assert.equal(modelTurn.parts[0].thoughtSignature, undefined);
  assert.equal(modelTurn.parts[0].text, "Claude thinking...");
});

test("Seam 1: buildAntigravityRequestBody preserves valid thoughtSignature for same provider and model family", () => {
  const validSig = "EtUOCtIOARFNMg8lE2aQ3yiigw==";
  const context = {
    messages: [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        provider: "antigravity",
        model: "gemini-3.7-flash",
        content: [
          {
            type: "thinking",
            thinking: "Gemini thinking...",
            thoughtSignature: validSig,
          },
          {
            type: "toolCall",
            id: "call_1",
            name: "bash",
            arguments: {},
            thoughtSignature: validSig,
          },
        ],
      },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"), // same base model: gemini-3.7-flash
    context,
  });

  const modelTurn = body.request.contents[1];
  assert.equal(modelTurn.role, "model");
  assert.equal(modelTurn.parts[0].thought, true);
  // agy CLI part-split (#15): thinking stays signature-free, the signature
  // rides on the following functionCall part.
  assert.equal("thoughtSignature" in modelTurn.parts[0], false);
  assert.equal(modelTurn.parts[1].thoughtSignature, validSig);
});

test("Seam 1 (Verified via agy mitmproxy): Gemini 3.7 and Gemini 3.8 share thoughtSignatures seamlessly", () => {
  // Wire payload test: Gemini 3.7 signature replayed to Gemini 3.8 preserves signature
  const validSig37 = "ErYHCrMHARFNMg9KW14YWa1Z";
  const context = {
    messages: [
      { role: "user", content: "say hello in exactly three words" },
      {
        role: "assistant",
        provider: "antigravity",
        model: "gemini-3.7-flash-high",
        content: [
          {
            type: "text",
            text: "Hello to you!",
            thoughtSignature: validSig37,
          },
        ],
      },
      { role: "user", content: "say another three words" },
    ],
  };

  const geminiBody = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.8-flash-high"),
    context,
  });

  const geminiTurn = geminiBody.request.contents[1];
  assert.equal(geminiTurn.role, "model");
  assert.equal(geminiTurn.parts[0].text, "Hello to you!");
  // Matching real agy capture: 3.7 thoughtSignature is preserved when continuing to 3.8
  assert.equal(geminiTurn.parts[0].thoughtSignature, validSig37);

  // Cross-family Claude -> Gemini drops signature
  const claudeToGeminiBody = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.8-flash-high"),
    context: {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          provider: "antigravity",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Claude response", thoughtSignature: validSig37 }],
        },
        { role: "user", content: "next" },
      ],
    },
  });
  assert.equal(claudeToGeminiBody.request.contents[1].parts[0].thoughtSignature, undefined);

  // Same-family Claude Sonnet -> Claude Opus preserves signature
  const claudeToClaudeBody = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("claude-opus-4-6-thinking"),
    context: {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          provider: "antigravity",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Claude response", thoughtSignature: validSig37 }],
        },
        { role: "user", content: "next" },
      ],
    },
  });
  assert.equal(claudeToClaudeBody.request.contents[1].parts[0].thoughtSignature, validSig37);
});

test("Seam 1: tool call IDs sanitize special characters and truncate to 64 chars", () => {
  const longId = "call_" + "a".repeat(100);
  const contextLong = {
    messages: [
      { role: "user", content: "run" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_123908", name: "list_dir", input: {} },
          { type: "tool_use", id: "call_123|part2:extra", name: "bash", input: {} },
          { type: "tool_use", id: longId, name: "read", input: {} },
        ],
      },
      { role: "user", content: "next" },
    ],
  };

  const bodyLong = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context: contextLong,
  });

  const parts = bodyLong.request.contents[1].parts;
  assert.equal(parts[0].functionCall.id, "call_123908");
  assert.equal(parts[1].functionCall.id, "call_123_part2_extra");
  assert.equal(parts[2].functionCall.id.length, 64);
  assert.match(parts[2].functionCall.id, /^call_a+$/);

  // Verifies toolCall and toolResult synchronization across OpenAI-style piped IDs
  const pipedId = "call_response_api_12345|tool_step_67890";
  const context = {
    messages: [
      { role: "user", content: "Check" },
      {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.4",
        content: [
          {
            type: "toolCall",
            id: pipedId,
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: pipedId,
        content: "file1",
      },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  const assistantTurn = body.request.contents[1];
  const toolResultTurn = body.request.contents[2];
  assert.equal(assistantTurn.parts[0].functionCall.id, "call_response_api_12345_tool_step_67890");
  assert.equal(toolResultTurn.parts[0].functionResponse.id, "call_response_api_12345_tool_step_67890");
  assert.equal(toolResultTurn.parts[0].functionResponse.name, "bash");
});

test("Seam 1: buildAntigravityRequestBody skips aborted and errored assistant messages", () => {
  const context = {
    messages: [
      { role: "user", content: "Query 1" },
      {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "thinking", thinking: "Incomplete thoughts..." }],
      },
      { role: "user", content: "Query 2 (retried)" },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  // Aborted turn is skipped so contents has only Query 1 and Query 2
  assert.equal(body.request.contents.length, 2);
  assert.equal(body.request.contents[0].parts[0].text, "Query 1");
  assert.equal(body.request.contents[1].parts[0].text, "Query 2 (retried)");
});

test("Seam 1 (#15): thinking replay matches the agy CLI part-split byte-for-byte (1.1.27 turn4)", () => {
  const turn4 = JSON.parse(
    fs.readFileSync("captures/agy_cli_1.1.27/stream_turn4_thinking.req.json", "utf-8")
  );
  const fixtureTurn = turn4.body.request.contents[1];
  assert.equal(fixtureTurn.parts[0].thought, true);
  assert.equal("thoughtSignature" in fixtureTurn.parts[0], false);

  // Stored history as this provider's own stream adapter leaves it: the thinking
  // block carries the closing signature, the visible text carries none, and the
  // message carries it too.
  const sig = fixtureTurn.parts[1].thoughtSignature;
  const context = {
    messages: [
      { role: "user", content: "train problem" },
      {
        role: "assistant",
        provider: "antigravity",
        model: "gemini-3.7-flash-high",
        thoughtSignature: sig,
        content: [
          { type: "thinking", thinking: fixtureTurn.parts[0].text, thoughtSignature: sig },
          { type: "text", text: fixtureTurn.parts[1].text },
        ],
      },
      { role: "user", content: "reply with exactly this one word: done" },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  assert.deepEqual(body.request.contents[1], fixtureTurn);
});

test("Seam 1 (#14): Claude thinking replay matches the agy CLI part-split byte-for-byte (1.1.27 turn9)", () => {
  // Counter-capture verdict: Claude signatures DO replay within the Claude
  // family, part-split exactly like Gemini (#15) — the drop rule stays for
  // cross-family only. SSE carries the signature combined on the closing
  // thought part; history stores it on the thinking block, as the adapter leaves it.
  const turn9 = JSON.parse(
    fs.readFileSync("captures/agy_cli_1.1.27/stream_turn9_claude_followup.req.json", "utf-8")
  );
  const fixtureTurn = turn9.body.request.contents[1];
  assert.equal(fixtureTurn.parts[0].thought, true);
  assert.equal("thoughtSignature" in fixtureTurn.parts[0], false);
  const sig = fixtureTurn.parts[1].thoughtSignature;
  assert.ok(sig, "turn9 must replay the turn8 thinking signature");

  const context = {
    messages: [
      { role: "user", content: "train problem" },
      {
        role: "assistant",
        provider: "antigravity",
        model: "claude-sonnet-4-6",
        thoughtSignature: sig,
        content: [
          { type: "thinking", thinking: fixtureTurn.parts[0].text, thoughtSignature: sig },
          { type: "text", text: fixtureTurn.parts[1].text },
        ],
      },
      { role: "user", content: "reply with exactly this one word: done" },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("claude-sonnet-4-6"),
    context,
  });

  assert.deepEqual(body.request.contents[1], fixtureTurn);
});

test("Seam 1 (#15): thinking signature forwards onto a following functionCall", () => {
  const sig = "EtUOCtIOARFNMg8lE2aQ3yiigw==";
  const context = {
    messages: [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        provider: "antigravity",
        model: "gemini-3.7-flash-high",
        content: [
          { type: "thinking", thinking: "Need a directory listing.", thoughtSignature: sig },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        ],
      },
      { role: "user", content: "next" },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  const turn = body.request.contents[1];
  assert.equal(turn.parts[0].thought, true);
  assert.equal("thoughtSignature" in turn.parts[0], false);
  assert.equal(turn.parts[1].functionCall.name, "bash");
  assert.equal(turn.parts[1].thoughtSignature, sig);
});

test("Seam 1 (#15): thinking-only turn falls back to the last part (uncovered edge)", () => {
  const sig = "EtUOCtIOARFNMg8lE2aQ3yiigw==";
  const context = {
    messages: [
      { role: "user", content: "think only" },
      {
        role: "assistant",
        provider: "antigravity",
        model: "gemini-3.7-flash-high",
        content: [{ type: "thinking", thinking: "Silent reasoning.", thoughtSignature: sig }],
      },
      { role: "user", content: "next" },
    ],
  };

  const body = buildAntigravityRequestBody({
    projectId: "aicode-consumers",
    plan: staticPlan("gemini-3.7-flash-high"),
    context,
  });

  const turn = body.request.contents[1];
  assert.equal(turn.parts.length, 1);
  assert.equal(turn.parts[0].thought, true);
  assert.equal(turn.parts[0].thoughtSignature, sig);
});
