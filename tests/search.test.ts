import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  registerWebSearchTool,
  executeWebSearchCommand,
  WEB_SEARCH_TOOL_NAME,
  SEARCH_MODEL,
  SEARCH_SYSTEM_INSTRUCTION,
} from "../src/search.ts";
import initExtension from "../src/index.ts";
import { createAntigravityCommands } from "../src/commands.ts";

function getRegisteredTool() {
  let tool: any = null;
  registerWebSearchTool({
    registerTool: (t: any) => {
      if (t.name === WEB_SEARCH_TOOL_NAME) tool = t;
    },
  } as any);
  return tool;
}

test("Web Search Grounding: tool registers with canonical metadata and parameters", () => {
  const tool = getRegisteredTool();
  assert.ok(tool, "antigravity_websearch tool must be registered");
  assert.equal(tool.name, WEB_SEARCH_TOOL_NAME);
  assert.equal(tool.label, "Antigravity Web Search");
  assert.ok(tool.parameters);
  assert.equal(typeof tool.execute, "function");
});

test("Web Search Grounding: tool returns error when unauthenticated", async () => {
  const tool = getRegisteredTool();
  const unauthCtx = { modelRegistry: { getApiKeyForProvider: async () => undefined } };
  const res = await tool.execute("call_unauth", { query: "test query" }, undefined, undefined, unauthCtx);

  assert.ok(res.content[0].text.includes("Not logged in"));
  assert.equal(res.details?.error, "not_logged_in");
});

test("Web Search Grounding: tool builds canonical wire request and parses grounding citations", async () => {
  const origFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: any = null;

  const mockResponse = {
    response: {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Alphabet is trading between $340 and $350. Recent dividend was paid." }],
          },
          groundingMetadata: {
            webSearchQueries: ["Alphabet stock price"],
            groundingChunks: [
              { web: { uri: "https://robinhood.com/stocks/GOOGL", title: "robinhood.com" } },
              { web: { uri: "https://fidelity.com/quote/GOOGL", title: "fidelity.com" } },
            ],
            groundingSupports: [
              {
                segment: { startIndex: 0, endIndex: 41 },
                groundingChunkIndices: [0, 1],
              },
            ],
          },
        },
      ],
    },
  };

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedHeaders = (init?.headers as Record<string, string>) || {};
    capturedBody = JSON.parse(init?.body as string);

    return new Response(JSON.stringify(mockResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const tool = getRegisteredTool();
    const authCtx = {
      apiKey: JSON.stringify({ token: "ya29.test-token", projectId: "test-project-123" }),
    };

    const res = await tool.execute(
      "call_1",
      { query: "Alphabet stock", domain: "example.com" },
      undefined,
      undefined,
      authCtx,
    );

    // 1. Verify Wire Request
    assert.ok(capturedUrl.includes("v1internal:generateContent"));
    assert.equal(capturedHeaders.Authorization, "Bearer ya29.test-token");
    assert.equal(capturedHeaders["Content-Type"], "application/json");

    assert.equal(capturedBody.project, "test-project-123");
    assert.equal(capturedBody.model, SEARCH_MODEL);
    assert.equal(capturedBody.requestType, "web_search");
    assert.equal(capturedBody.request.systemInstruction.parts[0].text, SEARCH_SYSTEM_INSTRUCTION);
    assert.deepEqual(capturedBody.request.tools[0].googleSearch, {
      enhancedContent: { imageSearch: { maxResultCount: 5 } },
    });
    // domain was appended as site:
    assert.equal(capturedBody.request.contents[0].parts[0].text, "Alphabet stock site:example.com");

    // 2. Verify Output & Citations
    const outputText = res.content[0].text;
    assert.ok(outputText.includes("$350[1][2]."), "Citations [1][2] must be inserted at segment end");
    assert.ok(outputText.includes("Sources:"));
    assert.ok(outputText.includes("[1] [robinhood.com](https://robinhood.com/stocks/GOOGL)"));
    assert.ok(outputText.includes("[2] [fidelity.com](https://fidelity.com/quote/GOOGL)"));

    // 3. Verify Details
    assert.equal(res.details?.sources?.length, 2);
    assert.equal(res.details?.sources[0].url, "https://robinhood.com/stocks/GOOGL");
    assert.deepEqual(res.details?.queries, ["Alphabet stock price"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Web Search Grounding: tool handles empty metadata gracefully", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "Simple answer without search grounding." }],
              },
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const tool = getRegisteredTool();
    const authCtx = {
      apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
    };

    const res = await tool.execute("call_2", { query: "simple query" }, undefined, undefined, authCtx);
    const outputText = res.content[0].text;
    assert.ok(outputText.includes("Simple answer without search grounding."));
    assert.ok(!outputText.includes("Sources:"));
    assert.equal(res.details?.sources?.length, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Web Search Grounding: tool handles backend failure gracefully", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response("Internal Server Error", { status: 500 });
  }) as typeof fetch;

  try {
    const tool = getRegisteredTool();
    const authCtx = {
      apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
    };

    const res = await tool.execute("call_err", { query: "failing query" }, undefined, undefined, authCtx);
    assert.ok(res.content[0].text.includes("Search failed:"));
    assert.ok(res.details?.error);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Web Search Grounding: extension initialization registers the tool", () => {
  let registeredTool: any = null;
  const mockPi = {
    registerProvider: () => {},
    registerCommand: () => {},
    registerTool: (tool: any) => {
      if (tool.name === WEB_SEARCH_TOOL_NAME) registeredTool = tool;
    },
    on: () => {},
  };

  initExtension(mockPi as any);
  assert.ok(registeredTool, "antigravity_websearch must be registered during initExtension");
  assert.equal(registeredTool.name, WEB_SEARCH_TOOL_NAME);
});

test("Web Search Grounding: /antigravity websearch executes via command interface", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "Today is sunny in Seoul." }],
              },
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const outputs: string[] = [];
    const mockCtx = {
      hasUI: true,
      ui: { notify: (msg: string) => outputs.push(msg) },
      apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
      signal: undefined,
    } as any;

    // 1. Run without query -> shows usage warning
    await executeWebSearchCommand(mockCtx, "");
    assert.ok(outputs.some((o) => o.includes("Usage: /antigravity websearch")));

    // 2. Run with query -> outputs result
    await executeWebSearchCommand(mockCtx, "Seoul weather");
    assert.ok(outputs.some((o) => o.includes("Today is sunny in Seoul.")));

    // 3. Delegation from createAntigravityCommands
    const subOutputs: string[] = [];
    const cmds = createAntigravityCommands({ catalog: {} as any });
    await cmds.handle("websearch Seoul weather", {
      ...mockCtx,
      ui: { notify: (msg: string) => subOutputs.push(msg) },
    } as any);
    assert.ok(subOutputs.some((o) => o.includes("Today is sunny in Seoul.")));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Web Search Grounding: wire fixtures match captured search request/response", async () => {
  const reqFixturePath = path.resolve(import.meta.dirname, "fixtures/web_search.req.json");
  const respFixturePath = path.resolve(import.meta.dirname, "fixtures/web_search.resp.json");

  assert.ok(fs.existsSync(reqFixturePath), "web_search.req.json fixture must exist");
  assert.ok(fs.existsSync(respFixturePath), "web_search.resp.json fixture must exist");

  const reqFixture = JSON.parse(fs.readFileSync(reqFixturePath, "utf-8"));
  assert.equal(reqFixture.method, "POST");
  assert.ok(reqFixture.url.includes("v1internal:generateContent"));
  assert.equal(reqFixture.body.requestType, "web_search");
  assert.equal(reqFixture.body.model, SEARCH_MODEL);
  assert.equal(reqFixture.body.request.systemInstruction.parts[0].text, SEARCH_SYSTEM_INSTRUCTION);
  assert.deepEqual(reqFixture.body.request.tools[0].googleSearch, {
    enhancedContent: { imageSearch: { maxResultCount: 5 } },
  });

  const respFixture = JSON.parse(fs.readFileSync(respFixturePath, "utf-8"));

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(respFixture), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const tool = getRegisteredTool();
    const authCtx = {
      apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
    };

    const res = await tool.execute(
      "call_fixture",
      { query: "AI news September 2026" },
      undefined,
      undefined,
      authCtx,
    );

    assert.ok(res.details?.sources?.length > 0, "sources must be formatted from chunks");
    assert.ok(res.content[0].text.includes("Sources:"));
  } finally {
    globalThis.fetch = origFetch;
  }
});
