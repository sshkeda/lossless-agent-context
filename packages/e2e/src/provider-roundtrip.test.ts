import {
  emptySidecar,
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";
import { readFixture } from "./fixtures";
import { parseJsonlLines } from "./jsonl";

type RoundtripCase = {
  name: string;
  fixtureFile: string;
  importToCanonical: (input: string) => CanonicalEvent[];
  exportFromCanonical: (events: CanonicalEvent[]) => string;
};

const roundtripCases: RoundtripCase[] = [
  {
    name: "pi",
    fixtureFile: "pi.jsonl",
    importToCanonical: importPiSessionJsonl,
    exportFromCanonical: exportPiSessionJsonl,
  },
  {
    name: "claude-code",
    fixtureFile: "claude-code.jsonl",
    importToCanonical: (input) => importClaudeCodeJsonl(input, emptySidecar()),
    exportFromCanonical: exportClaudeCodeJsonl,
  },
  {
    name: "codex",
    fixtureFile: "codex.jsonl",
    importToCanonical: importCodexJsonl,
    exportFromCanonical: exportCodexJsonl,
  },
];

describe("provider-roundtrip e2e (native -> canonical -> native)", () => {
  it("preserves duplicate native Pi lines as separate physical JSONL records", () => {
    const session = JSON.stringify({
      type: "session",
      version: 3,
      id: "dup-session",
      timestamp: "2026-04-28T19:36:39.845Z",
      cwd: "/tmp/example",
    });
    const sourceText = `${session}\n${session}\n${JSON.stringify({
      type: "model_change",
      id: "m1",
      parentId: null,
      timestamp: "2026-04-28T19:36:40.000Z",
      provider: "openai-codex",
      modelId: "gpt-5.5",
    })}\n`;

    expect(exportPiSessionJsonl(importPiSessionJsonl(sourceText))).toBe(sourceText);
  });

  it("preserves raw JSONL line whitespace and CRLF when replaying native-backed lines", () => {
    const sourceText = `  {"timestamp":"2026-03-23T13:37:28.689Z","type":"session_meta","payload":{"id":"codex-session-1","timestamp":"2026-03-23T13:19:01.660Z","cwd":"/tmp/lossless-agent-context","model_provider":"openai"}}  \r\n\t{"timestamp":"2026-03-23T13:37:28.692Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}\r\n`;
    const exported = exportCodexJsonl(importCodexJsonl(sourceText));

    expect(exported).toBe(sourceText);
  });

  for (const testCase of roundtripCases) {
    it(`${testCase.name} JSONL roundtrips losslessly`, () => {
      const sourceText = readFixture(testCase.fixtureFile);
      const events = testCase.importToCanonical(sourceText);
      const exported = testCase.exportFromCanonical(events);

      const sourceLines = parseJsonlLines(sourceText);
      const exportedLines = parseJsonlLines(exported);

      expect(exportedLines).toEqual(sourceLines);
    });

    it(`${testCase.name} double roundtrip is stable`, () => {
      const sourceText = readFixture(testCase.fixtureFile);
      const firstEvents = testCase.importToCanonical(sourceText);
      const firstExport = testCase.exportFromCanonical(firstEvents);
      const secondEvents = testCase.importToCanonical(firstExport);
      const secondExport = testCase.exportFromCanonical(secondEvents);

      expect(secondExport).toEqual(firstExport);
    });
  }
});
