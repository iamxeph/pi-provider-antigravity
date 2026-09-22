import {
  type CredentialSource,
  resolveCredentials,
  requireCredentials,
  AntigravityAuthError,
} from "./auth.ts";
import {
  PROVIDER_ID,
  PROVIDER_NAME,
  DEFAULT_HOST,
  DEFAULT_ENDPOINT,
  DEFAULT_USER_AGENT,
  FALLBACK_PROJECT_ID,
} from "./constants.ts";

export {
  AntigravityAuthError,
  PROVIDER_ID,
  PROVIDER_NAME,
  DEFAULT_HOST,
  DEFAULT_ENDPOINT,
  DEFAULT_USER_AGENT,
  FALLBACK_PROJECT_ID,
};

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
  endpoint?: string;
  headers?: Record<string, string>;
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
  endpoint = DEFAULT_ENDPOINT,
  headers,
  body,
  signal,
}: AntigravityPostParams): Promise<Response> {
  const token = resolveToken(auth);
  return fetch(`${endpoint}/${path}`, {
    method: "POST",
    headers: { ...buildAntigravityHeaders(token), ...headers },
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

export interface AntigravityStreamResult {
  response: Response;
  stream: ReadableStream<Uint8Array>;
}

/**
 * Deep protocol stream client: validates HTTP status, checks stream presence,
 * and returns the validated Response and ReadableStream.
 */
export async function postAntigravityStream(
  params: AntigravityPostParams
): Promise<AntigravityStreamResult> {
  const res = await postAntigravityRaw(params);
  if (!res.ok) {
    const errText = await res.text();
    throw new AntigravityHttpError(res.status, params.path, errText);
  }
  if (!res.body) {
    throw new Error(`No response stream received from Antigravity for ${params.path}.`);
  }
  return { response: res, stream: res.body };
}

/**
 * Builds the canonical HTTP request headers for the Antigravity Wire Fingerprint.
 */
export function buildAntigravityHeaders(token: string, userAgent = DEFAULT_USER_AGENT): Record<string, string> {
  return {
    Host: DEFAULT_HOST,
    "User-Agent": userAgent,
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Protocol Client: the deep module encapsulating Wire Fingerprint endpoint routing,
 * canonical HTTP headers, status code verification, structured error representation
 * (AntigravityHttpError / AntigravityAuthError), and JSON/stream payload decoding.
 */
export interface AntigravityClient {
  readonly endpoint: string;
  readonly userAgent: string;

  /**
   * Fetches available models catalog from Google Antigravity backend.
   * Encapsulates 'v1internal:fetchAvailableModels' routing and project ID injection.
   */
  fetchAvailableModels(source?: CredentialSource, signal?: AbortSignal): Promise<any>;

  /**
   * Retrieves quota summary from Google Antigravity backend.
   * Encapsulates 'v1internal:retrieveUserQuotaSummary' routing and project ID injection.
   * Returns undefined when source is unauthenticated.
   */
  retrieveQuotaSummary(source?: CredentialSource, signal?: AbortSignal): Promise<any>;

  /**
   * Streams generation content (SSE) from Google Antigravity backend.
   * Encapsulates 'v1internal:streamGenerateContent?alt=sse' routing.
   */
  streamGenerateContent(params: {
    source: CredentialSource;
    body: unknown;
    endpoint?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<AntigravityStreamResult>;

  /**
   * Issues a single-shot JSON POST request to Google Antigravity backend,
   * automatically resolving credentials, injecting project ID, and validating HTTP response.
   */
  postJson<T>(
    source: CredentialSource,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<T>;
}

export function createAntigravityClient(options?: {
  endpoint?: string;
  userAgent?: string;
}): AntigravityClient {
  const endpoint = options?.endpoint || DEFAULT_ENDPOINT;
  const userAgent = options?.userAgent || DEFAULT_USER_AGENT;

  return {
    endpoint,
    userAgent,

    async fetchAvailableModels(source?: CredentialSource, signal?: AbortSignal): Promise<any> {
      const creds = await requireCredentials(source);
      return postAntigravityJson<any>({
        auth: creds.token,
        endpoint,
        path: "v1internal:fetchAvailableModels",
        body: { project: creds.projectId },
        signal,
      });
    },

    async retrieveQuotaSummary(source?: CredentialSource, signal?: AbortSignal): Promise<any> {
      const creds = await resolveCredentials(source);
      if (!creds) return undefined;
      return postAntigravityJson<any>({
        auth: creds.token,
        endpoint,
        path: "v1internal:retrieveUserQuotaSummary",
        body: { project: creds.projectId },
        signal,
      });
    },

    async streamGenerateContent(params: {
      source: CredentialSource;
      body: unknown;
      endpoint?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    }): Promise<AntigravityStreamResult> {
      const creds = await requireCredentials(params.source);
      return postAntigravityStream({
        auth: creds.token,
        endpoint: params.endpoint || endpoint,
        path: "v1internal:streamGenerateContent?alt=sse",
        headers: params.headers,
        body: params.body,
        signal: params.signal,
      });
    },

    async postJson<T>(
      source: CredentialSource,
      path: string,
      body: unknown = {},
      signal?: AbortSignal,
      headers?: Record<string, string>,
    ): Promise<T> {
      const creds = await requireCredentials(source);
      const effectiveBody =
        body && typeof body === "object" && !Array.isArray(body)
          ? { project: creds.projectId, ...(body as Record<string, unknown>) }
          : body;

      return postAntigravityJson<T>({
        auth: creds.token,
        endpoint,
        path,
        body: effectiveBody,
        headers,
        signal,
      });
    },
  };
}

export const defaultAntigravityClient = createAntigravityClient();


