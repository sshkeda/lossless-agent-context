import {
  emptySidecar,
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import { CANONICAL_SCHEMA_VERSION, type CanonicalEvent, canonicalEventSchema } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";

const TS = "2026-04-15T12:00:00.000Z";
const TOOL_RESULT_DETAILS_KEY = "lossless-agent-context/toolResultDetails";

function event(input: Omit<CanonicalEvent, "schemaVersion" | "eventId" | "seq"> & { seq: number }): CanonicalEvent {
  return canonicalEventSchema.parse({
    ...input,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    eventId: `${input.sessionId}:${String(input.seq).padStart(6, "0")}`,
  });
}

function claudeSession(sessionId: string, overrides: Record<string, unknown> = {}): CanonicalEvent {
  return event({
    sessionId,
    branchId: "main",
    seq: 0,
    timestamp: TS,
    kind: "session.created",
    payload: { startedAt: TS, workingDirectory: "/tmp", ...overrides },
    native: {
      source: "claude-code",
      raw: { type: "system", subtype: "init", timestamp: TS, sessionId, cwd: "/tmp", version: "2.1.76" },
    },
  });
}

function piSession(sessionId: string, overrides: Record<string, unknown> = {}): CanonicalEvent {
  return event({
    sessionId,
    branchId: "main",
    seq: 0,
    timestamp: TS,
    kind: "session.created",
    payload: { startedAt: TS, workingDirectory: "/tmp", ...overrides },
    native: { source: "pi", raw: { type: "session", version: 3, id: sessionId, timestamp: TS, cwd: "/tmp" } },
  });
}

describe("edge case: session.created title/tags cross-provider preservation", () => {
  it("title and tags survive claude → pi → claude (lossless export)", () => {
    const sessionId = "claude-title-1";
    const session = claudeSession(sessionId, {
      title: "My Important Session",
      tags: { project: "alpha", env: "prod" },
    });
    const piText = exportPiSessionJsonl([session]);
    const c2 = importPiSessionJsonl(piText);
    const claudeText = exportClaudeCodeJsonl(c2);
    const final = importClaudeCodeJsonl(claudeText, emptySidecar());
    const roundtripped = final.find((e) => e.kind === "session.created");
    expect(roundtripped).toBeDefined();
    if (roundtripped?.kind !== "session.created") throw new Error("type narrowing");
    expect(roundtripped.payload.title).toBe("My Important Session");
    expect(roundtripped.payload.tags).toEqual({ project: "alpha", env: "prod" });
  });

  it("title and tags survive pi → codex → pi (lossless export)", () => {
    const sessionId = "pi-title-1";
    const session = piSession(sessionId, {
      title: "Pi Session",
      tags: { team: "beta" },
    });
    const codexText = exportCodexJsonl([session]);
    const c2 = importCodexJsonl(codexText);
    const piText = exportPiSessionJsonl(c2);
    const final = importPiSessionJsonl(piText);
    const roundtripped = final.find((e) => e.kind === "session.created");
    if (roundtripped?.kind !== "session.created") throw new Error("type narrowing");
    expect(roundtripped.payload.title).toBe("Pi Session");
    expect(roundtripped.payload.tags).toEqual({ team: "beta" });
  });

  it("session.created provider and model survive pi → claude → pi (lossless export)", () => {
    const sessionId = "pi-model-1";
    const session = piSession(sessionId, {
      provider: "anthropic",
      model: "claude-3-opus-20240229",
    });
    const claudeText = exportClaudeCodeJsonl([session]);
    const c2 = importClaudeCodeJsonl(claudeText, emptySidecar());
    const piText = exportPiSessionJsonl(c2);
    const final = importPiSessionJsonl(piText);
    const roundtripped = final.find((e) => e.kind === "session.created");
    if (roundtripped?.kind !== "session.created") throw new Error("type narrowing");
    expect(roundtripped.payload.provider).toBe("anthropic");
    expect(roundtripped.payload.model).toBe("claude-3-opus-20240229");
  });
});

describe("edge case: tool.result.error cross-provider preservation", () => {
  it("tool.result.error survives claude → pi (lossless export)", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: TS,
      sessionId: "claude-err-1",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "user",
      timestamp: "2026-04-15T12:00:02.000Z",
      sessionId: "claude-err-1",
      cwd: "/tmp",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_e", content: "boom", is_error: true }],
      },
    })}\n`;
    const c1 = importClaudeCodeJsonl(input, emptySidecar());
    const trIndex = c1.findIndex((e) => e.kind === "tool.result");
    const original = c1[trIndex];
    if (!original) throw new Error("missing tool.result");
    c1[trIndex] = canonicalEventSchema.parse({
      ...original,
      payload: { ...original.payload, error: "EPIPE: command aborted" },
    });

    const piText = exportPiSessionJsonl(c1);
    const c2 = importPiSessionJsonl(piText);
    const tr = c2.find((e) => e.kind === "tool.result");
    if (tr?.kind !== "tool.result") throw new Error("type narrowing");
    expect(tr.payload.error).toBe("EPIPE: command aborted");
    expect(tr.payload.isError).toBe(true);
  });

  it("tool.result actor.toolName survives pi → claude → pi even without a matching tool.call", () => {
    const input = `${JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-tool-name-1",
      timestamp: TS,
      cwd: "/tmp",
    })}\n${JSON.stringify({
      type: "message",
      id: "msg-tool-result-only",
      parentId: null,
      timestamp: "2026-04-15T12:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-only",
        toolName: "exec",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 1776254402000,
      },
    })}\n`;

    const c1 = importPiSessionJsonl(input);
    const claudeText = exportClaudeCodeJsonl(c1);
    const c2 = importClaudeCodeJsonl(claudeText, emptySidecar());
    const piText = exportPiSessionJsonl(c2);
    const final = importPiSessionJsonl(piText);
    const tr = final.find((event) => event.kind === "tool.result");
    expect(tr?.actor?.toolName).toBe("exec");
  });

  it("tool.result.details survive pi → claude → pi", () => {
    const input = `${JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-tool-details-1",
      timestamp: TS,
      cwd: "/tmp",
    })}\n${JSON.stringify({
      type: "message",
      id: "msg-tool-result-details",
      parentId: null,
      timestamp: "2026-04-15T12:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-details",
        toolName: "fetch",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        details: {
          method: "json",
          contentType: "application/json",
          finalUrl: "https://example.com/data.json",
        },
        timestamp: 1776254402000,
      },
    })}\n`;

    const c1 = importPiSessionJsonl(input);
    const claudeText = exportClaudeCodeJsonl(c1);
    const c2 = importClaudeCodeJsonl(claudeText, emptySidecar());
    const piText = exportPiSessionJsonl(c2);
    const final = importPiSessionJsonl(piText);
    const tr = final.find((event) => event.kind === "tool.result");
    if (tr?.kind !== "tool.result") throw new Error("type narrowing");
    expect(tr.payload.details).toEqual({
      method: "json",
      contentType: "application/json",
      finalUrl: "https://example.com/data.json",
    });
  });

  it("imports Claude tool_result structuredContent as tool.result.details", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: TS,
      sessionId: "claude-tool-details-1",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "user",
      timestamp: "2026-04-15T12:00:02.000Z",
      sessionId: "claude-tool-details-1",
      cwd: "/tmp",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_details",
            content: "ok",
            structuredContent: {
              [TOOL_RESULT_DETAILS_KEY]: {
                method: "jina",
                contentType: "text/html",
              },
            },
            is_error: false,
          },
        ],
      },
    })}\n`;

    const events = importClaudeCodeJsonl(input, emptySidecar());
    const tr = events.find((event) => event.kind === "tool.result");
    if (tr?.kind !== "tool.result") throw new Error("type narrowing");
    expect(tr.payload.details).toEqual({
      method: "jina",
      contentType: "text/html",
    });
  });
});

describe("edge case: actor rich-field cross-provider preservation", () => {
  it("tool.call actor.provider + model + agentId survive claude → pi (lossless export)", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: TS,
      sessionId: "claude-actor-1",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-actor-1",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_a", name: "Bash", input: { cmd: "ls" } }],
      },
    })}\n`;
    const c1 = importClaudeCodeJsonl(input, emptySidecar());
    const tcIndex = c1.findIndex((e) => e.kind === "tool.call");
    const original = c1[tcIndex];
    if (!original) throw new Error("missing tool.call");
    c1[tcIndex] = canonicalEventSchema.parse({
      ...original,
      actor: {
        type: "assistant",
        toolName: "Bash",
        provider: "anthropic",
        model: "claude-3-opus",
        agentId: "agent-xyz",
      },
    });

    const piText = exportPiSessionJsonl(c1);
    const c2 = importPiSessionJsonl(piText);
    const tc = c2.find((e) => e.kind === "tool.call");
    expect(tc?.actor?.type).toBe("assistant");
    expect(tc?.actor?.toolName).toBe("Bash");
    expect(tc?.actor?.provider).toBe("anthropic");
    expect(tc?.actor?.model).toBe("claude-3-opus");
    expect(tc?.actor?.agentId).toBe("agent-xyz");
  });

  it("message.created actor.agentId survives 3-hop claude → pi → codex → claude", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: TS,
      sessionId: "claude-actor-agent",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-actor-agent",
      cwd: "/tmp",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    })}\n`;
    const c1 = importClaudeCodeJsonl(input, emptySidecar());
    const msgIndex = c1.findIndex((e) => e.kind === "message.created");
    const original = c1[msgIndex];
    if (!original) throw new Error("missing message.created");
    c1[msgIndex] = canonicalEventSchema.parse({
      ...original,
      actor: { type: "assistant", agentId: "agent-multi-hop" },
    });

    const piT = exportPiSessionJsonl(c1);
    const c2 = importPiSessionJsonl(piT);
    const codexT = exportCodexJsonl(c2);
    const c3 = importCodexJsonl(codexT);
    const claudeT = exportClaudeCodeJsonl(c3);
    const final = importClaudeCodeJsonl(claudeT, emptySidecar());
    const msg = final.find((e) => e.kind === "message.created");
    expect(msg?.actor?.agentId).toBe("agent-multi-hop");
  });
});
