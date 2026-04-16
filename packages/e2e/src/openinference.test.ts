import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalEventSchema, type CanonicalEvent } from "@lossless-agent-context/core";
import { openInferenceSpanSchema, toOpenInferenceSpans } from "@lossless-agent-context/projection-openinference";
import { describe, expect, it } from "vitest";
import { conversionCases } from "./cases";

function expectedJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures", "expected", name), "utf8")) as T;
}

describe("openinference exporter e2e", () => {
  for (const testCase of conversionCases) {
    it(`matches golden OpenInference spans for ${testCase.name}`, () => {
      const canonical = expectedJson<CanonicalEvent[]>(`${testCase.name}.canonical.json`);
      const events = canonicalEventSchema.array().parse(canonical);
      const spans = openInferenceSpanSchema.array().parse(toOpenInferenceSpans(events));
      const expected = expectedJson<ReturnType<typeof toOpenInferenceSpans>>(`${testCase.name}.openinference.json`);

      expect(spans).toEqual(expected);
    });
  }
});
