import {
  emptySidecar,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";
import { readFixture } from "./fixtures";
import { parseJsonlObjectLines } from "./jsonl";
import { codexEventMsgLine, codexSessionMetaLine, jsonRecord } from "./sdk-schemas";

describe("resume compatibility", () => {
  it("codex export emits minimal session metadata plus a thread registration event for resume", () => {
    const canonical = importClaudeCodeJsonl(readFixture("claude-code.jsonl"), emptySidecar());
    const text = exportCodexJsonl(canonical);
    const lines = parseJsonlObjectLines(text).map((line) => jsonRecord.parse(line));

    const meta = codexSessionMetaLine.parse(lines[0]);
    expect(meta.payload.id).toBe("claude-session-1");
    expect(meta.payload.originator).toBeUndefined();
    expect(meta.payload.cli_version).toBeUndefined();
    expect(meta.payload.source).toBeUndefined();
    expect(meta.payload.model_provider).toBeUndefined();

    const threadLine = lines.find((line) => {
      const parsed = codexEventMsgLine.safeParse(line);
      return (
        parsed.success &&
        parsed.data.payload.type === "thread_name_updated" &&
        parsed.data.payload.thread_id === "claude-session-1"
      );
    });
    expect(threadLine).toBeDefined();
    const payload = (threadLine as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.thread_name).toBe("claude-session-1");
  });

  it("pi export emits non-null assistant usage objects without fabricating zero-valued counters", () => {
    const canonical = importCodexJsonl(readFixture("codex.jsonl"));
    const text = exportPiSessionJsonl(canonical);
    const lines = parseJsonlObjectLines(text).map((line) => jsonRecord.parse(line));

    const assistantLines = lines.filter(
      (line) => line.type === "message" && (line.message as Record<string, unknown> | undefined)?.role === "assistant",
    );
    expect(assistantLines.length).toBeGreaterThan(0);

    for (const line of assistantLines) {
      const usage = ((line.message as Record<string, unknown>).usage ?? null) as Record<string, unknown> | null;
      expect(usage).not.toBeNull();
      expect(usage).toEqual({});
    }
  });
});
