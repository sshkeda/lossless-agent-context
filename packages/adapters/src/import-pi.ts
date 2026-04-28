import type { CanonicalEvent, ContentPart } from "@lossless-agent-context/core";
import { claudeCodeTargetIdExtensions } from "./claude-code-ids";
import {
  applyCanonicalOverridesToRange,
  importEmbeddedCrossProviderLine,
  readCanonicalOverrides,
} from "./cross-provider";
import { normalizePiMcpToolName } from "./tool-projections";
import {
  createEvent,
  DEFAULT_BRANCH_ID,
  epochMillisToIso,
  nativeForLine,
  parseJsonlWithText,
  syntheticSessionId,
  toIsoTimestamp,
  withNativeRawRef,
} from "./utils";

type Extensions = Record<string, unknown> | undefined;

const PI_CLAUDE_CODE_TOOL_PROVENANCE_KEY = "pi-claude-code/toolProvenance";

function lineExtensions(line: Record<string, unknown>): Extensions {
  return claudeCodeTargetIdExtensions(line);
}

function readMessageDetails(message: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const details = message?.details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
}

function readToolProvenanceForCall(
  message: Record<string, unknown> | undefined,
  toolCallId: string,
): Record<string, unknown> | undefined {
  const details = readMessageDetails(message);
  const provenanceById = details?.[PI_CLAUDE_CODE_TOOL_PROVENANCE_KEY];
  if (!provenanceById || typeof provenanceById !== "object" || Array.isArray(provenanceById)) return undefined;
  const provenance = (provenanceById as Record<string, unknown>)[toolCallId];
  return provenance && typeof provenance === "object" && !Array.isArray(provenance)
    ? (provenance as Record<string, unknown>)
    : undefined;
}

function withToolProvenanceExtension(
  extensions: Extensions,
  message: Record<string, unknown> | undefined,
  toolCallId: string,
): Extensions {
  const provenance = readToolProvenanceForCall(message, toolCallId);
  if (!provenance) return extensions;
  return { ...(extensions ?? {}), [PI_CLAUDE_CODE_TOOL_PROVENANCE_KEY]: provenance };
}

function piContentParts(value: unknown): ContentPart[] {
  if (typeof value === "string") {
    return value.length > 0 ? [{ type: "text", text: value }] : [];
  }

  if (!Array.isArray(value)) {
    return value && typeof value === "object" ? [{ type: "json", value }] : [];
  }

  const parts: ContentPart[] = [];
  for (const block of value) {
    parts.push(...piContentPartsFromBlock(block));
  }
  return parts;
}

function piContentPartsFromBlock(value: unknown): ContentPart[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return piContentParts(value);
  }

  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return [{ type: "text", text: record.text }];
  }

  if (record.type === "image" && typeof record.data === "string") {
    return [
      {
        type: "image",
        imageRef: record.data,
        mediaType: typeof record.mimeType === "string" ? record.mimeType : undefined,
      },
    ];
  }

  if (record.type === "file") {
    if (typeof record.fileId !== "string") {
      return [{ type: "json", value: record }];
    }
    return [
      {
        type: "file",
        fileId: record.fileId,
        filename: typeof record.filename === "string" ? record.filename : undefined,
        mediaType: typeof record.mediaType === "string" ? record.mediaType : undefined,
      },
    ];
  }

  return [{ type: "json", value: record }];
}

function cacheFromPiMessage(message: Record<string, unknown> | undefined): CanonicalEvent["cache"] | undefined {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  const readTokens = typeof record.cacheRead === "number" ? record.cacheRead : undefined;
  const writeTokens = typeof record.cacheWrite === "number" ? record.cacheWrite : undefined;
  const inputTokens = typeof record.input === "number" ? record.input : undefined;
  const outputTokens = typeof record.output === "number" ? record.output : undefined;
  const totalTokens = typeof record.totalTokens === "number" ? record.totalTokens : undefined;
  if (
    readTokens === undefined &&
    writeTokens === undefined &&
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  if (
    (readTokens ?? 0) === 0 &&
    (writeTokens ?? 0) === 0 &&
    (inputTokens ?? 0) === 0 &&
    (outputTokens ?? 0) === 0 &&
    (totalTokens ?? 0) === 0
  ) {
    return undefined;
  }
  return {
    provider: typeof message?.provider === "string" ? message.provider : undefined,
    readTokens,
    writeTokens,
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function piTimestamp(value: unknown, label = "Pi timestamp"): string {
  return typeof value === "number" ? epochMillisToIso(value, label) : toIsoTimestamp(value, label);
}

export function importPiSessionJsonl(text: string): CanonicalEvent[] {
  const entries = parseJsonlWithText(text);
  const lines = entries.map((entry) => entry.line);
  const events: CanonicalEvent[] = [];

  const sessionHeader = lines.find((line) => line.type === "session") as Record<string, unknown> | undefined;
  let currentSessionId = typeof sessionHeader?.id === "string" ? sessionHeader.id : syntheticSessionId("pi", text);

  for (const entry of entries) {
    const { line, text: lineText } = entry;
    if (line.type === "session" && typeof line.id === "string") currentSessionId = line.id;
    const sessionId = currentSessionId;
    const branchId = DEFAULT_BRANCH_ID;
    const beforeIndex = events.length;
    const overrides = readCanonicalOverrides(line);
    try {
      const embedded = importEmbeddedCrossProviderLine(
        line,
        "pi",
        sessionId,
        branchId,
        events.length,
        line.type === "session" ? piTimestamp(line.timestamp, "Pi session timestamp") : piTimestamp(line.timestamp),
      );
      if (embedded) {
        for (const event of embedded) events.push(event);
        continue;
      }

      const baseNative = nativeForLine(line, "pi", lineText);
      const native = (rawRef?: string) => withNativeRawRef(baseNative, rawRef);
      const extensions = lineExtensions(line);

      switch (line.type) {
        case "session":
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: piTimestamp(line.timestamp, "Pi session timestamp"),
            kind: "session.created",
            payload: {
              startedAt: piTimestamp(line.timestamp, "Pi session timestamp"),
              workingDirectory: typeof line.cwd === "string" ? line.cwd : undefined,
            },
            extensions:
              baseNative.source === "pi" && line.version !== undefined && line.version !== null
                ? { ...(extensions ?? {}), version: String(line.version) }
                : extensions,
            native: native("session"),
          });
          break;
        case "model_change": {
          if (typeof line.provider !== "string" || typeof line.modelId !== "string") {
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: piTimestamp(line.timestamp),
              kind: "provider.event",
              payload: {
                provider: "pi",
                eventType: "model_change.invalid",
                raw: line,
              },
              extensions,
              native: native("model_change.invalid"),
            });
            break;
          }
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: piTimestamp(line.timestamp),
            kind: "model.selected",
            payload: {
              provider: line.provider,
              model: line.modelId,
            },
            extensions,
            native: native("model_change"),
          });
          break;
        }
        case "custom_message": {
          const content = line.content;
          const parts = piContentParts(content);
          if (parts.length > 0) {
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: piTimestamp(line.timestamp),
              kind: "message.created",
              actor: { type: "user" },
              payload: { role: "user", parts },
              extensions,
              native: native("custom_message"),
            });
          }
          break;
        }
        case "message": {
          const message = line.message as Record<string, unknown> | undefined;
          if (!message || typeof message.role !== "string") break;

          if (message.role === "user" || message.role === "system") {
            const parts = piContentParts(message.content);
            if (parts.length > 0) {
              createEvent(events, {
                sessionId,
                branchId,
                timestamp: piTimestamp(message.timestamp ?? line.timestamp),
                kind: "message.created",
                actor: { type: message.role },
                payload: { role: message.role, parts },
                extensions,
                native: native(`message.${message.role}`),
              });
            }
            break;
          }

          if (message.role === "assistant") {
            const content = Array.isArray(message.content) ? message.content : [];
            const cache = cacheFromPiMessage(message);
            for (const [blockIndex, block] of content.entries()) {
              if (!block || typeof block !== "object") continue;
              const record = block as Record<string, unknown>;

              if (record.type === "thinking") {
                createEvent(events, {
                  sessionId,
                  branchId,
                  timestamp: piTimestamp(message.timestamp ?? line.timestamp),
                  kind: "reasoning.created",
                  actor: { type: "assistant" },
                  payload: {
                    visibility: "full",
                    text: typeof record.thinking === "string" ? record.thinking : undefined,
                    providerExposed: true,
                  },
                  cache,
                  extensions,
                  native: native(`message.assistant.content[${blockIndex}].thinking`),
                });
                continue;
              }

              if (record.type === "text" && typeof record.text === "string") {
                createEvent(events, {
                  sessionId,
                  branchId,
                  timestamp: piTimestamp(message.timestamp ?? line.timestamp),
                  kind: "message.created",
                  actor: { type: "assistant" },
                  payload: { role: "assistant", parts: [{ type: "text", text: record.text }] },
                  cache,
                  extensions,
                  native: native(`message.assistant.content[${blockIndex}].text`),
                });
                continue;
              }

              if (record.type === "toolCall") {
                if (typeof record.id !== "string" || typeof record.name !== "string") {
                  createEvent(events, {
                    sessionId,
                    branchId,
                    timestamp: piTimestamp(message.timestamp ?? line.timestamp),
                    kind: "provider.event",
                    payload: {
                      provider: "pi",
                      eventType: "message.toolCall.invalid",
                      raw: line,
                    },
                    cache,
                    extensions,
                    native: native(`message.assistant.content[${blockIndex}].toolCall.invalid`),
                  });
                  continue;
                }
                const toolName = normalizePiMcpToolName(record.name);
                createEvent(events, {
                  sessionId,
                  branchId,
                  timestamp: piTimestamp(message.timestamp ?? line.timestamp),
                  kind: "tool.call",
                  actor: {
                    type: "assistant",
                    toolName,
                  },
                  payload: {
                    toolCallId: record.id,
                    name: toolName,
                    arguments: record.arguments,
                  },
                  cache,
                  extensions: withToolProvenanceExtension(extensions, message, record.id),
                  native: native(`message.assistant.content[${blockIndex}].toolCall`),
                });
              }
            }
            break;
          }

          if (message.role === "toolResult") {
            if (typeof message.toolCallId !== "string") {
              createEvent(events, {
                sessionId,
                branchId,
                timestamp: piTimestamp(message.timestamp ?? line.timestamp),
                kind: "provider.event",
                payload: {
                  provider: "pi",
                  eventType: "message.toolResult.invalid",
                  raw: line,
                },
                extensions,
                native: native("message.toolResult.invalid"),
              });
              break;
            }
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: piTimestamp(message.timestamp ?? line.timestamp),
              kind: "tool.result",
              actor: {
                type: "tool",
                toolName: typeof message.toolName === "string" ? normalizePiMcpToolName(message.toolName) : undefined,
              },
              payload: {
                toolCallId: message.toolCallId,
                output: piContentParts(message.content),
                isError: Boolean(message.isError),
                details: "details" in message ? message.details : undefined,
              },
              extensions,
              native: native("message.toolResult"),
            });
            break;
          }

          createEvent(events, {
            sessionId,
            branchId,
            timestamp: piTimestamp(line.timestamp),
            kind: "provider.event",
            payload: {
              provider: "pi",
              eventType: `message.${message.role}`,
              raw: line,
            },
            extensions,
            native: native(`message.${message.role}`),
          });
          break;
        }
        default:
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: piTimestamp(line.timestamp),
            kind: "provider.event",
            payload: {
              provider: "pi",
              eventType: typeof line.type === "string" ? line.type : "line.missing_type",
              raw: line,
            },
            extensions,
            native: native(`line.${typeof line.type === "string" ? line.type : "missing_type"}`),
          });
      }
    } finally {
      applyCanonicalOverridesToRange(events, overrides, beforeIndex);
    }
  }

  return events;
}
