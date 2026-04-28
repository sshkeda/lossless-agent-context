import { exportClaudeCodeJsonl, exportPiSessionJsonl, importClaudeCodeJsonl, importPiSessionJsonl , emptySidecar } from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";

const PI_PROXY_FIXTURE = [
  {
    type: "session",
    version: 3,
    id: "pi-mcp-proxy-session",
    timestamp: "2026-04-21T01:00:00.000Z",
    cwd: "/tmp/lossless-agent-context",
  },
  {
    type: "message",
    id: "m_user",
    parentId: null,
    timestamp: "2026-04-21T01:00:01.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "use ask_gpt" }],
      timestamp: 1776733201000,
    },
  },
  {
    type: "message",
    id: "m_assistant",
    parentId: "m_user",
    timestamp: "2026-04-21T01:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_proxy_1",
          name: "pi_mcp_proxy__ask_gpt",
          arguments: { prompt: "find bugs" },
        },
      ],
      timestamp: 1776733202000,
    },
  },
  {
    type: "message",
    id: "m_tool",
    parentId: "m_assistant",
    timestamp: "2026-04-21T01:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_proxy_1",
      toolName: "pi_mcp_proxy__ask_gpt",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 1776733203000,
    },
  },
]
  .map((line) => JSON.stringify(line))
  .join("\n");

const CLAUDE_PROXY_FIXTURE = [
  {
    type: "system",
    subtype: "init",
    timestamp: "2026-04-21T01:10:00.000Z",
    sessionId: "claude-mcp-proxy-session",
    cwd: "/tmp/lossless-agent-context",
  },
  {
    type: "assistant",
    timestamp: "2026-04-21T01:10:01.000Z",
    sessionId: "claude-mcp-proxy-session",
    cwd: "/tmp/lossless-agent-context",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_proxy_2", name: "pi_mcp_proxy__ask_gpt", input: { prompt: "find bugs" } }],
    },
  },
  {
    type: "user",
    timestamp: "2026-04-21T01:10:02.000Z",
    sessionId: "claude-mcp-proxy-session",
    cwd: "/tmp/lossless-agent-context",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_proxy_2", content: "result", is_error: false }],
    },
  },
]
  .map((line) => JSON.stringify(line))
  .join("\n");

function findToolCall(events: ReturnType<typeof importPiSessionJsonl> | ReturnType<typeof importClaudeCodeJsonl>) {
  return events.find((event): event is Extract<(typeof events)[number], { kind: "tool.call" }> => event.kind === "tool.call");
}

function findToolResult(events: ReturnType<typeof importPiSessionJsonl> | ReturnType<typeof importClaudeCodeJsonl>) {
  return events.find((event): event is Extract<(typeof events)[number], { kind: "tool.result" }> => event.kind === "tool.result");
}

function parseJsonlObjects(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("pi MCP proxy normalization", () => {
  it("normalizes pi_mcp_proxy__ tool names when importing pi session JSONL", () => {
    const canonical = importPiSessionJsonl(PI_PROXY_FIXTURE);
    const toolCall = findToolCall(canonical);
    const toolResult = findToolResult(canonical);

    expect(toolCall?.payload.name).toBe("ask_gpt");
    expect(toolCall?.actor?.toolName).toBe("ask_gpt");
    expect(toolResult?.actor?.toolName).toBe("ask_gpt");
  });

  it("exports normalized pi MCP proxy calls to Claude using the native pi tool name", () => {
    const canonical = importPiSessionJsonl(PI_PROXY_FIXTURE);
    const claudeText = exportClaudeCodeJsonl(canonical);
    const lines = parseJsonlObjects(claudeText);
    const assistantLine = lines.find((line) => line.type === "assistant");
    const assistantContent = ((assistantLine?.message as Record<string, unknown> | undefined)?.content ?? []) as Array<Record<string, unknown>>;
    const toolUse = assistantContent.find((part) => part.type === "tool_use");

    expect(toolUse?.name).toBe("ask_gpt");
  });

  it("normalizes pi_mcp_proxy__ tool names when importing Claude JSONL", () => {
    const canonical = importClaudeCodeJsonl(CLAUDE_PROXY_FIXTURE, emptySidecar());
    const toolCall = findToolCall(canonical);
    const piText = exportPiSessionJsonl(canonical);
    const lines = parseJsonlObjects(piText);
    const assistantLine = lines.find((line) => (line.message as Record<string, unknown> | undefined)?.role === "assistant");
    const assistantContent = ((assistantLine?.message as Record<string, unknown> | undefined)?.content ?? []) as Array<Record<string, unknown>>;
    const toolCallBlock = assistantContent.find((part) => part.type === "toolCall");

    expect(toolCall?.payload.name).toBe("ask_gpt");
    expect(piText).toContain('"toolCallId":"call_proxy_2"');
    expect(toolCallBlock?.name).toBe("ask_gpt");
  });
});
