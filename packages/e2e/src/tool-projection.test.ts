import {
  exportClaudeCodeJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";
import { readFixture } from "./fixtures";
import { parseJsonlObjectLines } from "./jsonl";

const PI_READ_FIXTURE = [
  {
    type: "session",
    version: 3,
    id: "pi-tool-projection-read",
    timestamp: "2026-04-20T02:00:00.000Z",
    cwd: "/tmp/lossless-agent-context",
  },
  {
    type: "message",
    id: "m_user",
    parentId: null,
    timestamp: "2026-04-20T02:00:01.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "read the file" }],
      timestamp: 1776650401000,
    },
  },
  {
    type: "message",
    id: "m_assistant",
    parentId: "m_user",
    timestamp: "2026-04-20T02:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_read_1",
          name: "read",
          arguments: {
            path: "/tmp/lossless-agent-context/README.md",
            offset: 10,
            limit: 5,
          },
        },
      ],
      timestamp: 1776650402000,
    },
  },
  {
    type: "message",
    id: "m_tool",
    parentId: "m_assistant",
    timestamp: "2026-04-20T02:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_read_1",
      toolName: "read",
      content: [{ type: "text", text: "alpha\nbeta\ngamma" }],
      isError: false,
      timestamp: 1776650403000,
    },
  },
]
  .map((line) => JSON.stringify(line))
  .join("\n");

const PI_BASH_FIXTURE = [
  {
    type: "session",
    version: 3,
    id: "pi-tool-projection-bash",
    timestamp: "2026-04-20T02:05:00.000Z",
    cwd: "/tmp/lossless-agent-context",
  },
  {
    type: "message",
    id: "m_user",
    parentId: null,
    timestamp: "2026-04-20T02:05:01.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "cat the file" }],
      timestamp: 1776650701000,
    },
  },
  {
    type: "message",
    id: "m_assistant",
    parentId: "m_user",
    timestamp: "2026-04-20T02:05:02.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_bash_1",
          name: "bash",
          arguments: {
            command: "cat /tmp/lossless-agent-context/README.md",
          },
        },
      ],
      timestamp: 1776650702000,
    },
  },
]
  .map((line) => JSON.stringify(line))
  .join("\n");

const PI_EDIT_FIXTURE = [
  {
    type: "session",
    version: 3,
    id: "pi-tool-projection-edit",
    timestamp: "2026-04-20T02:10:00.000Z",
    cwd: "/tmp/lossless-agent-context",
  },
  {
    type: "message",
    id: "m_user",
    parentId: null,
    timestamp: "2026-04-20T02:10:01.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "edit the file" }],
      timestamp: 1776651001000,
    },
  },
  {
    type: "message",
    id: "m_assistant",
    parentId: "m_user",
    timestamp: "2026-04-20T02:10:02.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_edit_1",
          name: "edit",
          arguments: {
            path: "/tmp/lossless-agent-context/README.md",
            edits: [{ oldText: "old", newText: "new" }],
          },
        },
      ],
      timestamp: 1776651002000,
    },
  },
]
  .map((line) => JSON.stringify(line))
  .join("\n");

const PI_MULTI_EDIT_FIXTURE = [
  {
    type: "session",
    version: 3,
    id: "pi-tool-projection-multi-edit",
    timestamp: "2026-04-20T02:15:00.000Z",
    cwd: "/tmp/lossless-agent-context",
  },
  {
    type: "message",
    id: "m_user",
    parentId: null,
    timestamp: "2026-04-20T02:15:01.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "edit twice" }],
      timestamp: 1776651301000,
    },
  },
  {
    type: "message",
    id: "m_assistant",
    parentId: "m_user",
    timestamp: "2026-04-20T02:15:02.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_edit_2",
          name: "edit",
          arguments: {
            path: "/tmp/lossless-agent-context/README.md",
            edits: [
              { oldText: "old-a", newText: "new-a" },
              { oldText: "old-b", newText: "new-b" },
            ],
          },
        },
      ],
      timestamp: 1776651302000,
    },
  },
]
  .map((line) => JSON.stringify(line))
  .join("\n");

describe("Claude native tool projections", () => {
  it("projects Pi read to Claude Read while preserving the original canonical tool call and tool result", () => {
    const canonical = importPiSessionJsonl(PI_READ_FIXTURE);
    const claudeText = exportClaudeCodeJsonl(canonical);
    const lines = parseJsonlObjectLines(claudeText);

    const assistantLine = lines.find((line) => line.type === "assistant");
    expect(assistantLine).toBeDefined();

    const assistantContent = ((assistantLine?.message as Record<string, unknown> | undefined)?.content ?? []) as Array<
      Record<string, unknown>
    >;
    const toolUse = assistantContent.find((part) => part.type === "tool_use");
    expect(toolUse).toEqual({
      type: "tool_use",
      id: "call_read_1",
      name: "Read",
      input: {
        file_path: "/tmp/lossless-agent-context/README.md",
        offset: 10,
        limit: 5,
      },
    });

    expect(Array.isArray(assistantLine?.__lac_canonical)).toBe(true);

    const reimported = importClaudeCodeJsonl(claudeText);
    const toolCall = reimported.find((event) => event.kind === "tool.call");

    expect(toolCall?.kind === "tool.call" ? toolCall.payload.name : undefined).toBe("read");
    expect(toolCall?.kind === "tool.call" ? toolCall.payload.arguments : undefined).toEqual({
      path: "/tmp/lossless-agent-context/README.md",
      offset: 10,
      limit: 5,
    });
  });

  it("projects structured exec_command to Claude Bash and restores the original Codex tool name on import", () => {
    const canonical = importCodexJsonl(readFixture("codex.jsonl"));
    const claudeText = exportClaudeCodeJsonl(canonical);
    const lines = parseJsonlObjectLines(claudeText);

    const assistantLine = lines.find((line) => {
      if (line.type !== "assistant") return false;
      const content = ((line.message as Record<string, unknown> | undefined)?.content ?? []) as Array<
        Record<string, unknown>
      >;
      return content.some((part) => part.type === "tool_use");
    });
    expect(assistantLine).toBeDefined();

    const assistantContent = ((assistantLine?.message as Record<string, unknown> | undefined)?.content ?? []) as Array<
      Record<string, unknown>
    >;
    const toolUse = assistantContent.find((part) => part.type === "tool_use");
    expect(toolUse).toEqual({
      type: "tool_use",
      id: "call_abc123",
      name: "Bash",
      input: {
        command: "echo hello",
      },
    });

    const reimported = importClaudeCodeJsonl(claudeText);
    const toolCall = reimported.find((event) => event.kind === "tool.call");
    expect(toolCall?.kind === "tool.call" ? toolCall.payload.name : undefined).toBe("exec_command");
    expect(toolCall?.kind === "tool.call" ? toolCall.payload.arguments : undefined).toEqual({ cmd: "echo hello" });
  });

  it("projects single-edit Pi edit calls into Claude Edit while preserving the original canonical arguments", () => {
    const canonical = importPiSessionJsonl(PI_EDIT_FIXTURE);
    const claudeText = exportClaudeCodeJsonl(canonical);
    const lines = parseJsonlObjectLines(claudeText);

    const assistantLine = lines.find((line) => line.type === "assistant");
    expect(assistantLine).toBeDefined();

    const assistantContent = ((assistantLine?.message as Record<string, unknown> | undefined)?.content ?? []) as Array<
      Record<string, unknown>
    >;
    const toolUse = assistantContent.find((part) => part.type === "tool_use");
    expect(toolUse).toEqual({
      type: "tool_use",
      id: "call_edit_1",
      name: "Edit",
      input: {
        file_path: "/tmp/lossless-agent-context/README.md",
        old_string: "old",
        new_string: "new",
        replace_all: false,
      },
    });

    const reimported = importClaudeCodeJsonl(claudeText);
    const toolCall = reimported.find((event) => event.kind === "tool.call");
    expect(toolCall?.kind === "tool.call" ? toolCall.payload.name : undefined).toBe("edit");
    expect(toolCall?.kind === "tool.call" ? toolCall.payload.arguments : undefined).toEqual({
      path: "/tmp/lossless-agent-context/README.md",
      edits: [{ oldText: "old", newText: "new" }],
    });
  });

  it("refuses lossy multi-edit projection and falls back to the original tool schema", () => {
    const canonical = importPiSessionJsonl(PI_MULTI_EDIT_FIXTURE);
    const claudeText = exportClaudeCodeJsonl(canonical);
    const lines = parseJsonlObjectLines(claudeText);

    const assistantLine = lines.find((line) => line.type === "assistant");
    expect(assistantLine).toBeDefined();

    const assistantContent = ((assistantLine?.message as Record<string, unknown> | undefined)?.content ?? []) as Array<
      Record<string, unknown>
    >;
    const toolUse = assistantContent.find((part) => part.type === "tool_use");
    expect(toolUse).toEqual({
      type: "tool_use",
      id: "call_edit_2",
      name: "edit",
      input: {
        path: "/tmp/lossless-agent-context/README.md",
        edits: [
          { oldText: "old-a", newText: "new-a" },
          { oldText: "old-b", newText: "new-b" },
        ],
      },
    });
  });

  it("never upgrades bash commands that merely resemble reads into Claude Read", () => {
    const canonical = importPiSessionJsonl(PI_BASH_FIXTURE);
    const claudeText = exportClaudeCodeJsonl(canonical);
    const lines = parseJsonlObjectLines(claudeText);

    const assistantLine = lines.find((line) => line.type === "assistant");
    expect(assistantLine).toBeDefined();

    const assistantContent = ((assistantLine?.message as Record<string, unknown> | undefined)?.content ?? []) as Array<
      Record<string, unknown>
    >;
    const toolUse = assistantContent.find((part) => part.type === "tool_use");
    expect(toolUse).toEqual({
      type: "tool_use",
      id: "call_bash_1",
      name: "Bash",
      input: {
        command: "cat /tmp/lossless-agent-context/README.md",
      },
    });

    const reimported = importClaudeCodeJsonl(claudeText);
    const toolCall = reimported.find((event) => event.kind === "tool.call");
    expect(toolCall?.kind === "tool.call" ? toolCall.payload.name : undefined).toBe("bash");
    expect(toolCall?.kind === "tool.call" ? toolCall.payload.arguments : undefined).toEqual({
      command: "cat /tmp/lossless-agent-context/README.md",
    });
  });
});
