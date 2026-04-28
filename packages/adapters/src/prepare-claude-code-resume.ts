import type { CanonicalEvent } from "@lossless-agent-context/core";
import { exportClaudeCodeJsonl } from "./export-claude-code";
import { deterministicUuid } from "./utils";

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

// Anthropic's API rejects tool_use.id (and the matching tool_result.tool_use_id)
// when it contains characters outside `^[a-zA-Z0-9_-]+$`. This bites cross-
// provider seeds: openai-codex toolCallIds are stored as `call_<id>|fc_<id>`
// because Responses-API replay needs both, and the `|` makes claude reject the
// resume with `messages.N.content.M.tool_use.id: String should match pattern
// '^[a-zA-Z0-9_-]+$'`. Replacing every disallowed char with `_` keeps the
// rewrite deterministic so the assistant tool_use and the user tool_result
// land on the same id and stay paired.
function sanitizeClaudeToolUseId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// HACK: cross-provider reasoning preservation.
//
// Claude's API requires every `{type:"thinking"}` block to carry a `signature`
// produced by claude itself — an HMAC over the encrypted reasoning that only
// claude can mint. Other providers' reasoning is fundamentally incompatible:
// openai-codex stores reasoning as encrypted_content + a base64-summary; we
// have neither the signing key nor a way to convert OpenAI's encrypted blob
// into a claude-format signed thinking block. Round-tripping reasoning
// natively across providers is therefore impossible without inventing fake
// signatures (which would either be rejected or silently corrupt claude's
// extended-thinking pipeline).
//
// The next-best option is to demote the unsigned thinking block into a plain
// text block wrapped in `<thinking>` tags. Claude reads this as part of the
// historical assistant turn — not as its own internal reasoning — so the
// chain-of-thought survives the resume and informs the next turn. The wrapper
// tags are a convention claude is trained on, so it interprets the block as
// prior reasoning rather than something the assistant said out loud.
//
// Empty/whitespace-only thinking blocks (codex reasoning items whose
// `summary[]` was empty) are dropped because there's no recoverable text —
// only the encrypted blob existed and that's opaque to claude.
//
// If a future API ever lets a non-claude signature pass through, or claude
// learns to verify foreign signatures, we should remove this demotion and
// pass thinking blocks natively.
function demoteUnsignedThinkingBlocks(content: unknown[]): unknown[] {
  return content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [block];
    const record = block as Record<string, unknown>;
    if (record.type !== "thinking") return [block];
    if (typeof record.signature === "string" && record.signature.length > 0) return [block];
    const text = typeof record.thinking === "string" ? record.thinking : "";
    if (text.trim().length === 0) return [];
    return [{ type: "text", text: `<thinking>\n${text}\n</thinking>` }];
  });
}

function sanitizeClaudeToolUseIds(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const block of value) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type === "tool_use" && typeof record.id === "string") {
      record.id = sanitizeClaudeToolUseId(record.id);
    } else if (record.type === "tool_result" && typeof record.tool_use_id === "string") {
      record.tool_use_id = sanitizeClaudeToolUseId(record.tool_use_id);
    }
  }
}

function synthesizeClaudeMessageId(line: Record<string, unknown>, lineIndex: number): string {
  const seed = JSON.stringify({
    sessionId: line.sessionId,
    uuid: line.uuid,
    timestamp: line.timestamp,
    parentUuid: line.parentUuid,
    lineIndex,
  });
  return `msg_${deterministicUuid(seed).replace(/-/g, "")}`;
}

function ensureAssistantMessageId(line: Record<string, unknown>, lineIndex: number): void {
  const message = line.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const messageRecord = message as Record<string, unknown>;
  if (typeof messageRecord.id === "string" && messageRecord.id.length > 0) return;
  messageRecord.id = synthesizeClaudeMessageId(line, lineIndex);
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
  const kept: Record<string, unknown>[] = [];
  for (const [lineIndex, line] of lines.entries()) {
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
          const transformed = demoteUnsignedThinkingBlocks(content);
          if (transformed.length === 0) continue;
          messageRecord.content = transformed;
          sanitizeClaudeToolUseIds(transformed);
        }
        ensureAssistantMessageId(obj, lineIndex);
      }
    }

    if (type === "user") {
      const message = obj.message;
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const content = (message as Record<string, unknown>).content;
        stripRejectedToolResultFields(content);
        sanitizeClaudeToolUseIds(content);
      }
    }

    obj.sessionId = sessionId;
    kept.push(obj);
  }
  return kept.length > 0 ? `${kept.map((obj) => JSON.stringify(obj)).join("\n")}\n` : "";
}
