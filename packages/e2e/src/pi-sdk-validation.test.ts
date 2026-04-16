import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportPiSessionJsonl, importClaudeCodeJsonl, importCodexJsonl } from "@lossless-agent-context/adapters";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  buildSessionContext,
  type FileEntry,
  parseSessionEntries,
  type SessionEntry,
  type SessionHeader,
  type SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

type AssistantArrayMessage = Extract<AgentMessage, { role: "assistant" }>;
type UserMessage = Extract<AgentMessage, { role: "user" }>;

function isAssistantMessage(message: AgentMessage): message is AssistantArrayMessage {
  return message.role === "assistant";
}

function isUserMessage(message: AgentMessage): message is UserMessage {
  return message.role === "user";
}

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "fixtures", name), "utf8");
}

function isHeader(entry: FileEntry): entry is SessionHeader {
  return entry.type === "session";
}

describe("Pi SDK validation: real Pi parser accepts Claude -> Pi conversion", () => {
  it("parseSessionEntries returns header + body entries for converted Claude session", () => {
    const claudeText = fixture("claude-code.jsonl");
    const canonical = importClaudeCodeJsonl(claudeText);
    const piText = exportPiSessionJsonl(canonical);

    const fileEntries = parseSessionEntries(piText);
    expect(fileEntries.length).toBeGreaterThan(0);

    const header = fileEntries.find(isHeader);
    expect(header).toBeDefined();
    expect(header?.id).toBe("claude-session-1");
    expect(header?.cwd).toBe("/tmp/lossless-agent-context");

    const entries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const types = entries.map((e) => e.type);
    expect(types).toContain("message");
  });

  it("buildSessionContext returns the Claude prompt + assistant response as Pi messages", () => {
    const claudeText = fixture("claude-code.jsonl");
    const canonical = importClaudeCodeJsonl(claudeText);
    const piText = exportPiSessionJsonl(canonical);

    const fileEntries = parseSessionEntries(piText);
    const sessionEntries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");

    const context = buildSessionContext(sessionEntries);
    expect(context.messages.length).toBeGreaterThanOrEqual(3);

    const userMessage = context.messages.find(isUserMessage);
    expect(userMessage).toBeDefined();
    if (userMessage && Array.isArray(userMessage.content)) {
      const textBlocks = userMessage.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
      expect(textBlocks.some((b) => b.text === "what is admin creds?")).toBe(true);
    } else {
      expect(typeof userMessage?.content).toBe("string");
      expect(userMessage?.content).toBe("what is admin creds?");
    }

    const assistantMessage = context.messages.find(isAssistantMessage);
    expect(assistantMessage).toBeDefined();
    expect(Array.isArray(assistantMessage?.content)).toBe(true);
    const blocks = assistantMessage?.content ?? [];
    const thinking = blocks.find((b) => b.type === "thinking");
    const toolCall = blocks.find((b) => b.type === "toolCall");
    expect(thinking).toBeDefined();
    expect(toolCall).toBeDefined();
    if (toolCall && toolCall.type === "toolCall") {
      expect(toolCall.id).toBe("toolu_123");
      expect(toolCall.name).toBe("Grep");
      expect(toolCall.arguments).toEqual({ pattern: "admin", "-i": true });
    }
  });

  it("the Claude tool_result becomes a Pi toolResult message with the same payload", () => {
    const claudeText = fixture("claude-code.jsonl");
    const canonical = importClaudeCodeJsonl(claudeText);
    const piText = exportPiSessionJsonl(canonical);

    const fileEntries = parseSessionEntries(piText);
    const sessionEntries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");

    const messageEntries = sessionEntries.filter((e): e is SessionMessageEntry => e.type === "message");
    const toolResult = messageEntries.find((e) => e.message.role === "toolResult");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.message.role === "toolResult") {
      expect(toolResult.message.toolCallId).toBe("toolu_123");
      const blocks = Array.isArray(toolResult.message.content) ? toolResult.message.content : [];
      const text = blocks
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      expect(text).toBe("Found 27 files");
      expect(toolResult.message.isError).toBe(false);
    }
  });
});

describe("Pi SDK validation: real Pi parser accepts Codex -> Pi conversion", () => {
  it("parseSessionEntries returns header + entries for converted Codex session", () => {
    const codexText = fixture("codex.jsonl");
    const canonical = importCodexJsonl(codexText);
    const piText = exportPiSessionJsonl(canonical);

    const fileEntries = parseSessionEntries(piText);
    const header = fileEntries.find(isHeader);
    expect(header).toBeDefined();
    expect(header?.id).toBe("codex-session-1");
    expect(header?.cwd).toBe("/tmp/lossless-agent-context");

    const entries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");
    expect(entries.length).toBeGreaterThanOrEqual(3);
  });

  it("buildSessionContext surfaces the Codex prompt, reasoning, and tool turn as Pi messages", () => {
    const codexText = fixture("codex.jsonl");
    const canonical = importCodexJsonl(codexText);
    const piText = exportPiSessionJsonl(canonical);

    const fileEntries = parseSessionEntries(piText);
    const sessionEntries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");

    const context = buildSessionContext(sessionEntries);

    const userMessage = context.messages.find(isUserMessage);
    expect(userMessage).toBeDefined();
    const userContent = Array.isArray(userMessage?.content) ? userMessage.content : [];
    const userText = userContent
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(typeof userMessage?.content === "string" ? userMessage.content : userText).toContain(
      "say goodmorning with some thoughtful advice",
    );

    const assistantMessages = context.messages.filter(isAssistantMessage);
    const assistantWithThinking = assistantMessages.find((m) => m.content.some((c) => c.type === "thinking"));
    expect(assistantWithThinking).toBeDefined();

    const assistantWithToolCall = assistantMessages.find((m) => m.content.some((c) => c.type === "toolCall"));
    expect(assistantWithToolCall).toBeDefined();
    if (assistantWithToolCall) {
      const toolCall = assistantWithToolCall.content.find((c) => c.type === "toolCall");
      if (toolCall && toolCall.type === "toolCall") {
        expect(toolCall.id).toBe("call_abc123");
        expect(toolCall.name).toBe("exec_command");
        expect(toolCall.arguments).toEqual({ cmd: "echo hello" });
      }
    }

    const toolResult = context.messages.find((m) => m.role === "toolResult");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.role === "toolResult") {
      expect(toolResult.toolCallId).toBe("call_abc123");
    }
  });
});
