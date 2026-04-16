import type { CanonicalEvent } from "@lossless-agent-context/core";
import { FOREIGN_FIELD, isForeignLine, readForeignEnvelope, reimportForeignRaw, rewriteIds } from "./cross-provider";
import { createEvent, DEFAULT_BRANCH_ID, parseJsonl, toIsoTimestamp } from "./utils";

type NativeRef = { source: string; raw: unknown };

function nativeForLine(line: Record<string, unknown>): NativeRef {
  const sidecar = line[FOREIGN_FIELD];
  if (sidecar && typeof sidecar === "object" && !Array.isArray(sidecar)) {
    const record = sidecar as Record<string, unknown>;
    if (typeof record.source === "string") {
      return { source: record.source, raw: record.raw };
    }
  }
  return { source: "claude-code", raw: line };
}

export function importClaudeCodeJsonl(text: string): CanonicalEvent[] {
  const lines = parseJsonl(text) as Array<Record<string, unknown>>;
  const events: CanonicalEvent[] = [];

  const firstNativeLine = lines.find((line) => !isForeignLine(line));
  const sessionId = typeof firstNativeLine?.sessionId === "string" ? firstNativeLine.sessionId : "claude-session";
  const branchId = DEFAULT_BRANCH_ID;
  let createdSession = false;

  function ensureSession(line: Record<string, unknown>) {
    if (createdSession) return;
    createdSession = true;
    createEvent(events, {
      sessionId,
      branchId,
      timestamp: toIsoTimestamp(line.timestamp),
      kind: "session.created",
      payload: {
        startedAt: toIsoTimestamp(line.timestamp),
        workingDirectory: typeof line.cwd === "string" ? line.cwd : undefined,
        model: typeof line.version === "string" ? line.version : undefined,
      },
      native: nativeForLine(line),
    });
  }

  for (const line of lines) {
    if (isForeignLine(line)) {
      const envelope = readForeignEnvelope(line);
      if (envelope) {
        const foreign = reimportForeignRaw(envelope);
        const rewritten = rewriteIds(foreign, sessionId, branchId, events.length);
        for (const event of rewritten) events.push(event);
        continue;
      }
    }

    ensureSession(line);
    const native = nativeForLine(line);

    switch (line.type) {
      case "user": {
        const message = line.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (typeof content === "string") {
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: toIsoTimestamp(line.timestamp),
            kind: "message.created",
            actor: { type: "user" },
            payload: { role: "user", parts: [{ type: "text", text: content }] },
            native,
          });
          break;
        }

        if (Array.isArray(content)) {
          for (const part of content) {
            if (!part || typeof part !== "object") continue;
            const record = part as Record<string, unknown>;

            if (record.type === "tool_result") {
              createEvent(events, {
                sessionId,
                branchId,
                timestamp: toIsoTimestamp(line.timestamp),
                kind: "tool.result",
                actor: { type: "tool" },
                payload: {
                  toolCallId: typeof record.tool_use_id === "string" ? record.tool_use_id : "unknown-tool-call",
                  output: record.content,
                  isError: Boolean(record.is_error),
                },
                native,
              });
              continue;
            }

            if (record.type === "text" && typeof record.text === "string") {
              createEvent(events, {
                sessionId,
                branchId,
                timestamp: toIsoTimestamp(line.timestamp),
                kind: "message.created",
                actor: { type: "user" },
                payload: { role: "user", parts: [{ type: "text", text: record.text }] },
                native,
              });
            }
          }
        }
        break;
      }
      case "assistant": {
        const message = line.message as Record<string, unknown> | undefined;
        const content = Array.isArray(message?.content) ? message?.content : [];

        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const record = part as Record<string, unknown>;

          if (record.type === "thinking") {
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: toIsoTimestamp(line.timestamp),
              kind: "reasoning.created",
              actor: { type: "assistant" },
              payload: {
                visibility: "full",
                text: typeof record.thinking === "string" ? record.thinking : undefined,
                providerExposed: true,
              },
              extensions: typeof record.signature === "string" ? { signature: record.signature } : undefined,
              native,
            });
            continue;
          }

          if (record.type === "text" && typeof record.text === "string") {
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: toIsoTimestamp(line.timestamp),
              kind: "message.created",
              actor: { type: "assistant" },
              payload: { role: "assistant", parts: [{ type: "text", text: record.text }] },
              native,
            });
            continue;
          }

          if (record.type === "tool_use") {
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: toIsoTimestamp(line.timestamp),
              kind: "tool.call",
              actor: {
                type: "assistant",
                toolName: typeof record.name === "string" ? record.name : undefined,
              },
              payload: {
                toolCallId: typeof record.id === "string" ? record.id : "unknown-tool-call",
                name: typeof record.name === "string" ? record.name : "unknown-tool",
                arguments: record.input,
              },
              native,
            });
          }
        }
        break;
      }
      default:
        createEvent(events, {
          sessionId,
          branchId,
          timestamp: toIsoTimestamp(line.timestamp),
          kind: "provider.event",
          payload: {
            provider: "claude-code",
            eventType: typeof line.type === "string" ? line.type : "unknown",
            raw: line,
          },
          native,
        });
    }
  }

  return events;
}
