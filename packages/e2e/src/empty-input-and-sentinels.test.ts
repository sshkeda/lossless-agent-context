import {
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
  emptySidecar,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";

function assistantText(events: ReturnType<typeof importClaudeCodeJsonl> | ReturnType<typeof importPiSessionJsonl>) {
  return events
    .filter(
      (event): event is Extract<(typeof events)[number], { kind: "message.created" }> =>
        event.kind === "message.created" && event.payload.role === "assistant",
    )
    .flatMap((event) => event.payload.parts)
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

describe("empty input and whitespace-only files", () => {
  const emptyInputs = ["", "   \n\t \n"];

  for (const text of emptyInputs) {
    const label = text.length === 0 ? "empty" : "whitespace-only";

    it(`pi importer returns [] for ${label} input`, () => {
      expect(importPiSessionJsonl(text)).toEqual([]);
    });

    it(`claude importer returns [] for ${label} input`, () => {
      expect(importClaudeCodeJsonl(text, emptySidecar())).toEqual([]);
    });

    it(`codex importer returns [] for ${label} input`, () => {
      expect(importCodexJsonl(text)).toEqual([]);
    });
  }

  it("exporters return an empty string for []", () => {
    expect(exportPiSessionJsonl([])).toBe("");
    expect(exportClaudeCodeJsonl([])).toBe("");
    expect(exportCodexJsonl([])).toBe("");
  });
});

describe("fallback behavior", () => {
  it("claude importer synthesizes a stable content-derived session id and preserves malformed tool-result lines as provider events", () => {
    const input = `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-16T12:00:01.000Z",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", input: { probe: true } }],
      },
    })}\n${JSON.stringify({
      type: "user",
      timestamp: "2026-04-16T12:00:02.000Z",
      cwd: "/tmp",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "ok", is_error: false }],
      },
    })}\n`;

    const imported = importClaudeCodeJsonl(input, emptySidecar());
    const sessionId = imported[0]?.sessionId;
    expect(sessionId).toMatch(/^claude-code-session-[0-9a-f]{12}$/);
    expect(imported.every((event) => event.sessionId === sessionId)).toBe(true);

    const toolResultEvent = imported.find(
      (event) => event.kind === "provider.event" && event.payload.eventType === "tool_result.invalid",
    );
    expect(toolResultEvent).toBeDefined();

    const reimported = importPiSessionJsonl(exportPiSessionJsonl(imported));
    expect(reimported.every((event) => event.sessionId === sessionId)).toBe(true);
    const reToolResultEvent = reimported.find(
      (event) => event.kind === "provider.event" && event.payload.eventType === "tool_result.invalid",
    );
    expect(reToolResultEvent).toBeDefined();
  });

  it("pi importer synthesizes a stable content-derived session id when no session header exists, then preserves it cross-provider", () => {
    const input = `${JSON.stringify({
      type: "message",
      id: "msg-no-session",
      parentId: null,
      timestamp: "2026-04-16T12:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1776340801000,
      },
    })}\n`;

    const imported = importPiSessionJsonl(input);
    const sessionId = imported[0]?.sessionId;
    expect(sessionId).toMatch(/^pi-session-[0-9a-f]{12}$/);
    expect(imported.every((event) => event.sessionId === sessionId)).toBe(true);
    expect(assistantText(imported)).toBe("hello");

    const reimported = importCodexJsonl(exportCodexJsonl(imported));
    expect(reimported.every((event) => event.sessionId === sessionId)).toBe(true);
    expect(assistantText(reimported)).toBe("hello");
  });

  it("codex importer synthesizes a stable content-derived session id and preserves malformed tool lines as provider events", () => {
    const input = `${JSON.stringify({
      timestamp: "2026-04-16T12:00:01.000Z",
      type: "response_item",
      payload: { type: "function_call", arguments: '{"probe":true}' },
    })}\n${JSON.stringify({
      timestamp: "2026-04-16T12:00:02.000Z",
      type: "response_item",
      payload: { type: "function_call_output", output: "done" },
    })}\n`;

    const imported = importCodexJsonl(input);
    const sessionId = imported[0]?.sessionId;
    expect(sessionId).toMatch(/^codex-session-[0-9a-f]{12}$/);
    expect(imported.every((event) => event.sessionId === sessionId)).toBe(true);

    const invalidToolCall = imported.find(
      (event) => event.kind === "provider.event" && event.payload.eventType === "function_call.invalid",
    );
    const invalidToolResult = imported.find(
      (event) => event.kind === "provider.event" && event.payload.eventType === "function_call_output.invalid",
    );
    expect(invalidToolCall).toBeDefined();
    expect(invalidToolResult).toBeDefined();
  });
});
