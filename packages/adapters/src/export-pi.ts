import { randomBytes } from "node:crypto";
import type { CanonicalEvent } from "@lossless-agent-context/core";
import {
  emitSemanticGroupedLines,
  FOREIGN_FIELD,
  type ForeignEnvelope,
  inferSessionIdForTarget,
  inferWorkingDirectory,
} from "./cross-provider";

export function exportPiSessionJsonl(events: CanonicalEvent[]): string {
  const sessionId = inferSessionIdForTarget(events, "pi");
  const cwd = inferWorkingDirectory(events);
  let parentId: string | null = null;
  let emittedSession = false;

  const { lines } = emitSemanticGroupedLines(events, "pi", (source, group, native) => {
    const piLine =
      source === "claude-code"
        ? renderClaudeGroupAsPiLine(group, native.raw, sessionId, cwd, parentId, emittedSession)
        : source === "codex"
          ? renderCodexGroupAsPiLine(group, native.raw, sessionId, cwd, parentId, emittedSession)
          : renderUnknownAsPiLine(source, native.raw, parentId, group[0]?.timestamp);

    if (piLine.type === "session") emittedSession = true;
    const idValue = piLine.id;
    if (typeof idValue === "string") parentId = idValue;
    return piLine;
  });

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function newPiId(): string {
  return randomBytes(4).toString("hex");
}

function epochMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function buildPiBase(parentId: string | null, isoTimestamp: string, sidecar: ForeignEnvelope): Record<string, unknown> {
  return {
    id: newPiId(),
    parentId,
    timestamp: isoTimestamp,
    [FOREIGN_FIELD]: sidecar,
  };
}

function renderClaudeGroupAsPiLine(
  group: CanonicalEvent[],
  claudeRaw: unknown,
  sessionId: string,
  cwd: string | undefined,
  parentId: string | null,
  emittedSession: boolean,
): Record<string, unknown> {
  const claudeLine = (claudeRaw && typeof claudeRaw === "object" ? claudeRaw : {}) as Record<string, unknown>;
  const claudeType = claudeLine.type;
  const sidecar: ForeignEnvelope = { source: "claude-code", raw: claudeRaw };
  const isoTimestamp = group[0]?.timestamp ?? new Date(0).toISOString();

  if (claudeType === "system" && !emittedSession) {
    return {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: isoTimestamp,
      ...(cwd !== undefined ? { cwd } : {}),
      [FOREIGN_FIELD]: sidecar,
    };
  }

  const base = buildPiBase(parentId, isoTimestamp, sidecar);

  if (claudeType === "user") {
    const message = claudeLine.message as Record<string, unknown> | undefined;
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
        type: "message",
        ...base,
        message: {
          role: "toolResult",
          toolCallId:
            toolResult && typeof toolResult.tool_use_id === "string" ? toolResult.tool_use_id : "unknown-tool-call",
          toolName: "unknown-tool",
          content: [{ type: "text", text }],
          isError: Boolean(toolResult?.is_error),
          timestamp: epochMs(isoTimestamp),
        },
      };
    }
    const text = typeof content === "string" ? content : extractTextArray(Array.isArray(content) ? content : []);
    return {
      type: "message",
      ...base,
      message: {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: epochMs(isoTimestamp),
      },
    };
  }

  if (claudeType === "assistant") {
    const message = claudeLine.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message?.content : [];
    const piContent = content.map(claudeAssistantBlockToPi);
    return {
      type: "message",
      ...base,
      message: {
        role: "assistant",
        content: piContent,
        timestamp: epochMs(isoTimestamp),
      },
    };
  }

  return {
    type: "model_change",
    ...base,
    provider: "claude-code",
    modelId: typeof claudeLine.version === "string" ? claudeLine.version : "unknown",
  };
}

function renderCodexGroupAsPiLine(
  group: CanonicalEvent[],
  codexRaw: unknown,
  sessionId: string,
  cwd: string | undefined,
  parentId: string | null,
  emittedSession: boolean,
): Record<string, unknown> {
  const codexLine = (codexRaw && typeof codexRaw === "object" ? codexRaw : {}) as Record<string, unknown>;
  const sidecar: ForeignEnvelope = { source: "codex", raw: codexRaw };
  const isoTimestamp = group[0]?.timestamp ?? new Date(0).toISOString();

  if (codexLine.type === "session_meta" && !emittedSession) {
    return {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: isoTimestamp,
      ...(cwd !== undefined ? { cwd } : {}),
      [FOREIGN_FIELD]: sidecar,
    };
  }

  const base = buildPiBase(parentId, isoTimestamp, sidecar);

  if (codexLine.type === "response_item") {
    const item = codexLine.payload as Record<string, unknown> | undefined;
    if (item) {
      if (item.type === "message") {
        const role = item.role;
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content
          .map((c) => {
            if (!c || typeof c !== "object") return "";
            const record = c as Record<string, unknown>;
            if ((record.type === "input_text" || record.type === "output_text") && typeof record.text === "string")
              return record.text;
            return "";
          })
          .join("");
        return {
          type: "message",
          ...base,
          message: {
            role: role === "assistant" ? "assistant" : "user",
            content: [{ type: "text", text }],
            timestamp: epochMs(isoTimestamp),
          },
        };
      }

      if (item.type === "reasoning") {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        const text = summary
          .map((part) => {
            if (!part || typeof part !== "object") return "";
            const record = part as Record<string, unknown>;
            return record.type === "summary_text" && typeof record.text === "string" ? record.text : "";
          })
          .filter(Boolean)
          .join("\n\n");
        return {
          type: "message",
          ...base,
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: text }],
            timestamp: epochMs(isoTimestamp),
          },
        };
      }

      if (item.type === "function_call") {
        return {
          type: "message",
          ...base,
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: typeof item.call_id === "string" ? item.call_id : "unknown-tool-call",
                name: typeof item.name === "string" ? item.name : "unknown-tool",
                arguments: typeof item.arguments === "string" ? safeJson(item.arguments) : (item.arguments ?? {}),
              },
            ],
            timestamp: epochMs(isoTimestamp),
          },
        };
      }

      if (item.type === "function_call_output") {
        const output = item.output;
        const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
        return {
          type: "message",
          ...base,
          message: {
            role: "toolResult",
            toolCallId: typeof item.call_id === "string" ? item.call_id : "unknown-tool-call",
            toolName: "unknown-tool",
            content: [{ type: "text", text }],
            isError: false,
            timestamp: epochMs(isoTimestamp),
          },
        };
      }
    }
  }

  if (codexLine.type === "event_msg") {
    const item = codexLine.payload as Record<string, unknown> | undefined;
    if (item?.type === "agent_message" && typeof item.message === "string") {
      return {
        type: "message",
        ...base,
        message: {
          role: "assistant",
          content: [{ type: "text", text: item.message }],
          timestamp: epochMs(isoTimestamp),
        },
      };
    }
    if (item?.type === "agent_reasoning" && typeof item.text === "string") {
      return {
        type: "message",
        ...base,
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: item.text }],
          timestamp: epochMs(isoTimestamp),
        },
      };
    }
  }

  return {
    type: "model_change",
    ...base,
    provider: "codex",
    modelId: "unknown",
  };
}

function renderUnknownAsPiLine(
  source: string,
  rawRef: unknown,
  parentId: string | null,
  isoTimestamp: string | undefined,
): Record<string, unknown> {
  const sidecar: ForeignEnvelope = { source, raw: rawRef };
  return {
    type: "model_change",
    ...buildPiBase(parentId, isoTimestamp ?? new Date(0).toISOString(), sidecar),
    provider: source,
    modelId: "unknown",
  };
}

function claudeAssistantBlockToPi(block: unknown): Record<string, unknown> {
  if (!block || typeof block !== "object") return { type: "text", text: "" };
  const record = block as Record<string, unknown>;
  if (record.type === "thinking") {
    return { type: "thinking", thinking: typeof record.thinking === "string" ? record.thinking : "" };
  }
  if (record.type === "text") {
    return { type: "text", text: typeof record.text === "string" ? record.text : "" };
  }
  if (record.type === "tool_use") {
    return {
      type: "toolCall",
      id: typeof record.id === "string" ? record.id : "unknown-tool-call",
      name: typeof record.name === "string" ? record.name : "unknown-tool",
      arguments: record.input ?? {},
    };
  }
  return { type: "text", text: JSON.stringify(record) };
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

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
