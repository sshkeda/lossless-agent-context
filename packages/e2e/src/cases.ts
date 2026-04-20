import { importClaudeCodeJsonl, importCodexJsonl, importPiSessionJsonl } from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";

export type FixtureKind = "jsonl" | "json";

export type ConversionCase = {
  name: string;
  fixtureFile: string;
  fixtureKind: FixtureKind;
  importToCanonical: (input: string) => CanonicalEvent[];
};

export const conversionCases: ConversionCase[] = [
  {
    name: "pi",
    fixtureFile: "pi.jsonl",
    fixtureKind: "jsonl",
    importToCanonical: importPiSessionJsonl,
  },
  {
    name: "claude-code",
    fixtureFile: "claude-code.jsonl",
    fixtureKind: "jsonl",
    importToCanonical: importClaudeCodeJsonl,
  },
  {
    name: "codex",
    fixtureFile: "codex.jsonl",
    fixtureKind: "jsonl",
    importToCanonical: importCodexJsonl,
  },
];
