import type { CanonicalEvent, ContentPart } from "@lossless-agent-context/core";
import { readStoredClaudeCodeIds, readStoredClaudeCodeIdsForGroup } from "./claude-code-ids";
import {
  emitTargetGroupedLines,
  FOREIGN_FIELD,
  type ForeignEnvelope,
  inferSessionIdForTarget,
  inferWorkingDirectory,
  renderCanonicalEventLine,
} from "./cross-provider";
import { projectToolCallToClaude } from "./tool-projections";
import { deterministicUuid, stringifyToolOutput } from "./utils";

type ClaudeBlock = Record<string, unknown>;
type StoredClaudeLineIds = {
  uuid?: string;
  parentUuid?: string | null;
};

export function exportClaudeCodeJsonl(events: CanonicalEvent[]): string {
  const sessionId = inferSessionIdForTarget(events, "claude-code");
  const cwd = inferWorkingDirectory(events);
  const hasSessionEvent = events.some((event) => event.kind === "session.created");
  let parentUuid: string | null = null;
  let emittedInit = false;
  let syntheticInit: Record<string, unknown> | null = null;
  let emittedIndex = 0;

  function nextUuid(label: string, timestamp: string): string {
    const seed = `${sessionId}:${label}:${timestamp}:${emittedIndex}`;
    emittedIndex += 1;
    return deterministicUuid(seed);
  }

  function readStoredClaudeIds(event: CanonicalEvent | undefined): StoredClaudeLineIds | undefined {
    const record = readStoredClaudeCodeIds(event);
    if (!record) return undefined;
    const ids: StoredClaudeLineIds = {};
    if (typeof record.uuid === "string") ids.uuid = record.uuid;
    if (typeof record.parentUuid === "string" || record.parentUuid === null) ids.parentUuid = record.parentUuid;
    return ids.uuid !== undefined || ids.parentUuid !== undefined ? ids : undefined;
  }

  function storedClaudeIdsForGroup(group: CanonicalEvent[]): StoredClaudeLineIds | undefined {
    const record = readStoredClaudeCodeIdsForGroup(group);
    if (!record) return undefined;
    const ids: StoredClaudeLineIds = {};
    if (typeof record.uuid === "string") ids.uuid = record.uuid;
    if (typeof record.parentUuid === "string" || record.parentUuid === null) ids.parentUuid = record.parentUuid;
    return ids.uuid !== undefined || ids.parentUuid !== undefined ? ids : undefined;
  }

  if (!hasSessionEvent) {
    const first = events[0];
    if (first?.native?.source && first.native.raw !== undefined) {
      const preserved = readStoredClaudeIds(first);
      syntheticInit = {
        type: "system",
        subtype: "init",
        uuid: preserved?.uuid ?? nextUuid("synthetic-init", first.timestamp),
        parentUuid: preserved?.parentUuid ?? null,
        timestamp: first.timestamp,
        sessionId,
      };
      syntheticInit[FOREIGN_FIELD] = { source: first.native.source, raw: first.native.raw };
      if (cwd !== undefined) syntheticInit.cwd = cwd;
      parentUuid = syntheticInit.uuid as string;
    }
  }

  function makeBase(
    timestamp: string,
    sidecar: ForeignEnvelope,
    preserved?: StoredClaudeLineIds,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      uuid: preserved?.uuid ?? nextUuid(String(sidecar.source), timestamp),
      parentUuid: preserved?.parentUuid ?? parentUuid,
      timestamp,
      sessionId,
    };
    base[FOREIGN_FIELD] = sidecar;
    if (cwd !== undefined) base.cwd = cwd;
    return base;
  }

  function emit(line: Record<string, unknown>): Record<string, unknown> {
    const uuidValue = line.uuid;
    if (typeof uuidValue === "string") parentUuid = uuidValue;
    return line;
  }

  const { lines } = emitTargetGroupedLines(events, "claude-code", (group, native) => {
    const first = group[0];
    if (!first) return null;
    const ts = first.timestamp;
    const preserved = storedClaudeIdsForGroup(group);

    if (first.kind === "session.created") {
      if (emittedInit) return null;
      emittedInit = true;
      const extVersion = first.extensions?.version;
      return emit({
        type: "system",
        subtype: "init",
        ...(typeof extVersion === "string" ? { version: extVersion } : {}),
        ...makeBase(ts, native, preserved),
      });
    }

    if (first.kind === "model.selected") {
      return emit({
        type: "system",
        subtype: "model_change",
        provider: first.payload.provider,
        model: first.payload.model,
        ...makeBase(ts, native, preserved),
      });
    }

    const assistantBlocks: ClaudeBlock[] = [];
    const userBlocks: ClaudeBlock[] = [];
    let userTextOnly = "";
    let userTextOnlyCount = 0;

    for (const event of group) {
      if (event.kind === "reasoning.created") {
        assistantBlocks.push({ type: "thinking", thinking: event.payload.text ?? "" });
        continue;
      }
      if (event.kind === "tool.call") {
        const projected = projectToolCallToClaude(event);
        assistantBlocks.push({
          type: "tool_use",
          id: event.payload.toolCallId,
          name: projected?.name ?? event.payload.name,
          input: projected?.input ?? event.payload.arguments ?? {},
        });
        continue;
      }
      if (event.kind === "message.created") {
        const role = event.payload.role;
        const blocksForMessage: ClaudeBlock[] = event.payload.parts.map(partToClaudeBlock);
        if (role === "assistant") {
          for (const block of blocksForMessage) assistantBlocks.push(block);
        } else {
          for (const block of blocksForMessage) userBlocks.push(block);
          if (blocksForMessage.every((b) => b.type === "text")) {
            const text = blocksForMessage.map((b) => (typeof b.text === "string" ? b.text : "")).join("");
            userTextOnly = userTextOnly.length > 0 ? `${userTextOnly}\n${text}` : text;
            userTextOnlyCount++;
          } else {
            userTextOnly = "";
            userTextOnlyCount = -1;
          }
        }
        continue;
      }
      if (event.kind === "tool.result") {
        userBlocks.push({
          type: "tool_result",
          tool_use_id: event.payload.toolCallId,
          content: toolResultContentForClaude(event.payload.output),
          is_error: event.payload.isError,
        });
      }
    }

    if (assistantBlocks.length > 0 && userBlocks.length === 0) {
      return emit({
        type: "assistant",
        ...makeBase(ts, native, preserved),
        message: { role: "assistant", content: assistantBlocks },
      });
    }

    if (userBlocks.length > 0 && assistantBlocks.length === 0) {
      const onlyText = userTextOnlyCount > 0 && userTextOnlyCount === userBlocks.length;
      const content: string | ClaudeBlock[] = onlyText ? userTextOnly : userBlocks;
      return emit({
        type: "user",
        ...makeBase(ts, native, preserved),
        message: { role: "user", content },
      });
    }

    const canonicalLines = group.map((event) => renderCanonicalEventLine(event, native));
    return canonicalLines.length > 0 ? canonicalLines : null;
  });

  if (syntheticInit) lines.unshift(JSON.stringify(syntheticInit));

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function partToClaudeBlock(part: ContentPart): ClaudeBlock {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType ?? "image/png",
          data: part.imageRef,
        },
      };
    case "file":
      return {
        type: "text",
        text: JSON.stringify({
          fileId: part.fileId,
          filename: part.filename ?? null,
          mediaType: part.mediaType ?? null,
        }),
      };
    case "json":
      return { type: "text", text: JSON.stringify(part.value) };
  }
}

function toolResultContentForClaude(output: unknown): string | unknown[] {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output;
  return stringifyToolOutput(output);
}
