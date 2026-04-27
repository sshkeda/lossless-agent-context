import { importPiSessionJsonl } from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";
import { readFixture } from "./fixtures";
import { parseJsonlObjectLines } from "./jsonl";
import { jsonRecord } from "./sdk-schemas";

function byKind(events: CanonicalEvent[], kind: CanonicalEvent["kind"]): CanonicalEvent[] {
  return events.filter((event) => event.kind === kind);
}

describe("Pi real native shape corpus", () => {
  it("committed representative Pi native lines have expected native structure", () => {
    const lines = parseJsonlObjectLines(readFixture("pi-real-shapes.jsonl")).map((line) => jsonRecord.parse(line));
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      expect(["session", "model_change", "message", "thinking_level_change", "custom_message", "compaction"]).toContain(
        String(line.type),
      );
      expect(typeof line.timestamp).toBe("string");
      if (line.type === "message") {
        expect(typeof (line.message as Record<string, unknown> | undefined)?.role).toBe("string");
      }
    }
  });

  it("imports representative real Pi shapes into a sane canonical timeline", () => {
    const events = importPiSessionJsonl(readFixture("pi-real-shapes.jsonl"));

    expect(byKind(events, "session.created")).toHaveLength(1);
    expect(byKind(events, "model.selected").length).toBeGreaterThanOrEqual(1);
    expect(byKind(events, "message.created").length).toBeGreaterThanOrEqual(2);
    expect(byKind(events, "reasoning.created").length).toBeGreaterThanOrEqual(1);
    expect(byKind(events, "tool.call").length).toBeGreaterThanOrEqual(2);
    expect(byKind(events, "tool.result").length).toBeGreaterThanOrEqual(2);
    expect(byKind(events, "provider.event").length).toBeGreaterThanOrEqual(2);
  });

  it("preserves real Pi model selection and tool-result semantics from the committed corpus", () => {
    const events = importPiSessionJsonl(readFixture("pi-real-shapes.jsonl"));

    const modelSelected = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "model.selected" }> => event.kind === "model.selected",
    );
    expect(modelSelected?.payload.provider).toBe("openai-codex");
    expect(modelSelected?.payload.model).toBe("gpt-5.4");

    const toolCall = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "tool.call" }> => event.kind === "tool.call",
    );
    expect(toolCall?.payload.toolCallId).toBe("toolu_018PDrat4i7Dxv8QoYimHtC7");
    expect(toolCall?.payload.name).toBe("bash");

    const toolResult = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "tool.result" }> => event.kind === "tool.result",
    );
    expect(toolResult?.payload.toolCallId).toBe("toolu_018PDrat4i7Dxv8QoYimHtC7");
    expect(toolResult?.payload.isError).toBe(false);
  });

  it("preserves newly harvested Pi provider-event and image/tool-result shapes", () => {
    const events = importPiSessionJsonl(readFixture("pi-real-shapes.jsonl"));

    const providerEvents = events.filter(
      (event): event is Extract<CanonicalEvent, { kind: "provider.event" }> => event.kind === "provider.event",
    );
    const eventTypes = new Set(providerEvents.map((event) => event.payload.eventType));
    expect(eventTypes.has("thinking_level_change")).toBe(true);
    expect(eventTypes.has("compaction")).toBe(true);

    const textSignatures = events
      .filter(
        (event): event is Extract<CanonicalEvent, { kind: "message.created" }> => event.kind === "message.created",
      )
      .flatMap((event) => event.payload.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text);
    expect(textSignatures.some((text) => text.includes("Signed text only."))).toBe(true);
    expect(textSignatures.some((text) => text.includes("Council results"))).toBe(true);

    const imageToolResult = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "tool.result" }> =>
        event.kind === "tool.result" &&
        Array.isArray(event.payload.output) &&
        event.payload.output.some((part) => part.type === "image"),
    );
    expect(imageToolResult).toBeDefined();

    const partialJsonToolCall = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "tool.call" }> =>
        event.kind === "tool.call" &&
        typeof event.payload.toolCallId === "string" &&
        (event.payload.toolCallId.includes("call_Fsm4EDvVDaysLn4FUdTUXDvQ") ||
          event.payload.toolCallId.includes("call-partialjson-1")),
    );
    expect(partialJsonToolCall?.payload.name).toBeDefined();

    const mixedTextToolCall = events.find(
      (event): event is Extract<CanonicalEvent, { kind: "tool.call" }> =>
        event.kind === "tool.call" && event.payload.toolCallId === "shape-tool-1",
    );
    expect(mixedTextToolCall?.payload.name).toBe("bash");
  });

  it("imports Pi cache usage markers as structured canonical cache metadata", () => {
    const events = importPiSessionJsonl(readFixture("pi-real-shapes.jsonl"));
    const cached = events.find(
      (event) => event.cache?.readTokens !== undefined || event.cache?.writeTokens !== undefined,
    );
    expect(cached).toBeDefined();
    expect(cached?.cache?.writeTokens).toBe(12363);
  });
});
