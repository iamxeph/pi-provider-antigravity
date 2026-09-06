export const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const DEFAULT_USER_AGENT =
  "antigravity/cli/1.1.27 (aidev_client; os_type=linux; arch=amd64; cl=976543523; auth_method=consumer)";

export const PROVIDER_ID = "antigravity";

const MAX_ERROR_BODY_CHARS = 500;

/**
 * Maps a backend failure to an actionable message: the (truncated) body plus
 * the user's next step — re-login, quota check, or a backend-error label.
 * Long HTML bodies are cut at 500 chars so they never leak into output as-is.
 */
export function formatApiError(status: number, body: string): string {
  const trimmed =
    body.length > MAX_ERROR_BODY_CHARS ? body.slice(0, MAX_ERROR_BODY_CHARS) + "..." : body;
  let hint = "";
  if (status === 401 || status === 403 || body.includes("invalid_grant")) {
    hint = " Re-authenticate via /login antigravity.";
  } else if (status === 429) {
    hint = " Check reset times via /antigravity usage.";
  } else if (status >= 500) {
    hint = " This looks like a backend error; retry later.";
  }
  return `(${status}): ${trimmed}${hint}`;
}

export const METADATA_TIMEOUT_MS = 30_000;

/**
 * Combines the caller's signal with a timeout for metadata calls
 * (quota/models/token/loadCodeAssist). Never use for streams: long
 * generations are not stalls. Call dispose() once the body is consumed.
 */
export function withMetadataTimeout(
  caller?: AbortSignal,
  ms = METADATA_TIMEOUT_MS
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(caller?.reason);
  if (caller?.aborted) {
    controller.abort(caller.reason);
  } else {
    caller?.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`metadata call timed out after ${ms}ms`)), ms);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    },
  };
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
