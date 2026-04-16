import type { CanonicalEvent } from "@lossless-agent-context/core";
import { createEvent, DEFAULT_BRANCH_ID, toIsoTimestamp } from "./utils";

export type AnthropicMessageTrace = {
  sessionId: string;
  timestamp: string;
  request: {
    model: string;
    system?: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    temperature?: number;
    max_tokens?: number;
  };
  response: {
    id?: string;
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
    [key: string]: unknown;
  };
};

export function importAnthropicMessageTrace(trace: AnthropicMessageTrace): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  const sessionId = trace.sessionId;
  const branchId = DEFAULT_BRANCH_ID;
  const timestamp = toIsoTimestamp(trace.timestamp);

  createEvent(events, {
    sessionId,
    branchId,
    timestamp,
    kind: "session.created",
    payload: {
      startedAt: timestamp,
      provider: "anthropic",
      model: trace.request.model,
      title: "Anthropic live trace",
    },
    native: { source: "anthropic-messages", raw: trace },
  });

  createEvent(events, {
    sessionId,
    branchId,
    timestamp,
    kind: "model.requested",
    actor: { type: "runtime", provider: "anthropic", model: trace.request.model },
    payload: {
      provider: "anthropic",
      model: trace.request.model,
      input: {
        system: trace.request.system,
        messages: trace.request.messages,
      },
      settings: {
        temperature: trace.request.temperature,
        max_tokens: trace.request.max_tokens,
      },
    },
    native: { source: "anthropic-messages", raw: trace.request },
  });

  if (trace.request.system) {
    createEvent(events, {
      sessionId,
      branchId,
      timestamp,
      kind: "message.created",
      actor: { type: "system" },
      payload: {
        role: "system",
        parts: [{ type: "text", text: trace.request.system }],
      },
      native: { source: "anthropic-messages", raw: { role: "system", content: trace.request.system } },
    });
  }

  for (const message of trace.request.messages) {
    createEvent(events, {
      sessionId,
      branchId,
      timestamp,
      kind: "message.created",
      actor: { type: message.role === "assistant" ? "assistant" : "user" },
      payload: {
        role: message.role,
        parts: [{ type: "text", text: message.content }],
      },
      native: { source: "anthropic-messages", raw: message },
    });
  }

  const outputText = (trace.response.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");

  if (outputText) {
    createEvent(events, {
      sessionId,
      branchId,
      timestamp,
      kind: "message.created",
      actor: { type: "assistant" },
      payload: {
        role: "assistant",
        parts: [{ type: "text", text: outputText }],
      },
      native: { source: "anthropic-messages", raw: trace.response.content },
    });
  }

  createEvent(events, {
    sessionId,
    branchId,
    timestamp,
    kind: "model.completed",
    actor: { type: "runtime", provider: "anthropic", model: trace.response.model ?? trace.request.model },
    payload: {
      provider: "anthropic",
      model: trace.response.model ?? trace.request.model,
      output: { content: trace.response.content },
      usage: trace.response.usage
        ? {
            inputTokens: trace.response.usage.input_tokens,
            outputTokens: trace.response.usage.output_tokens,
            totalTokens: (trace.response.usage.input_tokens ?? 0) + (trace.response.usage.output_tokens ?? 0),
          }
        : undefined,
    },
    native: { source: "anthropic-messages", raw: trace.response },
  });

  return events;
}
