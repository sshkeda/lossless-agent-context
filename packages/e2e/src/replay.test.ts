import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalEventSchema, type CanonicalEvent } from "@lossless-agent-context/core";
import { replayFromCursor, replayTimeline } from "@lossless-agent-context/replay";
import { describe, expect, it } from "vitest";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures", name), "utf8")) as T;
}

function eventIds(events: CanonicalEvent[]): string[] {
  return events.map(event => event.eventId);
}

describe("replay engine e2e", () => {
  const events = canonicalEventSchema.array().parse(fixture<CanonicalEvent[]>("replay-branching.canonical.json"));

  it("replays the main branch timeline", () => {
    const replayed = replayTimeline(events, {
      sessionId: "replay-session-1",
      branchId: "main",
    });

    expect(eventIds(replayed)).toEqual(fixture<string[]>("expected/replay-main.ids.json"));
  });

  it("replays a forked branch with ancestor truncation at the fork point", () => {
    const replayed = replayTimeline(events, {
      sessionId: "replay-session-1",
      branchId: "fix-a",
    });

    expect(eventIds(replayed)).toEqual(fixture<string[]>("expected/replay-fix-a.ids.json"));
  });

  it("replays from a cursor on the forked branch", () => {
    const replayed = replayFromCursor(events, {
      sessionId: "replay-session-1",
      branchId: "fix-a",
      cursorEventId: "replay-session-1:000008",
    });

    expect(eventIds(replayed)).toEqual(fixture<string[]>("expected/replay-fix-a-cursor.ids.json"));
  });
});
