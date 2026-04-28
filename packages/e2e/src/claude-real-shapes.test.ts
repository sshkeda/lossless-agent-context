import { importClaudeCodeJsonl , emptySidecar } from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";
import { readFixture } from "./fixtures";
import { parseJsonlObjectLines } from "./jsonl";
import { jsonRecord } from "./sdk-schemas";

function byKind(events: CanonicalEvent[], kind: CanonicalEvent["kind"]): CanonicalEvent[] {
  return events.filter((event) => event.kind === kind);
}

describe("Claude real native shape corpus", () => {
  it("committed representative Claude native lines have expected native structure", () => {
    const lines = parseJsonlObjectLines(readFixture("claude-real-shapes.jsonl")).map((line) => jsonRecord.parse(line));
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      expect([
        "user",
        "assistant",
        "system",
        "queue-operation",
        "attachment",
        "last-prompt",
        "permission-mode",
        "file-history-snapshot",
      ]).toContain(String(line.type));
      if (line.type !== "file-history-snapshot") expect(typeof line.sessionId).toBe("string");
      if (line.type === "file-history-snapshot") {
        expect(typeof (line.snapshot as Record<string, unknown> | undefined)?.timestamp).toBe("string");
      } else if (line.type !== "last-prompt" && line.type !== "permission-mode") {
        expect(typeof line.timestamp).toBe("string");
      }
      if (line.type === "assistant" || line.type === "user") {
        expect(typeof line.uuid).toBe("string");
        expect(typeof (line.message as Record<string, unknown> | undefined)?.role).toBe("string");
      }
    }
  });

  it("imports representative real Claude shapes into a sane canonical timeline", () => {
    const events = importClaudeCodeJsonl(readFixture("claude-real-shapes.jsonl"), emptySidecar());

    expect(byKind(events, "session.created").length).toBeGreaterThanOrEqual(4);
    expect(byKind(events, "message.created").length).toBeGreaterThanOrEqual(3);
    expect(byKind(events, "reasoning.created").length).toBeGreaterThanOrEqual(1);
    expect(byKind(events, "tool.call").length).toBeGreaterThanOrEqual(1);
    expect(byKind(events, "tool.result").length).toBeGreaterThanOrEqual(1);
    expect(byKind(events, "provider.event").length).toBeGreaterThanOrEqual(4);
  });

  it("preserves real Claude tool and tool_result semantics from the committed corpus", () => {
    const events = importClaudeCodeJsonl(readFixture("claude-real-shapes.jsonl"), emptySidecar());

    const toolCall = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "tool.call" }> => event.kind === "tool.call",
    );
    expect(toolCall?.payload.toolCallId).toBe("toolu_012d8sadSfd4DrVRpAZH9hVi");
    expect(toolCall?.payload.name).toBe("grep");

    const toolResult = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "tool.result" }> => event.kind === "tool.result",
    );
    expect(toolResult?.payload.toolCallId).toBe("toolu_01G8LJgUtsqWU53SaBUe4ofg");
    expect(toolResult?.payload.isError).toBe(true);
    expect(typeof toolResult?.payload.output === "string" ? toolResult.payload.output : "").toContain(
      "stdin is not a terminal",
    );
  });

  it("preserves harvested Claude queue, attachment, last-prompt, permission-mode, and file-history-snapshot shapes as provider events", () => {
    const events = importClaudeCodeJsonl(readFixture("claude-real-shapes.jsonl"), emptySidecar());
    const providerEvents = events.filter(
      (event): event is Extract<CanonicalEvent, { kind: "provider.event" }> => event.kind === "provider.event",
    );
    const eventTypes = new Set(providerEvents.map((event) => event.payload.eventType));

    expect(eventTypes.has("queue-operation")).toBe(true);
    expect(eventTypes.has("attachment")).toBe(true);
    expect(eventTypes.has("last-prompt")).toBe(true);
    expect(eventTypes.has("permission-mode")).toBe(true);
    expect(eventTypes.has("file-history-snapshot")).toBe(true);
  });

  it("imports harvested Claude sdk-cli user/tool/text/thinking variants into canonical events", () => {
    const events = importClaudeCodeJsonl(readFixture("claude-real-shapes.jsonl"), emptySidecar());

    const textMessages: string[] = [];
    for (const event of events) {
      if (event.kind !== "message.created") continue;
      for (const part of event.payload.parts) {
        if (part.type === "text") textMessages.push(part.text);
      }
    }

    expect(textMessages.some((text) => text.includes("Run printf blue and tell me the result."))).toBe(true);
    expect(textMessages.some((text) => text.includes("The command output was blue."))).toBe(true);

    const blueToolCall = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "tool.call" }> =>
        event.kind === "tool.call" && event.payload.toolCallId === "toolu_call-blue",
    );
    expect(blueToolCall?.payload.name).toBe("bash");

    const blueToolResult = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "tool.result" }> =>
        event.kind === "tool.result" && event.payload.toolCallId === "toolu_call-blue",
    );
    expect(blueToolResult).toBeDefined();
  });

  it("imports Claude cache usage markers as structured canonical cache metadata", () => {
    const events = importClaudeCodeJsonl(readFixture("claude-real-shapes.jsonl"), emptySidecar());
    const cached = events.find(
      (event) => event.cache?.readTokens !== undefined || event.cache?.writeTokens !== undefined,
    );
    expect(cached).toBeDefined();
    expect(cached?.cache?.writeTokens ?? 0).toBeGreaterThanOrEqual(12363);
  });
});
