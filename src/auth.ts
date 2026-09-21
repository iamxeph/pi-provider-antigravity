import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "antigravity";
const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const DEFAULT_USER_AGENT =
  "antigravity/cli/1.2.7 (aidev_client; os_type=linux; arch=amd64; cl=984112147; auth_method=consumer)";

export interface AntigravityCredentials {
  token: string;
  projectId: string;
}

export type CredentialSource =
  | { modelRegistry?: { getApiKeyForProvider?: (provider: string) => Promise<string | undefined> } }
  | { apiKey?: string }
  | { credential?: { access?: string; type?: string } }
  | string
  | null
  | undefined;

/**
 * Structured error thrown when an operation requires Antigravity credentials
 * but none are configured or resolvable from the context.
 */
export class AntigravityAuthError extends Error {
  constructor(message = NOT_LOGGED_IN) {
    super(message);
    this.name = "AntigravityAuthError";
  }
}

export const REDIRECT_URI = "https://antigravity.google/oauth-callback";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
export const FALLBACK_PROJECT_ID = "aicode-consumers";

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

export async function fetchProjectId(token: string, signal?: AbortSignal): Promise<string> {
  try {
    const res = await fetch(`${DEFAULT_ENDPOINT}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: {
        Host: "daily-cloudcode-pa.googleapis.com",
        "User-Agent": DEFAULT_USER_AGENT,
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal,
    });
    if (res.ok) {
      const data = (await res.json()) as { cloudaicompanionProject?: string };
      if (data.cloudaicompanionProject) {
        return data.cloudaicompanionProject;
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    // Fall back to standard project
  }
  return FALLBACK_PROJECT_ID;
}

export async function loginAntigravity(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = generatePKCE();
  // state is sent for OAuth wire parity, but never validated back:
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

  let timer: NodeJS.Timeout | undefined;
  const abortPromise = new Promise<never>((_, rej) => {
    if (callbacks.signal?.aborted) {
      rej(callbacks.signal.reason ?? new Error("Login cancelled"));
      return;
    }
    callbacks.signal?.addEventListener(
      "abort",
      () => rej(callbacks.signal?.reason ?? new Error("Login cancelled")),
      { once: true }
    );
  });

  const manualPromptPromise = (async () => {
    const input = await callbacks.onPrompt({
      message: "Paste authorization code from browser:",
    });
    return extractCodeFromInput(input);
  })();

  const timeoutPromise = new Promise<never>((_, rej) => {
    timer = setTimeout(
      () => rej(new Error("Timed out waiting for authorization code (5 minutes)")),
      OAUTH_CALLBACK_TIMEOUT_MS
    );
  });

  let code: string;
  try {
    code = await Promise.race([manualPromptPromise, timeoutPromise, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  callbacks.onProgress?.("Exchanging authorization code for tokens...");

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
    signal: callbacks.signal,
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Failed to exchange token (${tokenRes.status}): ${errText}`);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  callbacks.onProgress?.("Resolving Code Assist project ID...");
  const projectId = await fetchProjectId(tokens.access_token, callbacks.signal);

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

  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  let existingProjectId = FALLBACK_PROJECT_ID;
  try {
    const parsed = JSON.parse(credentials.access);
    if (parsed.projectId) existingProjectId = parsed.projectId;
  } catch {
    // ignore
  }

  // Re-resolve: a login-time lookup failure pins the "aicode-consumers"
  // default forever unless refresh retries it. A failed lookup yields that
  // same default, which must never clobber a known value.
  const freshProjectId = await fetchProjectId(tokens.access_token, signal);
  const projectId = freshProjectId !== FALLBACK_PROJECT_ID ? freshProjectId : existingProjectId;

  return {
    refresh: tokens.refresh_token || credentials.refresh,
    access: JSON.stringify({ token: tokens.access_token, projectId }),
    expires: Date.now() + (tokens.expires_in || 3600) * 1000,
  };
}

export function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}

/**
 * Deep credential resolution seam: extracts and normalizes Antigravity credentials
 * ({ token, projectId }) from any Pi context (command context, model registry,
 * stream options, refresh context, or raw API key strings).
 * Returns null when credentials are not found.
 */
export async function resolveCredentials(
  source: CredentialSource
): Promise<AntigravityCredentials | null> {
  if (!source) return null;

  let raw: string | undefined;

  if (typeof source === "string") {
    raw = source.trim();
  } else if (typeof source === "object") {
    if ("modelRegistry" in source && source.modelRegistry?.getApiKeyForProvider) {
      raw = await source.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
    } else if ("apiKey" in source && typeof source.apiKey === "string") {
      raw = source.apiKey;
    } else if ("credential" in source && source.credential) {
      raw = source.credential.type === "oauth" || !source.credential.type
        ? source.credential.access
        : undefined;
    }
  }

  if (!raw || typeof raw !== "string" || !raw.trim()) {
    return null;
  }

  const parsed = parseStoredCredentials(raw);
  if (!parsed.token || !parsed.token.trim()) {
    return null;
  }
  return parsed;
}

/**
 * One wording for the one state: the request path ("I am not signed in") and the
 * subcommands say the same thing, so a user learns it once.
 */
export const NOT_LOGGED_IN = "Not logged in. Run /login antigravity first.";

/**
 * Ensures credentials exist or throws a clear error message.
 */
export async function requireCredentials(
  source: CredentialSource,
  errorMessage = NOT_LOGGED_IN
): Promise<AntigravityCredentials> {
  const creds = await resolveCredentials(source);
  if (!creds) {
    throw new AntigravityAuthError(errorMessage);
  }
  return creds;
}

export function parseStoredCredentials(rawApiKey: string): AntigravityCredentials {
  try {
    const parsed = JSON.parse(rawApiKey);
    if (parsed.token) {
      return { token: parsed.token, projectId: parsed.projectId || FALLBACK_PROJECT_ID };
    }
  } catch {
    // If plain token
  }
  return { token: rawApiKey, projectId: FALLBACK_PROJECT_ID };
}
