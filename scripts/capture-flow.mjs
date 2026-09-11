#!/usr/bin/env node
// Manifest-driven capture helper (captures/scenarios.json is the source of truth).
//
//   node scripts/capture-flow.mjs plan [--version 1.2.0]
//   node scripts/capture-flow.mjs extract <flows.jsonl> --dir captures/agy_cli_1.2.0 [--force] [--no-prompt]
//   node scripts/capture-flow.mjs self-check [--dir captures/agy_cli_1.2.0]
//
// plan prints the capture checklist in capture order; extract matches the
// recorded flows back to the scenario slots and writes the frozen fixtures;
// self-check rebuilds flows from an already frozen directory and proves the
// matcher reproduces those fixtures byte for byte (offline, no quota).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "captures/scenarios.json"), "utf-8"));

const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const streamSlots = () => MANIFEST.stream;
const dirBase = (dir) => path.basename(path.resolve(ROOT, dir));

// Canonical slots minus a version's declared omissions, with its patch applied.
// Canonical slots minus a version's declared omissions, its generation remap and its
// patch applied.
function effectiveSlots(dirId) {
  const cfg = MANIFEST.dirs[dirId] ?? {};
  const omit = new Set(cfg.omit ?? []);
  // A canonical pin may name a newer generation than this directory froze; the remap
  // keeps the dir matched against what it actually captured.
  const generation = (base) => cfg.models?.[base] ?? base;
  return streamSlots()
    .filter((s) => !omit.has(s.slot))
    .map((s) => {
      const model = generation(s.model);
      const slot = model === s.model ? { ...s } : { ...s, model, wireModel: s.wireModel.replace(s.model, model) };
      const patch = cfg.patch?.[s.slot];
      if (!patch) return slot;
      const { reason, ...fields } = patch;
      const merged = { ...slot, ...fields, _reason: reason };
      // `expect` merges key by key so a patch can relax one assertion without
      // restating the rest of the slot.
      if (patch.expect) merged.expect = { ...slot.expect, ...patch.expect };
      return merged;
    });
}

const promptText = (slot) => MANIFEST.prompts[slot.prompt];
const shellQuote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

// ── flow reading ─────────────────────────────────────────────────────────────

const lastUserRequest = (body) => {
  let found;
  for (const c of body?.request?.contents ?? []) {
    if (c.role !== "user") continue;
    for (const p of c.parts ?? []) {
      if (typeof p.text !== "string") continue;
      const m = p.text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
      if (m) found = m[1].trim();
    }
  }
  return found;
};

const partFields = (body) => {
  const parts = (body?.request?.contents ?? []).flatMap((c) => c.parts ?? []);
  const has = new Set();
  for (const p of parts) {
    if (p.thought === true) has.add("thought");
    if (p.thoughtSignature) has.add("thoughtSignature");
    if (p.functionCall) has.add("functionCall");
    if (p.functionResponse) has.add("functionResponse");
    if (p.text !== undefined) has.add("text");
  }
  return has;
};

const isContinuation = (body) => "last_execution_id" in (body?.request?.labels ?? {});

function readFlows(file) {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return { ...JSON.parse(l), _index: i };
      } catch (e) {
        die(`${file}:${i + 1} is not JSON (${e.message})`);
      }
    });
}

const STREAM = (f) => (f.req?.url ?? "").startsWith(MANIFEST.policy.streamEndpoint);

// Why a flow did or did not match a slot: one line per reason, used for both matching and error reports.
function matchReasons(flow, slot, opts) {
  const body = flow.req?.body;
  const reasons = [];
  if (!body || typeof body !== "object") return ["request body is not JSON"];
  if (body.model !== slot.wireModel) reasons.push(`model=${body.model} (want ${slot.wireModel})`);
  const continuation = isContinuation(body);
  if (slot.mode === "continue" && !continuation) reasons.push("not a -c continuation (no last_execution_id)");
  if (slot.mode !== "continue" && continuation) reasons.push("unexpected last_execution_id (slot is not a continuation)");
  if (opts.prompt && lastUserRequest(body) !== promptText(slot)) {
    reasons.push(`prompt mismatch (want ${JSON.stringify(promptText(slot))})`);
  }
  const has = partFields(body);
  for (const want of slot.expect?.requestHas ?? []) if (!has.has(want)) reasons.push(`missing ${want}`);
  for (const not of slot.expect?.absent ?? []) if (has.has(not)) reasons.push(`unexpected ${not}`);
  if (opts.afterBody && slot.replays) {
    const before = opts.afterBody.request.contents;
    const now = body.request.contents;
    const prefix = before.every((c, i) => JSON.stringify(c) === JSON.stringify(now[i]));
    if (now.length <= before.length || !prefix) reasons.push(`does not extend ${slot.replays}`);
  }
  return reasons;
}

// ── plan ─────────────────────────────────────────────────────────────────────

// The newest frozen catalog is the best available oracle for "which runtime model
// ids does the backend still offer" before a capture spends quota.
function newestCatalog() {
  const dirs = fs
    .readdirSync(path.join(ROOT, "captures"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("agy_cli_"))
    .map((d) => d.name)
    .sort();
  const dir = dirs[dirs.length - 1];
  const file = dir && path.join(ROOT, "captures", dir, "models.resp.json");
  if (!file || !fs.existsSync(file)) return null;
  return { dir, runtimeIds: Object.keys(JSON.parse(fs.readFileSync(file, "utf-8")).models ?? {}) };
}

// Model turnover is expected churn: report the pinned ids the newest catalog no
// longer lists (both the command-line public id and the runtime id it resolves to),
// with candidates, so the fix is a manifest edit.
function preflight(slots) {
  const catalog = newestCatalog();
  if (!catalog) return [];
  // Mirrors the resolver's family match without importing model-catalog.ts.
  const known = (id) => catalog.runtimeIds.some((c) => c === id || c.startsWith(`${id}-`));
  const pinned = [...new Set(slots.flatMap((s) => [s.model, s.wireModel]))];
  const missing = pinned.filter((id) => !known(id));
  const lines = [`# Preflight vs captures/${catalog.dir}/models.resp.json:`];
  if (missing.length === 0) {
    lines.push(`#   ok: all ${pinned.length} pinned ids still resolve`);
  }
  for (const id of missing) {
    const family = id.split("-")[0];
    const candidates = catalog.runtimeIds.filter((c) => c.startsWith(`${family}-`));
    lines.push(`#   MISSING ${id} — update captures/scenarios.json. Candidates: ${candidates.join(", ") || "none"}`);
  }
  lines.push("#   (the pins are intentional: a renamed model moves the manifest, not the assertion)");
  return lines;
}

function plan() {
  const version = value("--version") ?? "<version>";
  const dir = `captures/agy_cli_${version}`;
  const slots = effectiveSlots(dirBase(dir));
  const emit = value("--emit");
  const argvOf = (slot) =>
    [
      "agy",
      slot.mode === "continue" ? "-c" : null,
      "-p",
      shellQuote(promptText(slot)),
      "--model",
      slot.model,
      slot.effort ? "--effort" : null,
      slot.effort,
      MANIFEST.policy.skipPermissions,
    ]
      .filter(Boolean)
      .join(" ");

  // `--emit sh` prints exactly the commands a capture runs, one per line, with
  // auto slots collapsed into the invocation that produces them — so the run is
  // whatever the manifest declares, not whatever the capturer retyped.
  if (emit === "sh") {
    let previous = null;
    for (const slot of slots) {
      const argv = argvOf(slot);
      if (slot.mode === "auto" && argv === previous) continue;
      console.log(`# ${slot.slot}`);
      console.log(argv);
      previous = argv;
    }
    return;
  }

  console.log(`# Capture plan — agy_cli_${version}`);
  console.log(`# Proxy: captures/README.md §1. Workdir: ${MANIFEST.policy.workdir} (mkdir -p).`);
  console.log(`# Auth lifecycle first (README §2.1) so the five endpoint fixtures land in flows.jsonl.`);
  console.log(preflight(slots).join("\n"));
  console.log();
  let session = null;
  let lastCommand = null;
  slots.forEach((slot, i) => {
    if (slot.session !== session) {
      session = slot.session;
      console.log(`-- session ${session}`);
    }
    const argv = argvOf(slot);
    const mode = { fresh: "fresh session", auto: "same invocation", continue: "-c continuation" }[slot.mode];
    console.log(`${String(i + 1).padStart(2)}. ${slot.slot}  [${mode}${slot.effort ? `, effort ${slot.effort}` : ""}]`);
    if (slot.mode !== "auto") {
      console.log(`    ${argv}`);
      lastCommand = argv;
    } else if (argv === lastCommand) {
      console.log("    (no new command — freeze the functionResponse request of the invocation above)");
    } else {
      console.log(`    ${argv}`);
      console.log("    (freeze the functionResponse request of this invocation, not its functionCall request)");
    }
    if (slot._reason) console.log(`    (${dir} patch: ${slot._reason})`);
    console.log(`    -> ${dir}/${slot.slot}.req.json + .resp.sse`);
  });
  console.log(`\n# Extract: node scripts/capture-flow.mjs extract <flows.jsonl> --dir ${dir}`);
  console.log("# Then: npm test (wire-parity + the manifest gate), and add the EXPECTED_UA row it prints.");
}

// ── extract ──────────────────────────────────────────────────────────────────

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

// Required endpoint fixtures (the ones this provider implements) plus the observed
// startup surface, which is frozen for reference but never required.
const allEndpoints = () => [
  ...MANIFEST.endpoints.map((ep) => ({ ...ep, required: true })),
  ...(MANIFEST.observedEndpoints ?? []).map((ep) => ({ ...ep, required: false })),
];

function extractEndpoints(flows, dir, report) {
  for (const ep of allEndpoints()) {
    const matches = flows.filter((f) => {
      const url = f.req?.url ?? "";
      return ep.urlPrefix ? url.startsWith(ep.urlPrefix) : url === ep.url;
    });
    // Any 2xx is a captured success: the canonical endpoints answer 200, agy's
    // unleash register answers 202 with an empty body.
    const ok = matches.filter((f) => (f.resp?.status ?? 0) >= 200 && (f.resp?.status ?? 0) < 300);
    if (!ok.length) {
      // The authorize URL is opened by the browser, so it never reaches the proxy:
      // that fixture is transcribed from the CLI's login prompt (README §2.1), and a
      // capture run must keep it instead of failing on a flow that cannot exist.
      const kept = ep.files.every((f) => fs.existsSync(path.join(dir, f)));
      if (kept) {
        report.push(`${ep.required ? "ok     " : "ok(obs)"} ${ep.id} (kept existing fixture — no matching flow)`);
        continue;
      }
      const line = `${dirBase(dir)}/${ep.files[0]} — no ${ep.id} flow captured. ${ep.why}`;
      report.push(ep.required ? `MISSING ${line}` : `note: ${line}`);
      continue;
    }
    if (ok.length > 1) report.push(`note: ${ok.length} ${ep.id} flows captured, using the last`);
    const flow = ok[ok.length - 1];
    if (ep.shape === "authorize-url") {
      const url = new URL(flow.req.url);
      writeJson(path.join(dir, "auth_login_params.json"), {
        endpoint: `${url.origin}${url.pathname}`,
        params: Object.fromEntries(url.searchParams),
      });
    } else {
      writeJson(path.join(dir, `${ep.id}.req.json`), flow.req);
      const body = flow.resp.body;
      fs.writeFileSync(
        path.join(dir, `${ep.id}.resp.json`),
        `${typeof body === "string" ? body.replace(/\n*$/, "") : JSON.stringify(body, null, 2)}\n`,
        "utf-8",
      );
    }
    report.push(`${ep.required ? "ok     " : "ok(obs)"} ${ep.id}`);
  }
}

function extractStream(flows, dir, { prompt = true, dest = dir, report = [] } = {}) {
  const dirId = dirBase(dir);
  const slots = effectiveSlots(dirId);
  const streamFlows = flows.filter(STREAM);
  const used = new Set();
  const consumed = new Map();

  for (const slot of slots) {
    const afterFlow = slot.replays ? consumed.get(slot.replays) : undefined;
    const candidates = streamFlows
      .filter((f) => !used.has(f._index))
      .map((f) => ({ f, reasons: matchReasons(f, slot, { prompt, afterBody: afterFlow?.req?.body }) }));
    const hit = candidates.find((c) => c.reasons.length === 0)?.f;
    if (!hit) {
      const detail = candidates
        .slice(0, 4)
        .map((c) => `      flow#${c.f._index}: ${c.reasons.join("; ")}`)
        .join("\n");
      report.push(`MISSING ${slot.slot} — no captured flow matches.\n${detail}`);
      continue;
    }
    used.add(hit._index);
    consumed.set(slot.slot, hit);
    writeJson(path.join(dest, `${slot.slot}.req.json`), hit.req);
    const respBody = hit.resp?.body ?? "";
    fs.writeFileSync(
      path.join(dest, `${slot.slot}.resp.sse`),
      `${typeof respBody === "string" ? respBody.replace(/\n*$/, "") : JSON.stringify(respBody)}\n`,
      "utf-8",
    );
    const dupes = candidates.filter((c) => c.reasons.length === 0).length;
    report.push(`ok      ${slot.slot}  (flow#${hit._index}${dupes > 1 ? `, ${dupes} candidates` : ""})`);
  }

  const leftovers = streamFlows.filter((f) => !used.has(f._index));
  if (leftovers.length) {
    report.push(`note: ${leftovers.length} stream flow(s) not consumed by any slot:`);
    for (const f of leftovers.slice(0, 8)) {
      report.push(
        `      flow#${f._index} ${f.req?.body?.model} "${(lastUserRequest(f.req?.body) ?? "<no USER_REQUEST>").slice(0, 60)}"`,
      );
    }
  }
  return report;
}

function extract() {
  const flowsFile = args[1];
  const dirArg = value("--dir");
  if (!flowsFile || !dirArg) die("usage: capture-flow.mjs extract <flows.jsonl> --dir captures/agy_cli_<version> [--force] [--no-prompt]");
  const dir = path.resolve(ROOT, dirArg);
  const dirId = dirBase(dir);
  if (!/^agy_cli_\d+\.\d+\.\d+$/.test(dirId)) die(`directory must be named agy_cli_<version>, got ${dirId}`);
  if (MANIFEST.dirs[dirId] && !flag("--force")) {
    die(`${dirId} is a frozen version with declared deviations; pass --force only to re-capture it in place`);
  }
  const flows = readFlows(flowsFile);
  const report = [];
  extractEndpoints(flows, dir, report);
  extractStream(flows, dir, { prompt: !flag("--no-prompt"), report });

  console.log(report.join("\n"));
  const ua = flows.find(STREAM)?.req?.headers?.["User-Agent"];
  if (ua) {
    console.log(`\n# EXPECTED_UA row for tests/wire-parity.test.mjs:\n  "${dirId}":\n    "${ua}",`);
  }
  console.log(`\n# Next: npm run sanitize:captures ${dirArg} && npm run lint:captures && npm test`);
  if (report.some((l) => l.startsWith("MISSING"))) process.exitCode = 1;
}

// ── self-check ───────────────────────────────────────────────────────────────

// Rebuild a flows.jsonl from a frozen directory: the matcher must then pick the
// same slot→file assignment it did on the original live flows.
function flowsFromDir(dir) {
  const entries = [];
  const stamp = (req) => Number(String(req?.body?.requestId ?? "").split("/")[2] ?? 0);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".req.json")) continue;
    const req = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    const stem = f.replace(/\.req\.json$/, "");
    const respFile = ["resp.sse", "resp.json"].map((e) => `${stem}.${e}`).find((e) => fs.existsSync(path.join(dir, e)));
    if (!respFile) continue;
    entries.push({ req, resp: { status: 200, body: fs.readFileSync(path.join(dir, respFile), "utf-8") }, stamp: stamp(req) });
  }
  const login = path.join(dir, "auth_login_params.json");
  if (fs.existsSync(login)) {
    const { endpoint, params } = JSON.parse(fs.readFileSync(login, "utf-8"));
    const url = `${endpoint}?${new URLSearchParams(params)}`;
    entries.push({ req: { method: "GET", url, headers: {}, body: "" }, resp: { status: 200, body: "{}" }, stamp: 0 });
  }
  entries.sort((a, b) => a.stamp - b.stamp);
  return entries.map((e, i) => ({ ...e, _index: i }));
}

function selfCheck() {
  const only = value("--dir");
  const dirs = (only ? [path.resolve(ROOT, only)] : fs
    .readdirSync(path.join(ROOT, "captures"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("agy_cli_"))
    .map((d) => path.join(ROOT, "captures", d.name))).sort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-selfcheck-"));
  let failures = 0;
  // JSON fixtures compare by value (formatting is the sanitizer's business);
  // everything else (SSE bodies) compares as text with trailing newlines ignored.
  const sameFixture = (want, got) => {
    const read = (p) => fs.readFileSync(p, "utf-8").replace(/\n+$/, "");
    const [x, y] = [read(want), read(got)];
    try {
      return JSON.stringify(JSON.parse(x)) === JSON.stringify(JSON.parse(y));
    } catch {
      return x === y;
    }
  };
  try {
    for (const dir of dirs) {
      const dirId = dirBase(dir);
      const out = path.join(tmp, dirId);
      const files = [];
      const report = extractStream(flowsFromDir(dir), dir, { prompt: false, dest: out, report: [] });
      for (const line of report.filter((l) => l.startsWith("MISSING"))) {
        console.log(`FAIL ${dirId}: ${line.split("\n")[0]}`);
        failures++;
      }
      for (const slot of effectiveSlots(dirId)) {
        files.push(`${slot.slot}.req.json`, `${slot.slot}.resp.sse`);
      }
      extractEndpoints(flowsFromDir(dir), out, []);
      for (const ep of allEndpoints()) files.push(...ep.files);
      for (const file of files) {
        const want = path.join(dir, file);
        const got = path.join(out, file);
        if (!fs.existsSync(want)) continue;
        if (!fs.existsSync(got)) {
          console.log(`FAIL ${dirId}/${file}: not extracted at all`);
          failures++;
        } else if (!sameFixture(want, got)) {
          console.log(`FAIL ${dirId}/${file}: extraction changed the fixture`);
          failures++;
        }
      }
      console.log(`${failures ? "FAIL" : "ok  "} ${dirId} (${effectiveSlots(dirId).length} slots, ${files.length} files)`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `self-check failed (${failures})` : "self-check passed: extraction reproduces every frozen fixture");
  if (failures) process.exitCode = 1;
}

switch (command) {
  case "plan":
    plan();
    break;
  case "extract":
    extract();
    break;
  case "self-check":
    selfCheck();
    break;
  default:
    die("usage: capture-flow.mjs <plan|extract|self-check> [options]");
}
