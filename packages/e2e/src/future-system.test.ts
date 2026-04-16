import { describe, expect, it } from "vitest";
import { systemE2EMatrix } from "./system-matrix";

describe("future system e2e matrix", () => {
  it("tracks every required end-to-end domain for the future system", () => {
    expect(systemE2EMatrix.map(entry => entry.domain)).toEqual([
      "fixture-corpus",
      "real-local-logs",
      "projection-roundtrip",
      "replay-engine",
      "openinference-export",
      "live-provider-smoke",
    ]);
  });

  it("marks the missing future-system suites explicitly instead of pretending they exist", () => {
    const planned = systemE2EMatrix.filter(entry => entry.status === "planned");
    expect(planned.map(entry => entry.domain)).toEqual([
      "replay-engine",
      "live-provider-smoke",
    ]);
  });
});
