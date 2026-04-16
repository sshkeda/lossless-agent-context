import type { CanonicalEvent, ContentPart } from "@lossless-agent-context/core";
import { openInferenceSpanSchema } from "./schema";

export type { OpenInferenceSpan } from "./schema";
export { openInferenceSpanSchema } from "./schema";

export function toOpenInferenceSpans(events: CanonicalEvent[]) {
  return events.map((event, index) =>
    openInferenceSpanSchema.parse({
      traceId: event.sessionId,
      spanId: event.eventId,
      parentSpanId: index > 0 ? events[index - 1]?.eventId : undefined,
      name: event.kind,
      startTime: event.timestamp,
      endTime: event.timestamp,
      attributes: attributesForEvent(event),
    }),
  );
}

function attributesForEvent(event: CanonicalEvent): Record<string, string | number | boolean | null> {
  const base: Record<string, string | number | boolean | null> = {
    "session.id": event.sessionId,
    "metadata.branch_id": event.branchId,
    "metadata.event_kind": event.kind,
    "openinference.span.kind": spanKindForEvent(event),
  };

  switch (event.kind) {
    case "session.created":
      return {
        ...base,
        "input.value": event.payload.title ?? null,
        "metadata.started_at": event.payload.startedAt,
        "metadata.working_directory": event.payload.workingDirectory ?? null,
      };
    case "model.selected":
      return {
        ...base,
        "llm.provider": event.payload.provider,
        "llm.model_name": event.payload.model,
      };
    case "message.created":
      return {
        ...base,
        "metadata.role": event.payload.role,
        ...(event.payload.role === "user" || event.payload.role === "system"
          ? { "input.value": stringifyParts(event.payload.parts) }
          : { "output.value": stringifyParts(event.payload.parts) }),
      };
    case "reasoning.created":
      return {
        ...base,
        "output.value": event.payload.text ?? null,
        "metadata.reasoning_visibility": event.payload.visibility,
        "metadata.provider_exposed": event.payload.providerExposed ?? null,
      };
    case "model.requested":
      return {
        ...base,
        "llm.provider": event.payload.provider,
        "llm.model_name": event.payload.model,
        "input.value": safeJson(event.payload.input),
      };
    case "model.completed":
      return {
        ...base,
        "llm.provider": event.payload.provider,
        "llm.model_name": event.payload.model,
        "output.value": safeJson(event.payload.output),
        "llm.token_count.prompt": event.payload.usage?.inputTokens ?? null,
        "llm.token_count.completion": event.payload.usage?.outputTokens ?? null,
        "llm.token_count.total": event.payload.usage?.totalTokens ?? null,
      };
    case "tool.call":
      return {
        ...base,
        "tool.id": event.payload.toolCallId,
        "tool.name": event.payload.name,
        "tool.parameters": safeJson(event.payload.arguments),
      };
    case "tool.result":
      return {
        ...base,
        "tool.id": event.payload.toolCallId,
        "output.value": safeJson(event.payload.output),
        "metadata.is_error": event.payload.isError,
        "exception.message": event.payload.error ?? null,
      };
    case "runtime.error":
      return {
        ...base,
        "exception.message": event.payload.message,
        "exception.type": event.payload.code ?? null,
      };
    case "provider.event":
      return {
        ...base,
        "metadata.provider": event.payload.provider,
        "metadata.provider_event_type": event.payload.eventType,
      };
    case "branch.created":
      return {
        ...base,
        "metadata.from_branch_id": event.payload.fromBranchId ?? null,
        "metadata.from_event_id": event.payload.fromEventId ?? null,
      };
  }
}

function spanKindForEvent(event: CanonicalEvent): string {
  switch (event.kind) {
    case "model.selected":
    case "model.requested":
    case "model.completed":
      return "LLM";
    case "tool.call":
    case "tool.result":
      return "TOOL";
    case "reasoning.created":
      return "AGENT";
    default:
      return "CHAIN";
  }
}

function partToString(part: ContentPart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "file":
      return JSON.stringify({
        fileId: part.fileId,
        filename: part.filename ?? null,
        mediaType: part.mediaType ?? null,
      });
    case "image":
      return JSON.stringify({ imageRef: part.imageRef, mediaType: part.mediaType ?? null });
    case "json":
      return JSON.stringify(part.value);
  }
}

function stringifyParts(parts: ContentPart[]): string {
  return parts.map(partToString).join("\n");
}

function safeJson(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
