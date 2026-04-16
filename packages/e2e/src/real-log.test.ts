import { existsSync, readFileSync } from "node:fs";
import { importClaudeCodeJsonl, importCodexJsonl, importPiSessionJsonl } from "@lossless-agent-context/adapters";
import { canonicalEventSchema } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";

const enabled = process.env.LAC_ENABLE_REAL_LOG_E2E === "1";

type RealLogCase = {
  name: string;
  envVar: string;
  importer: (input: string) => unknown;
};

const realLogCases: RealLogCase[] = [
  {
    name: "pi",
    envVar: "LAC_REAL_PI_SESSION",
    importer: importPiSessionJsonl,
  },
  {
    name: "claude-code",
    envVar: "LAC_REAL_CLAUDE_SESSION",
    importer: importClaudeCodeJsonl,
  },
  {
    name: "codex",
    envVar: "LAC_REAL_CODEX_SESSION",
    importer: importCodexJsonl,
  },
];

describe("real local log e2e", () => {
  for (const testCase of realLogCases) {
    const run = enabled ? it : it.skip;

    run(`parses a real ${testCase.name} session log when configured`, () => {
      const path = process.env[testCase.envVar];
      expect(path, `${testCase.envVar} must be set`).toBeTruthy();
      expect(existsSync(path as string), `${path} must exist`).toBe(true);

      const text = readFileSync(path as string, "utf8");
      const events = canonicalEventSchema.array().parse(testCase.importer(text));

      expect(events.length).toBeGreaterThan(0);
      expect(events[0]?.kind).toBe("session.created");
    });
  }
});
