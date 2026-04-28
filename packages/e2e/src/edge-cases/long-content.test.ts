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

const LONG_TEXT = `${"abcdefghij".repeat(2000)}END`;

const LOSSLESS_CASES = [{ name: "lossless" }] as const;

describe("edge case: very long content", () => {
  for (const { name } of LOSSLESS_CASES) {
    it(`claude: 20kb user message roundtrips (${name})`, () => {
      const input = `${JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-15T12:00:00.000Z",
        sessionId: "claude-long-1",
        cwd: "/tmp",
        version: "2.1.76",
      })}\n${JSON.stringify({
        type: "user",
        timestamp: "2026-04-15T12:00:01.000Z",
        sessionId: "claude-long-1",
        cwd: "/tmp",
        message: { role: "user", content: LONG_TEXT },
      })}\n`;
      const events = importClaudeCodeJsonl(input, emptySidecar());
      const exported = exportClaudeCodeJsonl(events);
      const reimported = importClaudeCodeJsonl(exported, emptySidecar());
      const userMessage = reimported.find((e) => e.kind === "message.created" && e.payload.role === "user");
      if (userMessage?.kind !== "message.created") throw new Error("type narrowing");
      const part = userMessage.payload.parts.find((p) => p.type === "text");
      if (part?.type !== "text") throw new Error("type narrowing");
      expect(part.text).toBe(LONG_TEXT);
    });

    it(`codex: 20kb user message roundtrips (${name})`, () => {
      const input = `${JSON.stringify({
        timestamp: "2026-04-15T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-long-1", timestamp: "2026-04-15T12:00:00.000Z", cwd: "/tmp", model_provider: "openai" },
      })}\n${JSON.stringify({
        timestamp: "2026-04-15T12:00:01.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: LONG_TEXT }] },
      })}\n`;
      const events = importCodexJsonl(input);
      const exported = exportCodexJsonl(events);
      const reimported = importCodexJsonl(exported);
      const userMessage = reimported.find((e) => e.kind === "message.created" && e.payload.role === "user");
      if (userMessage?.kind !== "message.created") throw new Error("type narrowing");
      const part = userMessage.payload.parts.find((p) => p.type === "text");
      if (part?.type !== "text") throw new Error("type narrowing");
      expect(part.text).toBe(LONG_TEXT);
    });

    it(`pi: 20kb user message roundtrips (${name})`, () => {
      const input = `${JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-long-1",
        timestamp: "2026-04-15T12:00:00.000Z",
        cwd: "/tmp",
      })}\n${JSON.stringify({
        type: "message",
        id: "abc33333",
        parentId: null,
        timestamp: "2026-04-15T12:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: LONG_TEXT }], timestamp: 1776297601000 },
      })}\n`;
      const events = importPiSessionJsonl(input);
      const exported = exportPiSessionJsonl(events);
      const reimported = importPiSessionJsonl(exported);
      const userMessage = reimported.find((e) => e.kind === "message.created" && e.payload.role === "user");
      if (userMessage?.kind !== "message.created") throw new Error("type narrowing");
      const part = userMessage.payload.parts.find((p) => p.type === "text");
      if (part?.type !== "text") throw new Error("type narrowing");
      expect(part.text).toBe(LONG_TEXT);
    });
  }
});
