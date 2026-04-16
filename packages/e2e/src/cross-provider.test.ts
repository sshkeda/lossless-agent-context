import { readFileSync } from "node:fs";
import { join } from "node:path";
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

type Provider = {
  name: string;
  fixtureFile: string;
  importToCanonical: (input: string) => CanonicalEvent[];
  exportFromCanonical: (events: CanonicalEvent[]) => string;
};

const providers: Provider[] = [
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

const crossPairs: { source: Provider; target: Provider }[] = [];
for (const source of providers) {
  for (const target of providers) {
    if (source.name === target.name) continue;
    crossPairs.push({ source, target });
  }
}

describe("cross-provider e2e (source -> target -> source roundtrip)", () => {
  for (const { source, target } of crossPairs) {
    it(`${source.name} -> ${target.name} -> ${source.name} preserves the original ${source.name} JSONL`, () => {
      const originalText = fixture(source.fixtureFile);

      const canonicalA = source.importToCanonical(originalText);
      const targetText = target.exportFromCanonical(canonicalA);

      const canonicalB = target.importToCanonical(targetText);
      const reExported = source.exportFromCanonical(canonicalB);

      expect(parseJsonlLines(reExported)).toEqual(parseJsonlLines(originalText));
    });

    it(`${source.name} -> ${target.name} carries the foreign source on every line via envelope or sidecar`, () => {
      const originalText = fixture(source.fixtureFile);
      const canonicalA = source.importToCanonical(originalText);
      const targetText = target.exportFromCanonical(canonicalA);
      const targetLines = parseJsonlLines(targetText) as Array<Record<string, unknown>>;

      expect(targetLines.length).toBeGreaterThan(0);
      for (const line of targetLines) {
        const foreign = line.__lac_foreign as { source?: string; raw?: unknown } | undefined;
        expect(foreign).toBeDefined();
        expect(foreign?.source).toBe(source.name);
        expect(foreign?.raw).toBeDefined();
      }

      const canonicalB = target.importToCanonical(targetText);
      for (const event of canonicalB) {
        expect(event.native?.source).toBe(source.name);
      }
    });
  }
});

function permutationsOf3<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (const a of items) {
    for (const b of items) {
      if (b === a) continue;
      for (const c of items) {
        if (c === a || c === b) continue;
        result.push([a, b, c]);
      }
    }
  }
  return result;
}

describe("pi -> claude-code semantic exporter (real Claude line shapes)", () => {
  it("emits real Claude line types (system/user/assistant), never the lac:foreign wrapper type", () => {
    const piText = fixture("pi.jsonl");
    const canonical = importPiSessionJsonl(piText);
    const claudeText = exportClaudeCodeJsonl(canonical);
    const claudeLines = parseJsonlLines(claudeText) as Array<Record<string, unknown>>;

    expect(claudeLines.length).toBeGreaterThan(0);
    const allowedTypes = new Set(["system", "user", "assistant"]);
    for (const line of claudeLines) {
      expect(typeof line.type).toBe("string");
      expect(allowedTypes.has(String(line.type))).toBe(true);
      expect(line.type).not.toBe("lac:foreign");
    }
  });

  it("attaches a uuid, parentUuid chain, and sessionId to every emitted Claude line", () => {
    const piText = fixture("pi.jsonl");
    const canonical = importPiSessionJsonl(piText);
    const claudeText = exportClaudeCodeJsonl(canonical);
    const claudeLines = parseJsonlLines(claudeText) as Array<Record<string, unknown>>;

    let previousUuid: string | null = null;
    for (const line of claudeLines) {
      expect(typeof line.uuid).toBe("string");
      expect(typeof line.sessionId).toBe("string");
      expect(line.parentUuid).toBe(previousUuid);
      previousUuid = String(line.uuid);
    }
  });
});

describe("multi-hop chain e2e (visit every provider, return home)", () => {
  for (const chain of permutationsOf3(providers)) {
    const [start, mid, end] = chain;
    if (!start || !mid || !end) continue;
    const chainLabel = `${start.name} -> ${mid.name} -> ${end.name} -> ${start.name}`;

    it(`${chainLabel} preserves the original ${start.name} JSONL`, () => {
      const originalText = fixture(start.fixtureFile);

      const canonical1 = start.importToCanonical(originalText);
      const midText = mid.exportFromCanonical(canonical1);

      const canonical2 = mid.importToCanonical(midText);
      const endText = end.exportFromCanonical(canonical2);

      const canonical3 = end.importToCanonical(endText);
      const finalText = start.exportFromCanonical(canonical3);

      expect(parseJsonlLines(finalText)).toEqual(parseJsonlLines(originalText));
    });

    it(`${chainLabel} keeps native.source pinned to the original at every hop`, () => {
      const originalText = fixture(start.fixtureFile);

      const canonical1 = start.importToCanonical(originalText);
      const canonical2 = mid.importToCanonical(mid.exportFromCanonical(canonical1));
      const canonical3 = end.importToCanonical(end.exportFromCanonical(canonical2));

      for (const event of canonical1) expect(event.native?.source).toBe(start.name);
      for (const event of canonical2) expect(event.native?.source).toBe(start.name);
      for (const event of canonical3) expect(event.native?.source).toBe(start.name);
    });
  }
});
