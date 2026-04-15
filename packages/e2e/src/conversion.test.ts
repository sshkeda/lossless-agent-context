import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importAiSdkMessages, importClaudeCodeJsonl, importCodexJsonl, importPiSessionJsonl, type AiSdkMessageLike } from "@lossless-agent-context/adapters";
import { canonicalEventSchema } from "@lossless-agent-context/core";
import { toAiSdkMessageProjection, uiMessageProjectionSchema } from "@lossless-agent-context/projection-ai-sdk";
import { describe, expect, it } from "vitest";

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "fixtures", name), "utf8");
}

describe("conversion e2e", () => {
  it("converts Pi session JSONL into canonical events and AI SDK projection", () => {
    const events = importPiSessionJsonl(fixture("pi.jsonl"));
    expect(canonicalEventSchema.array().parse(events)).toHaveLength(6);
    expect(events.map(event => event.kind)).toEqual([
      "session.created",
      "model.selected",
      "message.created",
      "reasoning.created",
      "tool.call",
      "tool.result",
    ]);

    const projection = toAiSdkMessageProjection(events);
    expect(uiMessageProjectionSchema.array().parse(projection)).toHaveLength(4);
    expect(projection.map(message => message.role)).toEqual(["user", "assistant", "assistant", "tool"]);
  });

  it("converts Claude Code JSONL into canonical events and AI SDK projection", () => {
    const events = importClaudeCodeJsonl(fixture("claude-code.jsonl"));
    expect(canonicalEventSchema.array().parse(events)).toHaveLength(8);
    expect(events.map(event => event.kind)).toEqual([
      "session.created",
      "provider.event",
      "message.created",
      "reasoning.created",
      "message.created",
      "tool.call",
      "tool.result",
      "message.created",
    ]);

    const projection = toAiSdkMessageProjection(events);
    expect(uiMessageProjectionSchema.array().parse(projection)).toHaveLength(6);
    expect(projection.map(message => message.role)).toEqual(["user", "assistant", "assistant", "assistant", "tool", "assistant"]);
  });

  it("converts Codex JSONL into canonical events and AI SDK projection", () => {
    const events = importCodexJsonl(fixture("codex.jsonl"));
    expect(canonicalEventSchema.array().parse(events)).toHaveLength(6);
    expect(events.map(event => event.kind)).toEqual([
      "session.created",
      "message.created",
      "reasoning.created",
      "tool.call",
      "tool.result",
      "message.created",
    ]);

    const projection = toAiSdkMessageProjection(events);
    expect(uiMessageProjectionSchema.array().parse(projection)).toHaveLength(5);
    expect(projection.map(message => message.role)).toEqual(["user", "assistant", "assistant", "tool", "assistant"]);
  });

  it("converts AI SDK-style messages into canonical events and back into projection messages", () => {
    const messages: AiSdkMessageLike[] = [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "Find the project README" }],
      },
      {
        id: "m2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "I should inspect the repository root." },
          { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "README.md" } },
        ],
      },
      {
        id: "m3",
        role: "tool",
        parts: [{ type: "tool-result", toolCallId: "tc1", output: "# README", isError: false }],
      },
      {
        id: "m4",
        role: "assistant",
        parts: [{ type: "text", text: "I found the README." }],
      },
    ];

    const events = importAiSdkMessages(messages, "ai-sdk-session-1");
    expect(canonicalEventSchema.array().parse(events)).toHaveLength(6);
    expect(events.map(event => event.kind)).toEqual([
      "session.created",
      "message.created",
      "reasoning.created",
      "tool.call",
      "tool.result",
      "message.created",
    ]);

    const projection = toAiSdkMessageProjection(events);
    expect(uiMessageProjectionSchema.array().parse(projection)).toHaveLength(5);
    expect(projection[0]?.parts[0]).toEqual({ type: "text", text: "Find the project README" });
    expect(projection[2]?.parts[0]).toEqual({ type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "README.md" } });
    expect(projection[3]?.parts[0]).toEqual({ type: "tool-result", toolCallId: "tc1", output: "# README", isError: false });
  });
});
