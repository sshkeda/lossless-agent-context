import {
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";

const UNICODE_SAMPLE =
  'hello \u{1F600} \u4F60\u597D \u062D\u0644\u0648 \u041F\u0440\u0438\u0432\u0435\u0442 \uD83D\uDC4B\uD83C\uDFFB tab=\t newline=\n nullesc=\\u0000 quote=" backslash=\\';

const LOSSLESS_CASES = [{ name: "lossless" }] as const;

describe("edge case: unicode and special characters", () => {
  for (const { name } of LOSSLESS_CASES) {
    it(`claude: roundtrip preserves unicode + control chars in user message (${name})`, () => {
      const input = `${JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-15T12:00:00.000Z",
        sessionId: "claude-unicode-1",
        cwd: "/tmp",
        version: "2.1.76",
      })}\n${JSON.stringify({
        type: "user",
        timestamp: "2026-04-15T12:00:01.000Z",
        sessionId: "claude-unicode-1",
        cwd: "/tmp",
        message: { role: "user", content: UNICODE_SAMPLE },
      })}\n`;
      const events = importClaudeCodeJsonl(input);
      const userMessage = events.find((e) => e.kind === "message.created" && e.payload.role === "user");
      if (userMessage?.kind !== "message.created") throw new Error("type narrowing");
      const textPart = userMessage.payload.parts.find((p) => p.type === "text");
      if (textPart?.type !== "text") throw new Error("type narrowing");
      expect(textPart.text).toBe(UNICODE_SAMPLE);

      const exported = exportClaudeCodeJsonl(events);
      const reimported = importClaudeCodeJsonl(exported);
      const reUser = reimported.find((e) => e.kind === "message.created" && e.payload.role === "user");
      if (reUser?.kind !== "message.created") throw new Error("type narrowing");
      const rePart = reUser.payload.parts.find((p) => p.type === "text");
      if (rePart?.type !== "text") throw new Error("type narrowing");
      expect(rePart.text).toBe(UNICODE_SAMPLE);
    });

    it(`pi: roundtrip preserves unicode in user message (${name})`, () => {
      const input = `${JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-unicode-1",
        timestamp: "2026-04-15T12:00:00.000Z",
        cwd: "/tmp",
      })}\n${JSON.stringify({
        type: "message",
        id: "abc11111",
        parentId: null,
        timestamp: "2026-04-15T12:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: UNICODE_SAMPLE }], timestamp: 1776297601000 },
      })}\n`;
      const events = importPiSessionJsonl(input);
      const userMessage = events.find((e) => e.kind === "message.created" && e.payload.role === "user");
      if (userMessage?.kind !== "message.created") throw new Error("type narrowing");
      const part = userMessage.payload.parts.find((p) => p.type === "text");
      if (part?.type !== "text") throw new Error("type narrowing");
      expect(part.text).toBe(UNICODE_SAMPLE);

      const exported = exportPiSessionJsonl(events);
      const reimported = importPiSessionJsonl(exported);
      const reUser = reimported.find((e) => e.kind === "message.created" && e.payload.role === "user");
      if (reUser?.kind !== "message.created") throw new Error("type narrowing");
      const rePart = reUser.payload.parts.find((p) => p.type === "text");
      if (rePart?.type !== "text") throw new Error("type narrowing");
      expect(rePart.text).toBe(UNICODE_SAMPLE);
    });

    it(`codex: roundtrip preserves unicode in user message (${name})`, () => {
      const input = `${JSON.stringify({
        timestamp: "2026-04-15T12:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "codex-unicode-1",
          timestamp: "2026-04-15T12:00:00.000Z",
          cwd: "/tmp",
          model_provider: "openai",
        },
      })}\n${JSON.stringify({
        timestamp: "2026-04-15T12:00:01.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: UNICODE_SAMPLE }] },
      })}\n`;
      const events = importCodexJsonl(input);
      const userMessage = events.find((e) => e.kind === "message.created" && e.payload.role === "user");
      if (userMessage?.kind !== "message.created") throw new Error("type narrowing");
      const part = userMessage.payload.parts.find((p) => p.type === "text");
      if (part?.type !== "text") throw new Error("type narrowing");
      expect(part.text).toBe(UNICODE_SAMPLE);

      const exported = exportCodexJsonl(events);
      const reimported = importCodexJsonl(exported);
      const reUser = reimported.find((e) => e.kind === "message.created" && e.payload.role === "user");
      if (reUser?.kind !== "message.created") throw new Error("type narrowing");
      const rePart = reUser.payload.parts.find((p) => p.type === "text");
      if (rePart?.type !== "text") throw new Error("type narrowing");
      expect(rePart.text).toBe(UNICODE_SAMPLE);
    });

    it(`cross-provider: unicode survives claude → pi → codex → claude (${name})`, () => {
      const input = `${JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-15T12:00:00.000Z",
        sessionId: "claude-unicode-2",
        cwd: "/tmp",
        version: "2.1.76",
      })}\n${JSON.stringify({
        type: "user",
        timestamp: "2026-04-15T12:00:01.000Z",
        sessionId: "claude-unicode-2",
        cwd: "/tmp",
        message: { role: "user", content: UNICODE_SAMPLE },
      })}\n`;
      const c1 = importClaudeCodeJsonl(input);
      const piT = exportPiSessionJsonl(c1);
      const c2 = importPiSessionJsonl(piT);
      const codexT = exportCodexJsonl(c2);
      const c3 = importCodexJsonl(codexT);
      const claudeT = exportClaudeCodeJsonl(c3);
      const final = importClaudeCodeJsonl(claudeT);

      const userMessage = final.find((e) => e.kind === "message.created" && e.payload.role === "user");
      if (userMessage?.kind !== "message.created") throw new Error("type narrowing");
      const part = userMessage.payload.parts.find((p) => p.type === "text");
      if (part?.type !== "text") throw new Error("type narrowing");
      expect(part.text).toBe(UNICODE_SAMPLE);
    });
  }
});
