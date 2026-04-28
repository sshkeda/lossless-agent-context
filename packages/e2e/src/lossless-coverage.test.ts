import {
  emptySidecar,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";
import { readFixture } from "./fixtures";
import { parseJsonlLines } from "./jsonl";

type JsonlImporterCase = {
  name: string;
  fixtureFile: string;
  importToCanonical: (input: string) => CanonicalEvent[];
};

const jsonlImporterCases: JsonlImporterCase[] = [
  { name: "pi", fixtureFile: "pi.jsonl", importToCanonical: importPiSessionJsonl },
  {
    name: "claude-code",
    fixtureFile: "claude-code.jsonl",
    importToCanonical: (input) => importClaudeCodeJsonl(input, emptySidecar()),
  },
  { name: "codex", fixtureFile: "codex.jsonl", importToCanonical: importCodexJsonl },
];

describe("importer lossless coverage (regression guard)", () => {
  for (const testCase of jsonlImporterCases) {
    it(`every canonical event from ${testCase.name} carries native.raw`, () => {
      const events = testCase.importToCanonical(readFixture(testCase.fixtureFile));
      for (const event of events) {
        expect(event.native, `event ${event.eventId} missing native ref`).toBeDefined();
        expect(event.native?.source, `event ${event.eventId} missing native.source`).toBeTruthy();
        expect(event.native?.raw, `event ${event.eventId} missing native.raw`).toBeDefined();
      }
    });

    it(`every source line from ${testCase.name} is referenced by at least one canonical event`, () => {
      const sourceLines = parseJsonlLines(readFixture(testCase.fixtureFile));
      const events = testCase.importToCanonical(readFixture(testCase.fixtureFile));
      const referencedRaws = new Set<string>();

      for (const event of events) {
        if (event.native?.raw === undefined) continue;
        referencedRaws.add(JSON.stringify(event.native.raw));
      }

      for (const [index, line] of sourceLines.entries()) {
        const serialized = JSON.stringify(line);
        expect(
          referencedRaws.has(serialized),
          `source line ${index} from ${testCase.fixtureFile} not referenced by any canonical event`,
        ).toBe(true);
      }
    });
  }
});
