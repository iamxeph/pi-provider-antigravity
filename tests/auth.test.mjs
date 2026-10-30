import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCodeFromInput,
  resolveCredentials,
  requireCredentials,
} from "../src/auth.ts";
import initExtension from "../src/index.ts";

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

test("Seam Auth: resolveCredentials extracts credentials from getApiKeyForProvider", async () => {
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
  const result = await resolveCredentials(mockCtx);
  assert.deepEqual(result, { token: "test_token_123", projectId: "test_proj_456" });
});

test("Seam Auth: resolveCredentials returns null when unauthenticated", async () => {
  const mockCtx = {
    modelRegistry: {
      getApiKeyForProvider: async () => undefined,
    },
  };
  const result = await resolveCredentials(mockCtx);
  assert.equal(result, null);
});

test("Seam Auth: resolveCredentials resolves polymorphically across sources", async () => {
  // 1. From modelRegistry (command/extension context)
  const ctxSource = {
    modelRegistry: {
      getApiKeyForProvider: async (p) => (p === "antigravity" ? JSON.stringify({ token: "t1", projectId: "p1" }) : undefined),
    },
  };
  assert.deepEqual(await resolveCredentials(ctxSource), { token: "t1", projectId: "p1" });

  // 2. From stream options (apiKey)
  const streamOptions = { apiKey: JSON.stringify({ token: "t2", projectId: "p2" }) };
  assert.deepEqual(await resolveCredentials(streamOptions), { token: "t2", projectId: "p2" });

  // 3. From refreshModels context (credential.access)
  const refreshCtx = { credential: { type: "oauth", access: JSON.stringify({ token: "t3", projectId: "p3" }) } };
  assert.deepEqual(await resolveCredentials(refreshCtx), { token: "t3", projectId: "p3" });

  // 4. From raw string
  assert.deepEqual(await resolveCredentials(JSON.stringify({ token: "t4", projectId: "p4" })), {
    token: "t4",
    projectId: "p4",
  });

  // 5. From plain non-json token
  assert.deepEqual(await resolveCredentials("plain-raw-token"), {
    token: "plain-raw-token",
    projectId: "aicode-consumers",
  });

  // 6. Missing / empty / null sources return null
  assert.equal(await resolveCredentials(null), null);
  assert.equal(await resolveCredentials(undefined), null);
  assert.equal(await resolveCredentials(""), null);
  assert.equal(await resolveCredentials({ apiKey: "" }), null);
  assert.equal(await resolveCredentials({ modelRegistry: { getApiKeyForProvider: async () => undefined } }), null);
});

test("Seam Auth: requireCredentials returns valid credentials or throws", async () => {
  const valid = { apiKey: JSON.stringify({ token: "tok", projectId: "proj" }) };
  assert.deepEqual(await requireCredentials(valid), { token: "tok", projectId: "proj" });

  await assert.rejects(
    async () => requireCredentials(null),
    /Not logged in/
  );

  await assert.rejects(
    async () => requireCredentials(null, "Custom missing message"),
    /Custom missing message/
  );
});

test("Seam Auth: /antigravity login sets editor text in UI mode", async () => {
  let commandHandler;
  const mockPi = {
    registerProvider: () => {},
    on: () => {},
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
    on: () => {},
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
  let providerConfig;
  const mockPi = {
    registerProvider: (_name, config) => {
      providerConfig = config;
    },
    on: () => {},
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
      modelRegistry: {
        getApiKeyForProvider: async () => "fake-token",
        // models goes through the single refresh-owned path, like refresh does:
        // Pi calls the provider's own refresh hook, which records into the store
        // this extension wired up.
        refresh: async () =>
          providerConfig.refreshModels({
            allowNetwork: true,
            credential: { type: "oauth", access: "fake-token" },
            stored: {},
          }),
      },
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

test("Seam Auth (M1 & Low-1 Fix): loginAntigravity invokes onProgress and respects callbacks.signal abort", async () => {
  const { loginAntigravity } = await import("../src/auth.ts");
  const controller = new AbortController();
  controller.abort(new Error("User cancelled login"));

  const progressUpdates = [];
  const callbacks = {
    onAuth: () => {},
    onPrompt: async () => "test_code",
    onProgress: (msg) => progressUpdates.push(msg),
    signal: controller.signal,
  };

  await assert.rejects(
    async () => loginAntigravity(callbacks),
    (err) => {
      assert.ok(err.message.includes("cancelled"));
      return true;
    }
  );
});

test("Seam Auth (Low-1 Fix): loginAntigravity emits progress events during login", async () => {
  const { loginAntigravity } = await import("../src/auth.ts");
  const realFetch = globalThis.fetch;
  const progressUpdates = [];

  globalThis.fetch = async (url) => {
    if (String(url).includes("loadCodeAssist")) {
      return { ok: true, json: async () => ({ cloudaicompanionProject: "proj-123" }) };
    }
    return { ok: true, json: async () => ({ access_token: "tok-123", expires_in: 3600, refresh_token: "ref-123" }) };
  };

  try {
    const creds = await loginAntigravity({
      onAuth: () => {},
      onPrompt: async () => "test_auth_code",
      onProgress: (msg) => progressUpdates.push(msg),
    });

    assert.ok(progressUpdates.some((p) => p.includes("Exchanging authorization code")));
    assert.ok(progressUpdates.some((p) => p.includes("Resolving Code Assist project ID")));
    const parsed = JSON.parse(creds.access);
    assert.equal(parsed.token, "tok-123");
    assert.equal(parsed.projectId, "proj-123");
  } finally {
    globalThis.fetch = realFetch;
  }
});
