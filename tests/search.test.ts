import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { formatSearchResults, performWebSearch, SEARCH_MODEL, SEARCH_SYSTEM_INSTRUCTION } from "../src/search.ts";
import initExtension from "../src/index.ts";
import { runAntigravitySubcommand } from "../src/commands.ts";
import { NOT_LOGGED_IN } from "../src/auth.ts";

test("Search: formatSearchResults correctly inserts citation badges and formats sources", () => {
  const rawText = "Alphabet is trading between $340 and $350. Recent dividend was paid.";
  const metadata = {
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
  };

  const createdAt = "2026-09-15T15:00:00.000Z";
  const completedAt = "2026-09-15T15:00:02.000Z";
  const result = formatSearchResults(rawText, metadata, "Alphabet stock", createdAt, completedAt);

  assert.equal(result.query, "Alphabet stock");
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].title, "robinhood.com");
  assert.equal(result.sources[0].url, "https://robinhood.com/stocks/GOOGL");
  assert.equal(result.sources[1].title, "fidelity.com");

  // Verify citation [1][2] placed right after index 41 ("$350")
  assert.ok(result.formattedOutput.includes("$350[1][2]."));
  assert.ok(result.formattedOutput.includes("Sources:"));
  assert.ok(result.formattedOutput.includes("[1] [robinhood.com](https://robinhood.com/stocks/GOOGL)"));
  assert.ok(result.formattedOutput.includes("[2] [fidelity.com](https://fidelity.com/quote/GOOGL)"));
  assert.ok(result.formattedOutput.includes("Created At: 2026-09-15T15:00:00.000Z"));
  assert.ok(result.formattedOutput.includes("Completed At: 2026-09-15T15:00:02.000Z"));
});

test("Search: formatSearchResults handles empty metadata and supports gracefully", () => {
  const rawText = "Simple answer without search grounding.";
  const result = formatSearchResults(rawText, undefined, "simple query", "start", "end");
  assert.equal(result.sources.length, 0);
  assert.ok(result.formattedOutput.includes("Simple answer without search grounding."));
  assert.ok(!result.formattedOutput.includes("Sources:"));
});

test("Search: performWebSearch builds canonical request body and headers", async () => {
  const origFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: any = null;

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedHeaders = (init?.headers as Record<string, string>) || {};
    capturedBody = JSON.parse(init?.body as string);

    return new Response(
      JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "Search result text from Google." }],
              },
              groundingMetadata: {
                webSearchQueries: ["gemini release date"],
                groundingChunks: [
                  { web: { uri: "https://example.com/gemini", title: "Example" } },
                ],
              },
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const creds = { token: "ya29.test-token", projectId: "test-project-123" };
    const result = await performWebSearch(creds, {
      query: "gemini release date",
      domain: "example.com",
    });

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
    assert.equal(capturedBody.request.contents[0].parts[0].text, "gemini release date site:example.com");

    assert.equal(result.rawText, "Search result text from Google.");
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].url, "https://example.com/gemini");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Search: antigravity_websearch tool registration and execution in extension", async () => {
  let registeredTool: any = null;
  const mockPi = {
    registerProvider: () => {},
    registerCommand: () => {},
    registerTool: (tool: any) => {
      if (tool.name === "antigravity_websearch") registeredTool = tool;
    },
    on: () => {},
  };

  initExtension(mockPi as any);
  assert.ok(registeredTool, "antigravity_websearch tool must be registered");
  assert.equal(registeredTool.name, "antigravity_websearch");
  assert.ok(registeredTool.parameters);

  // 1. Unauthenticated execution
  const unauthCtx = { modelRegistry: { getApiKeyForProvider: async () => undefined } };
  const unauthRes = await registeredTool.execute("call_1", { query: "test" }, undefined, undefined, unauthCtx);
  assert.ok(unauthRes.content[0].text.includes("Not logged in"));

  // 2. Authenticated execution
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "Google stock is $345." }],
              },
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const authCtx = {
      apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
    };
    const authRes = await registeredTool.execute("call_2", { query: "GOOGL stock" }, undefined, undefined, authCtx);
    assert.ok(authRes.content[0].text.includes("Google stock is $345."));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Subcommand: /antigravity websearch runs web search and formats output", async () => {
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
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const outputs: string[] = [];
    const mockCtx = {
      hasUI: false,
      apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
      signal: undefined,
    } as any;

    // Run without query -> shows usage warning
    await runAntigravitySubcommand("websearch", mockCtx, undefined, {} as any);

    // Run with query -> outputs result
    await runAntigravitySubcommand("websearch Seoul weather", {
      ...mockCtx,
      ui: { notify: (msg: string) => outputs.push(msg) },
      hasUI: true,
    }, undefined, {} as any);

    assert.ok(outputs.some((o) => o.includes("Today is sunny in Seoul.")));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Search: wire fixtures match captured search request/response", () => {
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
  const candidate = respFixture.response?.candidates?.[0];
  assert.ok(candidate, "candidate must exist in response fixture");
  assert.ok(candidate.groundingMetadata?.groundingChunks?.length > 0, "must contain grounding chunks");

  const rawText = candidate.content.parts.map((p: any) => p.text || "").join("");
  const formatted = formatSearchResults(
    rawText,
    candidate.groundingMetadata,
    "AI news September 2026",
    "2026-09-15T15:00:00.000Z",
    "2026-09-15T15:00:02.000Z"
  );
  assert.ok(formatted.sources.length > 0, "sources must be formatted from chunks");
  assert.ok(formatted.formattedOutput.includes("Sources:"));
});

