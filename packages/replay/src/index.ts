import type { CanonicalEvent } from "@lossless-agent-context/core";

export type ReplayOptions = {
  sessionId: string;
  branchId: string;
  cursorEventId?: string;
  includeBranchMarkers?: boolean;
};

export function replayTimeline(events: CanonicalEvent[], options: ReplayOptions): CanonicalEvent[] {
  const sessionEvents = events.filter(event => event.sessionId === options.sessionId);
  const branchCreatedByBranchId = new Map<string, CanonicalEvent>();
  const eventById = new Map<string, CanonicalEvent>();

  for (const event of sessionEvents) {
    eventById.set(event.eventId, event);
    if (event.kind === "branch.created") {
      branchCreatedByBranchId.set(event.branchId, event);
    }
  }

  const lineage = resolveBranchLineage(options.branchId, branchCreatedByBranchId);
  const replayed = lineage.flatMap((branchId, index) => {
    const branchEvents = sessionEvents
      .filter(event => event.branchId === branchId)
      .sort((left, right) => left.seq - right.seq);

    const childBranchId = lineage[index + 1];
    if (!childBranchId) {
      return maybeTruncateByCursor(branchEvents, options.cursorEventId);
    }

    const childMarker = branchCreatedByBranchId.get(childBranchId);
    if (!childMarker || childMarker.kind !== "branch.created" || !childMarker.payload.fromEventId) {
      return maybeTruncateByCursor(branchEvents, options.cursorEventId);
    }

    const forkSource = eventById.get(childMarker.payload.fromEventId);
    if (!forkSource || forkSource.branchId !== branchId) {
      return maybeTruncateByCursor(branchEvents, options.cursorEventId);
    }

    return maybeTruncateByCursor(branchEvents.filter(event => event.seq <= forkSource.seq), options.cursorEventId);
  });

  return dedupeByEventId(replayed).sort(compareTimeline);
}

export function replayFromCursor(events: CanonicalEvent[], options: ReplayOptions): CanonicalEvent[] {
  return replayTimeline(events, options);
}

function resolveBranchLineage(branchId: string, branchCreatedByBranchId: Map<string, CanonicalEvent>): string[] {
  const lineage: string[] = [];
  let currentBranchId: string | undefined = branchId;

  while (currentBranchId) {
    lineage.unshift(currentBranchId);
    const marker = branchCreatedByBranchId.get(currentBranchId);
    currentBranchId = marker && marker.kind === "branch.created"
      ? marker.payload.fromBranchId
      : undefined;
  }

  return lineage;
}

function maybeTruncateByCursor(events: CanonicalEvent[], cursorEventId?: string): CanonicalEvent[] {
  if (!cursorEventId) return events;
  const cursorIndex = events.findIndex(event => event.eventId === cursorEventId);
  return cursorIndex === -1 ? events : events.slice(0, cursorIndex + 1);
}

function dedupeByEventId(events: CanonicalEvent[]): CanonicalEvent[] {
  const seen = new Set<string>();
  const deduped: CanonicalEvent[] = [];

  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    deduped.push(event);
  }

  return deduped;
}

function compareTimeline(left: CanonicalEvent, right: CanonicalEvent): number {
  const timeDelta = new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime();
  if (timeDelta !== 0) return timeDelta;
  return left.seq - right.seq;
}
