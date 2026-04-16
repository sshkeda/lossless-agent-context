import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importAiSdkMessages, type AiSdkMessageLike } from "@lossless-agent-context/adapters";
import { canonicalEventSchema, type CanonicalEvent } from "@lossless-agent-context/core";
import { toAiSdkMessageProjection, uiMessageProjectionSchema } from "@lossless-agent-context/projection-ai-sdk";
import { describe, expect, it } from "vitest";
import { conversionCases } from "./cases";

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "fixtures", name), "utf8");
}

function expectedJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures", "expected", name), "utf8")) as T;
}

function stripProjectionIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripProjectionIds);
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "id")
      .map(([key, nestedValue]) => [key, stripProjectionIds(nestedValue)]);
    return Object.fromEntries(entries);
  }

  return value;
}

function assertCanonicalInvariants(events: CanonicalEvent[]): void {
  expect(events.length).toBeGreaterThan(0);

  const eventIds = new Set<string>();
  let previousSeq = -1;
  let sessionId: string | undefined;
  let branchId: string | undefined;

  for (const event of events) {
    expect(event.schemaVersion).toBe("0.0.1");
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
      const events = testCase.importToCanonical(fixture(testCase.fixtureFile));
      const parsed = canonicalEventSchema.array().parse(events);
      const expected = expectedJson<CanonicalEvent[]>(`${testCase.name}.canonical.json`);

      assertCanonicalInvariants(parsed);
      expect(parsed).toEqual(expected);
    });

    it(`matches golden AI SDK projection output for ${testCase.name}`, () => {
      const events = testCase.importToCanonical(fixture(testCase.fixtureFile));
      const projection = uiMessageProjectionSchema.array().parse(toAiSdkMessageProjection(events));
      const expected = expectedJson<ReturnType<typeof toAiSdkMessageProjection>>(`${testCase.name}.projection.json`);

      expect(projection).toEqual(expected);
    });

    it(`is projection-roundtrip stable for ${testCase.name}`, () => {
      const events = testCase.importToCanonical(fixture(testCase.fixtureFile));
      const firstProjection = uiMessageProjectionSchema.array().parse(toAiSdkMessageProjection(events));
      const roundTrippedEvents = importAiSdkMessages(firstProjection as AiSdkMessageLike[], `${testCase.name}-roundtrip`);
      const secondProjection = uiMessageProjectionSchema.array().parse(toAiSdkMessageProjection(roundTrippedEvents));

      expect(stripProjectionIds(secondProjection)).toEqual(stripProjectionIds(firstProjection));
    });
  }
});
