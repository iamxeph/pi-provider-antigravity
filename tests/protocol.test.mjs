import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_USER_AGENT,
  PROVIDER_ID,
  AntigravityHttpError,
  buildAntigravityHeaders,
  postAntigravityJson,
  postAntigravityStream,
} from "../src/protocol.ts";

test("Seam Protocol: buildAntigravityHeaders matches wire fingerprint", () => {
  const token = "mock-token-xyz";
  const headers = buildAntigravityHeaders(token);

  assert.equal(headers["Host"], "daily-cloudcode-pa.googleapis.com");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["Authorization"], `Bearer ${token}`);
  assert.equal(headers["User-Agent"], DEFAULT_USER_AGENT);
  // Version-agnostic shape pin: the exact release row lives in EXPECTED_UA
  // (wire-parity), so this one catches a wrong constant shape, not a new version.
  assert.match(
    headers["User-Agent"],
    /^antigravity\/cli\/\d+\.\d+\.\d+ \(aidev_client; os_type=linux; arch=amd64; cl=\d+; auth_method=consumer\)$/,
  );
  // Never send Anthropic-beta or Accept: application/json in standard wire traffic
  assert.equal(headers["anthropic-beta"], undefined);
  assert.equal(headers["Accept"], undefined);
});

test("Seam Protocol: constants match expected provider configuration", () => {
  assert.equal(PROVIDER_ID, "antigravity");
  assert.equal(DEFAULT_ENDPOINT, "https://daily-cloudcode-pa.googleapis.com");
});

test("Seam Protocol: AntigravityHttpError captures structured failure context", () => {
  const err = new AntigravityHttpError(403, "v1internal:loadCodeAssist", "PERMISSION_DENIED");
  assert.equal(err.name, "AntigravityHttpError");
  assert.equal(err.status, 403);
  assert.equal(err.path, "v1internal:loadCodeAssist");
  assert.equal(err.errorBody, "PERMISSION_DENIED");
  assert.match(err.message, /failed \(403\): PERMISSION_DENIED/);
  assert.ok(err instanceof Error);
});

test("Seam Protocol: postAntigravityJson decodes JSON and accepts object auth", async () => {
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ models: [{ id: "m1" }] }),
    };
  };

  try {
    const data = await postAntigravityJson({
      auth: { token: "tok-object-123" },
      path: "v1internal:loadAvailableModels",
      body: { project: "test-proj" },
    });

    assert.deepEqual(data, { models: [{ id: "m1" }] });
    assert.equal(seen.url, `${DEFAULT_ENDPOINT}/v1internal:loadAvailableModels`);
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.headers["Authorization"], "Bearer tok-object-123");
    assert.equal(seen.init.headers["User-Agent"], DEFAULT_USER_AGENT);
    assert.equal(seen.init.body, JSON.stringify({ project: "test-proj" }));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam Protocol: postAntigravityJson throws AntigravityHttpError on non-ok response", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => "UNAUTHENTICATED: token expired",
  });

  try {
    await assert.rejects(
      async () => {
        await postAntigravityJson({
          auth: "raw-tok",
          path: "v1internal:retrieveUserQuotaSummary",
          body: {},
        });
      },
      (err) => {
        assert.ok(err instanceof AntigravityHttpError);
        assert.equal(err.status, 401);
        assert.equal(err.path, "v1internal:retrieveUserQuotaSummary");
        assert.equal(err.errorBody, "UNAUTHENTICATED: token expired");
        return true;
      }
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam Protocol: postAntigravityStream returns ReadableStream on success", async () => {
  const realFetch = globalThis.fetch;
  const mockStream = new ReadableStream();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: mockStream,
  });

  try {
    const stream = await postAntigravityStream({
      auth: "stream-tok",
      path: "v1internal:streamGenerateContent?alt=sse",
      body: { prompt: "hi" },
    });
    assert.equal(stream, mockStream);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Seam Protocol: postAntigravityStream throws AntigravityHttpError on HTTP failure", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => "INTERNAL",
  });

  try {
    await assert.rejects(
      async () => {
        await postAntigravityStream({
          auth: "stream-tok",
          path: "v1internal:streamGenerateContent?alt=sse",
          body: {},
        });
      },
      (err) => {
        assert.ok(err instanceof AntigravityHttpError);
        assert.equal(err.status, 500);
        return true;
      }
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
