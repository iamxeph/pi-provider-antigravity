#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const targetArg = process.argv[2] || "captures";
const targetPath = path.resolve(process.cwd(), targetArg);

if (!fs.existsSync(targetPath)) {
  console.error(`Target path does not exist: ${targetPath}`);
  process.exit(1);
}

function getAllFiles(dir) {
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

function sanitizeString(str) {
  if (typeof str !== "string") return str;
  let text = str;

  // 1. Google OAuth Refresh Tokens
  text = text.replace(
    /refresh_token=1%2F%2F[A-Za-z0-9_.-]+/g,
    "refresh_token=1%2F%2F0_REDACTED_MOCK_REFRESH_TOKEN_FOR_FIXTURES"
  );
  text = text.replace(
    /(["']?(?:refresh_token|refreshToken)["']?\s*[:=]\s*["']?)1\/\/0[A-Za-z0-9_.-]+(["']?)/g,
    "$11//0_REDACTED_MOCK_REFRESH_TOKEN_FOR_FIXTURES$2"
  );

  // 2. Authorization Bearer Tokens (must run BEFORE bare ya29 redaction:
  // otherwise rule 3 mangles "Bearer ya29.xxx" into
  // "Bearer ya29.<REDACTED_ACCESS_TOKEN>", which rule 4 can no longer match
  // because "<" is outside [A-Za-z0-9_.-]).
  text = text.replace(
    /Bearer\s+(?!<REDACTED)(?:ya29\.[A-Za-z0-9_.-]+|1\/\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]{40,})/g,
    "Bearer <REDACTED_ACCESS_TOKEN>"
  );

  // 3. Bare Google OAuth Access Tokens (ya29...) outside Authorization headers.
  text = text.replace(/ya29\.[A-Za-z0-9_.-]+/g, "ya29.<REDACTED_ACCESS_TOKEN>");

  // 4. Email addresses (URL-encoded and plain)
  text = text.replace(/Email=[^&"'\s]+/gi, "Email=user%40example.com");
  text = text.replace(
    /[a-zA-Z0-9._%+-]+%40[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
    "user%40example.com"
  );
  text = text.replace(
    /(["':\s])([a-zA-Z0-9_.+-]+@(?!example\.com|default)[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)(["'\s,])/gi,
    "$1user@example.com$3"
  );

  // 5. Local home directories and usernames
  text = text.replace(/(file:\/\/\/|\/)(?:home|Users)\/(?!user[/\s"'\\])[a-zA-Z0-9_.-]+/g, "$1home/user");

  // 6. User-defined custom rules inside systemInstruction prompt
  text = text.replace(
    /<RULE\[user_global\]>[\s\S]*?<\/RULE\[user_global\]>/g,
    "<RULE[user_global]>\n# Standard instructions\n</RULE[user_global]>"
  );

  return text;
}

function sanitizeObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return sanitizeString(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = sanitizeObject(v);
    }
    return out;
  }
  return obj;
}

function sanitizeFile(filePath) {
  const original = fs.readFileSync(filePath, "utf-8");

  // Try JSON structure first for safe traversal & formatting
  let isJson = false;
  let parsedJson;
  try {
    parsedJson = JSON.parse(original);
    isJson = true;
  } catch {
    isJson = false;
  }

  let sanitized;
  if (isJson && typeof parsedJson === "object" && parsedJson !== null) {
    const cleaned = sanitizeObject(parsedJson);

    // Recalculate content-length header if body is string
    if (cleaned.headers && typeof cleaned.headers === "object" && typeof cleaned.body === "string") {
      const clKey = Object.keys(cleaned.headers).find((k) => k.toLowerCase() === "content-length");
      if (clKey) {
        cleaned.headers[clKey] = String(Buffer.byteLength(cleaned.body, "utf-8"));
      }
    }

    sanitized = JSON.stringify(cleaned, null, 2) + "\n";
  } else {
    sanitized = sanitizeString(original);
  }

  if (sanitized !== original) {
    fs.writeFileSync(filePath, sanitized, "utf-8");
    return true;
  }
  return false;
}

const files = fs.statSync(targetPath).isDirectory() ? getAllFiles(targetPath) : [targetPath];
let changedCount = 0;

for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  if (![".json", ".sse", ".txt", ".req", ".resp", ".log"].includes(ext)) {
    continue;
  }

  if (sanitizeFile(file)) {
    changedCount++;
    console.log(`[SANITIZED] ${path.relative(process.cwd(), file)}`);
  }
}

console.log(`Done. Sanitized ${changedCount} file(s).`);
