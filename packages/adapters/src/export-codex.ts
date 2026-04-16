import type { CanonicalEvent } from "@lossless-agent-context/core";
import {
  emitSemanticGroupedLines,
  FOREIGN_FIELD,
  type ForeignEnvelope,
  inferSessionIdForTarget,
  inferWorkingDirectory,
} from "./cross-provider";

export function exportCodexJsonl(events: CanonicalEvent[]): string {
  const sessionId = inferSessionIdForTarget(events, "codex");
  const cwd = inferWorkingDirectory(events);
  let emittedSession = false;

  const { lines } = emitSemanticGroupedLines(events, "codex", (source, group, native) => {
    let line: Record<string, unknown>;
    if (source === "claude-code") {
      line = renderClaudeGroupAsCodexLine(group, native.raw, sessionId, cwd, emittedSession);
    } else if (source === "pi") {
      line = renderPiGroupAsCodexLine(group, native.raw, sessionId, cwd, emittedSession);
    } else {
      line = renderUnknownAsCodexLine(source, native.raw, group[0]?.timestamp);
    }
    if (line.type === "session_meta") emittedSession = true;
    return line;
  });

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function buildCodexBase(isoTimestamp: string, sidecar: ForeignEnvelope): Record<string, unknown> {
  return {
    timestamp: isoTimestamp,
    [FOREIGN_FIELD]: sidecar,
  };
}

function renderClaudeGroupAsCodexLine(
  group: CanonicalEvent[],
  claudeRaw: unknown,
  sessionId: string,
  cwd: string | undefined,
  emittedSession: boolean,
): Record<string, unknown> {
  const claudeLine = (claudeRaw && typeof claudeRaw === "object" ? claudeRaw : {}) as Record<string, unknown>;
  const claudeType = claudeLine.type;
  const sidecar: ForeignEnvelope = { source: "claude-code", raw: claudeRaw };
  const isoTimestamp = group[0]?.timestamp ?? new Date(0).toISOString();

  if (claudeType === "system" && !emittedSession) {
    return {
      ...buildCodexBase(isoTimestamp, sidecar),
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: isoTimestamp,
        ...(cwd !== undefined ? { cwd } : {}),
        model_provider: "claude-code",
      },
    };
  }

  const message = claudeLine.message as Record<string, unknown> | undefined;

  if (claudeType === "user") {
    const content = message?.content;
    if (
      Array.isArray(content) &&
      content.some((c) => c && typeof c === "object" && (c as Record<string, unknown>).type === "tool_result")
    ) {
      const toolResult = content.find((c): c is Record<string, unknown> =>
        Boolean(c && typeof c === "object" && (c as Record<string, unknown>).type === "tool_result"),
      );
      const text =
        toolResult && typeof toolResult.content === "string"
          ? toolResult.content
          : JSON.stringify(toolResult?.content ?? "");
      return {
        ...buildCodexBase(isoTimestamp, sidecar),
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id:
            toolResult && typeof toolResult.tool_use_id === "string" ? toolResult.tool_use_id : "unknown-tool-call",
          output: text,
        },
      };
    }
    const text = typeof content === "string" ? content : extractTextArray(Array.isArray(content) ? content : []);
    return {
      ...buildCodexBase(isoTimestamp, sidecar),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    };
  }

  if (claudeType === "assistant") {
    const content = Array.isArray(message?.content) ? message?.content : [];
    const blocks = content.filter((c): c is Record<string, unknown> => Boolean(c && typeof c === "object"));
    const toolUse = blocks.find((b) => b.type === "tool_use");
    if (toolUse) {
      return {
        ...buildCodexBase(isoTimestamp, sidecar),
        type: "response_item",
        payload: {
          type: "function_call",
          name: typeof toolUse.name === "string" ? toolUse.name : "unknown-tool",
          arguments: typeof toolUse.input === "string" ? toolUse.input : JSON.stringify(toolUse.input ?? {}),
          call_id: typeof toolUse.id === "string" ? toolUse.id : "unknown-tool-call",
        },
      };
    }
    const thinking = blocks.find((b) => b.type === "thinking");
    if (thinking) {
      const text = typeof thinking.thinking === "string" ? thinking.thinking : "";
      return {
        ...buildCodexBase(isoTimestamp, sidecar),
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text }],
        },
      };
    }
    const textBlock = blocks.find((b) => b.type === "text");
    const text = textBlock && typeof textBlock.text === "string" ? textBlock.text : "";
    return {
      ...buildCodexBase(isoTimestamp, sidecar),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    };
  }

  return {
    ...buildCodexBase(isoTimestamp, sidecar),
    type: "event_msg",
    payload: { type: "claude-unknown" },
  };
}

function renderPiGroupAsCodexLine(
  group: CanonicalEvent[],
  piRaw: unknown,
  sessionId: string,
  cwd: string | undefined,
  emittedSession: boolean,
): Record<string, unknown> {
  const piLine = (piRaw && typeof piRaw === "object" ? piRaw : {}) as Record<string, unknown>;
  const sidecar: ForeignEnvelope = { source: "pi", raw: piRaw };
  const isoTimestamp = group[0]?.timestamp ?? new Date(0).toISOString();

  if (piLine.type === "session" && !emittedSession) {
    return {
      ...buildCodexBase(isoTimestamp, sidecar),
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: isoTimestamp,
        ...(cwd !== undefined ? { cwd } : {}),
        model_provider: "pi",
      },
    };
  }

  if (piLine.type === "model_change") {
    return {
      ...buildCodexBase(isoTimestamp, sidecar),
      type: "event_msg",
      payload: {
        type: "model_change",
        message: typeof piLine.modelId === "string" ? piLine.modelId : "unknown",
      },
    };
  }

  if (piLine.type === "message") {
    const piMessage = piLine.message as Record<string, unknown> | undefined;
    if (piMessage) {
      const role = piMessage.role;

      if (role === "user" || role === "system") {
        const content = piMessage.content;
        const text = typeof content === "string" ? content : extractTextArray(Array.isArray(content) ? content : []);
        return {
          ...buildCodexBase(isoTimestamp, sidecar),
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        };
      }

      if (role === "assistant") {
        const content = Array.isArray(piMessage.content) ? piMessage.content : [];
        const blocks = content.filter((c): c is Record<string, unknown> => Boolean(c && typeof c === "object"));
        const toolCall = blocks.find((b) => b.type === "toolCall");
        if (toolCall) {
          return {
            ...buildCodexBase(isoTimestamp, sidecar),
            type: "response_item",
            payload: {
              type: "function_call",
              name: typeof toolCall.name === "string" ? toolCall.name : "unknown-tool",
              arguments:
                typeof toolCall.arguments === "string" ? toolCall.arguments : JSON.stringify(toolCall.arguments ?? {}),
              call_id: typeof toolCall.id === "string" ? toolCall.id : "unknown-tool-call",
            },
          };
        }
        const thinking = blocks.find((b) => b.type === "thinking");
        if (thinking) {
          const text = typeof thinking.thinking === "string" ? thinking.thinking : "";
          return {
            ...buildCodexBase(isoTimestamp, sidecar),
            type: "response_item",
            payload: {
              type: "reasoning",
              summary: [{ type: "summary_text", text }],
            },
          };
        }
        const textBlock = blocks.find((b) => b.type === "text");
        const text = textBlock && typeof textBlock.text === "string" ? textBlock.text : "";
        return {
          ...buildCodexBase(isoTimestamp, sidecar),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        };
      }

      if (role === "toolResult") {
        const content = Array.isArray(piMessage.content) ? piMessage.content : [];
        const text = extractTextArray(content);
        return {
          ...buildCodexBase(isoTimestamp, sidecar),
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: typeof piMessage.toolCallId === "string" ? piMessage.toolCallId : "unknown-tool-call",
            output: text,
          },
        };
      }
    }
  }

  return {
    ...buildCodexBase(isoTimestamp, sidecar),
    type: "event_msg",
    payload: { type: "pi-unknown" },
  };
}

function renderUnknownAsCodexLine(
  source: string,
  rawRef: unknown,
  isoTimestamp: string | undefined,
): Record<string, unknown> {
  const sidecar: ForeignEnvelope = { source, raw: rawRef };
  return {
    ...buildCodexBase(isoTimestamp ?? new Date(0).toISOString(), sidecar),
    type: "event_msg",
    payload: { type: `${source}-unknown` },
  };
}

function extractTextArray(items: unknown[]): string {
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      return "";
    })
    .join("");
}
