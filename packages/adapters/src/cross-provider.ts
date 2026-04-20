import type { CanonicalEvent } from "@lossless-agent-context/core";
import { canonicalEventSchema, resolveCanonicalSchemaVersion } from "@lossless-agent-context/core";
import { CLAUDE_CODE_IDS_EXTENSION } from "./defaults";
import { importClaudeCodeJsonl } from "./import-claude-code";
import { importCodexJsonl } from "./import-codex";
import { importPiSessionJsonl } from "./import-pi";
import { stableJsonStringify } from "./utils";

export const FOREIGN_TYPE = "lac:foreign";
export const FOREIGN_FIELD = "__lac_foreign";
export const CANONICAL_OVERRIDE_FIELD = "__lac_canonical";
export const CANONICAL_EVENT_TYPE = "lac:event";

const CANONICAL_ONLY_KINDS: ReadonlySet<CanonicalEvent["kind"]> = new Set([
  "model.requested",
  "model.completed",
  "runtime.error",
  "branch.created",
]);

export type ForeignEnvelope = {
  source: string;
  raw: unknown;
  rawText?: string;
};

export type CanonicalOverride = {
  branchId?: string;
  payload?: Record<string, unknown>;
  cache?: Record<string, unknown>;
  causality?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  actor?: Record<string, unknown>;
  native?: {
    rawRef?: string;
    formatVersion?: string;
  };
};

export function buildCanonicalOverride(event: CanonicalEvent): CanonicalOverride | null {
  const override: CanonicalOverride = {};
  let hasOverride = false;

  if (event.branchId !== "main") {
    override.branchId = event.branchId;
    hasOverride = true;
  }

  if (event.kind === "reasoning.created") {
    const patch: Record<string, unknown> = {};
    if (event.payload.visibility) patch.visibility = event.payload.visibility;
    if (event.payload.providerExposed !== undefined) patch.providerExposed = event.payload.providerExposed;
    if (event.payload.retentionPolicy !== undefined) patch.retentionPolicy = event.payload.retentionPolicy;
    if (Object.keys(patch).length > 0) {
      override.payload = patch;
      hasOverride = true;
    }
  }

  if (event.kind === "message.created") {
    const requiresPartPreservation = event.payload.parts.some(
      (part) => part.type !== "text" || (part.type === "text" && (part.citations?.length ?? 0) > 0),
    );
    if (requiresPartPreservation) {
      override.payload = { ...(override.payload ?? {}), parts: event.payload.parts };
      hasOverride = true;
    }
  }

  if (event.kind === "session.created") {
    const patch: Record<string, unknown> = {};
    if (event.payload.title !== undefined) patch.title = event.payload.title;
    if (event.payload.tags !== undefined) patch.tags = event.payload.tags;
    if (event.payload.provider !== undefined) patch.provider = event.payload.provider;
    if (event.payload.model !== undefined) patch.model = event.payload.model;
    if (Object.keys(patch).length > 0) {
      override.payload = patch;
      hasOverride = true;
    }
  }

  if (event.kind === "tool.call") {
    override.payload = {
      ...(override.payload ?? {}),
      name: event.payload.name,
      arguments: event.payload.arguments,
    };
    hasOverride = true;
  }

  if (event.kind === "tool.result" && event.payload.error !== undefined) {
    override.payload = { ...(override.payload ?? {}), error: event.payload.error };
    hasOverride = true;
  }

  if (event.actor) {
    const actorPatch: Record<string, unknown> = {};
    if (event.actor.provider !== undefined) actorPatch.provider = event.actor.provider;
    if (event.actor.model !== undefined) actorPatch.model = event.actor.model;
    if (event.actor.agentId !== undefined) actorPatch.agentId = event.actor.agentId;
    if (Object.keys(actorPatch).length > 0) {
      override.actor = actorPatch;
      hasOverride = true;
    }
  }

  if (event.cache) {
    override.cache = { ...event.cache };
    hasOverride = true;
  }

  if (event.causality) {
    override.causality = { ...event.causality };
    hasOverride = true;
  }

  if (event.extensions) {
    const extensions = Object.fromEntries(
      Object.entries(event.extensions).filter(([key]) => key !== CLAUDE_CODE_IDS_EXTENSION),
    );
    if (Object.keys(extensions).length > 0) {
      override.extensions = extensions;
      hasOverride = true;
    }
  }

  if (event.native?.rawRef !== undefined || event.native?.formatVersion !== undefined) {
    override.native = {};
    if (event.native.rawRef !== undefined) override.native.rawRef = event.native.rawRef;
    if (event.native.formatVersion !== undefined) override.native.formatVersion = event.native.formatVersion;
    hasOverride = true;
  }

  return hasOverride ? override : null;
}

export function readCanonicalOverrides(line: Record<string, unknown>): CanonicalOverride[] | undefined {
  const value = line[CANONICAL_OVERRIDE_FIELD];
  if (!Array.isArray(value)) return undefined;
  return value.map((item) =>
    item && typeof item === "object" && !Array.isArray(item) ? (item as CanonicalOverride) : {},
  );
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return stableJsonStringify(a) === stableJsonStringify(b);
}

export type ShadowAlignmentStrategy = "rawRef" | "sequential" | "kind_bucket";

export type AlignmentStrategyCounts = {
  totalGroups: number;
  rawRef: number;
  sequential: number;
  kindBucket: number;
};

function alignShadowEventsWithStrategy(
  events: CanonicalEvent[],
  shadowEvents: CanonicalEvent[],
): { strategy: ShadowAlignmentStrategy; aligned: Array<CanonicalEvent | undefined> } {
  const shadowNativeBacked = shadowEvents.filter((event) => !CANONICAL_ONLY_KINDS.has(event.kind));

  const eventsHaveUniqueRawRefs = new Set(
    events.map((event) => event.native?.rawRef).filter((rawRef): rawRef is string => typeof rawRef === "string"),
  );
  if (eventsHaveUniqueRawRefs.size === events.length) {
    const shadowByRawRef = new Map<string, CanonicalEvent>();
    for (const shadow of shadowNativeBacked) {
      const rawRef = shadow.native?.rawRef;
      if (typeof rawRef === "string" && !shadowByRawRef.has(rawRef)) {
        shadowByRawRef.set(rawRef, shadow);
      }
    }
    const alignedByRawRef = events.map((event) =>
      typeof event.native?.rawRef === "string" ? shadowByRawRef.get(event.native.rawRef) : undefined,
    );
    if (alignedByRawRef.every((shadow, index) => shadow?.kind === events[index]?.kind)) {
      return { strategy: "rawRef", aligned: alignedByRawRef };
    }
  }

  if (
    events.length === shadowNativeBacked.length &&
    events.every((event, index) => shadowNativeBacked[index]?.kind === event.kind)
  ) {
    return { strategy: "sequential", aligned: events.map((_, index) => shadowNativeBacked[index]) };
  }

  const shadowBuckets = new Map<CanonicalEvent["kind"], CanonicalEvent[]>();
  for (const shadow of shadowNativeBacked) {
    const bucket = shadowBuckets.get(shadow.kind) ?? [];
    bucket.push(shadow);
    shadowBuckets.set(shadow.kind, bucket);
  }

  const shadowOffsets = new Map<CanonicalEvent["kind"], number>();
  return {
    strategy: "kind_bucket",
    aligned: events.map((event) => {
      const offset = shadowOffsets.get(event.kind) ?? 0;
      shadowOffsets.set(event.kind, offset + 1);
      return shadowBuckets.get(event.kind)?.[offset];
    }),
  };
}

function alignShadowEventsDeterministically(
  events: CanonicalEvent[],
  shadowEvents: CanonicalEvent[],
): Array<CanonicalEvent | undefined> {
  return alignShadowEventsWithStrategy(events, shadowEvents).aligned;
}

export function inspectShadowAlignmentStrategy(
  events: CanonicalEvent[],
  shadowEvents: CanonicalEvent[],
): ShadowAlignmentStrategy {
  return alignShadowEventsWithStrategy(events, shadowEvents).strategy;
}

export function inspectSameProviderAlignmentStrategies(
  events: CanonicalEvent[],
  target: string,
): AlignmentStrategyCounts {
  const counts: AlignmentStrategyCounts = {
    totalGroups: 0,
    rawRef: 0,
    sequential: 0,
    kindBucket: 0,
  };

  let i = 0;
  while (i < events.length) {
    const event = events[i];
    if (!event) {
      i++;
      continue;
    }
    const native = event.native;
    if (!native?.source || native.raw === undefined || native.source !== target) {
      i++;
      continue;
    }

    const groupRawJson = JSON.stringify(native.raw);
    const sameGroup: CanonicalEvent[] = [event];
    let k = i + 1;
    while (k < events.length) {
      const next = events[k];
      if (!next) break;
      const nextNative = next.native;
      if (!nextNative || nextNative.source !== native.source) break;
      if (nextNative.raw !== native.raw && JSON.stringify(nextNative.raw) !== groupRawJson) break;
      sameGroup.push(next);
      k++;
    }
    i = k;

    const nativeBacked = sameGroup.filter((candidate) => !CANONICAL_ONLY_KINDS.has(candidate.kind));
    if (nativeBacked.length === 0) continue;

    const shadowEvents = reimportForeignRaw({ source: native.source, raw: native.raw });
    const strategy = alignShadowEventsWithStrategy(nativeBacked, shadowEvents).strategy;
    counts.totalGroups += 1;
    if (strategy === "rawRef") counts.rawRef += 1;
    else if (strategy === "sequential") counts.sequential += 1;
    else counts.kindBucket += 1;
  }

  return counts;
}

function stripInternalNativeOverride(override: CanonicalOverride | null): CanonicalOverride | null {
  if (!override) return null;
  if (!override.native) return override;
  const { native: _native, ...rest } = override;
  return Object.keys(rest).length > 0 ? rest : null;
}

export function buildCanonicalOverrideAgainstShadow(
  event: CanonicalEvent,
  shadow: CanonicalEvent | undefined,
): CanonicalOverride | null {
  const full = stripInternalNativeOverride(buildCanonicalOverride(event));
  if (!full) return null;
  if (!shadow) return full;

  const filtered: CanonicalOverride = {};
  let hasOverride = false;

  if (full.branchId && full.branchId !== shadow.branchId) {
    filtered.branchId = full.branchId;
    hasOverride = true;
  }

  if (full.payload) {
    const filteredPayload: Record<string, unknown> = {};
    const shadowPayload: Record<string, unknown> = {};
    if (shadow.payload && typeof shadow.payload === "object") {
      Object.assign(shadowPayload, shadow.payload);
    }
    for (const [key, value] of Object.entries(full.payload)) {
      if (!jsonEqual(shadowPayload[key], value)) {
        filteredPayload[key] = value;
        hasOverride = true;
      }
    }
    if (Object.keys(filteredPayload).length > 0) filtered.payload = filteredPayload;
  }

  if (full.actor) {
    const filteredActor: Record<string, unknown> = {};
    const shadowActor: Record<string, unknown> = {};
    if (shadow.actor) Object.assign(shadowActor, shadow.actor);
    for (const [key, value] of Object.entries(full.actor)) {
      if (!jsonEqual(shadowActor[key], value)) {
        filteredActor[key] = value;
        hasOverride = true;
      }
    }
    if (Object.keys(filteredActor).length > 0) filtered.actor = filteredActor;
  }

  if (full.cache && !jsonEqual(shadow.cache, full.cache)) {
    filtered.cache = full.cache;
    hasOverride = true;
  }

  if (full.causality && !jsonEqual(shadow.causality, full.causality)) {
    filtered.causality = full.causality;
    hasOverride = true;
  }

  if (full.extensions) {
    const shadowExtensions = shadow.extensions
      ? Object.fromEntries(Object.entries(shadow.extensions).filter(([key]) => key !== CLAUDE_CODE_IDS_EXTENSION))
      : undefined;
    if (!jsonEqual(shadowExtensions, full.extensions)) {
      filtered.extensions = full.extensions;
      hasOverride = true;
    }
  }

  return hasOverride ? filtered : null;
}

export function applyCanonicalOverride(event: CanonicalEvent, override: CanonicalOverride): CanonicalEvent {
  const next: Record<string, unknown> = { ...event };
  if (override.branchId) next.branchId = override.branchId;
  if (override.payload && event.payload && typeof event.payload === "object") {
    next.payload = { ...event.payload, ...override.payload };
  }
  if (override.cache) next.cache = override.cache;
  if (override.causality) next.causality = override.causality;
  if (override.extensions) {
    next.extensions = {
      ...((event.extensions as Record<string, unknown> | undefined) ?? {}),
      ...override.extensions,
    };
  }
  if (override.actor) {
    next.actor = event.actor ? { ...event.actor, ...override.actor } : override.actor;
  }
  if (override.native) {
    next.native = {
      ...((event.native as Record<string, unknown> | undefined) ?? {}),
      ...override.native,
    };
  }
  return canonicalEventSchema.parse(next);
}

export function applyCanonicalOverridesToRange(
  events: CanonicalEvent[],
  overrides: CanonicalOverride[] | undefined,
  startIndex: number,
): void {
  if (!overrides) return;
  const limit = Math.min(overrides.length, events.length - startIndex);
  for (let k = 0; k < limit; k++) {
    const ov = overrides[k];
    if (!ov || Object.keys(ov).length === 0) continue;
    const event = events[startIndex + k];
    if (!event) continue;
    events[startIndex + k] = applyCanonicalOverride(event, ov);
  }
}

export function renderCanonicalEventLine(event: CanonicalEvent, sidecar: ForeignEnvelope): Record<string, unknown> {
  const line: Record<string, unknown> = {
    type: CANONICAL_EVENT_TYPE,
    schemaVersion: event.schemaVersion,
    branchId: event.branchId,
    timestamp: event.timestamp,
    kind: event.kind,
    payload: event.payload,
    [FOREIGN_FIELD]: sidecar,
  };
  if (event.actor) line.actor = event.actor;
  if (event.cache) line.cache = event.cache;
  if (event.causality) line.causality = event.causality;
  if (event.extensions) line.extensions = event.extensions;
  if (event.native?.rawRef !== undefined) line.rawRef = event.native.rawRef;
  if (event.native?.formatVersion !== undefined) line.formatVersion = event.native.formatVersion;
  return line;
}

export function isCanonicalEventLine(line: Record<string, unknown>): boolean {
  return line.type === CANONICAL_EVENT_TYPE && typeof line.kind === "string";
}

export function readCanonicalEventLine(
  line: Record<string, unknown>,
  fallbackSource: string,
  sessionId: string,
  branchId: string,
  seq: number,
  timestamp: string,
): CanonicalEvent | undefined {
  if (!isCanonicalEventLine(line)) return undefined;
  const schemaVersion = resolveCanonicalSchemaVersion(line.schemaVersion);
  const native = readForeignEnvelope(line) ?? { source: fallbackSource, raw: line };
  const candidate: Record<string, unknown> = {
    eventId: `${sessionId}:${String(seq).padStart(6, "0")}`,
    sessionId,
    branchId: typeof line.branchId === "string" ? line.branchId : branchId,
    seq,
    timestamp,
    kind: line.kind,
    payload: line.payload,
    native,
    schemaVersion,
  };
  if (line.actor) candidate.actor = line.actor;
  if (line.cache) candidate.cache = line.cache;
  if (line.causality) candidate.causality = line.causality;
  if (line.extensions) candidate.extensions = line.extensions;
  if (typeof line.rawRef === "string" || typeof line.formatVersion === "string") {
    const nativeRecord = candidate.native as Record<string, unknown>;
    candidate.native = {
      ...nativeRecord,
      ...(typeof line.rawRef === "string" ? { rawRef: line.rawRef } : {}),
      ...(typeof line.formatVersion === "string" ? { formatVersion: line.formatVersion } : {}),
    };
  }
  return canonicalEventSchema.parse(candidate);
}

export function importEmbeddedCrossProviderLine(
  line: Record<string, unknown>,
  fallbackSource: string,
  sessionId: string,
  branchId: string,
  startSeq: number,
  timestamp: string,
): CanonicalEvent[] | undefined {
  if (isForeignLine(line)) {
    const envelope = readForeignEnvelope(line);
    if (envelope) {
      const foreign = reimportForeignRaw(envelope);
      return rewriteIds(foreign, sessionId, branchId, startSeq);
    }
  }

  if (isCanonicalEventLine(line)) {
    const parsed = readCanonicalEventLine(line, fallbackSource, sessionId, branchId, startSeq, timestamp);
    if (parsed) return [parsed];
  }

  return undefined;
}

export function isForeignLine(line: Record<string, unknown>): boolean {
  return line.type === FOREIGN_TYPE && typeof line[FOREIGN_FIELD] === "object" && line[FOREIGN_FIELD] !== null;
}

export function readForeignEnvelope(line: Record<string, unknown>): ForeignEnvelope | undefined {
  const candidate = line[FOREIGN_FIELD];
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  if (typeof record.source !== "string") return undefined;
  const rawText = typeof record.rawText === "string" ? record.rawText : undefined;
  return rawText !== undefined
    ? { source: record.source, raw: record.raw, rawText }
    : { source: record.source, raw: record.raw };
}

export function reimportForeignRaw(envelope: ForeignEnvelope): CanonicalEvent[] {
  const jsonl = envelope.rawText ?? JSON.stringify(envelope.raw);
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
  const eventIdMap = new Map<string, string>();
  for (const [index, event] of foreignEvents.entries()) {
    eventIdMap.set(event.eventId, `${hostSessionId}:${String(startSeq + index).padStart(6, "0")}`);
  }

  return foreignEvents.map((event, index) => {
    const nextCausality = event.causality
      ? {
          ...event.causality,
          parentEventId: rewriteEventId(eventIdMap, event.causality.parentEventId),
          causedByEventId: rewriteEventId(eventIdMap, event.causality.causedByEventId),
        }
      : undefined;
    const nextPayload =
      event.kind === "branch.created"
        ? {
            ...event.payload,
            fromEventId: rewriteEventId(eventIdMap, event.payload.fromEventId),
          }
        : event.payload;
    const next = {
      ...event,
      sessionId: hostSessionId,
      branchId: event.branchId || hostBranchId,
      seq: startSeq + index,
      eventId: eventIdMap.get(event.eventId),
      payload: nextPayload,
      causality: nextCausality,
    };
    return canonicalEventSchema.parse(next);
  });
}

function rewriteEventId(eventIdMap: Map<string, string>, eventId: string | undefined): string | undefined {
  if (!eventId) return eventId;
  return eventIdMap.get(eventId) ?? eventId;
}

export type GroupRenderer = (
  group: CanonicalEvent[],
  envelope: ForeignEnvelope,
) => Record<string, unknown> | Record<string, unknown>[] | null;

export function emitTargetGroupedLines(
  events: CanonicalEvent[],
  target: string,
  renderGroup: GroupRenderer,
): { lines: string[] } {
  const lines: string[] = [];

  function pushLine(serialized: string): void {
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
      const groupRawJson = JSON.stringify(native.raw);
      const sameGroup: CanonicalEvent[] = [event];
      let k = i + 1;
      while (k < events.length) {
        const next = events[k];
        if (!next) break;
        const nextNative = next.native;
        if (!nextNative || nextNative.source !== native.source) break;
        if (nextNative.raw !== native.raw && JSON.stringify(nextNative.raw) !== groupRawJson) break;
        sameGroup.push(next);
        k++;
      }
      i = k;

      const canonicalOnly = sameGroup.filter((e) => CANONICAL_ONLY_KINDS.has(e.kind));
      const nativeBacked = sameGroup.filter((e) => !CANONICAL_ONLY_KINDS.has(e.kind));

      for (const e of canonicalOnly) {
        pushLine(JSON.stringify(renderCanonicalEventLine(e, { source: native.source, raw: native.raw })));
      }

      if (nativeBacked.length > 0) {
        const shadowEvents = reimportForeignRaw({ source: native.source, raw: native.raw });
        const alignedShadowEvents = alignShadowEventsDeterministically(nativeBacked, shadowEvents);
        const overrides = nativeBacked.map((event, index) =>
          buildCanonicalOverrideAgainstShadow(event, alignedShadowEvents[index]),
        );
        const hasAnyOverride = overrides.some((o) => o !== null);
        const isRawObject = typeof native.raw === "object" && native.raw !== null && !Array.isArray(native.raw);
        if (hasAnyOverride && isRawObject) {
          const clone: Record<string, unknown> = {};
          Object.assign(clone, native.raw);
          clone[CANONICAL_OVERRIDE_FIELD] = overrides.map((o) => o ?? {});
          pushLine(JSON.stringify(clone));
        } else if (typeof native.rawText === "string") {
          pushLine(native.rawText);
        } else {
          pushLine(JSON.stringify(native.raw));
        }
      }
      continue;
    }

    const group: CanonicalEvent[] = [event];
    const groupRawJson = JSON.stringify(native.raw);
    let j = i + 1;
    while (j < events.length) {
      const next = events[j];
      if (!next) break;
      const nextNative = next.native;
      if (!nextNative || nextNative.source !== native.source) break;
      if (nextNative.raw !== native.raw && JSON.stringify(nextNative.raw) !== groupRawJson) break;
      group.push(next);
      j++;
    }

    const envelope: ForeignEnvelope =
      typeof native.rawText === "string"
        ? { source: native.source, raw: native.raw, rawText: native.rawText }
        : { source: native.source, raw: native.raw };
    const result = renderGroup(group, envelope);
    i = j;
    if (result === null) continue;
    const toPush = Array.isArray(result) ? result : [result];

    if (toPush.length > 0) {
      const overrides = group.map((event) => stripInternalNativeOverride(buildCanonicalOverride(event)));
      const hasAnyOverride = overrides.some((o) => o !== null);
      if (hasAnyOverride) {
        if (toPush.length === group.length) {
          for (let k = 0; k < toPush.length; k++) {
            const ov = overrides[k];
            if (!ov) continue;
            const line = toPush[k];
            if (line) line[CANONICAL_OVERRIDE_FIELD] = [ov];
          }
        } else {
          const firstLine = toPush[0];
          if (firstLine) firstLine[CANONICAL_OVERRIDE_FIELD] = overrides.map((o) => o ?? {});
        }
      }
    }

    for (const line of toPush) {
      pushLine(JSON.stringify(line));
    }
  }

  return { lines };
}

function readWorkingDirectoryFromNativeRaw(raw: unknown, source: string | undefined): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const payload = record.payload as Record<string, unknown> | undefined;

  switch (source) {
    case "pi":
      return record.type === "session" && typeof record.cwd === "string" ? record.cwd : undefined;
    case "claude-code":
      return record.type === "system" && record.subtype === "init" && typeof record.cwd === "string"
        ? record.cwd
        : undefined;
    case "codex":
      return record.type === "session_meta" && payload && typeof payload.cwd === "string" ? payload.cwd : undefined;
    default:
      return undefined;
  }
}

export function inferWorkingDirectory(events: CanonicalEvent[]): string | undefined {
  const canonicalCandidates = new Set<string>();
  for (const event of events) {
    if (event.kind !== "session.created") continue;
    const wd = event.payload.workingDirectory;
    if (typeof wd === "string") canonicalCandidates.add(wd);
  }
  if (canonicalCandidates.size === 1) {
    const [workingDirectory] = canonicalCandidates;
    return workingDirectory;
  }
  if (canonicalCandidates.size > 1) return undefined;

  const nativeCandidates = new Set<string>();
  for (const event of events) {
    const wd = readWorkingDirectoryFromNativeRaw(event.native?.raw, event.native?.source);
    if (wd !== undefined) nativeCandidates.add(wd);
  }
  if (nativeCandidates.size === 1) {
    const [workingDirectory] = nativeCandidates;
    return workingDirectory;
  }

  return undefined;
}

export function inferSessionIdForTarget(events: CanonicalEvent[], target: string): string {
  const sessionIds = new Set(events.map((event) => event.sessionId));
  if (sessionIds.size > 1) {
    throw new Error(`Cannot export multiple sessions to ${target}; received ${sessionIds.size} sessionIds`);
  }
  const [sessionId] = sessionIds;
  return sessionId ?? `${target}-session`;
}
