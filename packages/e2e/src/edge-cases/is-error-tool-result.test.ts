import {
  emptySidecar,
  exportClaudeCodeJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";

const LOSSLESS_CASES = [{ name: "lossless" }] as const;

function findToolResult(events: CanonicalEvent[]): Extract<CanonicalEvent, { kind: "tool.result" }> | undefined {
  for (const event of events) {
    if (event.kind === "tool.result") return event;
  }
  return undefined;
}

const claudeErrInput = `${JSON.stringify({
  type: "system",
  subtype: "init",
  timestamp: "2026-04-15T12:00:00.000Z",
  sessionId: "claude-err-1",
  cwd: "/tmp",
  version: "2.1.76",
})}\n${JSON.stringify({
  type: "assistant",
  timestamp: "2026-04-15T12:00:01.000Z",
  sessionId: "claude-err-1",
  cwd: "/tmp",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "tu_err", name: "Bash", input: { command: "ls /missing" } }],
  },
})}\n${JSON.stringify({
  type: "user",
  timestamp: "2026-04-15T12:00:02.000Z",
  sessionId: "claude-err-1",
  cwd: "/tmp",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu_err",
        content: "ls: /missing: No such file or directory",
        is_error: true,
      },
    ],
  },
})}\n`;

const piErrInput = `${JSON.stringify({
  type: "session",
  version: 3,
  id: "pi-err-1",
  timestamp: "2026-04-15T12:00:00.000Z",
  cwd: "/tmp",
})}\n${JSON.stringify({
  type: "message",
  id: "abc77777",
  parentId: null,
  timestamp: "2026-04-15T12:00:01.000Z",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_pi_err", name: "exec", arguments: { cmd: "false" } }],
    timestamp: 1776297601000,
  },
})}\n${JSON.stringify({
  type: "message",
  id: "abc77778",
  parentId: "abc77777",
  timestamp: "2026-04-15T12:00:02.000Z",
  message: {
    role: "toolResult",
    toolCallId: "call_pi_err",
    toolName: "exec",
    content: [{ type: "text", text: "command failed with exit 1" }],
    isError: true,
    timestamp: 1776297602000,
  },
})}\n`;

describe("edge case: tool.result isError=true preservation", () => {
  describe("import correctness", () => {
    it("claude tool_result with is_error=true imports isError=true", () => {
      const events = importClaudeCodeJsonl(claudeErrInput, emptySidecar());
      const result = findToolResult(events);
      expect(result?.payload.isError).toBe(true);
    });

    it("pi toolResult with isError=true imports isError=true", () => {
      const events = importPiSessionJsonl(piErrInput);
      const result = findToolResult(events);
      expect(result?.payload.isError).toBe(true);
    });
  });

  describe("same-provider roundtrip preserves isError=true", () => {
    for (const { name } of LOSSLESS_CASES) {
      it(`claude → claude preserves is_error=true (${name})`, () => {
        const c1 = importClaudeCodeJsonl(claudeErrInput, emptySidecar());
        const exported = exportClaudeCodeJsonl(c1);
        const c2 = importClaudeCodeJsonl(exported, emptySidecar());
        const result = findToolResult(c2);
        expect(result?.payload.isError).toBe(true);
      });

      it(`pi → pi preserves isError=true (${name})`, () => {
        const c1 = importPiSessionJsonl(piErrInput);
        const exported = exportPiSessionJsonl(c1);
        const c2 = importPiSessionJsonl(exported);
        const result = findToolResult(c2);
        expect(result?.payload.isError).toBe(true);
      });
    }
  });

  describe("cross-provider preserves isError=true", () => {
    for (const { name } of LOSSLESS_CASES) {
      it(`claude → pi → claude preserves isError=true (${name})`, () => {
        const c1 = importClaudeCodeJsonl(claudeErrInput, emptySidecar());
        const piText = exportPiSessionJsonl(c1);
        const c2 = importPiSessionJsonl(piText);
        const claudeText = exportClaudeCodeJsonl(c2);
        const final = importClaudeCodeJsonl(claudeText, emptySidecar());
        const result = findToolResult(final);
        expect(result?.payload.isError).toBe(true);
      });

      it(`pi → claude → pi preserves isError=true (${name})`, () => {
        const c1 = importPiSessionJsonl(piErrInput);
        const claudeText = exportClaudeCodeJsonl(c1);
        const c2 = importClaudeCodeJsonl(claudeText, emptySidecar());
        const piText = exportPiSessionJsonl(c2);
        const final = importPiSessionJsonl(piText);
        const result = findToolResult(final);
        expect(result?.payload.isError).toBe(true);
      });
    }
  });

  describe("isError=false (success) does not get flipped", () => {
    for (const { name } of LOSSLESS_CASES) {
      it(`claude → claude preserves is_error=false (${name})`, () => {
        const successInput = `${JSON.stringify({
          type: "system",
          subtype: "init",
          timestamp: "2026-04-15T12:00:00.000Z",
          sessionId: "claude-ok-1",
          cwd: "/tmp",
          version: "2.1.76",
        })}\n${JSON.stringify({
          type: "user",
          timestamp: "2026-04-15T12:00:01.000Z",
          sessionId: "claude-ok-1",
          cwd: "/tmp",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu_ok", content: "OK", is_error: false }],
          },
        })}\n`;
        const c1 = importClaudeCodeJsonl(successInput, emptySidecar());
        const exported = exportClaudeCodeJsonl(c1);
        const c2 = importClaudeCodeJsonl(exported, emptySidecar());
        const result = findToolResult(c2);
        expect(result?.payload.isError).toBe(false);
      });
    }
  });
});
