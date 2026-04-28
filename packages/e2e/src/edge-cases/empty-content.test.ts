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

const LOSSLESS_CASES = [{ name: "lossless" }] as const;

describe("edge case: empty/edge content", () => {
  for (const { name } of LOSSLESS_CASES) {
    it(`claude: empty assistant text block does not crash and roundtrips (${name})`, () => {
      const input = `${JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-15T12:00:00.000Z",
        sessionId: "claude-empty-1",
        cwd: "/tmp",
        version: "2.1.76",
      })}\n${JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-15T12:00:01.000Z",
        sessionId: "claude-empty-1",
        cwd: "/tmp",
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      })}\n`;
      const events = importClaudeCodeJsonl(input, emptySidecar());
      const messages = events.filter((e) => e.kind === "message.created");
      expect(messages.length).toBe(1);

      const exported = exportClaudeCodeJsonl(events);
      const reimported = importClaudeCodeJsonl(exported, emptySidecar());
      expect(reimported.filter((e) => e.kind === "message.created")).toHaveLength(1);
    });

    it(`claude: tool call with empty arguments roundtrips (${name})`, () => {
      const input = `${JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-15T12:00:00.000Z",
        sessionId: "claude-empty-args",
        cwd: "/tmp",
        version: "2.1.76",
      })}\n${JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-15T12:00:01.000Z",
        sessionId: "claude-empty-args",
        cwd: "/tmp",
        message: { role: "assistant", content: [{ type: "tool_use", id: "tu_empty", name: "list_files", input: {} }] },
      })}\n`;
      const events = importClaudeCodeJsonl(input, emptySidecar());
      const exported = exportClaudeCodeJsonl(events);
      const reimported = importClaudeCodeJsonl(exported, emptySidecar());
      const calls = reimported.filter((e) => e.kind === "tool.call");
      expect(calls).toHaveLength(1);
      if (calls[0]?.kind !== "tool.call") throw new Error("type narrowing");
      expect(calls[0].payload.arguments).toEqual({});
    });

    it(`codex: reasoning with empty summary does not crash (${name})`, () => {
      const input = `${JSON.stringify({
        timestamp: "2026-04-15T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-empty-1", timestamp: "2026-04-15T12:00:00.000Z", cwd: "/tmp", model_provider: "openai" },
      })}\n${JSON.stringify({
        timestamp: "2026-04-15T12:00:01.000Z",
        type: "response_item",
        payload: { type: "reasoning", summary: [] },
      })}\n`;
      const events = importCodexJsonl(input);
      const reasoning = events.filter((e) => e.kind === "reasoning.created");
      expect(reasoning.length).toBe(1);

      const exported = exportCodexJsonl(events);
      const reimported = importCodexJsonl(exported);
      expect(reimported.filter((e) => e.kind === "reasoning.created")).toHaveLength(1);
    });

    it(`pi: empty thinking block does not crash and roundtrips (${name})`, () => {
      const input = `${JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-empty-1",
        timestamp: "2026-04-15T12:00:00.000Z",
        cwd: "/tmp",
      })}\n${JSON.stringify({
        type: "message",
        id: "abc22222",
        parentId: null,
        timestamp: "2026-04-15T12:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "" }],
          timestamp: 1776297601000,
        },
      })}\n`;
      const events = importPiSessionJsonl(input);
      const exported = exportPiSessionJsonl(events);
      const reimported = importPiSessionJsonl(exported);
      expect(reimported.filter((e) => e.kind === "reasoning.created")).toHaveLength(1);
    });

    it(`claude: tool result with structured array content roundtrips (${name})`, () => {
      const input = `${JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-15T12:00:00.000Z",
        sessionId: "claude-struct-result",
        cwd: "/tmp",
        version: "2.1.76",
      })}\n${JSON.stringify({
        type: "user",
        timestamp: "2026-04-15T12:00:01.000Z",
        sessionId: "claude-struct-result",
        cwd: "/tmp",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_struct",
              content: [
                { type: "text", text: "first block" },
                { type: "text", text: "second block" },
              ],
              is_error: false,
            },
          ],
        },
      })}\n`;
      const events = importClaudeCodeJsonl(input, emptySidecar());
      const results = events.filter((e) => e.kind === "tool.result");
      expect(results).toHaveLength(1);

      const exported = exportClaudeCodeJsonl(events);
      const reimported = importClaudeCodeJsonl(exported, emptySidecar());
      const reResults = reimported.filter((e) => e.kind === "tool.result");
      expect(reResults).toHaveLength(1);
      if (reResults[0]?.kind !== "tool.result") throw new Error("type narrowing");
      const out = JSON.stringify(reResults[0].payload.output);
      expect(out).toContain("first block");
      expect(out).toContain("second block");
    });
  }
});
