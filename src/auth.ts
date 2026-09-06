import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { buildAntigravityHeaders, DEFAULT_ENDPOINT } from "./protocol.ts";

export const REDIRECT_URI = "https://antigravity.google/oauth-callback";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
  "openid",
];

export const CLIENT_ID =
  process.env.ANTIGRAVITY_CLIENT_ID ||
  Buffer.from(
    "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
    "base64"
  ).toString("utf-8");

export const CLIENT_SECRET =
  process.env.ANTIGRAVITY_CLIENT_SECRET ||
  Buffer.from("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=", "base64").toString("utf-8");

function base64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function extractCodeFromInput(rawInput: string): string {
  let code = rawInput.trim();
  if (!code) {
    throw new Error("No authorization code provided");
  }

  if (code.startsWith("code=")) {
    code = code.slice(5).trim();
    if (!code) {
      throw new Error("No authorization code provided");
    }
  }

  // Reject callback URLs and other non-code input here instead of passing
  // garbage downstream (Google rejects those with a bare invalid_grant).
  // Note: real codes contain "/" (e.g. "4/0ATs…"), so only reject
  // characters a code can never contain.
  if (/[\s:?#&=%+]/.test(code)) {
    throw new Error("Invalid authorization code: paste the code value itself, not the callback URL");
  }

  return code;
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export async function fetchProjectId(
  token: string,
  endpoint = DEFAULT_ENDPOINT,
  signal?: AbortSignal
): Promise<string> {
  try {
    const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: buildAntigravityHeaders(token),
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal,
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      if (data.cloudaicompanionProject) {
        return data.cloudaicompanionProject;
      }
    }
  } catch {
    // Fall back to standard project
  }
  return "aicode-consumers";
}

export async function loginAntigravity(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = generatePKCE();
  // state is still sent for agy wire parity, but never validated back:
  // with code-only paste the callback URL (and its state) never reaches us.
  const state = randomBytes(16).toString("hex");

  const authParams = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });

  const authUrl = `${AUTH_URL}?${authParams.toString()}`;
  callbacks.onAuth({ url: authUrl });

  const manualPromptPromise = (async () => {
    const input = await callbacks.onPrompt({
      message: "Paste authorization code from browser:",
    });
    return extractCodeFromInput(input);
  })();

  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("Timed out waiting for authorization code (5 minutes)")), OAUTH_CALLBACK_TIMEOUT_MS)
  );

  const code = await Promise.race([manualPromptPromise, timeout]);

  const tokenParams = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Failed to exchange token (${tokenRes.status}): ${errText}`);
  }

  const tokens = (await tokenRes.json()) as any;
  const projectId = await fetchProjectId(tokens.access_token);

  return {
    refresh: tokens.refresh_token || "",
    access: JSON.stringify({ token: tokens.access_token, projectId }),
    expires: Date.now() + (tokens.expires_in || 3600) * 1000,
  };
}

export async function refreshAntigravityToken(
  credentials: OAuthCredentials,
  signal?: AbortSignal
): Promise<OAuthCredentials> {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: credentials.refresh,
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to refresh token (${res.status}): ${errText}`);
  }

  const tokens = (await res.json()) as any;

  let existingProjectId = "aicode-consumers";
  try {
    const parsed = JSON.parse(credentials.access);
    if (parsed.projectId) existingProjectId = parsed.projectId;
  } catch {
    // ignore
  }

  // Re-resolve: a login-time lookup failure pins the "aicode-consumers"
  // default forever unless refresh retries it. A failed lookup yields that
  // same default, which must never clobber a known value.
  const freshProjectId = await fetchProjectId(tokens.access_token, DEFAULT_ENDPOINT, signal);
  const projectId = freshProjectId !== "aicode-consumers" ? freshProjectId : existingProjectId;

  return {
    refresh: tokens.refresh_token || credentials.refresh,
    access: JSON.stringify({ token: tokens.access_token, projectId }),
    expires: Date.now() + (tokens.expires_in || 3600) * 1000,
  };
}

export function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}

export function parseStoredCredentials(rawApiKey: string): { token: string; projectId: string } {
  try {
    const parsed = JSON.parse(rawApiKey);
    if (parsed.token) {
      return { token: parsed.token, projectId: parsed.projectId || "aicode-consumers" };
    }
  } catch {
    // If plain token
  }
  return { token: rawApiKey, projectId: "aicode-consumers" };
}
