import { describe, expect, it } from "vitest";
import { scanClaudeCodeJsonl } from "./scan-claude-code-jsonl";

describe("scanClaudeCodeJsonl", () => {
  it("extracts usage samples and native compaction metadata", () => {
    const text = [
      JSON.stringify({
        type: "assistant",
        uuid: "usage-1",
        timestamp: "2026-04-29T00:00:00.000Z",
        message: {
          id: "msg-usage-1",
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 4,
          },
        },
      }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-04-29T00:00:01.000Z",
        compactMetadata: { tokensBefore: 12345 },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "compact-1",
        timestamp: "2026-04-29T00:00:02.000Z",
        isCompactSummary: true,
        message: {
          id: "msg-compact-1",
          role: "assistant",
          content: [{ type: "text", text: "native summary" }],
        },
      }),
    ].join("\n");

    const scan = scanClaudeCodeJsonl(text, { sourceId: "/tmp/native.jsonl" });

    expect(scan.usageSamples).toEqual([
      {
        input: 1,
        cacheWrite: 2,
        cacheRead: 3,
        output: 4,
        timestamp: "2026-04-29T00:00:00.000Z",
        nativeId: "usage-1",
      },
    ]);
    expect(scan.nativeCompactions).toHaveLength(1);
    const [compaction] = scan.nativeCompactions;
    expect(compaction).toBeDefined();
    expect(compaction).toMatchObject({
      summary: "native summary",
      tokensBefore: 12345,
      nativeId: "compact-1",
      timestamp: "2026-04-29T00:00:02.000Z",
      boundaryTimestamp: "2026-04-29T00:00:01.000Z",
    });
    expect(compaction?.key).toMatch(/^claude-code-native-compaction:/);
  });

  it("does not create compaction metadata from a boundary without a summary", () => {
    const text = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      timestamp: "2026-04-29T00:00:01.000Z",
      compactMetadata: { tokensBefore: 12345 },
    });

    expect(scanClaudeCodeJsonl(text).nativeCompactions).toEqual([]);
  });
});
