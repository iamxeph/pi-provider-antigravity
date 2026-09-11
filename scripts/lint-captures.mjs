#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

/**
 * Capture Fixture Linter
 * Ensures captured agy CLI network traffic and tests contain no personal PII,
 * private user instructions, or unredacted credentials.
 */

// CAPTURE_LINT_DIRS overrides the scan roots (comma-separated). Production use
// scans the repo fixtures; tests point it at a temp dir instead.
const SCAN_DIRS = process.env.CAPTURE_LINT_DIRS
  ? process.env.CAPTURE_LINT_DIRS.split(",")
  : ["captures", "tests"];

const LOCAL_USER = process.env.USER ?? "";
// Placeholder names would match their own normalization (see sanitize-captures.mjs).
const PLACEHOLDER_USERS = new Set(["", "user", "root", "runner", "node", "nobody"]);
const LOCAL_USER_RE = PLACEHOLDER_USERS.has(LOCAL_USER)
  ? null
  : new RegExp(LOCAL_USER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");

const RULES = [
  {
    id: "unmasked-google-refresh-token",
    description: "Unmasked Google OAuth Refresh Token in capture",
    regex: /(?:1\/\/0|1%2F%2F0)(?!_REDACTED)[a-zA-Z0-9_.-]{30,}/g,
  },
  {
    id: "unmasked-google-access-token",
    description: "Unmasked Google OAuth Access Token in capture",
    regex: /ya29\.(?!<REDACTED)[a-zA-Z0-9_.-]{30,}/g,
  },
  {
    id: "unmasked-jwt",
    description:
      "Unmasked JWT in capture (likely Google OIDC id_token with email/name/sub)",
    regex: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: "personal-email-encoded",
    description: "Personal email address (URL encoded)",
    regex: /[a-zA-Z0-9._%+-]+%40(?!example\.com)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
  },
  {
    id: "personal-email-plain",
    description: "Personal email address",
    regex: /[a-zA-Z0-9._%+-]+@(?!example\.com|default|users\.noreply\.github\.com)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
  },
  {
    id: "local-user-home-path",
    description: "Local home directory path (must be normalized to /home/user)",
    regex: /(?:file:\/\/\/|\/)(?:home|Users)\/(?!user(?:[/\\"'`]|$))[a-zA-Z0-9_.-]+/g,
  },
  {
    id: "unmasked-machine-instance-id",
    description: "Machine-derived instance id (embeds username/hostname) must be redacted",
    regex: /(["']instanceId["']\s*[:=]\s*["']?|[?&]instanceId=)(?!<REDACTED)[^"'&\s]+/gi,
  },
  {
    id: "local-username",
    description: "Local account name leaked into a fixture (tool output owner column)",
    regex: LOCAL_USER_RE ?? /(?!)/,
  },
  {
    id: "personal-global-rules",
    description: "Personal global AI instructions retained in capture",
    regex: /<RULE\[user_global\]>[\s\S]*?Ponytail/g,
  },
];

function getAllFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

const violations = [];

for (const dir of SCAN_DIRS) {
  const fullDir = path.resolve(process.cwd(), dir);
  const files = getAllFiles(fullDir);

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (![".json", ".sse", ".txt", ".req", ".resp", ".ts", ".js", ".mjs"].includes(ext)) {
      continue;
    }

    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split(/\r?\n/);

    for (const rule of RULES) {
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(content)) !== null) {
        const offset = match.index;
        let lineNo = 1;
        let currentOffset = 0;
        for (let i = 0; i < lines.length; i++) {
          currentOffset += lines[i].length + 1;
          if (currentOffset > offset) {
            lineNo = i + 1;
            break;
          }
        }

        const matchedSnippet = match[0].length > 40 ? `${match[0].slice(0, 37)}...` : match[0];
        violations.push({
          file: path.relative(process.cwd(), file),
          line: lineNo,
          ruleId: rule.id,
          description: rule.description,
          snippet: matchedSnippet,
        });
        break;
      }
    }
  }
}

if (violations.length > 0) {
  console.error("\n❌ [CAPTURE LINT FAILED] Unsanitized PII or tokens detected in captures/tests:");
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line} [${v.ruleId}] ${v.description}`);
    console.error(`    Matched: "${v.snippet}"`);
  }
  console.error("\n💡 To sanitize captures automatically, run:");
  console.error("   npm run sanitize:captures\n");
  process.exit(1);
} else {
  console.log("✅ [CAPTURE LINT PASSED] Captures and fixtures are clean of personal data.");
}
