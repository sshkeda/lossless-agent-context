import type { CanonicalEvent } from "@lossless-agent-context/core";
import { createEvent, DEFAULT_BRANCH_ID, parseJsonl, toIsoTimestamp } from "./utils";

export type CodexExecEvent = Record<string, unknown>;

export function importCodexExecJsonl(
  text: string,
  prompt: string,
  timestamp = new Date().toISOString(),
): CanonicalEvent[] {
  const lines = parseJsonl(text) as CodexExecEvent[];
  const events: CanonicalEvent[] = [];
  const threadStarted = lines.find((line) => line.type === "thread.started");
  const sessionId = typeof threadStarted?.thread_id === "string" ? threadStarted.thread_id : "codex-exec-session";
  const branchId = DEFAULT_BRANCH_ID;
  const isoTimestamp = toIsoTimestamp(timestamp);

  createEvent(events, {
    sessionId,
    branchId,
    timestamp: isoTimestamp,
    kind: "session.created",
    payload: {
      startedAt: isoTimestamp,
      provider: "codex-cli",
      title: "Codex exec trace",
    },
    native: { source: "codex-exec", raw: lines },
  });

  createEvent(events, {
    sessionId,
    branchId,
    timestamp: isoTimestamp,
    kind: "message.created",
    actor: { type: "user" },
    payload: {
      role: "user",
      parts: [{ type: "text", text: prompt }],
    },
    native: { source: "codex-exec", raw: { prompt } },
  });

  for (const line of lines) {
    if (line.type === "item.completed") {
      const item = line.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        createEvent(events, {
          sessionId,
          branchId,
          timestamp: isoTimestamp,
          kind: "message.created",
          actor: { type: "assistant", provider: "codex-cli" },
          payload: {
            role: "assistant",
            parts: [{ type: "text", text: item.text }],
          },
          native: { source: "codex-exec", raw: line },
        });
      }
    }

    if (line.type === "turn.completed") {
      const usage = line.usage as Record<string, unknown> | undefined;
      createEvent(events, {
        sessionId,
        branchId,
        timestamp: isoTimestamp,
        kind: "model.completed",
        actor: { type: "runtime", provider: "codex-cli" },
        payload: {
          provider: "codex-cli",
          model: "unknown",
          output: { events: lines },
          usage: usage
            ? {
                inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
                outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
                totalTokens:
                  typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number"
                    ? usage.input_tokens + usage.output_tokens
                    : undefined,
              }
            : undefined,
        },
        native: { source: "codex-exec", raw: line },
      });
    }
  }

  return events;
}
