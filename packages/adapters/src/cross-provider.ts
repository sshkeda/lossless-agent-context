import type { CanonicalEvent } from "@lossless-agent-context/core";
import { canonicalEventSchema } from "@lossless-agent-context/core";
import { importClaudeCodeJsonl } from "./import-claude-code";
import { importCodexJsonl } from "./import-codex";
import { importPiSessionJsonl } from "./import-pi";

export const FOREIGN_TYPE = "lac:foreign";
export const FOREIGN_FIELD = "__lac_foreign";

export type ForeignEnvelope = {
  source: string;
  raw: unknown;
};

export function isForeignLine(line: Record<string, unknown>): boolean {
  return line.type === FOREIGN_TYPE && typeof line[FOREIGN_FIELD] === "object" && line[FOREIGN_FIELD] !== null;
}

export function readForeignEnvelope(line: Record<string, unknown>): ForeignEnvelope | undefined {
  const candidate = line[FOREIGN_FIELD];
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  if (typeof record.source !== "string") return undefined;
  return { source: record.source, raw: record.raw };
}

export function reimportForeignRaw(envelope: ForeignEnvelope): CanonicalEvent[] {
  const jsonl = JSON.stringify(envelope.raw);
  switch (envelope.source) {
    case "pi":
      return importPiSessionJsonl(jsonl);
    case "claude-code":
      return importClaudeCodeJsonl(jsonl);
    case "codex":
      return importCodexJsonl(jsonl);
    default:
      throw new Error(`cross-provider: unknown foreign source "${envelope.source}"`);
  }
}

export function rewriteIds(
  foreignEvents: CanonicalEvent[],
  hostSessionId: string,
  hostBranchId: string,
  startSeq: number,
): CanonicalEvent[] {
  return foreignEvents.map((event, index) => {
    const next = {
      ...event,
      sessionId: hostSessionId,
      branchId: hostBranchId,
      seq: startSeq + index,
      eventId: `${hostSessionId}:${String(startSeq + index).padStart(6, "0")}`,
    };
    return canonicalEventSchema.parse(next);
  });
}

type ForeignEnvelopeBuilder = (envelope: ForeignEnvelope, isoTimestamp: string) => Record<string, unknown>;

export function emitForeignEnvelopes(
  events: CanonicalEvent[],
  buildEnvelope: ForeignEnvelopeBuilder,
  matchesTarget: (source: string | undefined) => boolean,
): { lines: string[] } {
  const lines: string[] = [];
  const seen = new Set<string>();

  function pushSerialized(serialized: string): void {
    if (seen.has(serialized)) return;
    seen.add(serialized);
    lines.push(serialized);
  }

  for (const event of events) {
    const native = event.native;
    if (native?.source && matchesTarget(native.source) && native.raw !== undefined) {
      pushSerialized(JSON.stringify(native.raw));
      continue;
    }

    if (!native?.source || native.raw === undefined) {
      throw new Error(
        `cross-provider exporter: event ${event.eventId} has no native.raw to embed (source=${native?.source ?? "unknown"})`,
      );
    }

    const envelope: ForeignEnvelope = { source: native.source, raw: native.raw };
    const wrapped = buildEnvelope(envelope, event.timestamp);
    pushSerialized(JSON.stringify(wrapped));
  }

  return { lines };
}

export type SemanticRenderer = (
  source: string,
  group: CanonicalEvent[],
  native: { source: string; raw: unknown },
) => Record<string, unknown>;

export function emitSemanticGroupedLines(
  events: CanonicalEvent[],
  target: string,
  renderForeign: SemanticRenderer,
): { lines: string[] } {
  const lines: string[] = [];
  const seen = new Set<string>();

  function pushLine(serialized: string): void {
    if (seen.has(serialized)) return;
    seen.add(serialized);
    lines.push(serialized);
  }

  let i = 0;
  while (i < events.length) {
    const event = events[i];
    if (!event) {
      i++;
      continue;
    }
    const native = event.native;
    if (!native?.source || native.raw === undefined) {
      throw new Error(
        `cross-provider exporter: event ${event.eventId} has no native.raw to embed (source=${native?.source ?? "unknown"})`,
      );
    }

    if (native.source === target) {
      pushLine(JSON.stringify(native.raw));
      i++;
      continue;
    }

    const group: CanonicalEvent[] = [event];
    let j = i + 1;
    while (j < events.length) {
      const next = events[j];
      if (!next || next.native?.raw !== native.raw) break;
      group.push(next);
      j++;
    }

    const rendered = renderForeign(native.source, group, { source: native.source, raw: native.raw });
    pushLine(JSON.stringify(rendered));
    i = j;
  }

  return { lines };
}

export function inferWorkingDirectory(events: CanonicalEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind === "session.created") {
      const payload = event.payload as Record<string, unknown> | undefined;
      const wd = payload?.workingDirectory;
      if (typeof wd === "string") return wd;
    }
  }
  for (const event of events) {
    const raw = event.native?.raw;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      if (typeof record.cwd === "string") return record.cwd;
      const payload = record.payload as Record<string, unknown> | undefined;
      if (payload && typeof payload.cwd === "string") return payload.cwd;
    }
  }
  return undefined;
}

export function inferSessionIdForTarget(events: CanonicalEvent[], target: string): string {
  for (const event of events) {
    if (event.native?.source !== target) continue;
    const raw = event.native?.raw;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      if (target === "claude-code" && typeof record.sessionId === "string") return record.sessionId;
      if (target === "pi" && record.type === "session" && typeof record.id === "string") return record.id;
      if (target === "codex" && record.type === "session_meta") {
        const payload = record.payload as Record<string, unknown> | undefined;
        if (payload && typeof payload.id === "string") return payload.id;
      }
    }
  }
  return events[0]?.sessionId ?? `${target}-session`;
}
