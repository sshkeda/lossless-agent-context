import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importClaudeCodeJsonl, importCodexJsonl, importPiSessionJsonl } from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";

type JsonlImporterCase = {
  name: string;
  fixtureFile: string;
  importToCanonical: (input: string) => CanonicalEvent[];
};

const jsonlImporterCases: JsonlImporterCase[] = [
  { name: "pi", fixtureFile: "pi.jsonl", importToCanonical: importPiSessionJsonl },
  { name: "claude-code", fixtureFile: "claude-code.jsonl", importToCanonical: importClaudeCodeJsonl },
  { name: "codex", fixtureFile: "codex.jsonl", importToCanonical: importCodexJsonl },
];

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "fixtures", name), "utf8");
}

function parseJsonlLines(text: string): unknown[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("importer lossless coverage (regression guard)", () => {
  for (const testCase of jsonlImporterCases) {
    it(`every canonical event from ${testCase.name} carries native.raw`, () => {
      const events = testCase.importToCanonical(fixture(testCase.fixtureFile));
      for (const event of events) {
        expect(event.native, `event ${event.eventId} missing native ref`).toBeDefined();
        expect(event.native?.source, `event ${event.eventId} missing native.source`).toBeTruthy();
        expect(event.native?.raw, `event ${event.eventId} missing native.raw`).toBeDefined();
      }
    });

    it(`every source line from ${testCase.name} is referenced by at least one canonical event`, () => {
      const sourceLines = parseJsonlLines(fixture(testCase.fixtureFile));
      const events = testCase.importToCanonical(fixture(testCase.fixtureFile));
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
