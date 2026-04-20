import type { CanonicalEvent } from "@lossless-agent-context/core";
import { CLAUDE_CODE_IDS_EXTENSION, TARGET_IDS_FIELD } from "./defaults";
import { stableJsonStringify } from "./utils";

export type JsonRecord = Record<string, unknown>;

export function readClaudeCodeIds(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

export function readStoredClaudeCodeIds(event: CanonicalEvent | undefined): JsonRecord | undefined {
  return readClaudeCodeIds(event?.extensions?.[CLAUDE_CODE_IDS_EXTENSION]);
}

export function readStoredClaudeCodeIdsForGroup(group: CanonicalEvent[]): JsonRecord | undefined {
  const first = group.map(readStoredClaudeCodeIds).find((value) => value !== undefined);
  if (!first) return undefined;
  const firstKey = stableJsonStringify(first);
  for (const event of group) {
    const next = readStoredClaudeCodeIds(event);
    if (next !== undefined && stableJsonStringify(next) !== firstKey) return undefined;
  }
  return first;
}

export function readClaudeCodeIdsFromTargetIds(line: Record<string, unknown>): JsonRecord | undefined {
  const targets = line[TARGET_IDS_FIELD];
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) return undefined;
  return readClaudeCodeIds((targets as JsonRecord)["claude-code"]);
}

export function claudeCodeTargetIdExtensions(line: Record<string, unknown>): Record<string, unknown> | undefined {
  const claudeIds = readClaudeCodeIdsFromTargetIds(line);
  return claudeIds ? { [CLAUDE_CODE_IDS_EXTENSION]: claudeIds } : undefined;
}

export function attachClaudeCodeTargetIds(
  line: Record<string, unknown>,
  ids: JsonRecord | undefined,
): Record<string, unknown> {
  if (!ids) return line;
  const targets = line[TARGET_IDS_FIELD];
  const nextTargets =
    targets && typeof targets === "object" && !Array.isArray(targets) ? { ...(targets as JsonRecord) } : {};
  nextTargets["claude-code"] = ids;
  line[TARGET_IDS_FIELD] = nextTargets;
  return line;
}
