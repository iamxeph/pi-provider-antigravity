export const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const DEFAULT_USER_AGENT =
  "antigravity/cli/1.1.27 (aidev_client; os_type=linux; arch=amd64; cl=976543523; auth_method=consumer)";

export const PROVIDER_ID = "antigravity";

export interface AntigravityPostParams {
  token: string;
  /** Path below the endpoint, e.g. "v1internal:retrieveUserQuotaSummary". */
  path: string;
  body: unknown;
  signal?: AbortSignal;
}

/**
 * Owns the Antigravity base POST: endpoint, Wire Fingerprint headers, and
 * JSON envelope serialization. Callers pass path + body only.
 * Returns the raw Response: status/body reading stays with callers
 * (streaming needs the body reader; error texts differ per call site).
 */
export async function postAntigravity({
  token,
  path,
  body,
  signal,
}: AntigravityPostParams): Promise<Response> {
  return fetch(`${DEFAULT_ENDPOINT}/${path}`, {
    method: "POST",
    headers: buildAntigravityHeaders(token),
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Builds the canonical HTTP request headers matching the official agy CLI Wire Fingerprint.
 */
export function buildAntigravityHeaders(token: string, userAgent = DEFAULT_USER_AGENT): Record<string, string> {
  return {
    Host: "daily-cloudcode-pa.googleapis.com",
    "User-Agent": userAgent,
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}
