import { exportClaudeCodeJsonl, importClaudeCodeJsonl, importPiSessionJsonl } from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";
import { stripPiClaudeBridgeToolCyclesForClaudeResume } from "./bridge-policy";
import { readFixture } from "./fixtures";

function textTranscript(events: CanonicalEvent[]): Array<{ role: string; text: string }> {
  return events
    .filter(
      (event): event is Extract<CanonicalEvent, { kind: "message.created" }> =>
        event.kind === "message.created" && event.payload.role !== "tool",
    )
    .map((event) => ({
      role: event.payload.role,
      text: event.payload.parts
        .filter((part): part is Extract<(typeof event.payload.parts)[number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join(""),
    }))
    .filter((message) => message.text.length > 0);
}

describe("Pi bridge -> Claude resume regression", () => {
  it("strips Pi ask_claude_code bridge tool cycles before seeding Claude resume without changing the visible transcript", () => {
    const piEvents = importPiSessionJsonl(readFixture("pi.jsonl"));
    expect(piEvents.some((event) => event.kind === "tool.call" && event.payload.name === "ask_claude_code")).toBe(true);
    expect(piEvents.some((event) => event.kind === "tool.result" && event.payload.toolCallId === "call_1")).toBe(true);

    const stripped = stripPiClaudeBridgeToolCyclesForClaudeResume(piEvents);
    expect(stripped.some((event) => event.kind === "tool.call" && event.payload.name === "ask_claude_code")).toBe(
      false,
    );
    expect(stripped.some((event) => event.kind === "tool.result" && event.payload.toolCallId === "call_1")).toBe(false);

    const exported = exportClaudeCodeJsonl(stripped);
    const reimported = importClaudeCodeJsonl(exported);

    expect(reimported.some((event) => event.kind === "tool.call" && event.payload.name === "ask_claude_code")).toBe(
      false,
    );
    expect(reimported.some((event) => event.kind === "tool.result" && event.payload.toolCallId === "call_1")).toBe(
      false,
    );
    expect(textTranscript(reimported)).toEqual(textTranscript(stripped));
  });
});
