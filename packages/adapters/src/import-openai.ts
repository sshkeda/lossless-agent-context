import type { CanonicalEvent } from "@lossless-agent-context/core";
import { DEFAULT_BRANCH_ID, createEvent, toIsoTimestamp } from "./utils";

export type OpenAIChatCompletionTrace = {
  sessionId: string;
  timestamp: string;
  request: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
    temperature?: number;
  };
  response: {
    id?: string;
    model?: string;
    choices?: Array<{
      message?: {
        role?: "assistant" | "user" | "system" | "tool";
        content?: string | null;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    [key: string]: unknown;
  };
};

export function importOpenAIChatCompletionTrace(trace: OpenAIChatCompletionTrace): CanonicalEvent[] {
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
      provider: "openai",
      model: trace.request.model,
      title: "OpenAI live trace",
    },
    native: { source: "openai-chat-completions", raw: trace },
  });

  createEvent(events, {
    sessionId,
    branchId,
    timestamp,
    kind: "model.requested",
    actor: { type: "runtime", provider: "openai", model: trace.request.model },
    payload: {
      provider: "openai",
      model: trace.request.model,
      input: { messages: trace.request.messages },
      settings: trace.request.temperature !== undefined ? { temperature: trace.request.temperature } : undefined,
    },
    native: { source: "openai-chat-completions", raw: trace.request },
  });

  for (const message of trace.request.messages) {
    createEvent(events, {
      sessionId,
      branchId,
      timestamp,
      kind: "message.created",
      actor: { type: message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : message.role },
      payload: {
        role: message.role,
        parts: [{ type: "text", text: message.content }],
      },
      native: { source: "openai-chat-completions", raw: message },
    });
  }

  const assistantMessages = (trace.response.choices ?? [])
    .map(choice => choice.message)
    .filter((message): message is { role?: "assistant" | "user" | "system" | "tool"; content?: string | null } => message != null);

  for (const message of assistantMessages) {
    if (message.content) {
      createEvent(events, {
        sessionId,
        branchId,
        timestamp,
        kind: "message.created",
        actor: { type: message.role === "assistant" ? "assistant" : "runtime" },
        payload: {
          role: message.role ?? "assistant",
          parts: [{ type: "text", text: message.content }],
        },
        native: { source: "openai-chat-completions", raw: message },
      });
    }
  }

  createEvent(events, {
    sessionId,
    branchId,
    timestamp,
    kind: "model.completed",
    actor: { type: "runtime", provider: "openai", model: trace.response.model ?? trace.request.model },
    payload: {
      provider: "openai",
      model: trace.response.model ?? trace.request.model,
      output: { choices: trace.response.choices },
      usage: trace.response.usage
        ? {
            inputTokens: trace.response.usage.prompt_tokens,
            outputTokens: trace.response.usage.completion_tokens,
            totalTokens: trace.response.usage.total_tokens,
          }
        : undefined,
    },
    native: { source: "openai-chat-completions", raw: trace.response },
  });

  return events;
}

