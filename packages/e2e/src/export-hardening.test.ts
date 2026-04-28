import {
  emptySidecar,
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
} from "@lossless-agent-context/adapters";
import { CANONICAL_SCHEMA_VERSION, type CanonicalEvent, canonicalEventSchema } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";

describe("export hardening", () => {
  it("claude exporter omits cwd when raw fallback candidates disagree", () => {
    const events = canonicalEventSchema.array().parse([
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: "cwd-pref-1:000000",
        sessionId: "cwd-pref-1",
        branchId: "main",
        seq: 0,
        timestamp: "2026-04-17T00:00:00.000Z",
        kind: "message.created",
        payload: {
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
        actor: { type: "user" },
        native: {
          source: "pi",
          raw: {
            type: "message",
            id: "msg-1",
            parentId: null,
            timestamp: "2026-04-17T00:00:00.000Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "hello" }],
              timestamp: Date.parse("2026-04-17T00:00:00.000Z"),
            },
          },
        },
      },
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: "cwd-pref-1:000001",
        sessionId: "cwd-pref-1",
        branchId: "main",
        seq: 1,
        timestamp: "2026-04-17T00:00:01.000Z",
        kind: "provider.event",
        payload: {
          provider: "codex",
          eventType: "session_meta",
          raw: { id: "cwd-pref-1", cwd: "/tmp/wrong-codex" },
        },
        native: {
          source: "codex",
          raw: {
            timestamp: "2026-04-17T00:00:01.000Z",
            type: "session_meta",
            payload: {
              id: "cwd-pref-1",
              timestamp: "2026-04-17T00:00:01.000Z",
              cwd: "/tmp/wrong-codex",
              model_provider: "openai",
            },
          },
        },
      },
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: "cwd-pref-1:000002",
        sessionId: "cwd-pref-1",
        branchId: "main",
        seq: 2,
        timestamp: "2026-04-17T00:00:02.000Z",
        kind: "provider.event",
        payload: {
          provider: "pi",
          eventType: "session",
          raw: { id: "cwd-pref-1", cwd: "/tmp/right-pi" },
        },
        native: {
          source: "pi",
          raw: {
            type: "session",
            version: 3,
            id: "cwd-pref-1",
            timestamp: "2026-04-17T00:00:02.000Z",
            cwd: "/tmp/right-pi",
          },
        },
      },
    ] satisfies CanonicalEvent[]);

    const exported = exportClaudeCodeJsonl(events)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
    const initLine = exported[0];

    expect(initLine?.type).toBe("system");
    expect(initLine?.subtype).toBe("init");
    expect(initLine?.cwd).toBeUndefined();
  });

  it("pi exporter rejects invalid canonical timestamps instead of coercing them to epoch", () => {
    const events = canonicalEventSchema.array().parse([
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: "pi-session-1:000000",
        sessionId: "pi-session-1",
        branchId: "main",
        seq: 0,
        timestamp: "2026-04-17T00:00:00.000Z",
        kind: "session.created",
        payload: {
          startedAt: "2026-04-17T00:00:00.000Z",
          workingDirectory: "/tmp/export-hardening",
        },
        native: {
          source: "pi",
          raw: {
            type: "session",
            version: 3,
            id: "pi-session-1",
            timestamp: "2026-04-17T00:00:00.000Z",
            cwd: "/tmp/export-hardening",
          },
        },
      },
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: "pi-session-1:000001",
        sessionId: "pi-session-1",
        branchId: "main",
        seq: 1,
        timestamp: "not-a-real-timestamp",
        kind: "tool.result",
        payload: {
          toolCallId: "tool-1",
          output: "oops",
          isError: false,
        },
        actor: { type: "tool" },
        native: {
          source: "claude-code",
          raw: {
            type: "user",
            timestamp: "2026-04-17T00:00:01.000Z",
            sessionId: "pi-session-1",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-1",
                  content: "oops",
                  is_error: false,
                },
              ],
            },
          },
        },
      },
    ] satisfies CanonicalEvent[]);

    expect(() => exportPiSessionJsonl(events)).toThrow("Invalid canonical event timestamp");
  });

  it("cross-provider export preserves structured canonical user parts via canonical overrides", () => {
    const events = canonicalEventSchema.array().parse([
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: "structured-1:000000",
        sessionId: "structured-1",
        branchId: "main",
        seq: 0,
        timestamp: "2026-04-17T00:00:00.000Z",
        kind: "message.created",
        payload: {
          role: "user",
          parts: [
            { type: "file", fileId: "file-1", filename: "report.txt", mediaType: "text/plain" },
            { type: "json", value: { nested: true, count: 2 } },
          ],
        },
        actor: { type: "user" },
        native: {
          source: "pi",
          raw: {
            type: "message",
            id: "msg-structured-1",
            parentId: null,
            timestamp: "2026-04-17T00:00:00.000Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "structured" }],
              timestamp: Date.parse("2026-04-17T00:00:00.000Z"),
            },
          },
        },
      },
    ] satisfies CanonicalEvent[]);

    const originalParts = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "message.created" }> =>
        event.kind === "message.created" && event.payload.role === "user",
    )?.payload.parts;

    const scenarios = [
      {
        name: "claude",
        exportText: exportClaudeCodeJsonl(events),
        reimport: (input: string) => importClaudeCodeJsonl(input, emptySidecar()),
      },
      { name: "codex", exportText: exportCodexJsonl(events), reimport: importCodexJsonl },
    ] as const;

    for (const scenario of scenarios) {
      const reimported = scenario.reimport(scenario.exportText);
      const message = reimported.find(
        (event): event is Extract<CanonicalEvent, { kind: "message.created" }> =>
          event.kind === "message.created" && event.payload.role === "user",
      );
      expect(message?.payload.parts, `${scenario.name} should restore structured parts`).toEqual(originalParts);
    }
  });

  it("claude exporter preserves repeated identical native lines across separate groups", () => {
    const events = canonicalEventSchema.array().parse([
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: "dup-1:000000",
        sessionId: "dup-1",
        branchId: "main",
        seq: 0,
        timestamp: "2026-04-17T00:00:00.000Z",
        kind: "message.created",
        payload: {
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
        actor: { type: "user" },
        native: {
          source: "claude-code",
          raw: {
            type: "user",
            timestamp: "2026-04-17T00:00:00.000Z",
            sessionId: "dup-1",
            message: { role: "user", content: "hello" },
          },
        },
      },
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: "dup-1:000001",
        sessionId: "dup-1",
        branchId: "main",
        seq: 1,
        timestamp: "2026-04-17T00:00:01.000Z",
        kind: "message.created",
        payload: {
          role: "assistant",
          parts: [{ type: "text", text: "ack" }],
        },
        actor: { type: "assistant" },
        native: {
          source: "claude-code",
          raw: {
            type: "assistant",
            timestamp: "2026-04-17T00:00:01.000Z",
            sessionId: "dup-1",
            message: { role: "assistant", content: [{ type: "text", text: "ack" }] },
          },
        },
      },
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: "dup-1:000002",
        sessionId: "dup-1",
        branchId: "main",
        seq: 2,
        timestamp: "2026-04-17T00:00:02.000Z",
        kind: "message.created",
        payload: {
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
        actor: { type: "user" },
        native: {
          source: "claude-code",
          raw: {
            type: "user",
            timestamp: "2026-04-17T00:00:00.000Z",
            sessionId: "dup-1",
            message: { role: "user", content: "hello" },
          },
        },
      },
    ] satisfies CanonicalEvent[]);

    const exported = exportClaudeCodeJsonl(events)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(exported.filter((line) => line.type === "user")).toHaveLength(2);
  });
});
