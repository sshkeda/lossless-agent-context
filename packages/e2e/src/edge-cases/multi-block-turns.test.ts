import {
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";

const LOSSLESS_CASES = [{ name: "lossless" }] as const;

describe("edge case: multi-block assistant turns", () => {
  for (const { name } of LOSSLESS_CASES) {
    it(`claude: assistant with thinking + text + tool_use + text + tool_use roundtrips through pi → claude (${name})`, () => {
      const input = `${JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-15T12:00:00.000Z",
        sessionId: "claude-multiblock-1",
        cwd: "/tmp",
        version: "2.1.76",
      })}\n${JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-15T12:00:01.000Z",
        sessionId: "claude-multiblock-1",
        cwd: "/tmp",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think first." },
            { type: "text", text: "I'll search and read." },
            { type: "tool_use", id: "tu_a", name: "Grep", input: { pattern: "x" } },
            { type: "text", text: "Then check the file." },
            { type: "tool_use", id: "tu_b", name: "Read", input: { path: "/x" } },
          ],
        },
      })}\n`;
      const c1 = importClaudeCodeJsonl(input);
      const piT = exportPiSessionJsonl(c1);
      const c2 = importPiSessionJsonl(piT);
      const claudeT = exportClaudeCodeJsonl(c2);
      const final = importClaudeCodeJsonl(claudeT);

      expect(final.filter((e) => e.kind === "reasoning.created")).toHaveLength(1);
      expect(final.filter((e) => e.kind === "tool.call")).toHaveLength(2);
      expect(final.filter((e) => e.kind === "message.created" && e.payload.role === "assistant")).toHaveLength(2);

      const calls = final.filter((e) => e.kind === "tool.call");
      const ids = calls.map((c) => (c.kind === "tool.call" ? c.payload.toolCallId : ""));
      expect(ids).toContain("tu_a");
      expect(ids).toContain("tu_b");
    });

    it(`codex: separate response_items aggregate correctly when re-exported to claude (${name})`, () => {
      const input = `${JSON.stringify({
        timestamp: "2026-04-15T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-multi-1", timestamp: "2026-04-15T12:00:00.000Z", cwd: "/tmp", model_provider: "openai" },
      })}\n${JSON.stringify({
        timestamp: "2026-04-15T12:00:01.000Z",
        type: "response_item",
        payload: { type: "reasoning", summary: [{ type: "summary_text", text: "thinking aloud" }] },
      })}\n${JSON.stringify({
        timestamp: "2026-04-15T12:00:02.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "exec", arguments: '{"cmd":"ls"}', call_id: "c1" },
      })}\n${JSON.stringify({
        timestamp: "2026-04-15T12:00:03.000Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "c1", output: "file1\nfile2" },
      })}\n${JSON.stringify({
        timestamp: "2026-04-15T12:00:04.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "exec", arguments: '{"cmd":"pwd"}', call_id: "c2" },
      })}\n`;
      const c1 = importCodexJsonl(input);
      expect(c1.filter((e) => e.kind === "tool.call")).toHaveLength(2);
      expect(c1.filter((e) => e.kind === "tool.result")).toHaveLength(1);
      expect(c1.filter((e) => e.kind === "reasoning.created")).toHaveLength(1);

      const claudeT = exportClaudeCodeJsonl(c1);
      const c2 = importClaudeCodeJsonl(claudeT);
      expect(c2.filter((e) => e.kind === "tool.call")).toHaveLength(2);
      expect(c2.filter((e) => e.kind === "tool.result")).toHaveLength(1);
      expect(c2.filter((e) => e.kind === "reasoning.created")).toHaveLength(1);
    });

    it(`pi: assistant with multiple thinking + multiple toolCalls roundtrips through codex → pi (${name})`, () => {
      const input = `${JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-multi-1",
        timestamp: "2026-04-15T12:00:00.000Z",
        cwd: "/tmp",
      })}\n${JSON.stringify({
        type: "message",
        id: "ab012345",
        parentId: null,
        timestamp: "2026-04-15T12:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "first thought" },
            { type: "thinking", thinking: "second thought" },
            { type: "toolCall", id: "p1", name: "x", arguments: { a: 1 } },
            { type: "toolCall", id: "p2", name: "y", arguments: { b: 2 } },
          ],
          timestamp: 1776297601000,
        },
      })}\n`;
      const c1 = importPiSessionJsonl(input);
      expect(c1.filter((e) => e.kind === "reasoning.created")).toHaveLength(2);
      expect(c1.filter((e) => e.kind === "tool.call")).toHaveLength(2);

      const codexT = exportCodexJsonl(c1);
      const c2 = importCodexJsonl(codexT);
      expect(c2.filter((e) => e.kind === "reasoning.created")).toHaveLength(2);
      expect(c2.filter((e) => e.kind === "tool.call")).toHaveLength(2);

      const piT = exportPiSessionJsonl(c2);
      const c3 = importPiSessionJsonl(piT);
      expect(c3.filter((e) => e.kind === "reasoning.created")).toHaveLength(2);
      expect(c3.filter((e) => e.kind === "tool.call")).toHaveLength(2);
    });
  }
});
