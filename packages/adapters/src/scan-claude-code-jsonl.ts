import { createHash } from "node:crypto";
import { parseJsonlWithText } from "./utils";

export type ClaudeCodePromptUsageSample = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp?: string;
  nativeId?: string;
};

export type ClaudeCodeNativeCompaction = {
  key: string;
  summary: string;
  tokensBefore?: number;
  nativeId?: string;
  timestamp?: string;
  boundaryTimestamp?: string;
};

export type ClaudeCodeJsonlScan = {
  usageSamples: ClaudeCodePromptUsageSample[];
  nativeCompactions: ClaudeCodeNativeCompaction[];
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textFromClaudeMessage(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function usageFromClaudeMessage(
  message: Record<string, unknown> | undefined,
  line: Record<string, unknown>,
): ClaudeCodePromptUsageSample | undefined {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  const input = finiteNumber(record.input_tokens) ?? 0;
  const output = finiteNumber(record.output_tokens) ?? 0;
  const cacheRead = finiteNumber(record.cache_read_input_tokens) ?? 0;
  const cacheWrite = finiteNumber(record.cache_creation_input_tokens) ?? 0;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(typeof line.timestamp === "string" ? { timestamp: line.timestamp } : {}),
    ...(typeof line.uuid === "string"
      ? { nativeId: line.uuid }
      : typeof message?.id === "string"
        ? { nativeId: message.id }
        : {}),
  };
}

function tokensBeforeFromCompactMetadata(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  return finiteNumber(record.tokensBefore) ?? finiteNumber(record.inputTokens) ?? finiteNumber(record.totalTokens);
}

function nativeCompactionFromLine(
  line: Record<string, unknown>,
  latestBoundary: { tokensBefore?: number; timestamp?: string } | undefined,
): Omit<ClaudeCodeNativeCompaction, "key"> | undefined {
  const tokensBefore = tokensBeforeFromCompactMetadata(line.compactMetadata) ?? latestBoundary?.tokensBefore;
  const message = line.message;

  if (message && typeof message === "object" && !Array.isArray(message)) {
    const msg = message as Record<string, unknown>;
    if (line.isCompactSummary === true || msg.isCompactSummary === true) {
      const summary = textFromClaudeMessage(msg).trim();
      if (summary.length > 0) {
        return {
          summary,
          ...(tokensBefore !== undefined ? { tokensBefore } : {}),
          ...(typeof line.uuid === "string" ? { nativeId: line.uuid } : typeof msg.id === "string" ? { nativeId: msg.id } : {}),
          ...(typeof line.timestamp === "string" ? { timestamp: line.timestamp } : {}),
          ...(latestBoundary?.timestamp !== undefined ? { boundaryTimestamp: latestBoundary.timestamp } : {}),
        };
      }
    }
  }

  if (line.type === "summary" && typeof line.summary === "string" && line.summary.trim().length > 0) {
    return {
      summary: line.summary.trim(),
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
      ...(typeof line.uuid === "string" ? { nativeId: line.uuid } : {}),
      ...(typeof line.timestamp === "string" ? { timestamp: line.timestamp } : {}),
      ...(latestBoundary?.timestamp !== undefined ? { boundaryTimestamp: latestBoundary.timestamp } : {}),
    };
  }

  return undefined;
}

function compactionKey(sourceId: string, compaction: Omit<ClaudeCodeNativeCompaction, "key">): string {
  const stable = [
    sourceId,
    compaction.nativeId ?? "no-native-id",
    compaction.boundaryTimestamp ?? "no-boundary-timestamp",
    compaction.timestamp ?? "no-summary-timestamp",
    compaction.tokensBefore ?? "no-tokens-before",
    createHash("sha256").update(compaction.summary).digest("hex"),
  ].join("\u001f");
  return `claude-code-native-compaction:${createHash("sha256").update(stable).digest("hex")}`;
}

export function scanClaudeCodeJsonl(text: string, options: { sourceId?: string } = {}): ClaudeCodeJsonlScan {
  const sourceId = options.sourceId ?? "claude-code-jsonl";
  const usageSamples: ClaudeCodePromptUsageSample[] = [];
  const nativeCompactions: ClaudeCodeNativeCompaction[] = [];
  let latestBoundary: { tokensBefore?: number; timestamp?: string } | undefined;

  for (const { line } of parseJsonlWithText(text)) {
    const message = line.message;
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const usage = usageFromClaudeMessage(message as Record<string, unknown>, line);
      if (usage) usageSamples.push(usage);
    }

    if (line.type === "system" && line.subtype === "compact_boundary") {
      const tokensBefore = tokensBeforeFromCompactMetadata(line.compactMetadata);
      latestBoundary = {
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
        ...(typeof line.timestamp === "string" ? { timestamp: line.timestamp } : {}),
      };
      continue;
    }

    const compaction = nativeCompactionFromLine(line, latestBoundary);
    if (compaction) {
      nativeCompactions.push({ ...compaction, key: compactionKey(sourceId, compaction) });
    }
  }

  return { usageSamples, nativeCompactions };
}
