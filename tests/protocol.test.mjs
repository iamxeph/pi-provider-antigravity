import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_USER_AGENT,
  PROVIDER_ID,
  buildAntigravityHeaders,
  postAntigravity,
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

test("Seam Protocol: postAntigravity owns endpoint, headers, and envelope", async () => {
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return { ok: true };
  };
  const signal = AbortSignal.timeout(1000);
  try {
    const res = await postAntigravity({
      token: "tok",
      path: "v1internal:retrieveUserQuotaSummary",
      body: { project: "test-project" },
      signal,
    });
    assert.equal(res.ok, true);
    assert.equal(seen.url, `${DEFAULT_ENDPOINT}/v1internal:retrieveUserQuotaSummary`);
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.headers["Authorization"], "Bearer tok");
    assert.equal(seen.init.headers["User-Agent"], DEFAULT_USER_AGENT);
    assert.equal(seen.init.body, JSON.stringify({ project: "test-project" }));
    assert.equal(seen.init.signal, signal);
  } finally {
    globalThis.fetch = realFetch;
  }
});
