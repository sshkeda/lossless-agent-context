import { type CanonicalEvent, type Citation, type ContentPart, contentPartSchema } from "@lossless-agent-context/core";
import { claudeCodeTargetIdExtensions } from "./claude-code-ids";
import {
  applyCanonicalOverridesToRange,
  importEmbeddedCrossProviderLine,
  readCanonicalOverrides,
} from "./cross-provider";
import { CODEX_ASSISTANT_PARTS_FIELD, TARGET_IDS_FIELD } from "./defaults";
import {
  createEvent,
  DEFAULT_BRANCH_ID,
  nativeForLine,
  parseJsonl,
  parseStrictJson,
  syntheticSessionId,
  toIsoTimestamp,
  toolActor,
  withNativeRawRef,
} from "./utils";

type Extensions = Record<string, unknown> | undefined;

function lineExtensions(line: Record<string, unknown>): Extensions {
  return claudeCodeTargetIdExtensions(line);
}

function readCodexAssistantParts(line: Record<string, unknown>): ContentPart[] | undefined {
  const targets = line[TARGET_IDS_FIELD];
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) return undefined;
  const codex = (targets as Record<string, unknown>).codex;
  if (!codex || typeof codex !== "object" || Array.isArray(codex)) return undefined;
  const parts = (codex as Record<string, unknown>)[CODEX_ASSISTANT_PARTS_FIELD];
  if (!Array.isArray(parts)) return undefined;

  const parsed: ContentPart[] = [];
  for (const part of parts) {
    const result = contentPartSchema.safeParse(part);
    if (!result.success) return undefined;
    parsed.push(result.data);
  }
  return parsed;
}

function readCodexToolCall(item: Record<string, unknown>):
  | {
      toolCallId: string;
      toolName: string;
      arguments: unknown;
      actorToolName: string;
    }
  | undefined {
  if (typeof item.call_id !== "string" || typeof item.name !== "string") return undefined;
  const input = "arguments" in item ? item.arguments : item.input;
  const argumentsValue =
    typeof input === "string"
      ? "arguments" in item
        ? parseStrictJson(input, "Codex function_call arguments")
        : input
      : input;
  return {
    toolCallId: item.call_id,
    toolName: item.name,
    arguments: argumentsValue,
    actorToolName: item.name,
  };
}

function readCodexToolResult(item: Record<string, unknown>): { toolCallId: string; output: unknown } | undefined {
  if (typeof item.call_id !== "string") return undefined;
  return {
    toolCallId: item.call_id,
    output: item.output,
  };
}

function citationsFromCodexAnnotations(value: unknown): Citation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const citations: Citation[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "url_citation") {
      citations.push({
        type: "url_citation",
        url: typeof record.url === "string" ? record.url : undefined,
        title: typeof record.title === "string" ? record.title : undefined,
        startIndex: typeof record.start_index === "number" ? record.start_index : undefined,
        endIndex: typeof record.end_index === "number" ? record.end_index : undefined,
      });
      continue;
    }
    if (record.type === "file_citation") {
      citations.push({
        type: "file_citation",
        fileId:
          typeof record.file_id === "string"
            ? record.file_id
            : typeof record.fileId === "string"
              ? record.fileId
              : undefined,
        filename:
          typeof record.filename === "string"
            ? record.filename
            : typeof record.title === "string"
              ? record.title
              : undefined,
        startIndex: typeof record.start_index === "number" ? record.start_index : undefined,
        endIndex: typeof record.end_index === "number" ? record.end_index : undefined,
      });
      continue;
    }
    if (typeof record.type === "string") {
      citations.push({
        type: "provider_citation",
        provider: "codex",
        citationType: record.type,
        raw: record,
      });
    }
  }
  return citations.length > 0 ? citations : undefined;
}

export function importCodexJsonl(text: string): CanonicalEvent[] {
  const lines = parseJsonl(text);
  const events: CanonicalEvent[] = [];

  const sessionMeta = lines.find((line) => line.type === "session_meta") as Record<string, unknown> | undefined;
  const metaPayload = sessionMeta?.payload as Record<string, unknown> | undefined;
  let currentSessionId = typeof metaPayload?.id === "string" ? metaPayload.id : syntheticSessionId("codex", text);
  const toolNameByCallId = new Map<string, string>();

  for (const line of lines) {
    if (line.type === "session_meta") {
      const linePayload = line.payload as Record<string, unknown> | undefined;
      if (typeof linePayload?.id === "string") currentSessionId = linePayload.id;
    }
    const sessionId = currentSessionId;
    const branchId = DEFAULT_BRANCH_ID;
    const beforeIndex = events.length;
    const overrides = readCanonicalOverrides(line);
    try {
      const extensions = lineExtensions(line);
      const embedded = importEmbeddedCrossProviderLine(
        line,
        "codex",
        sessionId,
        branchId,
        events.length,
        toIsoTimestamp(line.timestamp),
      );
      if (embedded) {
        for (const event of embedded) events.push(event);
        continue;
      }

      if (line.type === "session_meta") {
        const linePayload = line.payload as Record<string, unknown> | undefined;
        if (linePayload) {
          const native = withNativeRawRef(nativeForLine(line, "codex"), "session_meta");
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: toIsoTimestamp(line.timestamp),
            kind: "session.created",
            payload: {
              startedAt: toIsoTimestamp(linePayload.timestamp),
              workingDirectory: typeof linePayload.cwd === "string" ? linePayload.cwd : undefined,
              provider:
                native.source === "codex" && typeof linePayload.model_provider === "string"
                  ? linePayload.model_provider
                  : undefined,
            },
            extensions,
            native,
          });
        }
        continue;
      }

      const baseNative = nativeForLine(line, "codex");
      const native = (rawRef?: string) => withNativeRawRef(baseNative, rawRef);

      if (line.type === "response_item") {
        const item = line.payload as Record<string, unknown> | undefined;
        if (!item || typeof item.type !== "string") continue;

        if (item.type === "message") {
          const role = item.role;
          const assistantSidecarParts = role === "assistant" ? readCodexAssistantParts(line) : undefined;
          if (role === "assistant" && assistantSidecarParts) {
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: toIsoTimestamp(line.timestamp),
              kind: "message.created",
              actor: { type: "assistant" },
              payload: {
                role: "assistant",
                parts: assistantSidecarParts,
              },
              extensions,
              native: native("response_item.message.assistant.sidecar"),
            });
            continue;
          }
          const content = Array.isArray(item.content) ? item.content : [];
          for (const [partIndex, part] of content.entries()) {
            if (!part || typeof part !== "object") continue;
            const record = part as Record<string, unknown>;
            if ((record.type === "input_text" || record.type === "output_text") && typeof record.text === "string") {
              const part =
                role === "assistant"
                  ? {
                      type: "text" as const,
                      text: record.text,
                      citations: citationsFromCodexAnnotations(record.annotations),
                    }
                  : { type: "text" as const, text: record.text };
              createEvent(events, {
                sessionId,
                branchId,
                timestamp: toIsoTimestamp(line.timestamp),
                kind: "message.created",
                actor: { type: role === "assistant" ? "assistant" : "user" },
                payload: {
                  role: role === "assistant" ? "assistant" : "user",
                  parts: [part],
                },
                extensions,
                native: native(`response_item.message.content[${partIndex}].${record.type}`),
              });
              continue;
            }

            if (record.type === "input_image") {
              const imageUrlRaw = record.image_url;
              const imageUrl =
                typeof imageUrlRaw === "string"
                  ? imageUrlRaw
                  : imageUrlRaw &&
                      typeof imageUrlRaw === "object" &&
                      typeof (imageUrlRaw as Record<string, unknown>).url === "string"
                    ? ((imageUrlRaw as Record<string, unknown>).url as string)
                    : undefined;
              if (imageUrl) {
                const dataMatch = /^data:([^;]+);base64,(.*)$/.exec(imageUrl);
                const imageRef = dataMatch ? (dataMatch[2] ?? imageUrl) : imageUrl;
                const mediaType = dataMatch ? dataMatch[1] : undefined;
                createEvent(events, {
                  sessionId,
                  branchId,
                  timestamp: toIsoTimestamp(line.timestamp),
                  kind: "message.created",
                  actor: { type: role === "assistant" ? "assistant" : "user" },
                  payload: {
                    role: role === "assistant" ? "assistant" : "user",
                    parts: [{ type: "image", imageRef, mediaType }],
                  },
                  extensions,
                  native: native(`response_item.message.content[${partIndex}].input_image`),
                });
              }
            }
          }
          continue;
        }

        if (item.type === "reasoning") {
          const summary = Array.isArray(item.summary) ? item.summary : [];
          const text = summary
            .map((part) =>
              part && typeof part === "object" && (part as Record<string, unknown>).type === "summary_text"
                ? (part as Record<string, unknown>).text
                : undefined,
            )
            .filter((value): value is string => typeof value === "string")
            .join("\n\n");

          createEvent(events, {
            sessionId,
            branchId,
            timestamp: toIsoTimestamp(line.timestamp),
            kind: "reasoning.created",
            actor: { type: "assistant" },
            payload: {
              visibility: "summary",
              text: text || undefined,
              providerExposed: true,
            },
            extensions,
            native: native("response_item.reasoning"),
          });
          continue;
        }

        if (item.type === "function_call" || item.type === "custom_tool_call") {
          const toolCall = readCodexToolCall(item);
          if (!toolCall) {
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: toIsoTimestamp(line.timestamp),
              kind: "provider.event",
              payload: {
                provider: "codex",
                eventType: `${item.type}.invalid`,
                raw: line,
              },
              extensions,
              native: native(`response_item.${item.type}.invalid`),
            });
            continue;
          }
          toolNameByCallId.set(toolCall.toolCallId, toolCall.toolName);
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: toIsoTimestamp(line.timestamp),
            kind: "tool.call",
            actor: {
              type: "assistant",
              toolName: toolCall.actorToolName,
            },
            payload: {
              toolCallId: toolCall.toolCallId,
              name: toolCall.toolName,
              arguments: toolCall.arguments,
            },
            extensions,
            native: native(`response_item.${item.type}`),
          });
          continue;
        }

        if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
          const result = readCodexToolResult(item);
          if (!result) {
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: toIsoTimestamp(line.timestamp),
              kind: "provider.event",
              payload: {
                provider: "codex",
                eventType: `${item.type}.invalid`,
                raw: line,
              },
              extensions,
              native: native(`response_item.${item.type}.invalid`),
            });
            continue;
          }
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: toIsoTimestamp(line.timestamp),
            kind: "tool.result",
            actor: toolActor(toolNameByCallId.get(result.toolCallId)),
            payload: {
              toolCallId: result.toolCallId,
              output: result.output,
              isError: false,
            },
            extensions,
            native: native(`response_item.${item.type}`),
          });
          continue;
        }
      }

      if (line.type === "event_msg") {
        const item = line.payload as Record<string, unknown> | undefined;
        if (!item || typeof item.type !== "string") continue;

        if (item.type === "thread_name_updated") {
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: toIsoTimestamp(line.timestamp),
            kind: "provider.event",
            payload: {
              provider: "codex",
              eventType: item.type,
              raw: item,
            },
            extensions,
            native: native("event_msg.thread_name_updated"),
          });
          continue;
        }

        if (item.type === "agent_message" && typeof item.message === "string") {
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: toIsoTimestamp(line.timestamp),
            kind: "message.created",
            actor: { type: "assistant" },
            payload: { role: "assistant", parts: [{ type: "text", text: item.message }] },
            extensions,
            native: native("event_msg.agent_message"),
          });
          continue;
        }

        if (item.type === "agent_reasoning" && typeof item.text === "string") {
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: toIsoTimestamp(line.timestamp),
            kind: "reasoning.created",
            actor: { type: "assistant" },
            payload: {
              visibility: "summary",
              text: item.text,
              providerExposed: true,
            },
            extensions,
            native: native("event_msg.agent_reasoning"),
          });
          continue;
        }

        if (item.type === "model_change" && typeof item.message === "string") {
          if (typeof item.provider !== "string") {
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: toIsoTimestamp(line.timestamp),
              kind: "provider.event",
              payload: {
                provider: "codex",
                eventType: "model_change.invalid",
                raw: line,
              },
              extensions,
              native: native("event_msg.model_change.invalid"),
            });
            continue;
          }
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: toIsoTimestamp(line.timestamp),
            kind: "model.selected",
            payload: {
              provider: item.provider,
              model: item.message,
            },
            extensions,
            native: native("event_msg.model_change"),
          });
          continue;
        }
      }

      createEvent(events, {
        sessionId,
        branchId,
        timestamp: toIsoTimestamp(line.timestamp),
        kind: "provider.event",
        payload: {
          provider: "codex",
          eventType: typeof line.type === "string" ? line.type : "line.missing_type",
          raw: line,
        },
        extensions,
        native: native(`line.${typeof line.type === "string" ? line.type : "missing_type"}`),
      });
    } finally {
      applyCanonicalOverridesToRange(events, overrides, beforeIndex);
    }
  }

  return events;
}
