import {
  emptySidecar,
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";
import { parseJsonlObjectLines } from "../jsonl";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("edge case: citations and cache markers", () => {
  it("codex output_text annotations import as first-class citations and survive codex → claude → codex", () => {
    const input = `${JSON.stringify({
      timestamp: "2026-04-15T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "codex-citations-1",
        timestamp: "2026-04-15T12:00:00.000Z",
        cwd: "/tmp",
        model_provider: "openai",
      },
    })}\n${JSON.stringify({
      timestamp: "2026-04-15T12:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "See source A.",
            annotations: [
              {
                type: "url_citation",
                url: "https://example.com/a",
                title: "Source A",
                start_index: 4,
                end_index: 12,
              },
            ],
          },
        ],
      },
    })}\n`;

    const canonical1 = importCodexJsonl(input);
    const assistant = canonical1.find(
      (event): event is Extract<(typeof canonical1)[number], { kind: "message.created" }> =>
        event.kind === "message.created" && event.payload.role === "assistant",
    );
    const textPart = assistant?.payload.parts[0];
    expect(textPart?.type).toBe("text");
    if (textPart?.type !== "text") throw new Error("type narrowing");
    expect(textPart.citations).toEqual([
      {
        type: "url_citation",
        url: "https://example.com/a",
        title: "Source A",
        startIndex: 4,
        endIndex: 12,
      },
    ]);

    const claudeText = exportClaudeCodeJsonl(canonical1);
    const canonical2 = importClaudeCodeJsonl(claudeText, emptySidecar());
    const codexText = exportCodexJsonl(canonical2);
    const codexLines = parseJsonlObjectLines(codexText);
    const assistantLine = codexLines.find(
      (line) =>
        line.type === "response_item" &&
        (line.payload as Record<string, unknown> | undefined)?.type === "message" &&
        (line.payload as Record<string, unknown> | undefined)?.role === "assistant",
    );
    const content = Array.isArray((assistantLine?.payload as Record<string, unknown> | undefined)?.content)
      ? ((assistantLine?.payload as Record<string, unknown>).content as Array<Record<string, unknown>>)
      : [];
    expect(content[0]).toEqual({
      type: "output_text",
      text: "See source A.",
      annotations: [
        {
          type: "url_citation",
          url: "https://example.com/a",
          title: "Source A",
          start_index: 4,
          end_index: 12,
        },
      ],
    });
  });

  it("assistant cache markers survive claude → pi → claude", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-15T12:00:00.000Z",
      sessionId: "claude-cache-1",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-cache-1",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Checking cache markers." },
          { type: "text", text: "Cache info attached." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
        ],
        usage: {
          input_tokens: 3,
          output_tokens: 5,
          cache_read_input_tokens: 21,
          cache_creation_input_tokens: 34,
          cache_creation: { ephemeral_1h_input_tokens: 34 },
        },
      },
    })}\n`;

    const canonical1 = importClaudeCodeJsonl(input, emptySidecar());
    const piText = exportPiSessionJsonl(canonical1);
    const canonical2 = importPiSessionJsonl(piText);
    const claudeText = exportClaudeCodeJsonl(canonical2);
    const final = importClaudeCodeJsonl(claudeText, emptySidecar());
    const cached = final.find((event) => event.cache?.readTokens === 21 && event.cache?.writeTokens === 34);
    expect(cached).toBeDefined();
    expect(cached?.cache?.details).toEqual({ cache_creation: { ephemeral_1h_input_tokens: 34 } });
  });
});
