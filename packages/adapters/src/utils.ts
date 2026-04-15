import type { CanonicalEvent, ContentPart } from "@lossless-agent-context/core";
import { canonicalEventSchema } from "@lossless-agent-context/core";

export const DEFAULT_BRANCH_ID = "main";

export function parseJsonl(text: string): unknown[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

export function toIsoTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  if (typeof value === "number") {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }

  return new Date(0).toISOString();
}

export function createEvent(
  events: CanonicalEvent[],
  input: Omit<CanonicalEvent, "schemaVersion" | "eventId" | "seq">,
): CanonicalEvent {
  const event = canonicalEventSchema.parse({
    ...input,
    schemaVersion: "0.0.1",
    eventId: `${input.sessionId}:${String(events.length).padStart(6, "0")}`,
    seq: events.length,
  });
  events.push(event);
  return event;
}

export function textPart(text: string): ContentPart {
  return { type: "text", text };
}

export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function contentPartsFromUnknown(value: unknown): ContentPart[] {
  if (typeof value === "string") {
    return value.length > 0 ? [textPart(value)] : [];
  }

  if (Array.isArray(value)) {
    const parts = value.flatMap(contentPartsFromUnknownPart);
    return parts;
  }

  if (value && typeof value === "object") {
    return [{ type: "json", value }];
  }

  return [];
}

function contentPartsFromUnknownPart(value: unknown): ContentPart[] {
  if (!value || typeof value !== "object") {
    return contentPartsFromUnknown(value);
  }

  const record = value as Record<string, unknown>;
  const type = record.type;

  if (type === "text" && typeof record.text === "string") {
    return [{ type: "text", text: record.text }];
  }

  if (type === "image" && typeof record.data === "string") {
    return [{
      type: "image",
      imageRef: record.data,
      mediaType: typeof record.mimeType === "string" ? record.mimeType : undefined,
    }];
  }

  if (type === "file") {
    return [{
      type: "file",
      fileId: typeof record.fileId === "string" ? record.fileId : "unknown-file",
      filename: typeof record.filename === "string" ? record.filename : undefined,
      mediaType: typeof record.mediaType === "string" ? record.mediaType : undefined,
    }];
  }

  return [{ type: "json", value: record }];
}
