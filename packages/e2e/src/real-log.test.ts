import { existsSync, readFileSync } from "node:fs";
import {
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import { type CanonicalEvent, canonicalEventSchema } from "@lossless-agent-context/core";
import { buildSessionContext, parseSessionEntries, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseJsonlObjectLines } from "./jsonl";
import { detectRealLogPaths, detectRecentRealLogPaths, requireRealLogPaths } from "./runtime-detection";
import { codexNativeLine, jsonRecord } from "./sdk-schemas";

requireRealLogPaths();
const detectedPaths = detectRealLogPaths();
const recentPaths = detectRecentRealLogPaths(3);

type RealLogCase = {
  name: string;
  envVar: string;
  importer: (input: string) => CanonicalEvent[];
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

type ProviderName = RealLogCase["name"];

const exporters: Record<ProviderName, (events: CanonicalEvent[]) => string> = {
  pi: exportPiSessionJsonl,
  "claude-code": exportClaudeCodeJsonl,
  codex: exportCodexJsonl,
};

const threeHopChains: Array<{ source: ProviderName; path: ProviderName[] }> = [
  { source: "pi", path: ["claude-code", "codex", "pi"] },
  { source: "claude-code", path: ["codex", "pi", "claude-code"] },
  { source: "codex", path: ["pi", "claude-code", "codex"] },
];

function pathForCase(testCase: RealLogCase): string | undefined {
  return (
    process.env[testCase.envVar] ??
    (testCase.name === "pi"
      ? detectedPaths.pi
      : testCase.name === "claude-code"
        ? detectedPaths.claude
        : detectedPaths.codex)
  );
}

function pathsForCase(testCase: RealLogCase): string[] {
  if (process.env[testCase.envVar]) {
    const path = process.env[testCase.envVar];
    return path ? [path] : [];
  }
  return testCase.name === "pi"
    ? recentPaths.pi
    : testCase.name === "claude-code"
      ? recentPaths.claude
      : recentPaths.codex;
}

function nativeOnlyCodexLines(lines: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return lines.filter((line) => line.type !== "lac:event");
}

function findFirstUserText(events: CanonicalEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind !== "message.created" || event.payload.role !== "user") continue;
    for (const part of event.payload.parts) {
      if (part.type === "text" && part.text.trim().length > 0) return part.text;
    }
  }
  return undefined;
}

function findLastAssistantText(events: CanonicalEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.kind !== "message.created" || event.payload.role !== "assistant") continue;
    const text = event.payload.parts
      .filter((part): part is Extract<(typeof event.payload.parts)[number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

function validateNativeText(provider: ProviderName, text: string, label: string): void {
  if (provider === "pi") {
    const entries = parseSessionEntries(text);
    expect(entries.length).toBeGreaterThan(0);
    const body = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
    const context = buildSessionContext(body);
    expect(context.messages.length).toBeGreaterThan(0);
    return;
  }

  if (provider === "codex") {
    const lines = nativeOnlyCodexLines(parseJsonlObjectLines(text).map((line) => jsonRecord.parse(line)));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const result = codexNativeLine.safeParse(line);
      expect(
        result.success,
        result.success ? undefined : `real-log ${label} codex line failed schema: ${JSON.stringify(line)}`,
      ).toBe(true);
    }
    return;
  }

  const lines = parseJsonlObjectLines(text)
    .map((line) => jsonRecord.parse(line))
    .filter((line) => line.type !== "lac:event");
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(["system", "user", "assistant", "last-prompt"]).toContain(String(line.type));
    expect(typeof line.sessionId).toBe("string");
    if (line.type !== "last-prompt") expect(typeof line.timestamp).toBe("string");
  }
}

describe("real local log e2e", () => {
  for (const testCase of realLogCases) {
    it(`parses a real ${testCase.name} session log when configured`, () => {
      const path = pathForCase(testCase);
      expect(path, `${testCase.envVar} must be set`).toBeTruthy();
      expect(existsSync(path as string), `${path} must exist`).toBe(true);

      const text = readFileSync(path as string, "utf8");
      const events = canonicalEventSchema.array().parse(testCase.importer(text));

      expect(events.length).toBeGreaterThan(0);
      expect(events[0]?.kind).toBe("session.created");
    });

    it(`parses up to three recent real ${testCase.name} session logs when auto-discovered`, () => {
      const paths = pathsForCase(testCase);
      expect(paths.length, `expected at least one recent ${testCase.name} session log`).toBeGreaterThan(0);

      for (const path of paths) {
        expect(existsSync(path), `${path} must exist`).toBe(true);
        const text = readFileSync(path, "utf8");
        const events = canonicalEventSchema.array().parse(testCase.importer(text));
        expect(events.length, `expected parsed events for ${path}`).toBeGreaterThan(0);
        expect(events[0]?.kind, `expected session.created first for ${path}`).toBe("session.created");
      }
    });
  }

  for (const chain of threeHopChains) {
    it(`up to three recent real ${chain.source} logs survive ${chain.source} -> ${chain.path.join(" -> ")} with target-native validation at each hop`, async () => {
      const sourceCase = realLogCases.find((testCase) => testCase.name === chain.source);
      if (!sourceCase) throw new Error(`missing real log case for ${chain.source}`);

      const paths = pathsForCase(sourceCase);
      expect(paths.length, `expected at least one recent ${chain.source} session log`).toBeGreaterThan(0);

      for (const [index, path] of paths.entries()) {
        expect(existsSync(path), `${path} must exist`).toBe(true);

        const originalText = readFileSync(path, "utf8");
        const original = canonicalEventSchema.array().parse(sourceCase.importer(originalText));
        let canonical = original;

        for (const target of chain.path) {
          const exported = exporters[target](canonical);
          await validateNativeText(target, exported, `${chain.source}-${index + 1}-to-${target}`);
          const importer = realLogCases.find((testCase) => testCase.name === target)?.importer;
          if (!importer) throw new Error(`missing importer for ${target}`);
          canonical = canonicalEventSchema.array().parse(importer(exported));
          for (const event of canonical) expect(event.native?.source).toBe(chain.source);
        }

        const originalUser = findFirstUserText(original);
        const finalUser = findFirstUserText(canonical);
        if (originalUser !== undefined) expect(finalUser).toBe(originalUser);

        const originalAssistant = findLastAssistantText(original);
        const finalAssistant = findLastAssistantText(canonical);
        if (originalAssistant !== undefined) expect(finalAssistant).toBe(originalAssistant);
      }
    });
  }
});
