import type { CanonicalEvent } from "@lossless-agent-context/core";
import { exportClaudeCodeJsonl } from "./export-claude-code";

// Types claude-code's resume loader accepts on its session file. Anything
// else in the seed (e.g. "model_change" — valid in pi's format, rejected by
// claude) is dropped.
const CLAUDE_ACCEPTED_TYPES = new Set(["system", "user", "assistant", "summary", "attachment"]);

function stripRejectedToolResultFields(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const block of value) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "tool_result") continue;
    delete record.structuredContent;
  }
}

/**
 * Turns a claude-code JSONL (typically produced by `exportClaudeCodeJsonl`)
 * into a seed file that's safe to hand to claude-code-cli's `resume` flag.
 *
 * Two things happen here that `exportClaudeCodeJsonl` deliberately doesn't:
 *
 * 1. **sessionId rewrite**: the seed needs to be addressed to whatever sessionId
 *    the caller is about to pass as `resume`; all lines get that id stamped on.
 *
 * 2. **thinking-signature guard**: claude's API rejects any assistant message
 *    containing `{type: "thinking"}` without a non-empty `signature`. This
 *    comes up in two ways:
 *
 *    - Cross-provider conversations: e.g. openai-codex reasoning blocks
 *      imported via `importPiSessionJsonl` carry an OpenAI-format `thinkingSignature`
 *      but never a claude signature. Exporting them yields thinking blocks with
 *      no signature at all.
 *    - Canonical events that lost their `native.raw` passthrough (e.g. events
 *      re-derived from another format) can't reconstruct a claude signature
 *      even if one originally existed.
 *
 *    In both cases the only recoverable action is to drop the thinking block.
 *    Thinking is model-internal — historical thinking isn't needed for claude
 *    to reconstruct conversational context. If dropping the thinking leaves
 *    an assistant line with empty content, the whole line is dropped too.
 *
 * Overloads:
 *   prepareClaudeCodeResumeSeed(events, sessionId)  // convenience: runs export internally
 *   prepareClaudeCodeResumeSeed(jsonl, sessionId)   // for callers that already exported
 */
export function prepareClaudeCodeResumeSeed(input: CanonicalEvent[], sessionId: string): string;
export function prepareClaudeCodeResumeSeed(input: string, sessionId: string): string;
export function prepareClaudeCodeResumeSeed(input: CanonicalEvent[] | string, sessionId: string): string {
  const jsonl = typeof input === "string" ? input : exportClaudeCodeJsonl(input);
  const lines = jsonl.split("\n").filter((line) => line.trim().length > 0);
  const kept: string[] = [];
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      obj = parsed;
    } catch {
      continue;
    }
    const type = obj.type;
    if (typeof type !== "string" || !CLAUDE_ACCEPTED_TYPES.has(type)) continue;

    if (type === "assistant") {
      const message = obj.message;
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const messageRecord = message as Record<string, unknown>;
        const content = messageRecord.content;
        if (Array.isArray(content)) {
          const filtered = content.filter((block) => {
            if (!block || typeof block !== "object") return true;
            const blockRecord = block as Record<string, unknown>;
            if (blockRecord.type !== "thinking") return true;
            return typeof blockRecord.signature === "string" && blockRecord.signature.length > 0;
          });
          if (filtered.length === 0) continue;
          messageRecord.content = filtered;
        }
      }
    }

    if (type === "user") {
      const message = obj.message;
      if (message && typeof message === "object" && !Array.isArray(message)) {
        stripRejectedToolResultFields((message as Record<string, unknown>).content);
      }
    }

    obj.sessionId = sessionId;
    kept.push(JSON.stringify(obj));
  }
  return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}
