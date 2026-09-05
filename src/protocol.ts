export const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const DEFAULT_USER_AGENT =
  "antigravity/cli/1.1.26 (aidev_client; os_type=linux; arch=amd64; cl=976013059; auth_method=consumer)";

export const PROVIDER_ID = "antigravity";

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
