import type { CanonicalEvent } from "@lossless-agent-context/core";
import type { UiMessageProjection } from "./schema";
import { uiMessageProjectionSchema } from "./schema";

export type { UiMessageProjection } from "./schema";
export { uiMessageProjectionSchema } from "./schema";

export function toAiSdkMessageProjection(events: CanonicalEvent[]): UiMessageProjection[] {
  const projected: UiMessageProjection[] = [];

  for (const event of events) {
    switch (event.kind) {
      case "message.created": {
        projected.push(
          uiMessageProjectionSchema.parse({
            id: event.eventId,
            role: event.payload.role,
            parts: event.payload.parts,
          }),
        );
        break;
      }
      case "reasoning.created": {
        projected.push(
          uiMessageProjectionSchema.parse({
            id: event.eventId,
            role: "assistant",
            parts: [{ type: "reasoning", text: event.payload.text }],
          }),
        );
        break;
      }
      case "tool.call": {
        projected.push(
          uiMessageProjectionSchema.parse({
            id: event.eventId,
            role: "assistant",
            parts: [
              {
                type: "tool-call",
                toolCallId: event.payload.toolCallId,
                toolName: event.payload.name,
                input: event.payload.arguments,
              },
            ],
          }),
        );
        break;
      }
      case "tool.result": {
        projected.push(
          uiMessageProjectionSchema.parse({
            id: event.eventId,
            role: "tool",
            parts: [
              {
                type: "tool-result",
                toolCallId: event.payload.toolCallId,
                output: event.payload.output,
                isError: event.payload.isError,
              },
            ],
          }),
        );
        break;
      }
      default:
        break;
    }
  }

  return projected;
}
