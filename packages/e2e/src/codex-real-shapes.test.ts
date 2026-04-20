import { importCodexJsonl } from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";
import { readFixture } from "./fixtures";
import { parseJsonlObjectLines } from "./jsonl";
import { codexNativeLine, jsonRecord } from "./sdk-schemas";

function findByKind(events: CanonicalEvent[], kind: CanonicalEvent["kind"]): CanonicalEvent[] {
  return events.filter((event) => event.kind === kind);
}

describe("Codex real native shape corpus", () => {
  it("committed representative Codex native lines all satisfy the current native schema", () => {
    const lines = parseJsonlObjectLines(readFixture("codex-real-shapes.jsonl")).map((line) => jsonRecord.parse(line));
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const result = codexNativeLine.safeParse(line);
      expect(
        result.success,
        result.success ? undefined : `real codex shape failed schema: ${JSON.stringify(line)}`,
      ).toBe(true);
    }
  });

  it("imports representative real Codex shapes into a sane canonical timeline", () => {
    const events = importCodexJsonl(readFixture("codex-real-shapes.jsonl"));

    expect(findByKind(events, "session.created").length).toBeGreaterThanOrEqual(1);
    expect(findByKind(events, "message.created").length).toBeGreaterThanOrEqual(4);
    expect(findByKind(events, "reasoning.created").length).toBeGreaterThanOrEqual(2);
    expect(findByKind(events, "tool.call").length).toBeGreaterThanOrEqual(1);
    expect(findByKind(events, "tool.result").length).toBeGreaterThanOrEqual(1);

    const providerEvents = findByKind(events, "provider.event");
    expect(providerEvents.length).toBeGreaterThanOrEqual(7);

    const eventTypes = new Set(
      providerEvents
        .filter(
          (event): event is Extract<CanonicalEvent, { kind: "provider.event" }> => event.kind === "provider.event",
        )
        .map((event) => event.payload.eventType),
    );

    expect(eventTypes.has("turn_context")).toBe(true);
    expect(eventTypes.has("compacted")).toBe(true);
    expect(eventTypes.has("event_msg")).toBe(true);
  });

  it("preserves developer and user message text from the representative Codex corpus", () => {
    const events = importCodexJsonl(readFixture("codex-real-shapes.jsonl"));
    const texts = events
      .filter(
        (event): event is Extract<CanonicalEvent, { kind: "message.created" }> =>
          event.kind === "message.created" && (event.payload.role === "user" || event.payload.role === "assistant"),
      )
      .flatMap((event) => event.payload.parts)
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text);

    expect(texts.some((text) => text.includes("continue"))).toBe(true);
    expect(texts.some((text) => text.includes("Collaboration Mode: Default"))).toBe(true);
    expect(texts.some((text) => text.includes("strict-null stream errors"))).toBe(true);
  });

  it("imports harvested Codex token-count, custom-tool, and web-search shapes", () => {
    const events = importCodexJsonl(readFixture("codex-real-shapes.jsonl"));

    const customToolCall = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "tool.call" }> =>
        event.kind === "tool.call" && event.payload.name === "apply_patch",
    );
    expect(customToolCall).toBeDefined();

    const customToolResult = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "tool.result" }> =>
        event.kind === "tool.result" && event.payload.toolCallId === "call_JnruSF73OHYCYFx6q7o0fen9",
    );
    expect(customToolResult).toBeDefined();

    const providerEvents = events.filter(
      (event): event is Extract<CanonicalEvent, { kind: "provider.event" }> => event.kind === "provider.event",
    );
    const rawPayloadTypes = providerEvents.map((event) => {
      const raw = event.payload.raw as Record<string, unknown> | undefined;
      const payload = raw?.payload as Record<string, unknown> | undefined;
      return typeof payload?.type === "string" ? payload.type : undefined;
    });

    expect(rawPayloadTypes).toContain("token_count");
    expect(rawPayloadTypes).toContain("task_started");
    expect(rawPayloadTypes).toContain("task_complete");
    expect(rawPayloadTypes).toContain("exec_command_end");
    expect(rawPayloadTypes).toContain("web_search_end");
    expect(rawPayloadTypes).toContain("thread_rolled_back");
    expect(rawPayloadTypes).toContain("patch_apply_end");
    expect(rawPayloadTypes).toContain("turn_aborted");

    const encryptedReasoning = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "reasoning.created" }> =>
        event.kind === "reasoning.created" && event.native?.rawRef === "response_item.reasoning",
    );
    expect(encryptedReasoning).toBeDefined();

    const session = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "session.created" }> => event.kind === "session.created",
    );
    expect(session?.payload.provider).toBe("openai");
  });
});
