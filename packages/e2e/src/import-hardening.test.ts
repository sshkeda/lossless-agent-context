import {
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import { CANONICAL_SCHEMA_VERSION, type CanonicalEvent, canonicalEventSchema } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";

const TS = "2026-04-16T12:00:00.000Z";
const TS_MS = Date.parse(TS);

function event(input: Omit<CanonicalEvent, "schemaVersion" | "eventId" | "seq"> & { seq: number }): CanonicalEvent {
  return canonicalEventSchema.parse({
    ...input,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    eventId: `${input.sessionId}:${String(input.seq).padStart(6, "0")}`,
  });
}

describe("import hardening: multi-session JSONL", () => {
  it("pi importer preserves session boundaries across multiple session headers in one file", () => {
    const text = `${JSON.stringify({ type: "session", version: 3, id: "pi-a", timestamp: TS, cwd: "/tmp/a" })}
${JSON.stringify({
  type: "message",
  id: "msg-a",
  parentId: null,
  timestamp: TS,
  message: { role: "user", content: [{ type: "text", text: "from-a" }], timestamp: TS_MS },
})}
${JSON.stringify({ type: "session", version: 3, id: "pi-b", timestamp: TS, cwd: "/tmp/b" })}
${JSON.stringify({
  type: "message",
  id: "msg-b",
  parentId: null,
  timestamp: TS,
  message: { role: "user", content: [{ type: "text", text: "from-b" }], timestamp: TS_MS },
})}
`;

    const events = importPiSessionJsonl(text);
    const sessions = events.filter((e) => e.kind === "session.created");
    const messages = events.filter((e) => e.kind === "message.created");

    expect(sessions.map((e) => e.sessionId)).toEqual(["pi-a", "pi-b"]);
    expect(
      messages.map((e) => [
        e.sessionId,
        e.payload.parts[0] && "text" in e.payload.parts[0] ? e.payload.parts[0].text : null,
      ]),
    ).toEqual([
      ["pi-a", "from-a"],
      ["pi-b", "from-b"],
    ]);
  });

  it("claude importer preserves session boundaries across multiple sessionIds in one file", () => {
    const text = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: TS,
      sessionId: "claude-a",
      cwd: "/tmp/a",
      version: "2.1.76",
    })}
${JSON.stringify({
  type: "user",
  timestamp: TS,
  sessionId: "claude-a",
  cwd: "/tmp/a",
  message: { role: "user", content: "from-a" },
})}
${JSON.stringify({
  type: "system",
  subtype: "init",
  timestamp: TS,
  sessionId: "claude-b",
  cwd: "/tmp/b",
  version: "2.1.76",
})}
${JSON.stringify({
  type: "user",
  timestamp: TS,
  sessionId: "claude-b",
  cwd: "/tmp/b",
  message: { role: "user", content: "from-b" },
})}
`;

    const events = importClaudeCodeJsonl(text);
    const sessions = events.filter((e) => e.kind === "session.created");
    const messages = events.filter((e) => e.kind === "message.created");

    expect(sessions.map((e) => e.sessionId)).toEqual(["claude-a", "claude-b"]);
    expect(
      messages.map((e) => [
        e.sessionId,
        e.payload.parts[0] && "text" in e.payload.parts[0] ? e.payload.parts[0].text : null,
      ]),
    ).toEqual([
      ["claude-a", "from-a"],
      ["claude-b", "from-b"],
    ]);
  });

  it("codex importer preserves session boundaries across multiple session_meta entries in one file", () => {
    const text = `${JSON.stringify({
      timestamp: TS,
      type: "session_meta",
      payload: { id: "codex-a", timestamp: TS, cwd: "/tmp/a", model_provider: "openai" },
    })}
${JSON.stringify({
  timestamp: TS,
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: "from-a" }] },
})}
${JSON.stringify({
  timestamp: TS,
  type: "session_meta",
  payload: { id: "codex-b", timestamp: TS, cwd: "/tmp/b", model_provider: "openai" },
})}
${JSON.stringify({
  timestamp: TS,
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: "from-b" }] },
})}
`;

    const events = importCodexJsonl(text);
    const sessions = events.filter((e) => e.kind === "session.created");
    const messages = events.filter((e) => e.kind === "message.created");

    expect(sessions.map((e) => e.sessionId)).toEqual(["codex-a", "codex-b"]);
    expect(
      messages.map((e) => [
        e.sessionId,
        e.payload.parts[0] && "text" in e.payload.parts[0] ? e.payload.parts[0].text : null,
      ]),
    ).toEqual([
      ["codex-a", "from-a"],
      ["codex-b", "from-b"],
    ]);
  });
});

describe("import hardening: missing native line type", () => {
  it("pi importer preserves raw lines missing type with an explicit missing_type event label", () => {
    const text = `${JSON.stringify({ id: "pi-missing-type", timestamp: TS, payload: { hello: true } })}\n`;
    const events = importPiSessionJsonl(text);
    const preserved = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "provider.event" }> => event.kind === "provider.event",
    );

    expect(preserved?.payload.provider).toBe("pi");
    expect(preserved?.payload.eventType).toBe("line.missing_type");
  });

  it("claude importer preserves raw lines missing type with an explicit missing_type event label", () => {
    const text = `${JSON.stringify({ sessionId: "claude-missing-type", timestamp: TS, payload: { hello: true } })}\n`;
    const events = importClaudeCodeJsonl(text);
    const preserved = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "provider.event" }> => event.kind === "provider.event",
    );

    expect(preserved?.payload.provider).toBe("claude-code");
    expect(preserved?.payload.eventType).toBe("line.missing_type");
  });

  it("codex importer preserves raw lines missing type with an explicit missing_type event label", () => {
    const text = `${JSON.stringify({ timestamp: TS, payload: { hello: true } })}\n`;
    const events = importCodexJsonl(text);
    const preserved = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "provider.event" }> => event.kind === "provider.event",
    );

    expect(preserved?.payload.provider).toBe("codex");
    expect(preserved?.payload.eventType).toBe("line.missing_type");
  });
});

describe("import hardening: explicit failures", () => {
  it("throws a line-numbered error for malformed JSONL", () => {
    const text = `${JSON.stringify({ type: "session", version: 3, id: "pi-a", timestamp: TS, cwd: "/tmp/a" })}
not-json
`;
    expect(() => importPiSessionJsonl(text)).toThrow(/Invalid JSONL at line 2/);
  });

  it("throws for invalid timestamps instead of silently coercing to epoch", () => {
    const text = `${JSON.stringify({ type: "session", version: 3, id: "pi-a", timestamp: "not-a-date", cwd: "/tmp/a" })}
`;
    expect(() => importPiSessionJsonl(text)).toThrow(/Invalid Pi session timestamp/);
  });

  it("throws for invalid Codex function_call arguments instead of returning the raw string", () => {
    const text = `${JSON.stringify({
      timestamp: TS,
      type: "session_meta",
      payload: { id: "codex-a", timestamp: TS, cwd: "/tmp/a", model_provider: "openai" },
    })}
${JSON.stringify({
  timestamp: TS,
  type: "response_item",
  payload: { type: "function_call", name: "exec", arguments: "{not-json}", call_id: "call-1" },
})}
`;
    expect(() => importCodexJsonl(text)).toThrow(/Invalid Codex function_call arguments/);
  });

  it("preserves Codex custom_tool_call input as raw strings instead of opportunistically JSON-parsing it", () => {
    const text = `${JSON.stringify({
      timestamp: TS,
      type: "session_meta",
      payload: { id: "codex-a", timestamp: TS, cwd: "/tmp/a", model_provider: "openai" },
    })}
${JSON.stringify({
  timestamp: TS,
  type: "response_item",
  payload: {
    type: "custom_tool_call",
    name: "apply_patch",
    input: '{"path":"README.md","op":"update"}',
    call_id: "call-json",
  },
})}
${JSON.stringify({
  timestamp: TS,
  type: "response_item",
  payload: {
    type: "custom_tool_call",
    name: "shell",
    input: "ls -la",
    call_id: "call-text",
  },
})}
`;
    const events = importCodexJsonl(text).filter(
      (event): event is Extract<CanonicalEvent, { kind: "tool.call" }> => event.kind === "tool.call",
    );

    expect(events).toHaveLength(2);
    expect(events[0]?.payload.arguments).toBe('{"path":"README.md","op":"update"}');
    expect(events[1]?.payload.arguments).toBe("ls -la");
  });

  it("preserves Codex thread registration events as provider events so export can roundtrip them", () => {
    const text = `${JSON.stringify({
      timestamp: TS,
      type: "session_meta",
      payload: { id: "codex-a", timestamp: TS, cwd: "/tmp/a", model_provider: "openai" },
    })}
${JSON.stringify({
  timestamp: TS,
  type: "event_msg",
  payload: { type: "thread_name_updated", thread_id: "codex-a", thread_name: "codex-a" },
})}
`;
    const events = importCodexJsonl(text);
    const providerEvent = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "provider.event" }> =>
        event.kind === "provider.event" && event.payload.eventType === "thread_name_updated",
    );

    expect(providerEvent).toBeDefined();
    if (providerEvent?.kind !== "provider.event") throw new Error("type narrowing");
    expect(providerEvent.payload.provider).toBe("codex");
    expect(providerEvent.payload.raw).toEqual({
      type: "thread_name_updated",
      thread_id: "codex-a",
      thread_name: "codex-a",
    });

    const roundtripped = exportCodexJsonl(events)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(roundtripped).toEqual(
      text
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line)),
    );
  });

  it("throws for Claude lines missing timestamps instead of borrowing a prior timestamp", () => {
    const text = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: TS,
      sessionId: "claude-a",
      cwd: "/tmp/a",
      version: "2.1.76",
    })}
${JSON.stringify({
  type: "user",
  sessionId: "claude-a",
  cwd: "/tmp/a",
  message: { role: "user", content: "from-a" },
})}
`;
    expect(() => importClaudeCodeJsonl(text)).toThrow(/Invalid Claude line timestamp/);
  });

  it("preserves Claude last-prompt lines as provider events without borrowing timestamps", () => {
    const text = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: TS,
      sessionId: "claude-a",
      cwd: "/tmp/a",
      version: "2.1.76",
    })}
${JSON.stringify({
  type: "last-prompt",
  sessionId: "claude-a",
  cwd: "/tmp/a",
  message: { role: "user", content: "from-a" },
})}
${JSON.stringify({
  type: "user",
  timestamp: TS,
  sessionId: "claude-a",
  cwd: "/tmp/a",
  message: { role: "user", content: "real-user-line" },
})}
`;
    const events = importClaudeCodeJsonl(text);
    const preserved = events.find(
      (event): event is Extract<(typeof events)[number], { kind: "provider.event" }> =>
        event.kind === "provider.event" && event.payload.eventType === "last-prompt",
    );
    expect(preserved).toBeDefined();
    if (preserved?.kind !== "provider.event") throw new Error("type narrowing");
    expect(preserved.timestamp).toBe("1970-01-01T00:00:00.000Z");
    expect(preserved.extensions).toEqual({ "lac:syntheticTimestamp": true });
    expect(preserved.payload.provider).toBe("claude-code");
    expect(preserved.payload.eventType).toBe("last-prompt");

    const userMessages = events.filter(
      (event): event is Extract<(typeof events)[number], { kind: "message.created" }> =>
        event.kind === "message.created" && event.payload.role === "user",
    );
    expect(userMessages).toHaveLength(1);
    const firstPart = userMessages[0]?.payload.parts[0];
    expect(firstPart && "text" in firstPart ? firstPart.text : undefined).toBe("real-user-line");
  });

  it("rejects exporting a mixed-session canonical array to a single native JSONL target", () => {
    const events = [
      event({
        sessionId: "session-a",
        branchId: "main",
        seq: 0,
        timestamp: TS,
        kind: "session.created",
        payload: { startedAt: TS, workingDirectory: "/tmp/a" },
        native: { source: "pi", raw: { type: "session", version: 3, id: "session-a", timestamp: TS, cwd: "/tmp/a" } },
      }),
      event({
        sessionId: "session-b",
        branchId: "main",
        seq: 1,
        timestamp: TS,
        kind: "session.created",
        payload: { startedAt: TS, workingDirectory: "/tmp/b" },
        native: { source: "pi", raw: { type: "session", version: 3, id: "session-b", timestamp: TS, cwd: "/tmp/b" } },
      }),
    ];

    expect(() => exportPiSessionJsonl(events)).toThrow(/Cannot export multiple sessions to pi/);
    expect(() => exportClaudeCodeJsonl(events)).toThrow(/Cannot export multiple sessions to claude-code/);
    expect(() => exportCodexJsonl(events)).toThrow(/Cannot export multiple sessions to codex/);
  });

  it("round-trips Claude last-prompt lines through pi without dropping the raw native record", () => {
    const text = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: TS,
      sessionId: "claude-a",
      cwd: "/tmp/a",
      version: "2.1.76",
    })}
${JSON.stringify({
  type: "last-prompt",
  sessionId: "claude-a",
  cwd: "/tmp/a",
  message: { role: "user", content: "from-a" },
})}
${JSON.stringify({
  type: "user",
  timestamp: TS,
  sessionId: "claude-a",
  cwd: "/tmp/a",
  message: { role: "user", content: "real-user-line" },
})}
`;

    const imported = importClaudeCodeJsonl(text);
    const viaPi = importPiSessionJsonl(exportPiSessionJsonl(imported));
    const reexported = exportClaudeCodeJsonl(viaPi)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(reexported).toContainEqual({
      type: "last-prompt",
      sessionId: "claude-a",
      cwd: "/tmp/a",
      message: { role: "user", content: "from-a" },
    });
  });
});

describe("import hardening: canonical fallback schema compatibility", () => {
  it("fails fast when canonical fallback lines omit schemaVersion", () => {
    const text = `${JSON.stringify({ type: "session", version: 3, id: "legacy-pi", timestamp: TS, cwd: "/tmp" })}
${JSON.stringify({
  type: "lac:event",
  timestamp: TS,
  branchId: "feature-x",
  kind: "branch.created",
  payload: { fromBranchId: "main" },
  __lac_foreign: { source: "pi", raw: { type: "lac:branch_created", branchId: "feature-x", fromBranchId: "main" } },
})}
`;

    expect(() => importPiSessionJsonl(text)).toThrow(/Missing canonical schemaVersion/);
  });

  it("fails fast on explicit legacy canonical schemaVersion values", () => {
    const text = `${JSON.stringify({ type: "session", version: 3, id: "legacy-pi", timestamp: TS, cwd: "/tmp" })}
${JSON.stringify({
  type: "lac:event",
  schemaVersion: "0.0.1",
  timestamp: TS,
  branchId: "feature-x",
  kind: "branch.created",
  payload: { fromBranchId: "main" },
  __lac_foreign: { source: "pi", raw: { type: "lac:branch_created", branchId: "feature-x", fromBranchId: "main" } },
})}
`;

    expect(() => importPiSessionJsonl(text)).toThrow(/Unsupported canonical schemaVersion: 0\.0\.1/);
  });

  it("fails fast on unsupported canonical fallback schemaVersion", () => {
    const text = `${JSON.stringify({ type: "session", version: 3, id: "legacy-pi", timestamp: TS, cwd: "/tmp" })}
${JSON.stringify({
  type: "lac:event",
  schemaVersion: "9.9.9",
  timestamp: TS,
  branchId: "feature-x",
  kind: "branch.created",
  payload: { fromBranchId: "main" },
  __lac_foreign: { source: "pi", raw: { type: "lac:branch_created", branchId: "feature-x", fromBranchId: "main" } },
})}
`;

    expect(() => importPiSessionJsonl(text)).toThrow(/Unsupported canonical schemaVersion: 9\.9\.9/);
  });

  it("merges canonical override extensions with preserved claude line ids", () => {
    const text = `${JSON.stringify({
      type: "message",
      id: "msg-1",
      parentId: null,
      timestamp: TS,
      __lac_targets: { "claude-code": { uuid: "claude-uuid-1", parentUuid: null } },
      __lac_canonical: [{ extensions: { custom: { preserved: true } } }],
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        timestamp: TS_MS,
      },
    })}
`;

    const assistant = importPiSessionJsonl(text).find(
      (event) => event.kind === "message.created" && event.payload.role === "assistant",
    );

    expect(assistant).toBeDefined();
    expect(assistant?.extensions).toMatchObject({
      "lac:claudeCodeLine": { uuid: "claude-uuid-1", parentUuid: null },
      custom: { preserved: true },
    });
  });
});

describe("import hardening: cross-provider branch preservation", () => {
  it("preserves non-main branchId for canonical-only and native-equivalent events across pi -> claude conversion", () => {
    const session = event({
      sessionId: "branchy-session",
      branchId: "main",
      seq: 0,
      timestamp: TS,
      kind: "session.created",
      payload: { startedAt: TS, workingDirectory: "/tmp" },
      native: { source: "pi", raw: { type: "session", version: 3, id: "branchy-session", timestamp: TS, cwd: "/tmp" } },
    });
    const branch = event({
      sessionId: "branchy-session",
      branchId: "feature-x",
      seq: 1,
      timestamp: TS,
      kind: "branch.created",
      payload: { fromBranchId: "main", fromEventId: "branchy-session:000000", reason: "fork" },
      native: {
        source: "pi",
        raw: { type: "lac:branch_created", branchId: "feature-x", fromBranchId: "main" },
      },
    });
    const message = event({
      sessionId: "branchy-session",
      branchId: "feature-x",
      seq: 2,
      timestamp: TS,
      kind: "message.created",
      actor: { type: "user" },
      payload: { role: "user", parts: [{ type: "text", text: "feature branch message" }] },
      native: {
        source: "pi",
        raw: {
          type: "message",
          id: "feature-msg",
          parentId: null,
          timestamp: TS,
          message: { role: "user", content: [{ type: "text", text: "feature branch message" }], timestamp: TS_MS },
        },
      },
    });

    const reimported = importClaudeCodeJsonl(exportClaudeCodeJsonl([session, branch, message]));
    const reimportedBranch = reimported.find((e) => e.kind === "branch.created");
    const reimportedMessage = reimported.find(
      (e) =>
        e.kind === "message.created" &&
        e.payload.role === "user" &&
        e.payload.parts.some((part) => part.type === "text" && part.text === "feature branch message"),
    );

    expect(reimportedBranch).toBeDefined();
    expect(reimportedMessage).toBeDefined();
    if (reimportedBranch?.kind !== "branch.created" || reimportedMessage?.kind !== "message.created") {
      throw new Error("type narrowing");
    }

    expect(reimportedBranch.branchId).toBe("feature-x");
    expect(reimportedBranch.payload.fromEventId).toBe("branchy-session:000000");
    expect(reimportedMessage.branchId).toBe("feature-x");
  });
});

describe("import hardening: explicit Pi content block parsing", () => {
  it("imports Pi image and file blocks as structured content parts instead of opaque generic payloads", () => {
    const text = `${JSON.stringify({ type: "session", version: 3, id: "pi-rich-1", timestamp: TS, cwd: "/tmp" })}
${JSON.stringify({
  type: "message",
  id: "msg-rich",
  parentId: null,
  timestamp: TS,
  message: {
    role: "user",
    content: [
      { type: "image", data: "aGVsbG8=", mimeType: "application/octet-stream" },
      { type: "file", fileId: "file-123", filename: "report.txt", mediaType: "text/plain" },
    ],
    timestamp: TS_MS,
  },
})}
`;

    const events = importPiSessionJsonl(text);
    const message = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "message.created" }> =>
        event.kind === "message.created" && event.payload.role === "user",
    );

    expect(message).toBeDefined();
    if (message?.kind !== "message.created") throw new Error("type narrowing");
    expect(message.payload.parts).toEqual([
      { type: "image", imageRef: "aGVsbG8=", mediaType: "application/octet-stream" },
      { type: "file", fileId: "file-123", filename: "report.txt", mediaType: "text/plain" },
    ]);
  });

  it("preserves Pi file blocks without fileId as raw json instead of inventing unknown-file ids", () => {
    const text = `${JSON.stringify({ type: "session", version: 3, id: "pi-rich-2", timestamp: TS, cwd: "/tmp" })}
${JSON.stringify({
  type: "message",
  id: "msg-rich-2",
  parentId: null,
  timestamp: TS,
  message: {
    role: "user",
    content: [{ type: "file", filename: "report.txt", mediaType: "text/plain" }],
    timestamp: TS_MS,
  },
})}
`;

    const events = importPiSessionJsonl(text);
    const message = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "message.created" }> =>
        event.kind === "message.created" && event.payload.role === "user",
    );

    expect(message).toBeDefined();
    if (message?.kind !== "message.created") throw new Error("type narrowing");
    expect(message.payload.parts).toEqual([
      { type: "json", value: { type: "file", filename: "report.txt", mediaType: "text/plain" } },
    ]);
  });
});
