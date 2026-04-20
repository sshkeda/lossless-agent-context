import {
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
  inspectShadowAlignmentStrategy,
} from "@lossless-agent-context/adapters";
import { type CanonicalEvent, canonicalEventSchema } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";
import { readFixture } from "./fixtures";
import { parseJsonlLines, parseJsonlObjectLines } from "./jsonl";

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
      const originalText = readFixture(source.fixtureFile);

      const canonicalA = source.importToCanonical(originalText);
      const targetText = target.exportFromCanonical(canonicalA);

      const canonicalB = target.importToCanonical(targetText);
      const reExported = source.exportFromCanonical(canonicalB);

      expect(parseJsonlLines(reExported)).toEqual(parseJsonlLines(originalText));
    });

    it(`${source.name} -> ${target.name} carries the foreign source on every line via envelope or sidecar`, () => {
      const originalText = readFixture(source.fixtureFile);
      const canonicalA = source.importToCanonical(originalText);
      const targetText = target.exportFromCanonical(canonicalA);
      const targetLines = parseJsonlObjectLines(targetText);

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

function buildRevisitingChains<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (const start of items) {
    for (const hopA of items) {
      if (hopA === start) continue;
      for (const hopB of items) {
        if (hopB === start || hopB === hopA) continue;
        result.push([start, hopA, hopB, hopA, start]);
        result.push([start, hopA, hopB, hopA, hopB, start]);
      }
    }
  }
  return result;
}

function runChain(chain: Provider[], originalText: string): string {
  const first = chain[0];
  if (!first) throw new Error("chain must include at least one provider");
  let canonical = first.importToCanonical(originalText);
  for (let index = 1; index < chain.length; index++) {
    const target = chain[index];
    if (!target) throw new Error(`missing provider at chain index ${index}`);
    const text = target.exportFromCanonical(canonical);
    if (index === chain.length - 1) return text;
    canonical = target.importToCanonical(text);
  }
  throw new Error("chain must include at least two providers");
}

function canonicalAtEachHop(chain: Provider[], originalText: string): CanonicalEvent[][] {
  const snapshots: CanonicalEvent[][] = [];
  const first = chain[0];
  if (!first) throw new Error("chain must include at least one provider");
  let canonical = first.importToCanonical(originalText);
  snapshots.push(canonical);
  for (let index = 1; index < chain.length - 1; index++) {
    const target = chain[index];
    if (!target) throw new Error(`missing provider at chain index ${index}`);
    canonical = target.importToCanonical(target.exportFromCanonical(canonical));
    snapshots.push(canonical);
  }
  return snapshots;
}

describe("pi -> claude-code semantic exporter (real Claude line shapes)", () => {
  it("emits real Claude line types (system/user/assistant), never the lac:foreign wrapper type", () => {
    const piText = readFixture("pi.jsonl");
    const canonical = importPiSessionJsonl(piText);
    const claudeText = exportClaudeCodeJsonl(canonical);
    const claudeLines = parseJsonlObjectLines(claudeText);

    expect(claudeLines.length).toBeGreaterThan(0);
    const allowedTypes = new Set(["system", "user", "assistant"]);
    for (const line of claudeLines) {
      expect(typeof line.type).toBe("string");
      expect(allowedTypes.has(String(line.type))).toBe(true);
      expect(line.type).not.toBe("lac:foreign");
    }
  });

  it("attaches a uuid, parentUuid chain, and sessionId to every emitted Claude line", () => {
    const piText = readFixture("pi.jsonl");
    const canonical = importPiSessionJsonl(piText);
    const claudeText = exportClaudeCodeJsonl(canonical);
    const claudeLines = parseJsonlObjectLines(claudeText);

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
      const originalText = readFixture(start.fixtureFile);

      const canonical1 = start.importToCanonical(originalText);
      const midText = mid.exportFromCanonical(canonical1);

      const canonical2 = mid.importToCanonical(midText);
      const endText = end.exportFromCanonical(canonical2);

      const canonical3 = end.importToCanonical(endText);
      const finalText = start.exportFromCanonical(canonical3);

      expect(parseJsonlLines(finalText)).toEqual(parseJsonlLines(originalText));
    });

    it(`${chainLabel} keeps native.source pinned to the original at every hop`, () => {
      const originalText = readFixture(start.fixtureFile);

      const canonical1 = start.importToCanonical(originalText);
      const canonical2 = mid.importToCanonical(mid.exportFromCanonical(canonical1));
      const canonical3 = end.importToCanonical(end.exportFromCanonical(canonical2));

      for (const event of canonical1) expect(event.native?.source).toBe(start.name);
      for (const event of canonical2) expect(event.native?.source).toBe(start.name);
      for (const event of canonical3) expect(event.native?.source).toBe(start.name);
    });
  }
});

describe("same-provider override alignment", () => {
  it("uses rawRef matching when native-backed events have unique rawRef values", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-15T12:00:00.000Z",
      sessionId: "claude-align-rawref",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-align-rawref",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    })}\n`;

    const events = importClaudeCodeJsonl(input).filter((event) => event.kind !== "session.created");
    const shadow = importClaudeCodeJsonl(input).filter((event) => event.kind !== "session.created");

    expect(inspectShadowAlignmentStrategy(events, shadow)).toBe("rawRef");
  });

  it("uses sequential matching when rawRef values are unavailable but importer order still matches", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-15T12:00:00.000Z",
      sessionId: "claude-align-seq",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-align-seq",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.txt" } },
        ],
      },
    })}\n`;

    const stripRawRefs = (events: CanonicalEvent[]) =>
      events
        .filter((event) => event.kind !== "session.created")
        .map((event) =>
          canonicalEventSchema.parse({
            ...event,
            native: event.native ? { ...event.native, rawRef: undefined } : event.native,
          }),
        );

    const events = stripRawRefs(importClaudeCodeJsonl(input));
    const shadow = stripRawRefs(importClaudeCodeJsonl(input));

    expect(inspectShadowAlignmentStrategy(events, shadow)).toBe("sequential");
  });

  it("uses same-kind bucket fallback only when rawRef and sequential alignment are unavailable", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-15T12:00:00.000Z",
      sessionId: "claude-align-bucket",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-align-bucket",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.txt" } },
          { type: "tool_use", id: "call_2", name: "Read", input: { file_path: "b.txt" } },
        ],
      },
    })}\n`;

    const base = importClaudeCodeJsonl(input)
      .filter((event) => event.kind !== "session.created")
      .map((event) =>
        canonicalEventSchema.parse({
          ...event,
          native: event.native ? { ...event.native, rawRef: undefined } : event.native,
        }),
      );
    const extra = base.find(
      (event): event is Extract<CanonicalEvent, { kind: "tool.call" }> =>
        event.kind === "tool.call" && event.payload.toolCallId === "call_2",
    );
    if (!extra) throw new Error("missing second tool.call");
    const events = [
      ...base,
      canonicalEventSchema.parse({
        ...extra,
        eventId: "claude-align-bucket:999999",
        seq: 999999,
        payload: { ...extra.payload, toolCallId: "call_3" },
      }),
    ];

    expect(inspectShadowAlignmentStrategy(events, base)).toBe("kind_bucket");
  });
  it("aligns repeated same-kind native-backed events by deterministic importer order instead of fuzzy scoring", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-15T12:00:00.000Z",
      sessionId: "claude-shadow-1",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-shadow-1",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.txt" } },
          { type: "tool_use", id: "call_2", name: "Read", input: { file_path: "b.txt" } },
        ],
      },
    })}\n`;

    const canonical = importClaudeCodeJsonl(input);
    const secondToolCallIndex = canonical.findIndex(
      (event) => event.kind === "tool.call" && event.payload.toolCallId === "call_2",
    );
    const secondToolCall = canonical[secondToolCallIndex];
    if (!secondToolCall || secondToolCall.kind !== "tool.call") throw new Error("missing tool.call");

    canonical[secondToolCallIndex] = canonicalEventSchema.parse({
      ...secondToolCall,
      payload: {
        ...secondToolCall.payload,
        arguments: { file_path: "b.txt", offset: 10 },
      },
    });

    const exported = exportClaudeCodeJsonl(canonical);
    const assistantLine = parseJsonlObjectLines(exported).find((line) => line.type === "assistant");

    expect(assistantLine?.__lac_canonical).toEqual([
      {},
      { payload: { arguments: { file_path: "b.txt", offset: 10 } } },
    ]);
  });
});

describe("long revisiting chain e2e (4+ hops with provider revisits)", () => {
  for (const chain of buildRevisitingChains(providers)) {
    const first = chain[0];
    const last = chain.at(-1);
    if (!first || !last) continue;
    const chainLabel = chain.map((provider) => provider.name).join(" -> ");

    it(`${chainLabel} preserves the original ${first.name} JSONL`, () => {
      const originalText = readFixture(first.fixtureFile);
      const finalText = runChain(chain, originalText);
      expect(parseJsonlLines(finalText)).toEqual(parseJsonlLines(originalText));
    });

    it(`${chainLabel} keeps native.source pinned to the original at every intermediate hop`, () => {
      const originalText = readFixture(first.fixtureFile);
      const snapshots = canonicalAtEachHop(chain, originalText);
      for (const canonical of snapshots) {
        for (const event of canonical) expect(event.native?.source).toBe(first.name);
      }
    });
  }
});
