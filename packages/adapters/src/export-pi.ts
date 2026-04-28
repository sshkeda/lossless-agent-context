import type { CanonicalEvent, ContentPart } from "@lossless-agent-context/core";
import { attachClaudeCodeTargetIds, readStoredClaudeCodeIds, readStoredClaudeCodeIdsForGroup } from "./claude-code-ids";
import {
  emitTargetGroupedLines,
  FOREIGN_FIELD,
  type ForeignEnvelope,
  inferSessionIdForTarget,
  inferWorkingDirectory,
  renderCanonicalEventLine,
} from "./cross-provider";
import { PI_SESSION_VERSION } from "./defaults";
import { deterministicPiId, isoTimestampToEpochMs, stringifyToolOutput } from "./utils";
import { normalizePiMcpToolName } from "./tool-projections";

type PiBlock = Record<string, unknown>;
type StoredClaudeLineIds = Record<string, unknown> | undefined;

const PI_CLAUDE_CODE_TOOL_PROVENANCE_KEY = "pi-claude-code/toolProvenance";

function toolProvenanceDetailsForGroup(group: CanonicalEvent[]): Record<string, unknown> | undefined {
  const byId: Record<string, unknown> = {};
  for (const event of group) {
    if (event.kind !== "tool.call") continue;
    const provenance = event.extensions?.[PI_CLAUDE_CODE_TOOL_PROVENANCE_KEY];
    if (provenance !== undefined) byId[event.payload.toolCallId] = provenance;
  }
  return Object.keys(byId).length > 0 ? { [PI_CLAUDE_CODE_TOOL_PROVENANCE_KEY]: byId } : undefined;
}

export function exportPiSessionJsonl(events: CanonicalEvent[]): string {
  const sessionId = inferSessionIdForTarget(events, "pi");
  const cwd = inferWorkingDirectory(events);
  const hasSessionEvent = events.some((event) => event.kind === "session.created");
  const toolNameByCallId = new Map(
    events
      .filter((event): event is Extract<CanonicalEvent, { kind: "tool.call" }> => event.kind === "tool.call")
      .map((event) => [event.payload.toolCallId, normalizePiMcpToolName(event.payload.name)] as const),
  );
  let parentId: string | null = null;
  let emittedSession = false;
  let emittedIndex = 0;

  function attachTargetIds(line: Record<string, unknown>, ids: StoredClaudeLineIds): Record<string, unknown> {
    return attachClaudeCodeTargetIds(line, ids);
  }

  function nextPiId(label: string, timestamp: string): string {
    const seed = `${sessionId}:${label}:${timestamp}:${emittedIndex}`;
    emittedIndex += 1;
    return deterministicPiId(seed);
  }

  function makeBase(timestamp: string, sidecar: ForeignEnvelope): Record<string, unknown> {
    const base: Record<string, unknown> = {
      id: nextPiId(String(sidecar.source), timestamp),
      parentId,
      timestamp,
    };
    base[FOREIGN_FIELD] = sidecar;
    return base;
  }

  function assistantUsageForGroup(group: CanonicalEvent[]): Record<string, number> {
    const cache = group.find((event) => event.cache)?.cache;
    const usage: Record<string, number> = {};
    if (cache?.totalTokens !== undefined) usage.totalTokens = cache.totalTokens;
    if (cache?.inputTokens !== undefined) usage.input = cache.inputTokens;
    if (cache?.outputTokens !== undefined) usage.output = cache.outputTokens;
    if (cache?.readTokens !== undefined) usage.cacheRead = cache.readTokens;
    if (cache?.writeTokens !== undefined) usage.cacheWrite = cache.writeTokens;
    return usage;
  }

  function emit(line: Record<string, unknown>): Record<string, unknown> {
    const idValue = line.id;
    if (typeof idValue === "string") parentId = idValue;
    return line;
  }

  const { lines } = emitTargetGroupedLines(events, "pi", (group, native) => {
    const first = group[0];
    if (!first) return null;
    const ts = first.timestamp;
    const ms = epochMs(ts);
    const claudeIds = readStoredClaudeCodeIdsForGroup(group);

    if (first.kind === "session.created") {
      if (emittedSession) return null;
      emittedSession = true;
      const line: Record<string, unknown> = {
        type: "session",
        version: PI_SESSION_VERSION,
        id: sessionId,
        timestamp: ts,
      };
      line[FOREIGN_FIELD] = native;
      if (cwd !== undefined) line.cwd = cwd;
      return attachTargetIds(line, claudeIds);
    }

    if (first.kind === "model.selected") {
      return attachTargetIds(
        emit({
          type: "model_change",
          ...makeBase(ts, native),
          provider: first.payload.provider,
          modelId: first.payload.model,
        }),
        claudeIds,
      );
    }

    if (first.kind === "tool.result") {
      const toolResult = first as Extract<CanonicalEvent, { kind: "tool.result" }>;
      const output = toolResult.payload.output;
      const text = stringifyToolOutput(output);
      const toolName = toolResult.actor?.toolName
        ? normalizePiMcpToolName(toolResult.actor.toolName)
        : toolNameByCallId.get(toolResult.payload.toolCallId);
      const message: Record<string, unknown> = {
        role: "toolResult",
        toolCallId: toolResult.payload.toolCallId,
        content: [{ type: "text", text }],
        isError: toolResult.payload.isError,
        timestamp: ms,
      };
      if (toolName !== undefined) message.toolName = toolName;
      if (toolResult.payload.details !== undefined) message.details = toolResult.payload.details;
      return attachTargetIds(
        emit({
          type: "message",
          ...makeBase(ts, native),
          message,
        }),
        claudeIds,
      );
    }

    const assistantBlocks: PiBlock[] = [];
    const userBlocksRich: PiBlock[] = [];
    const systemBlocks: PiBlock[] = [];
    let userText = "";
    let systemText = "";
    let userCount = 0;
    let systemCount = 0;

    for (const event of group) {
      if (event.kind === "reasoning.created") {
        assistantBlocks.push({ type: "thinking", thinking: event.payload.text ?? "" });
        continue;
      }
      if (event.kind === "tool.call") {
        assistantBlocks.push({
          type: "toolCall",
          id: event.payload.toolCallId,
          name: normalizePiMcpToolName(event.payload.name),
          arguments: event.payload.arguments ?? {},
        });
        continue;
      }
      if (event.kind === "message.created") {
        const role = event.payload.role;
        if (role === "assistant") {
          for (const part of event.payload.parts) {
            assistantBlocks.push(partToPiBlock(part));
          }
        } else {
          const messageBlocks = event.payload.parts.map(partToPiBlock);
          const allText = messageBlocks.every((b) => b.type === "text");
          if (role === "system") {
            if (allText) {
              const text = messageBlocks.map((b) => (typeof b.text === "string" ? b.text : "")).join("");
              systemText = systemText.length > 0 ? `${systemText}\n${text}` : text;
            } else {
              for (const block of messageBlocks) systemBlocks.push(block);
            }
            systemCount++;
          } else {
            if (allText) {
              const text = messageBlocks.map((b) => (typeof b.text === "string" ? b.text : "")).join("");
              userText = userText.length > 0 ? `${userText}\n${text}` : text;
            } else {
              for (const block of messageBlocks) userBlocksRich.push(block);
            }
            userCount++;
          }
        }
      }
    }

    if (assistantBlocks.length > 0) {
      const message: Record<string, unknown> = {
        role: "assistant",
        content: assistantBlocks,
        usage: assistantUsageForGroup(group),
        timestamp: ms,
      };
      const details = toolProvenanceDetailsForGroup(group);
      if (details) message.details = details;
      return attachTargetIds(
        emit({
          type: "message",
          ...makeBase(ts, native),
          message,
        }),
        claudeIds,
      );
    }

    if (userCount > 0) {
      const content: PiBlock[] =
        userBlocksRich.length > 0
          ? userText.length > 0
            ? [{ type: "text", text: userText }, ...userBlocksRich]
            : userBlocksRich
          : [{ type: "text", text: userText }];
      return attachTargetIds(
        emit({
          type: "message",
          ...makeBase(ts, native),
          message: {
            role: "user",
            content,
            timestamp: ms,
          },
        }),
        claudeIds,
      );
    }

    if (systemCount > 0) {
      const content: PiBlock[] =
        systemBlocks.length > 0
          ? systemText.length > 0
            ? [{ type: "text", text: systemText }, ...systemBlocks]
            : systemBlocks
          : [{ type: "text", text: systemText }];
      return attachTargetIds(
        emit({
          type: "message",
          ...makeBase(ts, native),
          message: {
            role: "system",
            content,
            timestamp: ms,
          },
        }),
        claudeIds,
      );
    }

    const canonicalLines = group.map((event) =>
      attachTargetIds(
        emit({
          ...makeBase(event.timestamp, native),
          ...renderCanonicalEventLine(event, native),
        }),
        readStoredClaudeCodeIds(event),
      ),
    );
    return canonicalLines.length > 0 ? canonicalLines : null;
  });

  if (!hasSessionEvent) {
    const first = events[0];
    if (first?.native?.source && first.native.raw !== undefined) {
      const synthetic: Record<string, unknown> = {
        type: "session",
        version: PI_SESSION_VERSION,
        id: sessionId,
        timestamp: first.timestamp,
      };
      synthetic[FOREIGN_FIELD] = { source: first.native.source, raw: first.native.raw };
      if (cwd !== undefined) synthetic.cwd = cwd;
      attachTargetIds(synthetic, readStoredClaudeCodeIds(first));
      lines.unshift(JSON.stringify(synthetic));
    }
  }

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function epochMs(iso: string): number {
  return isoTimestampToEpochMs(iso, "canonical event timestamp");
}

function partToPiBlock(part: ContentPart): PiBlock {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return {
        type: "image",
        data: part.imageRef,
        mimeType: part.mediaType ?? "image/png",
      };
    case "file":
      return {
        type: "file",
        fileId: part.fileId,
        filename: part.filename ?? null,
        mediaType: part.mediaType ?? null,
      };
    case "json":
      return { type: "text", text: JSON.stringify(part.value) };
  }
}
