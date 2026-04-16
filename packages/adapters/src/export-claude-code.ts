import { randomUUID } from "node:crypto";
import type { CanonicalEvent } from "@lossless-agent-context/core";
import {
  emitSemanticGroupedLines,
  FOREIGN_FIELD,
  type ForeignEnvelope,
  inferSessionIdForTarget,
  inferWorkingDirectory,
} from "./cross-provider";

export function exportClaudeCodeJsonl(events: CanonicalEvent[]): string {
  const sessionId = inferSessionIdForTarget(events, "claude-code");
  const cwd = inferWorkingDirectory(events);
  let parentUuid: string | null = null;

  const { lines } = emitSemanticGroupedLines(events, "claude-code", (source, group, native) => {
    if (source === "pi") {
      const claudeLine = renderPiGroupAsClaudeLine(group, native.raw, sessionId, cwd, parentUuid);
      const uuidValue = claudeLine.uuid;
      if (typeof uuidValue === "string") parentUuid = uuidValue;
      return claudeLine;
    }
    if (source === "codex") {
      const claudeLine = renderCodexGroupAsClaudeLine(group, native.raw, sessionId, cwd, parentUuid);
      const uuidValue = claudeLine.uuid;
      if (typeof uuidValue === "string") parentUuid = uuidValue;
      return claudeLine;
    }
    return renderUnknownAsClaudeLine(source, native.raw, sessionId, cwd, parentUuid, group[0]?.timestamp);
  });

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function buildClaudeBase(
  sessionId: string,
  cwd: string | undefined,
  parentUuid: string | null,
  isoTimestamp: string,
  sidecar: ForeignEnvelope,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    uuid: randomUUID(),
    parentUuid,
    timestamp: isoTimestamp,
    sessionId,
    [FOREIGN_FIELD]: sidecar,
  };
  if (cwd !== undefined) base.cwd = cwd;
  return base;
}

function renderPiGroupAsClaudeLine(
  group: CanonicalEvent[],
  piRaw: unknown,
  sessionId: string,
  cwd: string | undefined,
  parentUuid: string | null,
): Record<string, unknown> {
  const piLine = (piRaw && typeof piRaw === "object" ? piRaw : {}) as Record<string, unknown>;
  const piType = piLine.type;
  const sidecar: ForeignEnvelope = { source: "pi", raw: piRaw };
  const isoTimestamp = group[0]?.timestamp ?? new Date(0).toISOString();
  const base = buildClaudeBase(sessionId, cwd, parentUuid, isoTimestamp, sidecar);

  if (piType === "session") {
    return {
      type: "system",
      subtype: "init",
      version: typeof piLine.version === "number" ? `pi-${piLine.version}` : "pi-unknown",
      ...base,
    };
  }

  if (piType === "model_change") {
    return {
      type: "system",
      subtype: "model_change",
      ...base,
    };
  }

  if (piType === "message") {
    const piMessage = piLine.message as Record<string, unknown> | undefined;
    if (piMessage) {
      const role = piMessage.role;

      if (role === "user" || role === "system") {
        return {
          type: "user",
          ...base,
          message: { role: "user", content: renderUserContent(piMessage.content) },
        };
      }

      if (role === "assistant") {
        const piContent = Array.isArray(piMessage.content) ? piMessage.content : [];
        const claudeContent = piContent.map(piAssistantBlockToClaude);
        return {
          type: "assistant",
          ...base,
          message: { role: "assistant", content: claudeContent },
        };
      }

      if (role === "toolResult") {
        const piContent = Array.isArray(piMessage.content) ? piMessage.content : [];
        const text = extractText(piContent);
        return {
          type: "user",
          ...base,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: typeof piMessage.toolCallId === "string" ? piMessage.toolCallId : "unknown-tool-call",
                content: text,
                is_error: Boolean(piMessage.isError),
              },
            ],
          },
        };
      }
    }
  }

  return {
    type: "system",
    subtype: "pi-unknown",
    ...base,
  };
}

function renderCodexGroupAsClaudeLine(
  group: CanonicalEvent[],
  codexRaw: unknown,
  sessionId: string,
  cwd: string | undefined,
  parentUuid: string | null,
): Record<string, unknown> {
  const codexLine = (codexRaw && typeof codexRaw === "object" ? codexRaw : {}) as Record<string, unknown>;
  const sidecar: ForeignEnvelope = { source: "codex", raw: codexRaw };
  const isoTimestamp = group[0]?.timestamp ?? new Date(0).toISOString();
  const base = buildClaudeBase(sessionId, cwd, parentUuid, isoTimestamp, sidecar);

  if (codexLine.type === "session_meta") {
    const payload = codexLine.payload as Record<string, unknown> | undefined;
    return {
      type: "system",
      subtype: "init",
      version:
        payload && typeof payload.model_provider === "string" ? `codex-${payload.model_provider}` : "codex-unknown",
      ...base,
    };
  }

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
        if (role === "assistant") {
          return {
            type: "assistant",
            ...base,
            message: { role: "assistant", content: [{ type: "text", text }] },
          };
        }
        return {
          type: "user",
          ...base,
          message: { role: "user", content: text },
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
          type: "assistant",
          ...base,
          message: { role: "assistant", content: [{ type: "thinking", thinking: text }] },
        };
      }

      if (item.type === "function_call") {
        return {
          type: "assistant",
          ...base,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: typeof item.call_id === "string" ? item.call_id : "unknown-tool-call",
                name: typeof item.name === "string" ? item.name : "unknown-tool",
                input: typeof item.arguments === "string" ? safeJson(item.arguments) : (item.arguments ?? {}),
              },
            ],
          },
        };
      }

      if (item.type === "function_call_output") {
        return {
          type: "user",
          ...base,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: typeof item.call_id === "string" ? item.call_id : "unknown-tool-call",
                content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
                is_error: false,
              },
            ],
          },
        };
      }
    }
  }

  if (codexLine.type === "event_msg") {
    const item = codexLine.payload as Record<string, unknown> | undefined;
    if (item?.type === "agent_message" && typeof item.message === "string") {
      return {
        type: "assistant",
        ...base,
        message: { role: "assistant", content: [{ type: "text", text: item.message }] },
      };
    }
    if (item?.type === "agent_reasoning" && typeof item.text === "string") {
      return {
        type: "assistant",
        ...base,
        message: { role: "assistant", content: [{ type: "thinking", thinking: item.text }] },
      };
    }
  }

  return {
    type: "system",
    subtype: "codex-unknown",
    ...base,
  };
}

function renderUnknownAsClaudeLine(
  source: string,
  rawRef: unknown,
  sessionId: string,
  cwd: string | undefined,
  parentUuid: string | null,
  isoTimestamp: string | undefined,
): Record<string, unknown> {
  const sidecar: ForeignEnvelope = { source, raw: rawRef };
  const base = buildClaudeBase(sessionId, cwd, parentUuid, isoTimestamp ?? new Date(0).toISOString(), sidecar);
  return {
    type: "system",
    subtype: `${source}-unknown`,
    ...base,
  };
}

function piAssistantBlockToClaude(block: unknown): Record<string, unknown> {
  if (!block || typeof block !== "object") return { type: "text", text: "" };
  const record = block as Record<string, unknown>;
  if (record.type === "thinking") {
    return { type: "thinking", thinking: typeof record.thinking === "string" ? record.thinking : "" };
  }
  if (record.type === "text") {
    return { type: "text", text: typeof record.text === "string" ? record.text : "" };
  }
  if (record.type === "toolCall") {
    return {
      type: "tool_use",
      id: typeof record.id === "string" ? record.id : "unknown-tool-call",
      name: typeof record.name === "string" ? record.name : "unknown-tool",
      input: record.arguments ?? {},
    };
  }
  return { type: "text", text: JSON.stringify(record) };
}

function renderUserContent(content: unknown): string | unknown[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = extractText(content);
    if (text.length > 0) return text;
    return content;
  }
  return "";
}

function extractText(items: unknown[]): string {
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
