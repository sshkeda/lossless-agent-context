import { createHash } from "node:crypto";
import type { CanonicalEvent, ContentPart } from "@lossless-agent-context/core";
import { CANONICAL_SCHEMA_VERSION, canonicalEventSchema } from "@lossless-agent-context/core";

export { DEFAULT_BRANCH_ID } from "./defaults";

export function parseJsonl(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSONL at line ${index + 1}: ${message}`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid JSONL at line ${index + 1}: expected an object`);
      }
      return parsed as Record<string, unknown>;
    });
}

export function toIsoTimestamp(value: unknown, label = "timestamp"): string {
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  throw new Error(`Invalid ${label}`);
}

export function epochMillisToIso(value: number, label = "timestamp"): string {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  throw new Error(`Invalid ${label}`);
}

export function epochSecondsToIso(value: number, label = "timestamp"): string {
  return epochMillisToIso(value * 1000, label);
}

export function isoTimestampToEpochMs(value: string, label = "timestamp"): number {
  const millis = Date.parse(value);
  if (Number.isFinite(millis)) return millis;
  throw new Error(`Invalid ${label}`);
}

export function deterministicHex(seed: string, length: number): string {
  const digest = createHash("sha256").update(seed).digest("hex");
  return digest.slice(0, length);
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const next = sortJsonValue(record[key]);
    if (next !== undefined) sorted[key] = next;
  }
  return sorted;
}

export const SYNTHETIC_TIMESTAMP_EXTENSION = "lac:syntheticTimestamp";

export function syntheticSessionId(source: string, seed: unknown): string {
  const normalizedSource =
    source
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "session";
  const serializedSeed = typeof seed === "string" ? seed : stableJsonStringify(seed);
  return `${normalizedSource}-session-${deterministicHex(serializedSeed, 12)}`;
}

export function withSyntheticTimestampExtension(
  extensions?: Record<string, unknown>,
  synthetic = true,
): Record<string, unknown> | undefined {
  if (!synthetic) return extensions;
  return { ...(extensions ?? {}), [SYNTHETIC_TIMESTAMP_EXTENSION]: true };
}

export function deterministicPiId(seed: string): string {
  return deterministicHex(seed, 8);
}

export function deterministicUuid(seed: string): string {
  const hex = deterministicHex(seed, 32).split("");
  hex[12] = "4";
  const variantNibble = parseInt(hex[16] ?? "0", 16);
  hex[16] = ((variantNibble & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

export function createEvent(
  events: CanonicalEvent[],
  input: Omit<CanonicalEvent, "schemaVersion" | "eventId" | "seq">,
): CanonicalEvent {
  const event = canonicalEventSchema.parse(
    Object.fromEntries(
      Object.entries({
        ...input,
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: `${input.sessionId}:${String(events.length).padStart(6, "0")}`,
        seq: events.length,
      }).filter(([, value]) => value !== undefined),
    ),
  );
  events.push(event);
  return event;
}

export function textPart(text: string): ContentPart {
  return { type: "text", text };
}

export function parseStrictJson(value: string, label = "JSON"): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label}: ${message}`);
  }
}

export function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output ?? null);
}

export function toolActor(toolName?: string): { type: "tool"; toolName?: string } {
  return toolName ? { type: "tool", toolName } : { type: "tool" };
}

export function nativeForLine(line: Record<string, unknown>, defaultSource: string): { source: string; raw: unknown } {
  const sidecar = line.__lac_foreign;
  if (sidecar && typeof sidecar === "object" && !Array.isArray(sidecar)) {
    const record = sidecar as Record<string, unknown>;
    if (typeof record.source === "string") {
      return { source: record.source, raw: record.raw };
    }
  }
  return { source: defaultSource, raw: line };
}

export function withNativeRawRef<T extends { source: string; raw: unknown }>(
  native: T,
  rawRef: string | undefined,
): T & { rawRef?: string } {
  return rawRef ? { ...native, rawRef } : native;
}
