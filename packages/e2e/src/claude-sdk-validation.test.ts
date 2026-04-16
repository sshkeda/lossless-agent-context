import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getSessionMessages, InMemorySessionStore } from "@anthropic-ai/claude-agent-sdk";
import { exportClaudeCodeJsonl, importPiSessionJsonl } from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";
import {
  claudeSdkAssistantInner,
  claudeSdkThinkingBlock,
  claudeSdkToolResultBlock,
  claudeSdkToolUseBlock,
  claudeSdkUserInner,
  jsonRecord,
} from "./sdk-schemas";

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "fixtures", name), "utf8");
}

function parseJsonlLines(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => jsonRecord.parse(JSON.parse(line)));
}

function projectKeyFromCwd(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

function buildClaudeFromPiFixture(): { entries: Array<Record<string, unknown>>; cwd: string; sessionId: string } {
  const piText = fixture("pi.jsonl");
  const canonical = importPiSessionJsonl(piText);
  const claudeText = exportClaudeCodeJsonl(canonical);
  const lines = parseJsonlLines(claudeText);

  const sessionId = randomUUID();
  const cwd = "/tmp/lossless-agent-context-claude-sdk-validation";

  for (const line of lines) {
    line.sessionId = sessionId;
    line.cwd = cwd;
  }

  return { entries: lines, cwd, sessionId };
}

describe("Claude Agent SDK validation: real SDK parses Pi -> Claude conversion", () => {
  it("getSessionMessages returns the user/assistant chain converted from a Pi session", async () => {
    const { entries, cwd, sessionId } = buildClaudeFromPiFixture();

    const store = new InMemorySessionStore();
    await store.append({ projectKey: projectKeyFromCwd(cwd), sessionId }, entries);

    const messages = await getSessionMessages(sessionId, { sessionStore: store, dir: cwd });

    expect(messages.length).toBeGreaterThanOrEqual(3);
    const types = messages.map((m) => m.type);
    expect(types).toContain("user");
    expect(types).toContain("assistant");
    for (const message of messages) {
      expect(message.session_id).toBe(sessionId);
      expect(typeof message.uuid).toBe("string");
    }
  });

  it("getSessionMessages with includeSystemMessages returns the full chain including init/model_change", async () => {
    const { entries, cwd, sessionId } = buildClaudeFromPiFixture();

    const store = new InMemorySessionStore();
    await store.append({ projectKey: projectKeyFromCwd(cwd), sessionId }, entries);

    const messages = await getSessionMessages(sessionId, {
      sessionStore: store,
      dir: cwd,
      includeSystemMessages: true,
    });

    expect(messages.length).toBe(entries.length);
    expect(messages[0]?.type).toBe("system");
    expect(messages.at(-1)?.type).toBe("user");
  });

  it("the converted assistant turn surfaces thinking + tool_use content blocks with the original Pi values", async () => {
    const { entries, cwd, sessionId } = buildClaudeFromPiFixture();

    const store = new InMemorySessionStore();
    await store.append({ projectKey: projectKeyFromCwd(cwd), sessionId }, entries);

    const messages = await getSessionMessages(sessionId, { sessionStore: store, dir: cwd });
    const assistantMessage = messages.find((m) => m.type === "assistant");
    expect(assistantMessage).toBeDefined();

    const inner = claudeSdkAssistantInner.parse(assistantMessage?.message);
    expect(inner.role).toBe("assistant");

    const thinking = inner.content
      .map((block) => claudeSdkThinkingBlock.safeParse(block))
      .find((result) => result.success)?.data;
    const toolUse = inner.content
      .map((block) => claudeSdkToolUseBlock.safeParse(block))
      .find((result) => result.success)?.data;
    expect(thinking?.thinking).toBe("Need to start the dev server.");
    expect(toolUse?.id).toBe("call_1");
    expect(toolUse?.name).toBe("ask_claude_code");
    expect(toolUse?.input).toEqual({ input: "spin up the dev server pls" });
  });

  it("the user/tool_result turns surface the original Pi user prompt and tool output", async () => {
    const { entries, cwd, sessionId } = buildClaudeFromPiFixture();

    const store = new InMemorySessionStore();
    await store.append({ projectKey: projectKeyFromCwd(cwd), sessionId }, entries);

    const messages = await getSessionMessages(sessionId, { sessionStore: store, dir: cwd });
    const userMessages = messages.filter((m) => m.type === "user");
    expect(userMessages.length).toBeGreaterThanOrEqual(2);

    const promptInner = claudeSdkUserInner.parse(userMessages[0]?.message);
    expect(promptInner.content).toBe("spin up the dev server pls");

    const toolResultInner = claudeSdkUserInner.parse(userMessages[1]?.message);
    const blocks = Array.isArray(toolResultInner.content) ? toolResultInner.content : [];
    const toolResult = blocks
      .map((block) => claudeSdkToolResultBlock.safeParse(block))
      .find((result) => result.success)?.data;
    expect(toolResult?.tool_use_id).toBe("call_1");
    expect(toolResult?.content).toContain("Dev server is starting");
  });
});
