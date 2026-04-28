import {
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
  emptySidecar,
} from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";

const LOSSLESS_CASES = [{ name: "lossless" }] as const;

function findReasoning(events: CanonicalEvent[]): Extract<CanonicalEvent, { kind: "reasoning.created" }> | undefined {
  for (const event of events) {
    if (event.kind === "reasoning.created") return event;
  }
  return undefined;
}

describe("edge case: reasoning visibility per-provider defaults", () => {
  it("claude-code thinking block imports as visibility=full", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-15T12:00:00.000Z",
      sessionId: "claude-vis-1",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-vis-1",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning text" }],
      },
    })}\n`;
    const events = importClaudeCodeJsonl(input, emptySidecar());
    const reasoning = findReasoning(events);
    expect(reasoning).toBeDefined();
    expect(reasoning?.payload.visibility).toBe("full");
    expect(reasoning?.payload.text).toBe("reasoning text");
    expect(reasoning?.payload.providerExposed).toBe(true);
  });

  it("pi thinking block imports as visibility=full", () => {
    const input = `${JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-vis-1",
      timestamp: "2026-04-15T12:00:00.000Z",
      cwd: "/tmp",
    })}\n${JSON.stringify({
      type: "message",
      id: "abc44444",
      parentId: null,
      timestamp: "2026-04-15T12:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "pi thoughts" }],
        timestamp: 1776297601000,
      },
    })}\n`;
    const events = importPiSessionJsonl(input);
    const reasoning = findReasoning(events);
    expect(reasoning?.payload.visibility).toBe("full");
    expect(reasoning?.payload.text).toBe("pi thoughts");
  });

  it("codex reasoning summary imports as visibility=summary", () => {
    const input = `${JSON.stringify({
      timestamp: "2026-04-15T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "codex-vis-1", timestamp: "2026-04-15T12:00:00.000Z", cwd: "/tmp", model_provider: "openai" },
    })}\n${JSON.stringify({
      timestamp: "2026-04-15T12:00:01.000Z",
      type: "response_item",
      payload: { type: "reasoning", summary: [{ type: "summary_text", text: "high level plan" }] },
    })}\n`;
    const events = importCodexJsonl(input);
    const reasoning = findReasoning(events);
    expect(reasoning?.payload.visibility).toBe("summary");
    expect(reasoning?.payload.text).toBe("high level plan");
  });

  it("codex agent_reasoning event_msg also imports as visibility=summary", () => {
    const input = `${JSON.stringify({
      timestamp: "2026-04-15T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "codex-vis-2", timestamp: "2026-04-15T12:00:00.000Z", cwd: "/tmp", model_provider: "openai" },
    })}\n${JSON.stringify({
      timestamp: "2026-04-15T12:00:01.000Z",
      type: "event_msg",
      payload: { type: "agent_reasoning", text: "thinking aloud" },
    })}\n`;
    const events = importCodexJsonl(input);
    const reasoning = findReasoning(events);
    expect(reasoning?.payload.visibility).toBe("summary");
    expect(reasoning?.payload.text).toBe("thinking aloud");
  });
});

describe("edge case: reasoning visibility same-provider roundtrips preserve default value", () => {
  for (const { name } of LOSSLESS_CASES) {
    it(`claude visibility=full survives claude → claude (${name})`, () => {
      const input = `${JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-15T12:00:00.000Z",
        sessionId: "claude-vis-rt",
        cwd: "/tmp",
        version: "2.1.76",
      })}\n${JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-15T12:00:01.000Z",
        sessionId: "claude-vis-rt",
        cwd: "/tmp",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "rt thought" }] },
      })}\n`;
      const c1 = importClaudeCodeJsonl(input, emptySidecar());
      const exported = exportClaudeCodeJsonl(c1);
      const c2 = importClaudeCodeJsonl(exported, emptySidecar());
      const reasoning = findReasoning(c2);
      expect(reasoning?.payload.visibility).toBe("full");
      expect(reasoning?.payload.text).toBe("rt thought");
    });

    it(`pi visibility=full survives pi → pi (${name})`, () => {
      const input = `${JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-vis-rt",
        timestamp: "2026-04-15T12:00:00.000Z",
        cwd: "/tmp",
      })}\n${JSON.stringify({
        type: "message",
        id: "abc55555",
        parentId: null,
        timestamp: "2026-04-15T12:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "pi rt thought" }],
          timestamp: 1776297601000,
        },
      })}\n`;
      const c1 = importPiSessionJsonl(input);
      const exported = exportPiSessionJsonl(c1);
      const c2 = importPiSessionJsonl(exported);
      const reasoning = findReasoning(c2);
      expect(reasoning?.payload.visibility).toBe("full");
      expect(reasoning?.payload.text).toBe("pi rt thought");
    });

    it(`codex visibility=summary survives codex → codex (${name})`, () => {
      const input = `${JSON.stringify({
        timestamp: "2026-04-15T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-vis-rt", timestamp: "2026-04-15T12:00:00.000Z", cwd: "/tmp", model_provider: "openai" },
      })}\n${JSON.stringify({
        timestamp: "2026-04-15T12:00:01.000Z",
        type: "response_item",
        payload: { type: "reasoning", summary: [{ type: "summary_text", text: "codex rt thought" }] },
      })}\n`;
      const c1 = importCodexJsonl(input);
      const exported = exportCodexJsonl(c1);
      const c2 = importCodexJsonl(exported);
      const reasoning = findReasoning(c2);
      expect(reasoning?.payload.visibility).toBe("summary");
      expect(reasoning?.payload.text).toBe("codex rt thought");
    });
  }
});

describe("edge case: cross-provider visibility is preserved in lossless exports", () => {
  it("claude visibility=full → codex re-import keeps visibility=full (lossless export)", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-15T12:00:00.000Z",
      sessionId: "claude-cv-1",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-cv-1",
      cwd: "/tmp",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "cross-provider" }] },
    })}\n`;
    const c1 = importClaudeCodeJsonl(input, emptySidecar());
    const codexText = exportCodexJsonl(c1);
    const c2 = importCodexJsonl(codexText);
    const reasoning = findReasoning(c2);
    expect(reasoning?.payload.visibility).toBe("full");
    expect(reasoning?.payload.text).toBe("cross-provider");
  });

  it("codex visibility=summary → claude re-import keeps visibility=summary (lossless export)", () => {
    const input = `${JSON.stringify({
      timestamp: "2026-04-15T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "codex-cv-1", timestamp: "2026-04-15T12:00:00.000Z", cwd: "/tmp", model_provider: "openai" },
    })}\n${JSON.stringify({
      timestamp: "2026-04-15T12:00:01.000Z",
      type: "response_item",
      payload: { type: "reasoning", summary: [{ type: "summary_text", text: "codex→claude" }] },
    })}\n`;
    const c1 = importCodexJsonl(input);
    const claudeText = exportClaudeCodeJsonl(c1);
    const c2 = importClaudeCodeJsonl(claudeText, emptySidecar());
    const reasoning = findReasoning(c2);
    expect(reasoning?.payload.visibility).toBe("summary");
    expect(reasoning?.payload.text).toBe("codex→claude");
  });

  it("pi visibility=full → codex re-import keeps visibility=full (lossless export)", () => {
    const input = `${JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-cv-1",
      timestamp: "2026-04-15T12:00:00.000Z",
      cwd: "/tmp",
    })}\n${JSON.stringify({
      type: "message",
      id: "abc66666",
      parentId: null,
      timestamp: "2026-04-15T12:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "pi→codex" }],
        timestamp: 1776297601000,
      },
    })}\n`;
    const c1 = importPiSessionJsonl(input);
    const codexText = exportCodexJsonl(c1);
    const c2 = importCodexJsonl(codexText);
    const reasoning = findReasoning(c2);
    expect(reasoning?.payload.visibility).toBe("full");
  });

  it("3-hop claude → pi → codex → claude preserves visibility=full (lossless export)", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-15T12:00:00.000Z",
      sessionId: "claude-3hop",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-3hop",
      cwd: "/tmp",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "3-hop" }] },
    })}\n`;
    const c1 = importClaudeCodeJsonl(input, emptySidecar());
    const piT = exportPiSessionJsonl(c1);
    const c2 = importPiSessionJsonl(piT);
    const codexT = exportCodexJsonl(c2);
    const c3 = importCodexJsonl(codexT);
    const claudeT = exportClaudeCodeJsonl(c3);
    const final = importClaudeCodeJsonl(claudeT, emptySidecar());
    const reasoning = findReasoning(final);
    expect(reasoning?.payload.visibility).toBe("full");
    expect(reasoning?.payload.text).toBe("3-hop");
  });
});
