export const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const DEFAULT_USER_AGENT =
  "antigravity/cli/1.2.2 (aidev_client; os_type=linux; arch=amd64; cl=980147163; auth_method=consumer)";

export const PROVIDER_ID = "antigravity";

/**
 * Structured error thrown when an Antigravity HTTP endpoint responds with a non-2xx status code.
 * Preserves status, endpoint path, and raw error body for error inspection without string parsing.
 */
export class AntigravityHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly errorBody: string;

  constructor(status: number, path: string, errorBody: string) {
    super(`Antigravity request to ${path} failed (${status}): ${errorBody}`);
    this.name = "AntigravityHttpError";
    this.status = status;
    this.path = path;
    this.errorBody = errorBody;
  }
}

export interface AntigravityPostParams {
  auth: string | { token: string };
  /** Path below the endpoint, e.g. "v1internal:retrieveUserQuotaSummary". */
  path: string;
  body: unknown;
  signal?: AbortSignal;
}

function resolveToken(auth: string | { token: string }): string {
  if (typeof auth === "string") return auth;
  if (auth && typeof auth.token === "string") return auth.token;
  throw new Error("Invalid auth parameter: missing token string");
}

async function postAntigravityRaw({
  auth,
  path,
  body,
  signal,
}: AntigravityPostParams): Promise<Response> {
  const token = resolveToken(auth);
  return fetch(`${DEFAULT_ENDPOINT}/${path}`, {
    method: "POST",
    headers: buildAntigravityHeaders(token),
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Deep protocol JSON client: validates HTTP status, decodes JSON payloads,
 * and throws structured AntigravityHttpError on failures.
 */
export async function postAntigravityJson<T>(params: AntigravityPostParams): Promise<T> {
  const res = await postAntigravityRaw(params);
  if (!res.ok) {
    const errText = await res.text();
    throw new AntigravityHttpError(res.status, params.path, errText);
  }
  return (await res.json()) as T;
}

/**
 * Deep protocol stream client: validates HTTP status, checks stream presence,
 * and returns the validated ReadableStream.
 */
export async function postAntigravityStream(
  params: AntigravityPostParams
): Promise<ReadableStream<Uint8Array>> {
  const res = await postAntigravityRaw(params);
  if (!res.ok) {
    const errText = await res.text();
    throw new AntigravityHttpError(res.status, params.path, errText);
  }
  if (!res.body) {
    throw new Error(`No response stream received from Antigravity for ${params.path}.`);
  }
  return res.body;
}

/**
 * Builds the canonical HTTP request headers for the Antigravity Wire Fingerprint.
 */
export function buildAntigravityHeaders(token: string, userAgent = DEFAULT_USER_AGENT): Record<string, string> {
  return {
    Host: "daily-cloudcode-pa.googleapis.com",
    "User-Agent": userAgent,
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

