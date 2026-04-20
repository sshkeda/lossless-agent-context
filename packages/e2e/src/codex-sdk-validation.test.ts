import {
  exportCodexJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";
import { readFixture } from "./fixtures";
import { parseJsonlObjectLines } from "./jsonl";
import {
  codexEventMsgLine,
  codexNativeLine,
  codexResponseItemLine,
  codexSessionMetaLine,
  jsonRecord,
} from "./sdk-schemas";

const CANONICAL_EVENT_TYPE = "lac:event";

function isCanonicalFallbackLine(line: Record<string, unknown>): boolean {
  return line.type === CANONICAL_EVENT_TYPE;
}

function nativeOnlyLines(lines: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return lines.filter((line) => !isCanonicalFallbackLine(line));
}

function findFirstUserText(events: CanonicalEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind !== "message.created" || event.payload.role !== "user") continue;
    for (const part of event.payload.parts) {
      if (part.type === "text") return part.text;
    }
  }
  return undefined;
}

function findAllAssistantText(events: CanonicalEvent[]): string {
  return events
    .filter(
      (event): event is Extract<CanonicalEvent, { kind: "message.created" }> =>
        event.kind === "message.created" && event.payload.role === "assistant",
    )
    .flatMap((event) => event.payload.parts)
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function findFirstReasoningText(events: CanonicalEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind === "reasoning.created") return event.payload.text;
  }
  return undefined;
}

function findFirstToolCall(
  events: CanonicalEvent[],
): Extract<CanonicalEvent, { kind: "tool.call" }>["payload"] | undefined {
  for (const event of events) {
    if (event.kind === "tool.call") return event.payload;
  }
  return undefined;
}

function findFirstToolResult(
  events: CanonicalEvent[],
): Extract<CanonicalEvent, { kind: "tool.result" }>["payload"] | undefined {
  for (const event of events) {
    if (event.kind === "tool.result") return event.payload;
  }
  return undefined;
}

describe("Codex SDK validation: real Codex JSONL schema accepts Pi -> Codex conversion", () => {
  it("every emitted line matches the strict codex session JSONL schema", () => {
    const piText = readFixture("pi.jsonl");
    const canonical = importPiSessionJsonl(piText);
    const codexText = exportCodexJsonl(canonical);
    const lines = nativeOnlyLines(parseJsonlObjectLines(codexText).map((line) => jsonRecord.parse(line)));

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const result = codexNativeLine.safeParse(line);
      expect(
        result.success,
        result.success ? undefined : `line failed codex schema: ${JSON.stringify(line)} -- ${result.error.message}`,
      ).toBe(true);
    }
  });

  it("session_meta line carries the pi session id, cwd, and only the metadata still proven necessary", () => {
    const piText = readFixture("pi.jsonl");
    const canonical = importPiSessionJsonl(piText);
    const codexText = exportCodexJsonl(canonical);
    const lines = parseJsonlObjectLines(codexText).map((line) => jsonRecord.parse(line));

    const meta = codexSessionMetaLine.parse(lines[0]);
    expect(meta.payload.id).toBe("pi-session-1");
    expect(meta.payload.cwd).toBe("/tmp/lossless-agent-context");
    expect(meta.payload.originator).toBeUndefined();
    expect(meta.payload.cli_version).toBeUndefined();
    expect(meta.payload.source).toBeUndefined();
    expect(meta.payload.model_provider).toBe("claude-code");
  });

  it("user prompt becomes a response_item:message:user with input_text content", () => {
    const piText = readFixture("pi.jsonl");
    const canonical = importPiSessionJsonl(piText);
    const codexText = exportCodexJsonl(canonical);
    const lines = parseJsonlObjectLines(codexText).map((line) => jsonRecord.parse(line));

    const userLine = lines.find((line) => {
      const result = codexResponseItemLine.safeParse(line);
      if (!result.success) return false;
      const payload = result.data.payload;
      return payload.type === "message" && payload.role === "user";
    });
    expect(userLine).toBeDefined();
    const parsed = codexResponseItemLine.parse(userLine);
    if (parsed.payload.type !== "message" || parsed.payload.role !== "user") {
      throw new Error("user message expected");
    }
    const text = parsed.payload.content
      .filter((c): c is Extract<typeof c, { type: "input_text" }> => c.type === "input_text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("spin up the dev server pls");
  });

  it("assistant reasoning + tool call + tool output round-trip semantically through codex format", () => {
    const piText = readFixture("pi.jsonl");
    const canonical = importPiSessionJsonl(piText);
    const codexText = exportCodexJsonl(canonical);
    const reimported = importCodexJsonl(codexText);

    expect(findFirstUserText(reimported)).toBe("spin up the dev server pls");
    expect(findFirstReasoningText(reimported)).toBe("Need to start the dev server.");

    const toolCall = findFirstToolCall(reimported);
    expect(toolCall?.toolCallId).toBe("call_1");
    expect(toolCall?.name).toBe("ask_claude_code");
    expect(toolCall?.arguments).toEqual({ input: "spin up the dev server pls" });

    const toolResult = findFirstToolResult(reimported);
    expect(toolResult?.toolCallId).toBe("call_1");
    expect(typeof toolResult?.output === "string" ? toolResult.output : "").toContain("Dev server is starting");
  });
});

describe("Codex SDK validation: real Codex JSONL schema accepts Claude -> Codex conversion", () => {
  it("every native codex line matches the strict codex session JSONL schema", () => {
    const claudeText = readFixture("claude-code.jsonl");
    const canonical = importClaudeCodeJsonl(claudeText);
    const codexText = exportCodexJsonl(canonical);
    const lines = nativeOnlyLines(parseJsonlObjectLines(codexText).map((line) => jsonRecord.parse(line)));

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const result = codexNativeLine.safeParse(line);
      expect(
        result.success,
        result.success ? undefined : `line failed codex schema: ${JSON.stringify(line)} -- ${result.error.message}`,
      ).toBe(true);
    }
  });

  it("session_meta line carries the claude session id, cwd, and only the metadata still proven necessary", () => {
    const claudeText = readFixture("claude-code.jsonl");
    const canonical = importClaudeCodeJsonl(claudeText);
    const codexText = exportCodexJsonl(canonical);
    const lines = parseJsonlObjectLines(codexText).map((line) => jsonRecord.parse(line));

    const meta = codexSessionMetaLine.parse(lines[0]);
    expect(meta.payload.id).toBe("claude-session-1");
    expect(meta.payload.cwd).toBe("/tmp/lossless-agent-context");
    expect(meta.payload.originator).toBeUndefined();
    expect(meta.payload.cli_version).toBeUndefined();
    expect(meta.payload.source).toBeUndefined();
    expect(meta.payload.model_provider).toBeUndefined();
  });

  it("assistant text + tool call + tool result survive claude → codex round-trip", () => {
    const claudeText = readFixture("claude-code.jsonl");
    const canonical = importClaudeCodeJsonl(claudeText);
    const codexText = exportCodexJsonl(canonical);
    const reimported = importCodexJsonl(codexText);

    expect(findFirstUserText(reimported)).toBe("what is admin creds?");
    expect(findAllAssistantText(reimported)).toContain("Let me search the codebase for admin credential references.");

    const toolCall = findFirstToolCall(reimported);
    expect(toolCall?.toolCallId).toBe("toolu_123");
    expect(toolCall?.name).toBe("Grep");
    expect(toolCall?.arguments).toEqual({ pattern: "admin", "-i": true });

    const toolResult = findFirstToolResult(reimported);
    expect(toolResult?.toolCallId).toBe("toolu_123");
    expect(typeof toolResult?.output === "string" ? toolResult.output : "").toContain("Found 27 files");
  });
});

describe("Codex SDK validation: native codex fixture is itself accepted by the schema", () => {
  it("the codex fixture parses cleanly with the same schema we apply to converted output", () => {
    const codexText = readFixture("codex.jsonl");
    const lines = parseJsonlObjectLines(codexText).map((line) => jsonRecord.parse(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const result = codexNativeLine.safeParse(line);
      expect(
        result.success,
        result.success
          ? undefined
          : `fixture line failed codex schema: ${JSON.stringify(line)} -- ${result.error.message}`,
      ).toBe(true);
    }
  });

  it("event_msg agent_message lines are recognized when present", () => {
    const codexText = readFixture("codex.jsonl");
    const lines = parseJsonlObjectLines(codexText).map((line) => jsonRecord.parse(line));
    const agentMessage = lines.find((line) => {
      const result = codexEventMsgLine.safeParse(line);
      return result.success && result.data.payload.type === "agent_message";
    });
    expect(agentMessage).toBeDefined();
  });
});
