import type { CanonicalEvent } from "@lossless-agent-context/core";
import { createEvent, DEFAULT_BRANCH_ID, toIsoTimestamp } from "./utils";

export type ClaudePrintResult = {
  type: string;
  subtype?: string;
  result: string;
  session_id?: string;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; totalTokens?: number }>;
  [key: string]: unknown;
};

export function importClaudePrintResult(
  result: ClaudePrintResult,
  prompt: string,
  timestamp = new Date().toISOString(),
): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  const sessionId = result.session_id ?? `claude-print-${crypto.randomUUID?.() ?? "session"}`;
  const branchId = DEFAULT_BRANCH_ID;
  const model = extractClaudeModel(result.modelUsage);
  const isoTimestamp = toIsoTimestamp(timestamp);

  createEvent(events, {
    sessionId,
    branchId,
    timestamp: isoTimestamp,
    kind: "session.created",
    payload: {
      startedAt: isoTimestamp,
      provider: "claude-code",
      model: model ?? undefined,
      title: "Claude CLI print trace",
    },
    native: { source: "claude-print", raw: result },
  });

  if (model) {
    createEvent(events, {
      sessionId,
      branchId,
      timestamp: isoTimestamp,
      kind: "model.selected",
      payload: {
        provider: "claude-code",
        model,
      },
      native: { source: "claude-print", raw: result.modelUsage },
    });
  }

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
    native: { source: "claude-print", raw: { prompt } },
  });

  createEvent(events, {
    sessionId,
    branchId,
    timestamp: isoTimestamp,
    kind: "message.created",
    actor: { type: "assistant", provider: "claude-code", model: model ?? undefined },
    payload: {
      role: "assistant",
      parts: [{ type: "text", text: result.result }],
    },
    native: { source: "claude-print", raw: result },
  });

  createEvent(events, {
    sessionId,
    branchId,
    timestamp: isoTimestamp,
    kind: "model.completed",
    actor: { type: "runtime", provider: "claude-code", model: model ?? undefined },
    payload: {
      provider: "claude-code",
      model: model ?? "unknown",
      output: { result: result.result },
      usage: result.usage
        ? {
            inputTokens: result.usage.input_tokens,
            outputTokens: result.usage.output_tokens,
            totalTokens: result.usage.total_tokens,
          }
        : undefined,
      latencyMs: result.duration_ms,
    },
    native: { source: "claude-print", raw: result },
  });

  return events;
}

function extractClaudeModel(modelUsage: ClaudePrintResult["modelUsage"]): string | undefined {
  if (!modelUsage) return undefined;
  const firstKey = Object.keys(modelUsage)[0];
  return firstKey ? firstKey.replace(/\[[^\]]+\]$/, "") : undefined;
}
