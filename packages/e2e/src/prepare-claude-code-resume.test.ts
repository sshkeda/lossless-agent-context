import {
  importPiSessionJsonl,
  prepareClaudeCodeResumeSeed,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9oN7L9kAAAAASUVORK5CYII=";

describe("prepareClaudeCodeResumeSeed", () => {
  it("synthesizes Claude assistant message ids for completed Pi tool cycles", () => {
    // Reverse engineered against Claude Code 2.1.119:
    // a synthetic assistant tool_use -> user tool_result -> assistant text
    // sequence is rejected with "tool use concurrency issues" when both
    // assistant message objects lack Claude's native message.id field.
    const piJsonl = [
      { type: "session", version: 3, id: "sess-1", timestamp: "2026-04-21T00:00:00.000Z", cwd: "/tmp" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-04-21T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "run pwd" }], timestamp: 1 } },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-21T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "toolu_pwd_1", name: "bash", arguments: { command: "pwd" } }],
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "r1",
        parentId: "a1",
        timestamp: "2026-04-21T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "toolu_pwd_1",
          toolName: "bash",
          content: [{ type: "text", text: "/tmp" }],
          isError: false,
          timestamp: 3,
        },
      },
      {
        type: "message",
        id: "a2",
        parentId: "r1",
        timestamp: "2026-04-21T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          timestamp: 4,
        },
      },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    const { jsonl: firstSeed } = prepareClaudeCodeResumeSeed(importPiSessionJsonl(piJsonl), "target-session-id");
    const { jsonl: secondSeed } = prepareClaudeCodeResumeSeed(importPiSessionJsonl(piJsonl), "target-session-id");
    const assistantLines = firstSeed
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .filter((line) => line.type === "assistant");

    expect(firstSeed).toBe(secondSeed);
    expect(assistantLines).toHaveLength(2);
    expect(assistantLines.every((line) => typeof line.message?.id === "string")).toBe(true);
    expect(assistantLines.every((line) => line.message.id.startsWith("msg_"))).toBe(true);
    expect(new Set(assistantLines.map((line) => line.message.id)).size).toBe(2);
    expect(assistantLines[0].message.content.some((block: { type?: string }) => block.type === "tool_use")).toBe(true);
    expect(assistantLines[1].message.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("preserves high-count historical tool pairs instead of folding them to text", () => {
    // The failing AgentVibe seed happened to cross 80 tool results, but the
    // root cause was missing assistant message ids. Tool count is not the
    // contract, so the resume seed must not drop or stringify native pairs.
    const pairCount = 83;
    const claudeJsonl = [
      { type: "system", subtype: "init", uuid: "u0", parentUuid: null, timestamp: "2026-04-21T00:00:00.000Z", sessionId: "orig", cwd: "/tmp" },
      ...Array.from({ length: pairCount }, (_, index) => {
        const pair = index + 1;
        return [
          {
            type: "assistant",
            parentUuid: pair === 1 ? "u0" : `r${pair - 1}`,
            uuid: `a${pair}`,
            timestamp: `2026-04-21T00:${String(pair).padStart(2, "0")}:01.000Z`,
            sessionId: "orig",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: `running tool ${pair}` },
                { type: "tool_use", id: `toolu_${pair}`, name: "Bash", input: { command: `echo ${pair}` } },
              ],
              stop_reason: "tool_use",
            },
          },
          {
            type: "user",
            parentUuid: `a${pair}`,
            uuid: `r${pair}`,
            timestamp: `2026-04-21T00:${String(pair).padStart(2, "0")}:02.000Z`,
            sessionId: "orig",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: `toolu_${pair}`,
                  content: `result ${pair}`,
                  is_error: false,
                },
              ],
            },
          },
        ];
      }).flat(),
      {
        type: "assistant",
        parentUuid: `r${pairCount}`,
        uuid: "final",
        timestamp: "2026-04-21T01:30:00.000Z",
        sessionId: "orig",
        message: { role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
      },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    const { jsonl: seed } = prepareClaudeCodeResumeSeed(claudeJsonl, "target-session-id");
    const seedObjects = seed.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
    const contentBlocks = seedObjects.flatMap((obj) => {
      const content = obj.message?.content;
      return Array.isArray(content) ? content : [];
    });
    const nativeToolUses = contentBlocks.filter((block) => block?.type === "tool_use");
    const nativeToolResults = contentBlocks.filter((block) => block?.type === "tool_result");
    const textBlocks = contentBlocks.filter((block) => block?.type === "text").map((block) => block.text);

    expect(nativeToolUses).toHaveLength(pairCount);
    expect(nativeToolResults).toHaveLength(pairCount);
    expect(nativeToolUses.some((block) => block.id === "toolu_1")).toBe(true);
    expect(nativeToolResults.some((block) => block.tool_use_id === "toolu_1")).toBe(true);
    expect(nativeToolUses.some((block) => block.id === "toolu_83")).toBe(true);
    expect(nativeToolResults.some((block) => block.tool_use_id === "toolu_83")).toBe(true);
    expect(textBlocks.some((text) => text.includes("Historical tool call"))).toBe(false);
    expect(textBlocks.some((text) => text.includes("Historical tool result"))).toBe(false);
    expect(seedObjects.every((obj) => obj.sessionId === "target-session-id")).toBe(true);
  });

  it("demotes unsigned foreign thinking blocks to text so claude keeps the reasoning history", () => {
    // Pi session with an openai-codex assistant message carrying a thinking
    // block — its `thinkingSignature` is OpenAI's encrypted reasoning ID,
    // NOT a claude signature. Exporting to claude-code yields `{type:"thinking"}`
    // with no signature, which claude's API rejects:
    //   messages.N.content.M.thinking.signature: Field required
    // Previously the seed prep dropped these, silently losing every codex
    // chain-of-thought. Now it demotes them to a `<thinking>...</thinking>`
    // wrapped text block so claude has the reasoning history when resuming.
    const piJsonl = [
      { type: "session", version: 3, id: "sess-1", timestamp: "2026-04-21T00:00:00.000Z", cwd: "/tmp" },
      { type: "model_change", id: "m1", parentId: null, timestamp: "2026-04-21T00:00:00.100Z", provider: "openai-codex", modelId: "gpt-5.4" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-04-21T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hey" }], timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-04-21T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "codex reasoning", thinkingSignature: '{"id":"rs_x","encrypted_content":"OPENAI_FORMAT"}' }, { type: "text", text: "Hey!", textSignature: '{"id":"msg_y"}' }], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.4", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    const canonical = importPiSessionJsonl(piJsonl);
    const { jsonl: seed } = prepareClaudeCodeResumeSeed(canonical, "target-session-id");

    const seedLines = seed.split("\n").filter((l) => l.trim().length > 0);
    const invalid: Array<{ line: number; block: number }> = [];
    let userTextPreserved = false;
    let demotedThinkingPreserved = false;
    let originalAssistantTextPreserved = false;
    for (const [i, line] of seedLines.entries()) {
      const obj = JSON.parse(line);
      expect(obj.sessionId).toBe("target-session-id");
      expect(new Set(["system", "user", "assistant", "summary", "attachment"]).has(obj.type)).toBe(true);

      if (obj.type === "user") {
        const content = obj.message?.content;
        if (typeof content === "string" && content === "hey") userTextPreserved = true;
        if (Array.isArray(content) && content.some((p) => p?.type === "text" && p.text === "hey")) {
          userTextPreserved = true;
        }
      }

      if (obj.type === "assistant") {
        const content = obj.message?.content ?? [];
        for (const [j, block] of content.entries()) {
          if (block?.type === "thinking") {
            const hasSig = typeof block.signature === "string" && block.signature.length > 0;
            if (!hasSig) invalid.push({ line: i, block: j });
          }
          if (block?.type === "text" && typeof block.text === "string") {
            if (block.text === "<thinking>\ncodex reasoning\n</thinking>") demotedThinkingPreserved = true;
            if (block.text === "Hey!") originalAssistantTextPreserved = true;
          }
        }
      }
    }
    // No unsigned thinking blocks survive (claude API would reject them)
    expect(invalid).toEqual([]);
    expect(userTextPreserved).toBe(true);
    // Demoted thinking text and the original assistant text both survive
    expect(demotedThinkingPreserved).toBe(true);
    expect(originalAssistantTextPreserved).toBe(true);
  });

  it("drops assistant lines whose content becomes empty after stripping", () => {
    // Pi session whose assistant message contains ONLY a foreign thinking
    // block whose text is empty (codex reasoning items where summary[] was
    // empty come across as `thinking: ""`). With no recoverable text to
    // demote, the whole line should be dropped — empty-content assistant
    // messages are invalid.
    const piJsonl = [
      { type: "session", version: 3, id: "sess-1", timestamp: "2026-04-21T00:00:00.000Z", cwd: "/tmp" },
      { type: "model_change", id: "m1", parentId: null, timestamp: "2026-04-21T00:00:00.100Z", provider: "openai-codex", modelId: "gpt-5.4" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-04-21T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-04-21T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "", thinkingSignature: '{"id":"rs_z"}' }], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.4", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    const canonical = importPiSessionJsonl(piJsonl);
    const { jsonl: seed } = prepareClaudeCodeResumeSeed(canonical, "target-session-id");

    const seedObjs = seed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const assistantLines = seedObjs.filter((o) => o.type === "assistant");
    expect(assistantLines).toHaveLength(0);
  });

  it("preserves claude's own signed thinking on a pure claude round-trip", () => {
    // Pure claude round-trip: thinking has a valid signature (claude->canonical->claude).
    // The helper must keep the block untouched — the `native.raw` passthrough in
    // exportClaudeCodeJsonl already preserves the signature in this case.
    const claudeJsonl = [
      { type: "system", subtype: "init", uuid: "u0", parentUuid: null, timestamp: "2026-04-21T00:00:00.000Z", sessionId: "orig", cwd: "/tmp" },
      { type: "assistant", parentUuid: "u0", uuid: "u1", timestamp: "2026-04-21T00:00:01.000Z", sessionId: "orig", message: { role: "assistant", content: [{ type: "thinking", thinking: "real claude reasoning", signature: "sig-valid-claude" }, { type: "text", text: "answer" }] } },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    // Round-trip through the jsonl overload (claude-code jsonl in, seed jsonl out).
    const { jsonl: seed } = prepareClaudeCodeResumeSeed(claudeJsonl, "target-session-id");

    const assistantLine = seed
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .find((o) => o.type === "assistant");
    expect(assistantLine).toBeDefined();
    const thinkingBlock = assistantLine.message.content.find((b: { type: string }) => b.type === "thinking");
    expect(thinkingBlock?.signature).toBe("sig-valid-claude");
    expect(assistantLine.sessionId).toBe("target-session-id");
  });

  it("jsonl overload: demotes unsigned thinking blocks in pre-exported claude-code jsonl", () => {
    // Direct input of malformed claude-code jsonl (thinking without signature)
    // — the helper must still rewrite, without needing to go through canonical.
    // Unsigned thinking is demoted to a `<thinking>...</thinking>` text block
    // so the reasoning history survives.
    const malformedClaudeJsonl = [
      { type: "system", subtype: "init", uuid: "u0", parentUuid: null, timestamp: "2026-04-21T00:00:00.000Z", sessionId: "orig", cwd: "/tmp" },
      { type: "assistant", parentUuid: "u0", uuid: "u1", timestamp: "2026-04-21T00:00:01.000Z", sessionId: "orig", message: { role: "assistant", content: [{ type: "thinking", thinking: "no sig" }, { type: "text", text: "hi" }] } },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    const { jsonl: seed } = prepareClaudeCodeResumeSeed(malformedClaudeJsonl, "new-sess");

    const assistantLine = seed
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .find((o) => o.type === "assistant");
    // No surviving raw thinking blocks (claude API would reject unsigned ones)
    expect(assistantLine?.message.content.some((b: { type: string }) => b.type === "thinking")).toBe(false);
    // Original text and demoted thinking text both present
    expect(assistantLine?.message.content.some((b: { type: string; text?: string }) => b.type === "text" && b.text === "hi")).toBe(true);
    expect(assistantLine?.message.content.some((b: { type: string; text?: string }) => b.type === "text" && b.text === "<thinking>\nno sig\n</thinking>")).toBe(true);
  });

  it("does not export Pi tool result details as Claude tool_result structuredContent", () => {
    const piJsonl = [
      { type: "session", version: 3, id: "sess-1", timestamp: "2026-04-21T00:00:00.000Z", cwd: "/tmp" },
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-04-21T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "toolu_details_1", name: "bash", arguments: { command: "pwd" } }],
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "r1",
        parentId: "a1",
        timestamp: "2026-04-21T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "toolu_details_1",
          toolName: "bash",
          content: [{ type: "text", text: "/tmp" }],
          details: { "pi-claude-code/nativeSessionId": "native-session-from-pi" },
          isError: false,
          timestamp: 2,
        },
      },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    const { jsonl: seed } = prepareClaudeCodeResumeSeed(importPiSessionJsonl(piJsonl), "target-session-id");
    const seedObjects = seed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const toolResultLine = seedObjects.find(
      (line) =>
        line.type === "user" &&
        Array.isArray(line.message?.content) &&
        line.message.content.some((part: { type?: string }) => part?.type === "tool_result"),
    );
    const toolResultBlock = toolResultLine?.message.content.find((part: { type?: string }) => part?.type === "tool_result");

    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock.structuredContent).toBeUndefined();
    expect(JSON.stringify(toolResultBlock)).not.toContain("pi-claude-code/nativeSessionId");
  });

  it("jsonl overload: strips legacy tool_result structuredContent before Claude resume", () => {
    const malformedClaudeJsonl = [
      {
        type: "assistant",
        parentUuid: "u0",
        uuid: "u1",
        timestamp: "2026-04-21T00:00:01.000Z",
        sessionId: "orig",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_legacy_1", name: "Bash", input: { command: "pwd" } }],
        },
      },
      {
        type: "user",
        parentUuid: "u1",
        uuid: "u2",
        timestamp: "2026-04-21T00:00:02.000Z",
        sessionId: "orig",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_legacy_1",
              content: [{ type: "text", text: "/tmp" }],
              is_error: false,
              structuredContent: {
                "lossless-agent-context/toolResultDetails": {
                  "pi-claude-code/nativeSessionId": "native-session-from-pi",
                },
              },
            },
          ],
        },
      },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    const { jsonl: seed } = prepareClaudeCodeResumeSeed(malformedClaudeJsonl, "target-session-id");
    const seedObjects = seed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const toolResultLine = seedObjects.find(
      (line) =>
        line.type === "user" &&
        Array.isArray(line.message?.content) &&
        line.message.content.some((part: { type?: string }) => part?.type === "tool_result"),
    );
    const toolResultBlock = toolResultLine?.message.content.find((part: { type?: string }) => part?.type === "tool_result");

    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock.structuredContent).toBeUndefined();
  });

  it("rewrites Pi image tool results into Claude image source blocks", () => {
    const piJsonl = [
      { type: "session", version: 3, id: "sess-1", timestamp: "2026-04-21T00:00:00.000Z", cwd: "/tmp" },
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-04-21T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool_read_1", name: "read", arguments: { path: "/tmp/example.png" } }],
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "r1",
        parentId: "a1",
        timestamp: "2026-04-21T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tool_read_1",
          toolName: "read",
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", mimeType: "image/png", data: PNG_BASE64 },
          ],
          isError: false,
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "u1",
        parentId: "r1",
        timestamp: "2026-04-21T00:00:03.000Z",
        message: { role: "user", content: [{ type: "text", text: "undo it" }], timestamp: 3 },
      },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    const canonical = importPiSessionJsonl(piJsonl);
    const { jsonl: seed } = prepareClaudeCodeResumeSeed(canonical, "target-session-id");
    const seedObjects = seed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const toolResultLine = seedObjects.find(
      (line) =>
        line.type === "user" &&
        Array.isArray(line.message?.content) &&
        line.message.content.some((part: { type?: string }) => part?.type === "tool_result"),
    );

    expect(toolResultLine).toBeDefined();
    const toolResultBlock = toolResultLine.message.content.find((part: { type?: string }) => part?.type === "tool_result");
    expect(toolResultBlock?.content).toEqual([
      { type: "text", text: "Read image file [image/png]" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: PNG_BASE64,
        },
      },
    ]);
  });

  it("sanitizes cross-provider tool ids that violate claude's tool_use.id regex", () => {
    // Pi session that started with openai-codex. Codex stores toolCallIds as
    // `call_<call_id>|fc_<function_call_id>` because both are needed for
    // Responses-API replay. The `|` is fine for codex but Anthropic's API
    // rejects any tool_use.id that doesn't match `^[a-zA-Z0-9_-]+$` with
    //   messages.N.content.M.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'
    // The seed prep must rewrite both the assistant tool_use.id and the
    // matching user tool_result.tool_use_id consistently so claude still sees
    // a paired call/result.
    const codexId = "call_EBCp3MVfuIhi2nKKkcsrDBBe|fc_0fcd27f083613e7d0169eed3a44734819b913c64a9f766b62f";
    const piJsonl = [
      { type: "session", version: 3, id: "sess-1", timestamp: "2026-04-21T00:00:00.000Z", cwd: "/tmp" },
      { type: "model_change", id: "m1", parentId: null, timestamp: "2026-04-21T00:00:00.100Z", provider: "openai-codex", modelId: "gpt-5.5" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-04-21T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "read it" }], timestamp: 1 } },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-21T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: codexId, name: "read", arguments: { path: "/tmp/x.md" } }],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.5",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "r1",
        parentId: "a1",
        timestamp: "2026-04-21T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: codexId,
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
          isError: false,
          timestamp: 3,
        },
      },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    const { jsonl: seed } = prepareClaudeCodeResumeSeed(importPiSessionJsonl(piJsonl), "target-session-id");
    const seedObjects = seed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const idPattern = /^[a-zA-Z0-9_-]+$/;

    const toolUseBlocks: Array<{ id: string }> = [];
    const toolResultBlocks: Array<{ tool_use_id: string }> = [];
    for (const line of seedObjects) {
      const content = line.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "tool_use" && typeof block.id === "string") toolUseBlocks.push(block);
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string") toolResultBlocks.push(block);
      }
    }

    expect(toolUseBlocks).toHaveLength(1);
    expect(toolResultBlocks).toHaveLength(1);
    expect(idPattern.test(toolUseBlocks[0].id)).toBe(true);
    expect(idPattern.test(toolResultBlocks[0].tool_use_id)).toBe(true);
    // Pairing must survive: the rewritten ids must still match each other so
    // claude sees a complete tool_use -> tool_result cycle.
    expect(toolUseBlocks[0].id).toBe(toolResultBlocks[0].tool_use_id);
  });

  it("jsonl overload: sanitizes pre-exported claude-code jsonl tool ids that violate the regex", () => {
    // Same regex violation, but the input is already claude-code jsonl whose
    // tool_use.id slipped through (e.g. someone exported a cross-provider
    // session with Codex ids before this fix existed). The jsonl overload
    // must still sanitize so resume succeeds.
    const codexId = "call_X|fc_Y";
    const malformedClaudeJsonl = [
      { type: "system", subtype: "init", uuid: "u0", parentUuid: null, timestamp: "2026-04-21T00:00:00.000Z", sessionId: "orig", cwd: "/tmp" },
      { type: "assistant", parentUuid: "u0", uuid: "u1", timestamp: "2026-04-21T00:00:01.000Z", sessionId: "orig", message: { role: "assistant", content: [{ type: "tool_use", id: codexId, name: "Bash", input: { command: "pwd" } }] } },
      { type: "user", parentUuid: "u1", uuid: "u2", timestamp: "2026-04-21T00:00:02.000Z", sessionId: "orig", message: { role: "user", content: [{ type: "tool_result", tool_use_id: codexId, content: "/tmp", is_error: false }] } },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    const { jsonl: seed } = prepareClaudeCodeResumeSeed(malformedClaudeJsonl, "target-session-id");
    const seedObjects = seed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const idPattern = /^[a-zA-Z0-9_-]+$/;
    const toolUse = seedObjects
      .flatMap((o) => Array.isArray(o.message?.content) ? o.message.content : [])
      .find((b: { type?: string }) => b?.type === "tool_use");
    const toolResult = seedObjects
      .flatMap((o) => Array.isArray(o.message?.content) ? o.message.content : [])
      .find((b: { type?: string }) => b?.type === "tool_result");

    expect(toolUse).toBeDefined();
    expect(toolResult).toBeDefined();
    expect(idPattern.test(toolUse.id)).toBe(true);
    expect(idPattern.test(toolResult.tool_use_id)).toBe(true);
    expect(toolUse.id).toBe(toolResult.tool_use_id);
  });

  it("rewrites sessionId on every kept line", () => {
    const claudeJsonl = [
      { type: "system", subtype: "init", uuid: "u0", parentUuid: null, timestamp: "2026-04-21T00:00:00.000Z", sessionId: "old-id", cwd: "/tmp" },
      { type: "user", parentUuid: "u0", uuid: "u1", timestamp: "2026-04-21T00:00:01.000Z", sessionId: "old-id", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "assistant", parentUuid: "u1", uuid: "u2", timestamp: "2026-04-21T00:00:02.000Z", sessionId: "old-id", message: { role: "assistant", content: [{ type: "text", text: "hey" }] } },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    const { jsonl: seed } = prepareClaudeCodeResumeSeed(claudeJsonl, "brand-new-id");
    for (const line of seed.split("\n").filter((l) => l.trim())) {
      expect(JSON.parse(line).sessionId).toBe("brand-new-id");
    }
  });

});
