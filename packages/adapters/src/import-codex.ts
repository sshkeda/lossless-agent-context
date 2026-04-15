import type { CanonicalEvent } from "@lossless-agent-context/core";
import { DEFAULT_BRANCH_ID, createEvent, parseJsonl, safeJsonParse, toIsoTimestamp } from "./utils";

export function importCodexJsonl(text: string): CanonicalEvent[] {
  const lines = parseJsonl(text) as Array<Record<string, unknown>>;
  const events: CanonicalEvent[] = [];

  const sessionMeta = lines.find(line => line.type === "session_meta") as Record<string, unknown> | undefined;
  const payload = sessionMeta?.payload as Record<string, unknown> | undefined;
  const sessionId = typeof payload?.id === "string" ? payload.id : "codex-session";
  const branchId = DEFAULT_BRANCH_ID;

  if (sessionMeta && payload) {
    createEvent(events, {
      sessionId,
      branchId,
      timestamp: toIsoTimestamp(sessionMeta.timestamp),
      kind: "session.created",
      payload: {
        startedAt: toIsoTimestamp(payload.timestamp),
        workingDirectory: typeof payload.cwd === "string" ? payload.cwd : undefined,
        provider: typeof payload.model_provider === "string" ? payload.model_provider : undefined,
      },
      native: { source: "codex", raw: sessionMeta },
    });
  }

  for (const line of lines) {
    if (line.type === "session_meta") continue;

    if (line.type === "response_item") {
      const item = line.payload as Record<string, unknown> | undefined;
      if (!item || typeof item.type !== "string") continue;

      if (item.type === "message") {
        const role = item.role;
        const content = Array.isArray(item.content) ? item.content : [];
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const record = part as Record<string, unknown>;
          if ((record.type === "input_text" || record.type === "output_text") && typeof record.text === "string") {
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: toIsoTimestamp(line.timestamp),
              kind: "message.created",
              actor: { type: role === "assistant" ? "assistant" : "user" },
              payload: {
                role: role === "assistant" ? "assistant" : "user",
                parts: [{ type: "text", text: record.text }],
              },
              native: { source: "codex", raw: line },
            });
          }
        }
        continue;
      }

      if (item.type === "reasoning") {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        const text = summary
          .map(part => (part && typeof part === "object" && (part as Record<string, unknown>).type === "summary_text" ? (part as Record<string, unknown>).text : undefined))
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
          native: { source: "codex", raw: line },
        });
        continue;
      }

      if (item.type === "function_call") {
        createEvent(events, {
          sessionId,
          branchId,
          timestamp: toIsoTimestamp(line.timestamp),
          kind: "tool.call",
          actor: {
            type: "assistant",
            toolName: typeof item.name === "string" ? item.name : undefined,
          },
          payload: {
            toolCallId: typeof item.call_id === "string" ? item.call_id : "unknown-tool-call",
            name: typeof item.name === "string" ? item.name : "unknown-tool",
            arguments: typeof item.arguments === "string" ? safeJsonParse(item.arguments) : item.arguments,
          },
          native: { source: "codex", raw: line },
        });
        continue;
      }

      if (item.type === "function_call_output") {
        createEvent(events, {
          sessionId,
          branchId,
          timestamp: toIsoTimestamp(line.timestamp),
          kind: "tool.result",
          actor: { type: "tool" },
          payload: {
            toolCallId: typeof item.call_id === "string" ? item.call_id : "unknown-tool-call",
            output: item.output,
            isError: false,
          },
          native: { source: "codex", raw: line },
        });
        continue;
      }
    }

    if (line.type === "event_msg") {
      const item = line.payload as Record<string, unknown> | undefined;
      if (!item || typeof item.type !== "string") continue;

      if (item.type === "agent_message" && typeof item.message === "string") {
        createEvent(events, {
          sessionId,
          branchId,
          timestamp: toIsoTimestamp(line.timestamp),
          kind: "message.created",
          actor: { type: "assistant" },
          payload: { role: "assistant", parts: [{ type: "text", text: item.message }] },
          native: { source: "codex", raw: line },
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
          native: { source: "codex", raw: line },
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
        eventType: typeof line.type === "string" ? line.type : "unknown",
        raw: line,
      },
      native: { source: "codex", raw: line },
    });
  }

  return events;
}
