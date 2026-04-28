import {
  exportClaudeCodeJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importPiSessionJsonl,
  prepareClaudeCodeResumeSeed,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";

const TOOL_PROVENANCE_KEY = "pi-claude-code/toolProvenance";

describe("pi claude-code Bash provenance", () => {
  it("keeps Pi-native display while preserving Claude Bash timeout-ms semantics", () => {
    const piJsonl = `${[
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-28T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "toolu_watch_1",
              name: "bash",
              arguments: { command: "gh pr checks 23 --watch 2>&1", timeout: 600000 },
            },
          ],
          details: {
            [TOOL_PROVENANCE_KEY]: {
              toolu_watch_1: {
                sourceExecutor: "claude-code",
                sourceToolName: "Bash",
                projectedToolName: "bash",
                argumentSemantics: {
                  timeout: { unit: "ms", value: 600000, sourceField: "timeout" },
                },
              },
            },
          },
        },
      }),
    ].join("\n")}\n`;

    const canonical = importPiSessionJsonl(piJsonl);
    const toolCall = canonical.find((event) => event.kind === "tool.call");
    expect(toolCall?.payload.name).toBe("bash");
    expect(toolCall?.payload.arguments).toEqual({ command: "gh pr checks 23 --watch 2>&1", timeout: 600000 });
    expect(toolCall?.extensions?.[TOOL_PROVENANCE_KEY]).toEqual({
      sourceExecutor: "claude-code",
      sourceToolName: "Bash",
      projectedToolName: "bash",
      argumentSemantics: {
        timeout: { unit: "ms", value: 600000, sourceField: "timeout" },
      },
    });

    const piRoundTrip = exportPiSessionJsonl(canonical);
    const piRoundTripLine = piRoundTrip
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((line) => line.type === "message");
    expect(piRoundTripLine.message.content[0]).toEqual({
      type: "toolCall",
      id: "toolu_watch_1",
      name: "bash",
      arguments: { command: "gh pr checks 23 --watch 2>&1", timeout: 600000 },
    });
    expect(piRoundTripLine.message.details[TOOL_PROVENANCE_KEY].toolu_watch_1.sourceToolName).toBe("Bash");

    const claudeJsonl = exportClaudeCodeJsonl(canonical);
    const claudeLine = claudeJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((line) => line.type === "assistant");
    expect(claudeLine.message.content[0]).toEqual({
      type: "tool_use",
      id: "toolu_watch_1",
      name: "Bash",
      input: { command: "gh pr checks 23 --watch 2>&1", timeout: 600000 },
    });

    const prepared = prepareClaudeCodeResumeSeed(canonical, "target-session");
    const seedLine = prepared.jsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((line) => line.type === "assistant");
    expect(seedLine.message.content[0].input.timeout).toBe(600000);
    expect(seedLine.__lac_foreign).toBeUndefined();
    expect(seedLine.__lac_canonical).toBeUndefined();
    expect(prepared.sidecar.byLineUuid[seedLine.uuid]?.canonicalOverrides).toBeDefined();

    const canonicalFromSeed = importClaudeCodeJsonl(prepared.jsonl, prepared.sidecar);
    const seedToolCall = canonicalFromSeed.find((event) => event.kind === "tool.call");
    expect(seedToolCall?.extensions?.[TOOL_PROVENANCE_KEY]).toEqual({
      sourceExecutor: "claude-code",
      sourceToolName: "Bash",
      projectedToolName: "bash",
      argumentSemantics: {
        timeout: { unit: "ms", value: 600000, sourceField: "timeout" },
      },
    });
  });
});
