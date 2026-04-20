import { CANONICAL_SCHEMA_VERSION, type CanonicalEvent, canonicalEventSchema } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";
import { conversionCases } from "./cases";
import { readExpectedJson, readFixture } from "./fixtures";

function assertCanonicalInvariants(events: CanonicalEvent[]): void {
  expect(events.length).toBeGreaterThan(0);

  const eventIds = new Set<string>();
  let previousSeq = -1;
  let sessionId: string | undefined;
  let branchId: string | undefined;

  for (const event of events) {
    expect(event.schemaVersion).toBe(CANONICAL_SCHEMA_VERSION);
    expect(event.seq).toBeGreaterThan(previousSeq);
    previousSeq = event.seq;

    expect(eventIds.has(event.eventId)).toBe(false);
    eventIds.add(event.eventId);

    if (!sessionId) sessionId = event.sessionId;
    if (!branchId) branchId = event.branchId;

    expect(event.sessionId).toBe(sessionId);
    expect(event.branchId).toBe(branchId);
  }
}

describe("conversion corpus e2e", () => {
  for (const testCase of conversionCases) {
    it(`matches golden canonical output for ${testCase.name}`, () => {
      const events = testCase.importToCanonical(readFixture(testCase.fixtureFile));
      const parsed = canonicalEventSchema.array().parse(events);
      const expected = readExpectedJson<CanonicalEvent[]>(`${testCase.name}.canonical.json`);

      assertCanonicalInvariants(parsed);
      expect(parsed).toEqual(expected);
    });
  }
});
