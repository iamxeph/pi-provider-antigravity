import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Assemble a JWT-shaped value at runtime: a literal eyJ…payload…sig run in
// this file would trip lint:captures (unmasked-jwt), so keep the parts split.
const fakeJwt =
  ["eyJ", "hbGciOiJSUzI1NiJ9"].join("") + "." + "cGF5bG9hZA" + "." + "c2lnbmF0dXJl";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capture-hygiene-"));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function runSanitize(dir) {
  execFileSync("node", ["scripts/sanitize-captures.mjs", dir], { stdio: "pipe" });
}

function runLint(dir) {
  return execFileSync("node", ["scripts/lint-captures.mjs"], {
    stdio: "pipe",
    env: { ...process.env, CAPTURE_LINT_DIRS: dir },
  }).toString();
}

test("sanitize redacts an id_token JWT in a JSON fixture", () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "sanitize-"));
  const file = path.join(dir, "auth_token_refresh.resp.json");
  fs.writeFileSync(file, JSON.stringify({ id_token: fakeJwt }, null, 2));

  runSanitize(dir);

  const out = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(out.id_token, "<REDACTED_ID_TOKEN>");
});

test("sanitize leaves an already-redacted id_token untouched", () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "idempotent-"));
  const file = path.join(dir, "auth_token_refresh.resp.json");
  const before = JSON.stringify({ id_token: "<REDACTED_ID_TOKEN>" }, null, 2) + "\n";
  fs.writeFileSync(file, before);

  runSanitize(dir);

  assert.equal(fs.readFileSync(file, "utf-8"), before);
});

test("lint fails on an unredacted JWT", () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "lint-fail-"));
  fs.writeFileSync(dir + "/leak.json", JSON.stringify({ id_token: fakeJwt }));

  assert.throws(() => runLint(dir), /Command failed/);
});

test("lint passes on a redacted fixture", () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "lint-pass-"));
  fs.writeFileSync(dir + "/clean.json", JSON.stringify({ id_token: "<REDACTED_ID_TOKEN>" }));

  assert.match(runLint(dir), /CAPTURE LINT PASSED/);
});
