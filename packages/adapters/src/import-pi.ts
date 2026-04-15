import type { CanonicalEvent } from "@lossless-agent-context/core";
import { DEFAULT_BRANCH_ID, contentPartsFromUnknown, createEvent, parseJsonl, toIsoTimestamp } from "./utils";

export function importPiSessionJsonl(text: string): CanonicalEvent[] {
  const lines = parseJsonl(text) as Array<Record<string, unknown>>;
  const events: CanonicalEvent[] = [];

  const sessionHeader = lines.find(line => line.type === "session") as Record<string, unknown> | undefined;
  const sessionId = typeof sessionHeader?.id === "string" ? sessionHeader.id : "pi-session";
  const branchId = DEFAULT_BRANCH_ID;

  if (sessionHeader) {
    createEvent(events, {
      sessionId,
      branchId,
      timestamp: toIsoTimestamp(sessionHeader.timestamp),
      kind: "session.created",
      payload: {
        startedAt: toIsoTimestamp(sessionHeader.timestamp),
        workingDirectory: typeof sessionHeader.cwd === "string" ? sessionHeader.cwd : undefined,
      },
      native: { source: "pi", raw: sessionHeader },
    });
  }

  for (const line of lines) {
    switch (line.type) {
      case "session":
        break;
      case "model_change": {
        createEvent(events, {
          sessionId,
          branchId,
          timestamp: toIsoTimestamp(line.timestamp),
          kind: "model.selected",
          payload: {
            provider: typeof line.provider === "string" ? line.provider : "unknown",
            model: typeof line.modelId === "string" ? line.modelId : "unknown",
          },
          native: { source: "pi", raw: line },
        });
        break;
      }
      case "message": {
        const message = line.message as Record<string, unknown> | undefined;
        if (!message || typeof message.role !== "string") break;

        if (message.role === "user" || message.role === "system") {
          const parts = contentPartsFromUnknown(message.content);
          if (parts.length > 0) {
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: toIsoTimestamp(message.timestamp ?? line.timestamp),
              kind: "message.created",
              actor: { type: message.role },
              payload: { role: message.role, parts },
              native: { source: "pi", raw: line },
            });
          }
          break;
        }

        if (message.role === "assistant") {
          const content = Array.isArray(message.content) ? message.content : [];
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const record = block as Record<string, unknown>;

            if (record.type === "thinking") {
              createEvent(events, {
                sessionId,
                branchId,
                timestamp: toIsoTimestamp(message.timestamp ?? line.timestamp),
                kind: "reasoning.created",
                actor: { type: "assistant" },
                payload: {
                  visibility: "full",
                  text: typeof record.thinking === "string" ? record.thinking : undefined,
                  providerExposed: true,
                },
                native: { source: "pi", raw: line },
              });
              continue;
            }

            if (record.type === "text" && typeof record.text === "string") {
              createEvent(events, {
                sessionId,
                branchId,
                timestamp: toIsoTimestamp(message.timestamp ?? line.timestamp),
                kind: "message.created",
                actor: { type: "assistant" },
                payload: { role: "assistant", parts: [{ type: "text", text: record.text }] },
                native: { source: "pi", raw: line },
              });
              continue;
            }

            if (record.type === "toolCall") {
              createEvent(events, {
                sessionId,
                branchId,
                timestamp: toIsoTimestamp(message.timestamp ?? line.timestamp),
                kind: "tool.call",
                actor: {
                  type: "assistant",
                  toolName: typeof record.name === "string" ? record.name : undefined,
                },
                payload: {
                  toolCallId: typeof record.id === "string" ? record.id : "unknown-tool-call",
                  name: typeof record.name === "string" ? record.name : "unknown-tool",
                  arguments: record.arguments,
                },
                native: { source: "pi", raw: line },
              });
            }
          }
          break;
        }

        if (message.role === "toolResult") {
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: toIsoTimestamp(message.timestamp ?? line.timestamp),
            kind: "tool.result",
            actor: { type: "tool" },
            payload: {
              toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "unknown-tool-call",
              output: contentPartsFromUnknown(message.content),
              isError: Boolean(message.isError),
            },
            native: { source: "pi", raw: line },
          });
          break;
        }

        createEvent(events, {
          sessionId,
          branchId,
          timestamp: toIsoTimestamp(line.timestamp),
          kind: "provider.event",
          payload: {
            provider: "pi",
            eventType: `message.${message.role}`,
            raw: line,
          },
          native: { source: "pi", raw: line },
        });
        break;
      }
      default:
        createEvent(events, {
          sessionId,
          branchId,
          timestamp: toIsoTimestamp(line.timestamp),
          kind: "provider.event",
          payload: {
            provider: "pi",
            eventType: typeof line.type === "string" ? line.type : "unknown",
            raw: line,
          },
          native: { source: "pi", raw: line },
        });
    }
  }

  return events;
}
