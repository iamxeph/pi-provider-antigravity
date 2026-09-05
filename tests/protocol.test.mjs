import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_USER_AGENT,
  PROVIDER_ID,
  buildAntigravityHeaders,
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
