import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SCOPES, CLIENT_ID, AUTH_URL, REDIRECT_URI, extractCodeFromInput } from "../src/auth.ts";
import initExtension from "../src/index.ts";
import { resolveToken } from "../src/commands.ts";

const loginFixture = JSON.parse(fs.readFileSync("captures/agy_cli_1.1.26/auth_login_params.json", "utf-8"));
const refreshFixture = JSON.parse(fs.readFileSync("captures/agy_cli_1.1.26/auth_token_refresh.req.json", "utf-8"));

test("Seam Auth: OAuth client ID matches agy CLI wire traffic", () => {
  assert.equal(CLIENT_ID, loginFixture.params.client_id);
});

test("Seam Auth: OAuth endpoint and redirect URI match agy CLI wire traffic exactly", () => {
  assert.equal(AUTH_URL, loginFixture.endpoint);
  assert.equal(REDIRECT_URI, loginFixture.params.redirect_uri);
});

test("Seam Auth: OAuth scopes match agy CLI wire traffic exactly", () => {
  const fixtureScopes = loginFixture.params.scope.split(" ").sort();
  const ourScopes = [...SCOPES].sort();

  assert.deepEqual(ourScopes, fixtureScopes);
});

test("Seam Auth: token refresh payload parameters match wire fixture", () => {
  const parsedBody = new URLSearchParams(refreshFixture.body);

  assert.equal(parsedBody.get("client_id"), CLIENT_ID);
  assert.equal(parsedBody.get("grant_type"), "refresh_token");
  assert.ok(parsedBody.get("client_secret"));
  assert.ok(parsedBody.get("refresh_token"));
});

test("Seam Auth: extractCodeFromInput accepts a plain authorization code", () => {
  assert.equal(
    extractCodeFromInput("4/0ATsMZqB-dHThG7HUGJSYpHLNvRqt0LViehIUtx3B-N5xu02j1qBgldMoM-hmv6LurMY0AA"),
    "4/0ATsMZqB-dHThG7HUGJSYpHLNvRqt0LViehIUtx3B-N5xu02j1qBgldMoM-hmv6LurMY0AA"
  );
  assert.equal(extractCodeFromInput("  4/0ATsPlainCodeWithWhitespace\n"), "4/0ATsPlainCodeWithWhitespace");
});

test("Seam Auth: extractCodeFromInput strips an optional code= prefix", () => {
  assert.equal(extractCodeFromInput("code=my_code_val"), "my_code_val");
});

test("Seam Auth: extractCodeFromInput rejects callback URLs instead of passing garbage downstream", () => {
  assert.throws(
    () =>
      extractCodeFromInput(
        "https://antigravity.google/oauth-callback?state=st1&code=code123&scope=email%20profile"
      ),
    /not the callback URL/
  );
  assert.throws(() => extractCodeFromInput("?code=code456&state=st2"), /not the callback URL/);
  assert.throws(() => extractCodeFromInput("/oauth-callback?code=code789"), /not the callback URL/);
});

test("Seam Auth: extractCodeFromInput throws on empty input", () => {
  assert.throws(() => extractCodeFromInput("   "), /No authorization code/);
  assert.throws(() => extractCodeFromInput("code=   "), /No authorization code/);
});

test("Seam Auth: resolveToken extracts credentials from getApiKeyForProvider", async () => {
  const mockCtx = {
    modelRegistry: {
      getApiKeyForProvider: async (provider) => {
        if (provider === "antigravity") {
          return JSON.stringify({ token: "test_token_123", projectId: "test_proj_456" });
        }
        return undefined;
      },
    },
  };
  const result = await resolveToken(mockCtx);
  assert.deepEqual(result, { token: "test_token_123", projectId: "test_proj_456" });
});

test("Seam Auth: resolveToken returns null when unauthenticated", async () => {
  const mockCtx = {
    modelRegistry: {
      getApiKeyForProvider: async () => undefined,
    },
  };
  const result = await resolveToken(mockCtx);
  assert.equal(result, null);
});

test("Seam Auth: /antigravity login sets editor text in UI mode", async () => {
  let commandHandler;
  const mockPi = {
    registerProvider: () => {},
    registerCommand: (name, def) => {
      if (name === "antigravity") {
        commandHandler = def.handler;
      }
    },
  };
  initExtension(mockPi);
  assert.ok(commandHandler);

  let editorText = "";
  let notifyMessage = "";
  const mockCtx = {
    hasUI: true,
    ui: {
      setEditorText: (text) => {
        editorText = text;
      },
      notify: (msg) => {
        notifyMessage = msg;
      },
    },
  };

  await commandHandler("login", mockCtx);
  assert.equal(editorText, "/login antigravity");
  assert.match(notifyMessage, /Press Enter to log in to Antigravity/);
});

test("Seam Auth: /antigravity login falls back to console in non-UI mode", async () => {
  let commandHandler;
  const mockPi = {
    registerProvider: () => {},
    registerCommand: (name, def) => {
      if (name === "antigravity") {
        commandHandler = def.handler;
      }
    },
  };
  initExtension(mockPi);

  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    const mockCtx = {
      hasUI: false,
    };
    await commandHandler("login", mockCtx);
    assert.ok(logs.some((l) => l.includes("/login antigravity")));
  } finally {
    console.log = originalLog;
  }
});

test("Seam Auth: /antigravity model is an alias of models", async () => {
  let commandHandler;
  const mockPi = {
    registerProvider: () => {},
    registerCommand: (name, def) => {
      if (name === "antigravity") {
        commandHandler = def.handler;
      }
    },
  };
  initExtension(mockPi);
  assert.ok(commandHandler);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: {} }) });
  try {
    const outputs = [];
    const mockCtx = {
      hasUI: true,
      ui: { notify: (msg) => outputs.push(msg) },
      modelRegistry: { getApiKeyForProvider: async () => "fake-token" },
    };
    await commandHandler("models", mockCtx);
    await commandHandler("model", mockCtx);
    const lists = outputs.filter((m) => m.includes("Available Antigravity Models"));
    assert.equal(lists.length, 2);
    assert.equal(lists[0], lists[1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Token refresh re-resolves projectId on successful lookup", async () => {
  const { refreshAntigravityToken } = await import("../src/auth.ts");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("loadCodeAssist")) {
      return { ok: true, json: async () => ({ cloudaicompanionProject: "new-project" }) };
    }
    return { ok: true, json: async () => ({ access_token: "new-token", expires_in: 3600 }) };
  };
  try {
    const out = await refreshAntigravityToken({
      refresh: "r",
      access: JSON.stringify({ token: "old-token", projectId: "old-project" }),
      expires: 0,
    });
    const parsed = JSON.parse(out.access);
    assert.equal(parsed.token, "new-token");
    assert.equal(parsed.projectId, "new-project");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Token refresh keeps the stored projectId when lookup fails", async () => {
  const { refreshAntigravityToken } = await import("../src/auth.ts");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("loadCodeAssist")) {
      return { ok: false, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ access_token: "new-token", expires_in: 3600 }) };
  };
  try {
    const out = await refreshAntigravityToken({
      refresh: "r",
      access: JSON.stringify({ token: "old-token", projectId: "old-project" }),
      expires: 0,
    });
    const parsed = JSON.parse(out.access);
    assert.equal(parsed.projectId, "old-project");
  } finally {
    globalThis.fetch = realFetch;
  }
});
