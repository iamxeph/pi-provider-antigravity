import { postAntigravityJson } from "./protocol.ts";
import { FALLBACK_PROJECT_ID, type AntigravityCredentials } from "./auth.ts";

export interface WebSearchOptions {
  query: string;
  domain?: string;
  signal?: AbortSignal;
}

export interface GroundingChunk {
  web?: {
    uri: string;
    title: string;
  };
}

export interface GroundingSupport {
  segment?: {
    startIndex?: number;
    endIndex?: number;
    text?: string;
  };
  groundingChunkIndices?: number[];
}

export interface GroundingMetadata {
  webSearchQueries?: string[];
  searchEntryPoint?: {
    renderedContent?: string;
  };
  groundingChunks?: GroundingChunk[];
  groundingSupports?: GroundingSupport[];
}

export interface SearchCandidate {
  content?: {
    role: string;
    parts?: Array<{
      text?: string;
      thoughtSignature?: string;
    }>;
  };
  finishReason?: string;
  groundingMetadata?: GroundingMetadata;
}

export interface SearchApiResponse {
  response?: {
    candidates?: SearchCandidate[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
    modelVersion?: string;
    responseId?: string;
  };
  traceId?: string;
  metadata?: unknown;
}

export interface SearchSource {
  index: number;
  title: string;
  url: string;
}

export interface SearchResult {
  query: string;
  rawText: string;
  formattedOutput: string;
  sources: SearchSource[];
  queries: string[];
  createdAt: string;
  completedAt: string;
}

export const SEARCH_SYSTEM_INSTRUCTION =
  "You are a search engine bot. You will be given a query from a user. " +
  "Your task is to search the web for relevant information that will help the user. " +
  "You MUST perform a web search. Do not respond or interact with the user, " +
  "please respond as if they typed the query into a search bar.";

export const SEARCH_MODEL = "gemini-3.1-flash-lite";

/**
 * Annotates the raw text with inline citations [1][2] and appends Sources list,
 * matching agy CLI's exact Wire output shape.
 */
export function formatSearchResults(
  rawText: string,
  metadata: GroundingMetadata | undefined,
  query: string,
  createdAt: string,
  completedAt: string
): SearchResult {
  const sources: SearchSource[] = (metadata?.groundingChunks || [])
    .map((chunk, i) => ({
      index: i + 1,
      title: chunk.web?.title || "Web Source",
      url: chunk.web?.uri || "",
    }))
    .filter((s) => Boolean(s.url));

  const queries = metadata?.webSearchQueries || [];

  let annotatedText = rawText;
  const supports = (metadata?.groundingSupports || [])
    .filter(
      (s): s is GroundingSupport & { segment: { endIndex: number } } =>
        typeof s.segment?.endIndex === "number" &&
        Array.isArray(s.groundingChunkIndices) &&
        s.groundingChunkIndices.length > 0
    )
    .slice()
    .sort((a, b) => (b.segment.endIndex ?? 0) - (a.segment.endIndex ?? 0));

  // Insert footnote citations from end to start so indices stay stable
  for (const sup of supports) {
    const end = sup.segment.endIndex;
    if (end >= 0 && end <= annotatedText.length) {
      const citations = (sup.groundingChunkIndices || [])
        .map((idx) => `[${idx + 1}]`)
        .join("");
      annotatedText = annotatedText.slice(0, end) + citations + annotatedText.slice(end);
    }
  }

  const sourceLines = sources.map((s) => `[${s.index}] [${s.title}](${s.url})`);

  let formattedOutput =
    `Created At: ${createdAt}\n` +
    `Completed At: ${completedAt}\n` +
    `The search for "${query}" returned the following summary:\n` +
    `${annotatedText.trim() || "No content returned."}`;

  if (sourceLines.length > 0) {
    formattedOutput += `\n\nSources:\n${sourceLines.join("\n")}`;
  }

  return {
    query,
    rawText,
    formattedOutput,
    sources,
    queries,
    createdAt,
    completedAt,
  };
}

/**
 * Executes a live Google Web Search with Search Grounding via Antigravity backend,
 * replicating agy CLI's native search_web tool call.
 */
export async function performWebSearch(
  creds: AntigravityCredentials,
  options: WebSearchOptions
): Promise<SearchResult> {
  const createdAt = new Date().toISOString();
  let effectiveQuery = options.query.trim();
  if (options.domain && options.domain.trim()) {
    const d = options.domain.trim();
    if (!effectiveQuery.toLowerCase().includes(`site:${d.toLowerCase()}`)) {
      effectiveQuery = `${effectiveQuery} site:${d}`;
    }
  }

  const reqBody = {
    project: creds.projectId || FALLBACK_PROJECT_ID,
    request: {
      contents: [
        {
          role: "user",
          parts: [{ text: effectiveQuery }],
        },
      ],
      systemInstruction: {
        role: "user",
        parts: [{ text: SEARCH_SYSTEM_INSTRUCTION }],
      },
      tools: [
        {
          googleSearch: {
            enhancedContent: {
              imageSearch: {
                maxResultCount: 5,
              },
            },
          },
        },
      ],
      generationConfig: {
        candidateCount: 1,
      },
    },
    model: SEARCH_MODEL,
    userAgent: "antigravity",
    requestType: "web_search",
  };

  const resp = await postAntigravityJson<SearchApiResponse>({
    auth: creds.token,
    path: "v1internal:generateContent",
    body: reqBody,
    signal: options.signal,
  });

  const completedAt = new Date().toISOString();
  const candidate = resp.response?.candidates?.[0];
  const rawText =
    candidate?.content?.parts
      ?.filter((p) => typeof p.text === "string")
      .map((p) => p.text)
      .join("") || "";
  const metadata = candidate?.groundingMetadata;

  return formatSearchResults(rawText, metadata, effectiveQuery, createdAt, completedAt);
}
