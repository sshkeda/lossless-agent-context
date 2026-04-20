import {
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";
import { readFixture } from "./fixtures";
import { parseJsonlObjectLines } from "./jsonl";

describe("deterministic export", () => {
  it("claude exporter is byte-stable for the same pi canonical timeline", () => {
    const canonical = importPiSessionJsonl(readFixture("pi.jsonl"));
    const first = exportClaudeCodeJsonl(canonical);
    const second = exportClaudeCodeJsonl(canonical);
    expect(second).toBe(first);
  });

  it("pi exporter is byte-stable for the same claude canonical timeline", () => {
    const canonical = importClaudeCodeJsonl(readFixture("claude-code.jsonl"));
    const first = exportPiSessionJsonl(canonical);
    const second = exportPiSessionJsonl(canonical);
    expect(second).toBe(first);
  });

  it("same-provider codex export remains byte-stable", () => {
    const canonical = importCodexJsonl(readFixture("codex.jsonl"));
    const first = exportCodexJsonl(canonical);
    const second = exportCodexJsonl(canonical);
    expect(second).toBe(first);
  });

  it("cross-provider Claude export preserves its generated uuid chain across a codex detour", () => {
    const canonical = importPiSessionJsonl(readFixture("pi.jsonl"));

    const firstClaude = exportClaudeCodeJsonl(canonical);
    const viaClaude = importClaudeCodeJsonl(firstClaude);
    const codex = exportCodexJsonl(viaClaude);
    const viaCodex = importCodexJsonl(codex);
    const secondClaude = exportClaudeCodeJsonl(viaCodex);

    const firstLines = parseJsonlObjectLines(firstClaude);
    const secondLines = parseJsonlObjectLines(secondClaude);

    expect(
      secondLines.map((line) => ({
        type: line.type,
        subtype: line.subtype,
        uuid: line.uuid,
        parentUuid: line.parentUuid,
      })),
    ).toEqual(
      firstLines.map((line) => ({
        type: line.type,
        subtype: line.subtype,
        uuid: line.uuid,
        parentUuid: line.parentUuid,
      })),
    );
  });
});
