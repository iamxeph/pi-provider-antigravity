import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_USER_AGENT,
  PROVIDER_ID,
  buildAntigravityHeaders,
  formatApiError,
  withMetadataTimeout,
} from "../src/protocol.ts";

test("Seam Protocol: buildAntigravityHeaders matches wire fingerprint", () => {
  const token = "mock-token-xyz";
  const headers = buildAntigravityHeaders(token);

  assert.equal(headers["Host"], "daily-cloudcode-pa.googleapis.com");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["Authorization"], `Bearer ${token}`);
  assert.equal(headers["User-Agent"], DEFAULT_USER_AGENT);
  assert.match(headers["User-Agent"], /^antigravity\/cli\/1\.1\.\d+/);
  // Never send Anthropic-beta or Accept: application/json in standard wire traffic
  assert.equal(headers["anthropic-beta"], undefined);
  assert.equal(headers["Accept"], undefined);
});

test("Seam Protocol: constants match expected provider configuration", () => {
  assert.equal(PROVIDER_ID, "antigravity");
  assert.equal(DEFAULT_ENDPOINT, "https://daily-cloudcode-pa.googleapis.com");
});

test("Seam Protocol: formatApiError maps 401/403 to the re-login hint", () => {
  assert.match(formatApiError(401, "unauthorized"), /\/login antigravity/);
  assert.match(formatApiError(403, "forbidden"), /\/login antigravity/);
});

test("Seam Protocol: formatApiError maps 429 to the quota hint", () => {
  assert.match(formatApiError(429, "too many requests"), /\/antigravity usage/);
});

test("Seam Protocol: formatApiError labels 5xx as a backend error", () => {
  assert.match(formatApiError(503, "unavailable"), /backend error/);
});

test("Seam Protocol: formatApiError sniffs invalid_grant for the re-login hint", () => {
  assert.match(formatApiError(400, '{"error":"invalid_grant"}'), /\/login antigravity/);
});

test("Seam Protocol: formatApiError truncates long bodies at 500 chars", () => {
  const body = "x".repeat(600);
  const out = formatApiError(500, body);
  assert.ok(out.endsWith("... This looks like a backend error; retry later."));
  assert.ok(out.length < 600);
});

test("Seam Protocol: formatApiError keeps short bodies verbatim", () => {
  assert.equal(formatApiError(400, "bad request"), "(400): bad request");
});

test("Seam Protocol: withMetadataTimeout aborts after the timeout", async () => {
  const t = withMetadataTimeout(undefined, 20);
  await new Promise((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error("never aborted")), 1000);
    t.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(fail);
        t.dispose();
        resolve();
      },
      { once: true }
    );
  });
});

test("Seam Protocol: withMetadataTimeout propagates caller abort", () => {
  const caller = new AbortController();
  const t = withMetadataTimeout(caller.signal);
  caller.abort();
  assert.equal(t.signal.aborted, true);
  t.dispose();
});
