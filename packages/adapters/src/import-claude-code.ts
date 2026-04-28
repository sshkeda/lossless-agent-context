import type { CanonicalEvent } from "@lossless-agent-context/core";
import {
  applyCanonicalOverridesToRange,
  importEmbeddedCrossProviderLine,
  isForeignLine,
  readCanonicalOverrides,
} from "./cross-provider";
import { CLAUDE_CODE_IDS_EXTENSION } from "./defaults";
import { type LosslessSidecar, readDemotedReasoningByContentIndex } from "./recovery-sidecar";
import {
  createEvent,
  DEFAULT_BRANCH_ID,
  nativeForLine,
  parseJsonlWithText,
  syntheticSessionId,
  toIsoTimestamp,
  toolActor,
  withNativeRawRef,
  withSyntheticTimestampExtension,
} from "./utils";
import { projectClaudeToolCallToPi } from "./tool-projections";

type Extensions = Record<string, unknown> | undefined;
const TOOL_RESULT_DETAILS_KEY = "lossless-agent-context/toolResultDetails";

// Recovery markers for one-way cross-format transforms (e.g. demoting
// foreign-unsigned thinking to `<thinking>`-wrapped text) live in a
// SIDECAR file outside the JSONL — see recovery-sidecar.ts. The lookup
// helper there takes a parsed sidecar plus a line uuid and returns the
// markers for that line. We pass the sidecar in via the importer's
// options parameter; callers without a sidecar (e.g. importing a
// claude-code session that wasn't produced by lac) get a no-op recovery
// path and the importer falls through to default handling.
type ResolvedClaudeLineTimestamp = {
  synthetic: boolean;
  value: string;
};

function lineExtensions(line: Record<string, unknown>, extra?: Record<string, unknown>): Extensions {
  const merged: Record<string, unknown> = {};
  const claudeIds: Record<string, unknown> = {};

  if (typeof line.uuid === "string") claudeIds.uuid = line.uuid;
  if (typeof line.parentUuid === "string" || line.parentUuid === null) claudeIds.parentUuid = line.parentUuid;
  if (Object.keys(claudeIds).length > 0) merged[CLAUDE_CODE_IDS_EXTENSION] = claudeIds;
  if (extra) Object.assign(merged, extra);

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function cacheFromClaudeMessage(message: Record<string, unknown> | undefined): CanonicalEvent["cache"] | undefined {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  const readTokens = typeof record.cache_read_input_tokens === "number" ? record.cache_read_input_tokens : undefined;
  const writeTokens =
    typeof record.cache_creation_input_tokens === "number" ? record.cache_creation_input_tokens : undefined;
  const inputTokens = typeof record.input_tokens === "number" ? record.input_tokens : undefined;
  const outputTokens = typeof record.output_tokens === "number" ? record.output_tokens : undefined;
  const totalTokens =
    inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined;
  if (
    readTokens === undefined &&
    writeTokens === undefined &&
    inputTokens === undefined &&
    outputTokens === undefined &&
    record.cache_creation === undefined
  ) {
    return undefined;
  }
  return {
    provider: "anthropic",
    readTokens,
    writeTokens,
    inputTokens,
    outputTokens,
    totalTokens,
    details:
      record.cache_creation && typeof record.cache_creation === "object" && !Array.isArray(record.cache_creation)
        ? { cache_creation: record.cache_creation }
        : undefined,
  };
}

function resolveClaudeLineTimestamp(line: Record<string, unknown>): ResolvedClaudeLineTimestamp {
  if (typeof line.timestamp === "string") {
    return {
      synthetic: false,
      value: toIsoTimestamp(line.timestamp, "Claude line timestamp"),
    };
  }

  if (line.type === "file-history-snapshot") {
    const snapshot = line.snapshot;
    if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
      const snapshotTimestamp = (snapshot as Record<string, unknown>).timestamp;
      if (typeof snapshotTimestamp === "string") {
        return {
          synthetic: false,
          value: toIsoTimestamp(snapshotTimestamp, "Claude line timestamp"),
        };
      }
    }
  }

  if (line.type === "last-prompt" || line.type === "permission-mode") {
    return {
      synthetic: true,
      value: new Date(0).toISOString(),
    };
  }

  throw new Error("Invalid Claude line timestamp");
}

function structuredToolResultDetailsFromClaudeRecord(record: Record<string, unknown>): unknown {
  const structuredContent = record.structuredContent;
  if (!structuredContent || typeof structuredContent !== "object" || Array.isArray(structuredContent)) return undefined;
  return (structuredContent as Record<string, unknown>)[TOOL_RESULT_DETAILS_KEY];
}

type ClaudeStructuredPatchHunk = {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  lines?: unknown;
};

function normalizedEditToolResultDetailsFromClaudeLine(line: Record<string, unknown>): Record<string, unknown> | undefined {
  const toolUseResult = line.toolUseResult;
  if (!toolUseResult || typeof toolUseResult !== "object" || Array.isArray(toolUseResult)) return undefined;
  const record = toolUseResult as Record<string, unknown>;
  const structuredPatch = Array.isArray(record.structuredPatch)
    ? (record.structuredPatch as ClaudeStructuredPatchHunk[])
    : undefined;
  if (!structuredPatch || structuredPatch.length === 0) return undefined;

  const hunks = structuredPatch.filter(
    (hunk) =>
      hunk &&
      typeof hunk === "object" &&
      typeof hunk.oldStart === "number" &&
      typeof hunk.newStart === "number" &&
      Array.isArray(hunk.lines),
  );
  if (hunks.length === 0) return undefined;

  const maxLine = hunks.reduce((max, hunk) => {
    const oldEnd = typeof hunk.oldStart === "number" && typeof hunk.oldLines === "number"
      ? hunk.oldStart + hunk.oldLines - 1
      : 0;
    const newEnd = typeof hunk.newStart === "number" && typeof hunk.newLines === "number"
      ? hunk.newStart + hunk.newLines - 1
      : 0;
    return Math.max(max, oldEnd, newEnd);
  }, 0);
  const lineNumWidth = String(Math.max(maxLine, 1)).length;
  const blankLineNum = "".padStart(lineNumWidth, " ");
  const output: string[] = [];

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    if (i > 0) output.push(` ${blankLineNum} ...`);
    let oldLine = hunk.oldStart ?? 1;
    let newLine = hunk.newStart ?? 1;

    for (const rawLine of hunk.lines as unknown[]) {
      if (typeof rawLine !== "string") continue;
      if (rawLine.startsWith("+")) {
        output.push(`+${String(newLine).padStart(lineNumWidth, " ")} ${rawLine.slice(1)}`);
        newLine++;
        continue;
      }
      if (rawLine.startsWith("-")) {
        output.push(`-${String(oldLine).padStart(lineNumWidth, " ")} ${rawLine.slice(1)}`);
        oldLine++;
        continue;
      }
      const text = rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine;
      output.push(` ${String(oldLine).padStart(lineNumWidth, " ")} ${text}`);
      oldLine++;
      newLine++;
    }
  }

  return {
    diff: output.join("\n"),
    firstChangedLine: hunks[0]?.newStart,
    claudeToolUseResult: record,
  };
}

function toolResultDetailsFromClaudeRecord(
  record: Record<string, unknown>,
  line: Record<string, unknown>,
  toolName: string | undefined,
): unknown {
  const structured = structuredToolResultDetailsFromClaudeRecord(record);
  const editDetails = toolName === "edit" ? normalizedEditToolResultDetailsFromClaudeLine(line) : undefined;
  if (structured === undefined) return editDetails;
  if (!editDetails) return structured;
  if (typeof structured === "object" && structured !== null && !Array.isArray(structured)) {
    return { ...(structured as Record<string, unknown>), ...editDetails };
  }
  return { structuredToolResultDetails: structured, ...editDetails };
}

/**
 * Imports a claude-code session JSONL plus its recovery sidecar.
 *
 * The sidecar parameter is REQUIRED. If the session has no recovery markers
 * (e.g. a native claude session that wasn't produced by lac), pass
 * `emptySidecar()` from `recovery-sidecar.ts`. Forcing every caller to
 * explicitly hand in a sidecar (or an empty one) prevents the silent
 * recovery-loss bug where a caller forgets to load the sidecar from disk
 * and silently degrades round-trip fidelity. See AGENTS.md ("mark, don't
 * infer").
 */
export function importClaudeCodeJsonl(text: string, sidecar: LosslessSidecar): CanonicalEvent[] {
  const entries = parseJsonlWithText(text);
  const lines = entries.map((entry) => entry.line);
  const events: CanonicalEvent[] = [];

  const firstNativeLine = lines.find((line) => !isForeignLine(line) && typeof line.sessionId === "string");
  let currentSessionId =
    typeof firstNativeLine?.sessionId === "string"
      ? firstNativeLine.sessionId
      : syntheticSessionId("claude-code", text);
  const createdSessions = new Set<string>();
  const toolNameByCallId = new Map<string, string>();

  function ensureSession(
    line: Record<string, unknown>,
    lineText: string,
    sessionId: string,
    sessionTimestamp: string,
    syntheticTimestamp: boolean,
  ) {
    if (createdSessions.has(sessionId)) return;
    createdSessions.add(sessionId);
    const native = withNativeRawRef(nativeForLine(line, "claude-code", lineText), "session");
    const version = native.source === "claude-code" && typeof line.version === "string" ? line.version : undefined;
    createEvent(events, {
      sessionId,
      branchId: DEFAULT_BRANCH_ID,
      timestamp: sessionTimestamp,
      kind: "session.created",
      payload: {
        startedAt: sessionTimestamp,
        workingDirectory: typeof line.cwd === "string" ? line.cwd : undefined,
      },
      extensions: withSyntheticTimestampExtension(
        lineExtensions(line, version !== undefined ? { version } : undefined),
        syntheticTimestamp,
      ),
      native,
    });
  }

  for (const entry of entries) {
    const { line, text: lineText } = entry;
    if (typeof line.sessionId === "string") currentSessionId = line.sessionId;
    const sessionId = currentSessionId;
    const branchId = DEFAULT_BRANCH_ID;
    const beforeIndex = events.length;
    const overrides = readCanonicalOverrides(line);
    const { synthetic: syntheticTimestamp, value: lineTimestamp } = resolveClaudeLineTimestamp(line);
    try {
      const embedded = importEmbeddedCrossProviderLine(
        line,
        "claude-code",
        sessionId,
        branchId,
        events.length,
        lineTimestamp,
      );
      if (embedded) {
        for (const event of embedded) events.push(event);
        continue;
      }

      if (line.type !== "last-prompt") ensureSession(line, lineText, sessionId, lineTimestamp, syntheticTimestamp);
      const baseNative = nativeForLine(line, "claude-code", lineText);
      const native = (rawRef?: string) => withNativeRawRef(baseNative, rawRef);

      switch (line.type) {
        case "last-prompt": {
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: lineTimestamp,
            kind: "provider.event",
            payload: {
              provider: "claude-code",
              eventType: "last-prompt",
              raw: line,
            },
            extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
            native: native("last-prompt"),
          });
          break;
        }
        case "user": {
          const message = line.message as Record<string, unknown> | undefined;
          const content = message?.content;
          if (typeof content === "string") {
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: lineTimestamp,
              kind: "message.created",
              actor: { type: "user" },
              payload: { role: "user", parts: [{ type: "text", text: content }] },
              extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
              native: native("user.message"),
            });
            break;
          }

          if (Array.isArray(content)) {
            for (const [partIndex, part] of content.entries()) {
              if (!part || typeof part !== "object") continue;
              const record = part as Record<string, unknown>;

              if (record.type === "tool_result") {
                if (typeof record.tool_use_id !== "string") {
                  createEvent(events, {
                    sessionId,
                    branchId,
                    timestamp: lineTimestamp,
                    kind: "provider.event",
                    payload: {
                      provider: "claude-code",
                      eventType: "tool_result.invalid",
                      raw: line,
                    },
                    extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
                    native: native(`user.content[${partIndex}].tool_result.invalid`),
                  });
                  continue;
                }
                const toolCallId = record.tool_use_id;
                const toolName = toolNameByCallId.get(toolCallId);
                const details = toolResultDetailsFromClaudeRecord(record, line, toolName);
                createEvent(events, {
                  sessionId,
                  branchId,
                  timestamp: lineTimestamp,
                  kind: "tool.result",
                  actor: toolActor(toolName),
                  payload: {
                    toolCallId,
                    output: record.content,
                    isError: Boolean(record.is_error),
                    ...(details !== undefined ? { details } : {}),
                  },
                  extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
                  native: native(`user.content[${partIndex}].tool_result`),
                });
                continue;
              }

              if (record.type === "text" && typeof record.text === "string") {
                createEvent(events, {
                  sessionId,
                  branchId,
                  timestamp: lineTimestamp,
                  kind: "message.created",
                  actor: { type: "user" },
                  payload: { role: "user", parts: [{ type: "text", text: record.text }] },
                  extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
                  native: native(`user.content[${partIndex}].text`),
                });
                continue;
              }

              if (record.type === "image") {
                const source = record.source as Record<string, unknown> | undefined;
                const data = typeof source?.data === "string" ? source.data : undefined;
                const mediaType = typeof source?.media_type === "string" ? source.media_type : undefined;
                if (data) {
                  createEvent(events, {
                    sessionId,
                    branchId,
                    timestamp: lineTimestamp,
                    kind: "message.created",
                    actor: { type: "user" },
                    payload: {
                      role: "user",
                      parts: [{ type: "image", imageRef: data, mediaType }],
                    },
                    extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
                    native: native(`user.content[${partIndex}].image`),
                  });
                }
                continue;
              }

              createEvent(events, {
                sessionId,
                branchId,
                timestamp: lineTimestamp,
                kind: "message.created",
                actor: { type: "user" },
                payload: { role: "user", parts: [{ type: "json", value: record }] },
                extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
                native: native(
                  `user.content[${partIndex}].${typeof record.type === "string" ? record.type : "unknown"}`,
                ),
              });
            }
          }
          break;
        }
        case "assistant": {
          const message = line.message as Record<string, unknown> | undefined;
          const content = Array.isArray(message?.content) ? message?.content : [];
          const cache = cacheFromClaudeMessage(message);
          const demotedReasoningByIndex = readDemotedReasoningByContentIndex(
            sidecar,
            typeof line.uuid === "string" ? line.uuid : undefined,
          );

          for (const [partIndex, part] of content.entries()) {
            if (!part || typeof part !== "object") continue;
            const record = part as Record<string, unknown>;

            if (record.type === "thinking") {
              createEvent(events, {
                sessionId,
                branchId,
                timestamp: lineTimestamp,
                kind: "reasoning.created",
                actor: { type: "assistant" },
                payload: {
                  visibility: "full",
                  text: typeof record.thinking === "string" ? record.thinking : undefined,
                  providerExposed: true,
                },
                cache,
                extensions: withSyntheticTimestampExtension(
                  lineExtensions(
                    line,
                    typeof record.signature === "string" ? { signature: record.signature } : undefined,
                  ),
                  syntheticTimestamp,
                ),
                native: native(`assistant.content[${partIndex}].thinking`),
              });
              continue;
            }

            if (record.type === "text" && typeof record.text === "string") {
              // Recovery for the cross-provider thinking demotion: a previous
              // pass through prepareClaudeCodeResumeSeed wrapped foreign
              // (unsigned) thinking blocks in `<thinking>...</thinking>` text
              // and recorded the original chain-of-thought in the line
              // wrapper's `losslessAgentContext.demotedReasoning[]` keyed by
              // contentIndex. If this text block was one of those, restore
              // the canonical `reasoning.created` event using the recorded
              // text — exact, deterministic, no regex.
              const demotedReasoningText = demotedReasoningByIndex.get(partIndex);
              if (demotedReasoningText !== undefined) {
                createEvent(events, {
                  sessionId,
                  branchId,
                  timestamp: lineTimestamp,
                  kind: "reasoning.created",
                  actor: { type: "assistant" },
                  payload: {
                    visibility: "summary",
                    text: demotedReasoningText,
                    providerExposed: true,
                  },
                  cache,
                  extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
                  native: native(`assistant.content[${partIndex}].text.demoted_thinking`),
                });
                continue;
              }
              createEvent(events, {
                sessionId,
                branchId,
                timestamp: lineTimestamp,
                kind: "message.created",
                actor: { type: "assistant" },
                payload: { role: "assistant", parts: [{ type: "text", text: record.text }] },
                cache,
                extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
                native: native(`assistant.content[${partIndex}].text`),
              });
              continue;
            }

            if (record.type === "tool_use") {
              if (typeof record.id !== "string" || typeof record.name !== "string") {
                createEvent(events, {
                  sessionId,
                  branchId,
                  timestamp: lineTimestamp,
                  kind: "provider.event",
                  payload: {
                    provider: "claude-code",
                    eventType: "tool_use.invalid",
                    raw: line,
                  },
                  cache,
                  extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
                  native: native(`assistant.content[${partIndex}].tool_use.invalid`),
                });
                continue;
              }
              const toolCallId = record.id;
              const projected = projectClaudeToolCallToPi(record.name, record.input);
              toolNameByCallId.set(toolCallId, projected.name);
              createEvent(events, {
                sessionId,
                branchId,
                timestamp: lineTimestamp,
                kind: "tool.call",
                actor: {
                  type: "assistant",
                  toolName: projected.name,
                },
                payload: {
                  toolCallId,
                  name: projected.name,
                  arguments: projected.arguments,
                },
                cache,
                extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
                native: native(`assistant.content[${partIndex}].tool_use`),
              });
              continue;
            }

            if (record.type === "image") {
              const source = record.source as Record<string, unknown> | undefined;
              const data = typeof source?.data === "string" ? source.data : undefined;
              const mediaType = typeof source?.media_type === "string" ? source.media_type : undefined;
              if (data) {
                createEvent(events, {
                  sessionId,
                  branchId,
                  timestamp: lineTimestamp,
                  kind: "message.created",
                  actor: { type: "assistant" },
                  payload: {
                    role: "assistant",
                    parts: [{ type: "image", imageRef: data, mediaType }],
                  },
                  cache,
                  extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
                  native: native(`assistant.content[${partIndex}].image`),
                });
              }
            }
          }
          break;
        }
        case "system": {
          if (line.subtype === "model_change") {
            if (typeof line.provider !== "string" || typeof line.model !== "string") {
              createEvent(events, {
                sessionId,
                branchId,
                timestamp: lineTimestamp,
                kind: "provider.event",
                payload: {
                  provider: "claude-code",
                  eventType: "model_change.invalid",
                  raw: line,
                },
                extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
                native: native("system.model_change.invalid"),
              });
              break;
            }
            createEvent(events, {
              sessionId,
              branchId,
              timestamp: lineTimestamp,
              kind: "model.selected",
              payload: {
                provider: line.provider,
                model: line.model,
              },
              extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
              native: native("system.model_change"),
            });
            break;
          }
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: lineTimestamp,
            kind: "provider.event",
            payload: {
              provider: "claude-code",
              eventType: "system",
              raw: line,
            },
            extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
            native: native(`system.${typeof line.subtype === "string" ? line.subtype : String(line.type)}`),
          });
          break;
        }
        default:
          createEvent(events, {
            sessionId,
            branchId,
            timestamp: lineTimestamp,
            kind: "provider.event",
            payload: {
              provider: "claude-code",
              eventType: typeof line.type === "string" ? line.type : "line.missing_type",
              raw: line,
            },
            extensions: withSyntheticTimestampExtension(lineExtensions(line), syntheticTimestamp),
            native: native(`line.${typeof line.type === "string" ? line.type : "missing_type"}`),
          });
      }
    } finally {
      applyCanonicalOverridesToRange(events, overrides, beforeIndex);
    }
  }

  return events;
}
