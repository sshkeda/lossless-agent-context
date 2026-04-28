import {
  emptySidecar,
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";

const LOSSLESS_CASES = [{ name: "lossless" }] as const;

describe("edge case: orphan tool call (no matching result)", () => {
  for (const { name } of LOSSLESS_CASES) {
    it(`claude: orphan tool_use survives roundtrip claude → claude (${name})`, () => {
      const input = `${JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-15T12:00:00.000Z",
        sessionId: "claude-orphan-1",
        cwd: "/tmp",
        version: "2.1.76",
      })}\n${JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-15T12:00:01.000Z",
        sessionId: "claude-orphan-1",
        cwd: "/tmp",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool_orphan_1", name: "Bash", input: { command: "ls" } }],
        },
      })}\n`;
      const events = importClaudeCodeJsonl(input, emptySidecar());
      const toolCalls = events.filter((e) => e.kind === "tool.call");
      const toolResults = events.filter((e) => e.kind === "tool.result");
      expect(toolCalls).toHaveLength(1);
      expect(toolResults).toHaveLength(0);

      const exported = exportClaudeCodeJsonl(events);
      const reimported = importClaudeCodeJsonl(exported, emptySidecar());
      const reimportedCalls = reimported.filter((e) => e.kind === "tool.call");
      const reimportedResults = reimported.filter((e) => e.kind === "tool.result");
      expect(reimportedCalls).toHaveLength(1);
      expect(reimportedResults).toHaveLength(0);
      if (reimportedCalls[0]?.kind !== "tool.call") throw new Error("type narrowing");
      expect(reimportedCalls[0].payload.toolCallId).toBe("tool_orphan_1");
    });

    it(`codex: orphan function_call survives roundtrip codex → codex (${name})`, () => {
      const input = `${JSON.stringify({
        timestamp: "2026-04-15T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-orphan-1", timestamp: "2026-04-15T12:00:00.000Z", cwd: "/tmp", model_provider: "openai" },
      })}\n${JSON.stringify({
        timestamp: "2026-04-15T12:00:01.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "call_orphan" },
      })}\n`;
      const events = importCodexJsonl(input);
      const toolCalls = events.filter((e) => e.kind === "tool.call");
      expect(toolCalls).toHaveLength(1);

      const exported = exportCodexJsonl(events);
      const reimported = importCodexJsonl(exported);
      const reimportedCalls = reimported.filter((e) => e.kind === "tool.call");
      expect(reimportedCalls).toHaveLength(1);
    });

    it(`pi: orphan toolCall survives roundtrip pi → pi (${name})`, () => {
      const input = `${JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-orphan-1",
        timestamp: "2026-04-15T12:00:00.000Z",
        cwd: "/tmp",
      })}\n${JSON.stringify({
        type: "message",
        id: "abc12345",
        parentId: null,
        timestamp: "2026-04-15T12:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_orphan_pi", name: "ls", arguments: { path: "/tmp" } }],
          timestamp: 1776297601000,
        },
      })}\n`;
      const events = importPiSessionJsonl(input);
      const toolCalls = events.filter((e) => e.kind === "tool.call");
      expect(toolCalls).toHaveLength(1);

      const exported = exportPiSessionJsonl(events);
      const reimported = importPiSessionJsonl(exported);
      expect(reimported.filter((e) => e.kind === "tool.call")).toHaveLength(1);
    });

    it(`cross-provider: orphan tool call claude → pi → claude (${name})`, () => {
      const input = `${JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-15T12:00:00.000Z",
        sessionId: "claude-orphan-cross",
        cwd: "/tmp",
        version: "2.1.76",
      })}\n${JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-15T12:00:01.000Z",
        sessionId: "claude-orphan-cross",
        cwd: "/tmp",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_x", name: "Read", input: { path: "/x" } }],
        },
      })}\n`;
      const canonical1 = importClaudeCodeJsonl(input, emptySidecar());
      const piText = exportPiSessionJsonl(canonical1);
      const canonical2 = importPiSessionJsonl(piText);
      const claudeText = exportClaudeCodeJsonl(canonical2);
      const final = importClaudeCodeJsonl(claudeText, emptySidecar());
      const calls = final.filter((e) => e.kind === "tool.call");
      expect(calls).toHaveLength(1);
      if (calls[0]?.kind !== "tool.call") throw new Error("type narrowing");
      expect(calls[0].payload.toolCallId).toBe("tu_x");
    });
  }
});

describe("edge case: orphan tool result (no preceding call)", () => {
  for (const { name } of LOSSLESS_CASES) {
    it(`claude: orphan tool_result survives roundtrip claude → claude (${name})`, () => {
      const input = `${JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-15T12:00:00.000Z",
        sessionId: "claude-orphan-result-1",
        cwd: "/tmp",
        version: "2.1.76",
      })}\n${JSON.stringify({
        type: "user",
        timestamp: "2026-04-15T12:00:01.000Z",
        sessionId: "claude-orphan-result-1",
        cwd: "/tmp",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_missing", content: "leftover", is_error: false }],
        },
      })}\n`;
      const events = importClaudeCodeJsonl(input, emptySidecar());
      const toolResults = events.filter((e) => e.kind === "tool.result");
      expect(toolResults).toHaveLength(1);

      const exported = exportClaudeCodeJsonl(events);
      const reimported = importClaudeCodeJsonl(exported, emptySidecar());
      expect(reimported.filter((e) => e.kind === "tool.result")).toHaveLength(1);
    });

    it(`codex: orphan function_call_output survives roundtrip codex → codex (${name})`, () => {
      const input = `${JSON.stringify({
        timestamp: "2026-04-15T12:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "codex-orphan-result-1",
          timestamp: "2026-04-15T12:00:00.000Z",
          cwd: "/tmp",
          model_provider: "openai",
        },
      })}\n${JSON.stringify({
        timestamp: "2026-04-15T12:00:01.000Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_missing", output: "leftover output" },
      })}\n`;
      const events = importCodexJsonl(input);
      expect(events.filter((e) => e.kind === "tool.result")).toHaveLength(1);

      const exported = exportCodexJsonl(events);
      const reimported = importCodexJsonl(exported);
      expect(reimported.filter((e) => e.kind === "tool.result")).toHaveLength(1);
    });
  }
});
