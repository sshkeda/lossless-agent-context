import {
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
    importToCanonical: importClaudeCodeJsonl,
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
