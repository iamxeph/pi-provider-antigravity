import { createHash, randomUUID } from "node:crypto";
import type { ModelPlan } from "./catalog.ts";
import { extractBaseModelId } from "./catalog.ts";
import { PROVIDER_ID } from "./protocol.ts";

export interface BuildRequestBodyParams {
  projectId: string;
  plan: ModelPlan;
  context: {
    systemPrompt?: string;
    messages: Array<any>;
    tools?: Array<any>;
  };
  sessionId?: string;
  trajectoryId?: string;
  maxOutputTokens?: number;
  toolChoice?: string;
}

const BASE64_SIGNATURE_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Verifies that a thought signature candidate is a valid base64 string suitable
 * for Google Protobuf TYPE_BYTES fields in JSON mapping.
 */
function isValidThoughtSignature(sig: unknown): sig is string {
  if (typeof sig !== "string" || sig.length === 0) return false;
  if (sig.includes("=") && sig.length % 4 !== 0) return false;
  return BASE64_SIGNATURE_PATTERN.test(sig);
}

/**
 * Resolves a thoughtSignature candidate only when coming from the same provider and
 * compatible model family, and only when formatted as valid base64.
 */
function resolveThoughtSignature(
  isSameProviderAndModel: boolean,
  sig: unknown
): string | undefined {
  if (!isSameProviderAndModel) return undefined;
  return isValidThoughtSignature(sig) ? sig : undefined;
}

/**
 * Checks model family compatibility for thoughtSignature replay.
 * Official agy CLI wire captures demonstrate that:
 * - Gemini models (gemini-3.7, gemini-3.8, etc.) share thoughtSignatures seamlessly.
 * - Non-Gemini models (Claude, GPT-OSS) do NOT share signatures with Gemini models.
 */
function isCompatibleModelFamily(msgModel?: string, targetModelId?: string): boolean {
  if (!msgModel || !targetModelId) return true;
  if (msgModel === targetModelId) return true;

  const isMsgGemini = msgModel.startsWith("gemini-");
  const isTargetGemini = targetModelId.startsWith("gemini-");
  if (isMsgGemini && isTargetGemini) return true;

  const isMsgClaude = msgModel.startsWith("claude-");
  const isTargetClaude = targetModelId.startsWith("claude-");
  if (isMsgClaude && isTargetClaude) return true;

  const isMsgGpt = msgModel.startsWith("gpt-");
  const isTargetGpt = targetModelId.startsWith("gpt-");
  if (isMsgGpt && isTargetGpt) return true;

  return extractBaseModelId(msgModel) === extractBaseModelId(targetModelId);
}

/**
 * Deterministically derives a persistent session ID from the initial conversation turn.
 */
function deriveSessionId(
  context: { messages?: Array<any>; systemPrompt?: string },
  explicitSessionId?: string
): string {
  if (explicitSessionId && typeof explicitSessionId === "string" && explicitSessionId.trim().length > 0) {
    return explicitSessionId.trim();
  }

  const firstMsg = context.messages?.[0];
  if (!firstMsg) {
    return randomUUID();
  }

  const seedContent =
    typeof firstMsg.content === "string"
      ? firstMsg.content
      : JSON.stringify(firstMsg.content || "");

  const hash = createHash("sha256")
    .update(`antigravity:conversation:${seedContent}`)
    .digest()
    .subarray(0, 16);

  hash[6] = (hash[6] & 0x0f) | 0x40; // v4 UUID
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Computes deterministic v5 UUID trajectory ID from the session ID.
 */
function resolveSessionTrajectory(sessionId: string): string {
  const bytes = createHash("sha1").update(`antigravity:${sessionId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // v5 UUID
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Computes signed 64-bit integer session ID matching official agy CLI Wire Fingerprint.
 */
function resolveNumericSessionId(sessionId: string): string {
  if (/^-?\d+$/.test(sessionId)) {
    return sessionId;
  }
  const hash = createHash("sha256").update(`antigravity:session:${sessionId}`).digest();
  return hash.readBigInt64BE(0).toString();
}

/**
 * Normalizes tool call IDs for cross-provider compatibility.
 */
function normalizeToolCallId(id: string | undefined): string | undefined {
  if (!id || typeof id !== "string") return id;
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

const CUSTOM_TOOL_SCHEMA_ALLOW = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
]);

function stripMetaSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const omit = new Set(["$schema", "$id", "$defs", "definitions"]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!omit.has(key)) out[key] = stripMetaSchema(value);
  }
  return out;
}

function normalizeCustomToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);

  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(s)) {
    if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) {
      // Map string const to single-item enum for Claude bridge compatibility
      if (key === "const" && s.enum === undefined && typeof value === "string") {
        out.enum = [value];
      }
      continue;
    }
    if (key === "type" && Array.isArray(value)) {
      const scalar = value.find((e) => typeof e === "string" && e !== "null");
      if (scalar) out.type = scalar;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propName] = normalizeCustomToolSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (key === "enum" && Array.isArray(value) && !value.every((e) => typeof e === "string")) {
      continue;
    }
    out[key] = normalizeCustomToolSchema(value);
  }
  return out;
}

function convertTools(
  tools: Array<any> | undefined,
  useLegacyParameters = false
): Array<{ functionDeclarations: Array<any> }> | undefined {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const schema = stripMetaSchema(tool.parameters) || { type: "object", properties: {} };
        return {
          name: tool.name,
          description: tool.description,
          ...(useLegacyParameters
            ? { parameters: normalizeCustomToolSchema(schema) }
            : { parametersJsonSchema: schema }),
        };
      }),
    },
  ];
}

/**
 * Translates one Turn Trace (see CONTEXT.md) into Antigravity wire contents.
 */
function translateTurnTrace(
  context: { messages?: Array<any>; systemPrompt?: string },
  runtimeModelId: string
): Array<any> {
  const contents: Array<any> = [];
  const messages = context.messages || [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const parts: Array<any> = [];
      if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === "text") {
            parts.push({ text: item.text });
          } else if (item.type === "image") {
            parts.push({
              inlineData: {
                mimeType: item.mimeType || "image/png",
                data: item.data,
              },
            });
          }
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "user", parts });
      }
    } else if (msg.role === "assistant") {
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }

      const isSameProvider = !msg.provider || msg.provider === PROVIDER_ID;
      const isSameModel = isCompatibleModelFamily(msg.model, runtimeModelId);
      const isSameProviderAndModel = isSameProvider && isSameModel;

      const parts: Array<any> = [];
      // agy CLI shape (1.1.27 turn4 fixture): a thinking replay never carries its
      // own signature — it stays pending and rides on the NEXT text/functionCall
      // part. Only when the turn ends with no carrying part does it fall back
      // onto the last part (uncovered edge, same as the message-level fallback).
      let pendingThinkingSig: string | undefined;
      if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === "text") {
            const part: any = { text: item.text };
            const sig =
              resolveThoughtSignature(
                isSameProviderAndModel,
                item.thoughtSignature || (item as any).textSignature
              ) || pendingThinkingSig;
            if (sig) {
              part.thoughtSignature = sig;
              pendingThinkingSig = undefined;
            }
            parts.push(part);
          } else if (item.type === "thinking") {
            const candidateSig =
              item.thoughtSignature || item.thinkingSignature || (msg as any).thoughtSignature;
            const isForeignReasoning =
              !isSameProviderAndModel ||
              (typeof candidateSig === "string" && candidateSig.trim().startsWith("{"));

            if (!isForeignReasoning) {
              // No thoughtSignature here by design: it stays pending for the
              // next text/functionCall part (agy CLI part-split shape).
              const part: any = {
                thought: true,
                text: item.thinking || "",
              };
              const sig = resolveThoughtSignature(true, candidateSig);
              if (sig) {
                pendingThinkingSig = sig;
              }
              parts.push(part);
            } else {
              // Cross-provider/model or foreign reasoning item: drop foreign signature and
              // serialize reasoning text (or summary) as plain text so the model retains
              // conversation context without failing Google's TYPE_BYTES base64 validation.
              let text = item.thinking || "";
              if (!text && typeof candidateSig === "string" && candidateSig.trim().startsWith("{")) {
                try {
                  const parsed = JSON.parse(candidateSig);
                  if (Array.isArray(parsed.summary)) {
                    text = parsed.summary
                      .filter((s: any) => s && typeof s.text === "string")
                      .map((s: any) => s.text)
                      .join("\n");
                  }
                } catch {
                  // Ignore JSON parse errors
                }
              }
              if (text && text.trim() !== "") {
                parts.push({ text });
              }
            }
          } else if (item.type === "tool_use" || item.type === "toolCall") {
            const part: any = {
              functionCall: {
                id: normalizeToolCallId(item.id),
                name: item.name,
                args: item.input || item.arguments || {},
              },
            };
            const sig =
              resolveThoughtSignature(
                isSameProviderAndModel,
                item.thoughtSignature || (msg as any).thoughtSignature
              ) || pendingThinkingSig;
            if (sig) {
              part.thoughtSignature = sig;
              pendingThinkingSig = undefined;
            }
            parts.push(part);
          }
        }
      }
      if (parts.length > 0) {
        if (pendingThinkingSig && !parts.some((p) => p.thoughtSignature)) {
          parts[parts.length - 1].thoughtSignature = pendingThinkingSig;
        }
        const msgSig = resolveThoughtSignature(
          isSameProviderAndModel,
          (msg as any).thoughtSignature
        );
        if (msgSig && !parts.some((p) => p.thoughtSignature)) {
          parts[parts.length - 1].thoughtSignature = msgSig;
        }
        contents.push({ role: "model", parts });
      }
    } else if (msg.role === "toolResult") {
      let toolName = msg.toolName || msg.name;
      if (!toolName && (msg.toolCallId || msg.id)) {
        const rawTargetId = msg.toolCallId || msg.id;
        const normTargetId = normalizeToolCallId(rawTargetId);
        for (const prev of messages) {
          if (prev.role === "assistant" && Array.isArray(prev.content)) {
            const found = prev.content.find(
              (c: any) =>
                (c.type === "tool_use" || c.type === "toolCall") &&
                (c.id === rawTargetId || normalizeToolCallId(c.id) === normTargetId)
            );
            if (found) {
              toolName = found.name;
              break;
            }
          }
        }
      }

      let toolText = "";
      const imageParts: Array<any> = [];

      if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        for (const c of msg.content) {
          if (typeof c === "string") {
            textParts.push(c);
          } else if (c.type === "text") {
            textParts.push(c.text);
          } else if (c.type === "image") {
            imageParts.push({
              inlineData: {
                mimeType: c.mimeType || "image/png",
                data: c.data,
              },
            });
          } else {
            textParts.push(JSON.stringify(c));
          }
        }
        toolText = textParts.join("\n");
      } else if (typeof msg.content === "string") {
        toolText = msg.content;
      } else if (msg.content) {
        toolText = JSON.stringify(msg.content);
      }

      // Strict agy parity (captured 2026-09-05 via mitmdump, agy 1.1.26):
      // - response is always { output: string }, never a top-level list.
      // - error tool results also use the "output" key.
      const responseObj = { output: toolText };

      const functionResponse: any = {
        name: toolName || "tool",
        response: responseObj,
      };

      const rawCallId = msg.toolCallId || msg.id;
      const callId = normalizeToolCallId(rawCallId);
      if (callId) {
        functionResponse.id = callId;
      }

      if (imageParts.length > 0) {
        functionResponse.parts = imageParts;
      }

      contents.push({
        role: "model",
        parts: [{ functionResponse }],
      });
    }
  }

  // Antigravity rejects requests ending with an incomplete model turn.
  if (contents.length > 0) {
    const lastContent = contents[contents.length - 1];
    if (
      lastContent.role === "model" &&
      !lastContent.parts?.some((p: any) => p.functionResponse)
    ) {
      contents.push({
        role: "user",
        parts: [{ text: "continue" }],
      });
    }
  }

  return contents;
}

/**
 * Builds the complete Antigravity Wire Fingerprint request envelope.
 * Encapsulates session identity derivation, Thought Signature replay,
 * Turn Trace translation, and tool schema normalization.
 */
export function buildAntigravityRequestBody(params: BuildRequestBodyParams): Record<string, any> {
  const {
    projectId,
    plan,
    context,
    maxOutputTokens = 65536,
  } = params;
  const runtimeModelId = plan.runtimeModelId;

  const sessionId = deriveSessionId(context, params.sessionId);
  const trajectoryId =
    params.trajectoryId && typeof params.trajectoryId === "string" && params.trajectoryId.trim().length > 0
      ? params.trajectoryId.trim()
      : resolveSessionTrajectory(sessionId);
  const contents = translateTurnTrace(context, runtimeModelId);

  // Request ID sequence increments by completed assistant turns
  const requestIndex = context.messages.filter((m) => m.role === "assistant").length;
  const requestId = `agent/${sessionId}/${Date.now()}/${trajectoryId}/${contents.length}`;

  const modelEnum = plan.modelEnum;

  const labels: Record<string, string> = {
    last_step_index: String(Math.max(0, contents.length - 1)),
    model_enum: modelEnum,
    request_id: `${trajectoryId}-${requestIndex}`,
    trajectory_id: trajectoryId,
    used_claude: String(plan.isClaude),
    used_claude_conservative: String(plan.isClaude),
    used_non_gemini_model: String(plan.isNonGemini),
  };

  const generationConfig: Record<string, any> = {
    maxOutputTokens,
    thinkingConfig: plan.thinkingConfig,
  };

  const request: Record<string, any> = {
    contents,
  };

  if (context.systemPrompt) {
    request.systemInstruction = {
      role: "user",
      parts: [{ text: context.systemPrompt }],
    };
  }

  const tools = convertTools(context.tools, plan.isNonGemini);
  if (tools) {
    request.tools = tools;
  }

  if (params.toolChoice && params.toolChoice !== "auto" && params.toolChoice !== "Auto") {
    let mode = "AUTO";
    const tc = String(params.toolChoice).toLowerCase();
    if (tc === "none") mode = "NONE";
    else if (tc === "any" || tc === "required") mode = "ANY";
    request.toolConfig = {
      functionCallingConfig: {
        mode,
      },
    };
  }

  request.labels = labels;
  request.generationConfig = generationConfig;
  request.sessionId = resolveNumericSessionId(sessionId);

  return {
    project: projectId,
    requestId,
    request,
    model: runtimeModelId,
    userAgent: "antigravity",
    requestType: "agent",
  };
}
