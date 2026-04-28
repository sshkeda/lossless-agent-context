import type { CanonicalEvent } from "@lossless-agent-context/core";
import { exportClaudeCodeJsonl } from "./export-claude-code";
import {
  emptySidecar,
  type LosslessSidecar,
  setDemotedReasoningMarkers,
} from "./recovery-sidecar";
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
// To make the inverse direction (claude seed → reimport → codex export)
// deterministic, the original chain-of-thought text is recorded in the
// recovery sidecar (see recovery-sidecar.ts) keyed by the line's claude
// uuid. The seed JSONL itself stays pristine — pure claude-code format
// with NO custom wrapper fields.
type DemotedThinkingMarker = {
  contentIndex: number;
  originalText: string;
};

function demoteUnsignedThinkingBlocks(content: unknown[]): {
  content: unknown[];
  demoted: DemotedThinkingMarker[];
} {
  const transformed: unknown[] = [];
  const demoted: DemotedThinkingMarker[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      transformed.push(block);
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type !== "thinking") {
      transformed.push(block);
      continue;
    }
    if (typeof record.signature === "string" && record.signature.length > 0) {
      transformed.push(block);
      continue;
    }
    const text = typeof record.thinking === "string" ? record.thinking : "";
    if (text.trim().length === 0) continue;
    const contentIndex = transformed.length;
    transformed.push({ type: "text", text: `<thinking>\n${text}\n</thinking>` });
    demoted.push({ contentIndex, originalText: text });
  }
  return { content: transformed, demoted };
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

export interface PreparedClaudeCodeResume {
  /**
   * The pure claude-code JSONL seed — write this to
   * `~/.claude/projects/<slug>/<sessionId>.jsonl` and hand `<sessionId>` to
   * claude-code-cli's `resume`. Contains only fields claude-code's session
   * loader knows about; lac adds no custom wrapper fields.
   */
  jsonl: string;
  /**
   * Recovery sidecar — write to the canonical sidecar path (see
   * `sidecarPathForSeedPath` in recovery-sidecar.ts) so that a future
   * `importClaudeCodeJsonl(text, { sidecar })` can deterministically
   * restore one-way transforms (e.g. `<thinking>`-text demotions back to
   * native `reasoning.created` events). Empty-ish sidecars (no markers
   * for any line) are still safe to write — the importer treats them as
   * "no recovery info available, fall through".
   */
  sidecar: LosslessSidecar;
}

/**
 * Turns a claude-code JSONL (typically produced by `exportClaudeCodeJsonl`)
 * or a canonical event array into a seed file safe for claude-code-cli's
 * `resume`, plus a recovery sidecar.
 *
 * The jsonl half is pristine claude-code format — no custom wrapper fields
 * or sentinel content. The sidecar half carries lac's recovery markers
 * keyed by claude line uuid, in a separate file outside Claude Code's
 * parse path entirely. This is the "mark, don't infer" pattern applied to
 * one-way cross-format transforms (see AGENTS.md).
 *
 * Five things happen here that `exportClaudeCodeJsonl` deliberately doesn't:
 *
 * 1. **sessionId rewrite**: every line gets the target sessionId stamped on.
 * 2. **type filter**: lines with types outside CLAUDE_ACCEPTED_TYPES are
 *    dropped (claude-code rejects unknown types).
 * 3. **thinking-signature guard**: assistant thinking blocks without a
 *    valid claude signature are demoted to `<thinking>`-wrapped text and
 *    recorded in the sidecar for deterministic restoration.
 * 4. **tool_result legacy field strip**: `structuredContent` (a removed
 *    field) is stripped to avoid claude API rejection.
 * 5. **tool id sanitization**: `tool_use.id` and `tool_result.tool_use_id`
 *    are forced to match claude's `^[a-zA-Z0-9_-]+$`. Cross-provider
 *    codex IDs containing `|` are rewritten deterministically so paired
 *    blocks land on the same sanitized id.
 *
 * Overloads:
 *   prepareClaudeCodeResumeSeed(events, sessionId)  // convenience: runs export internally
 *   prepareClaudeCodeResumeSeed(jsonl, sessionId)   // for callers that already exported
 */
export function prepareClaudeCodeResumeSeed(input: CanonicalEvent[], sessionId: string): PreparedClaudeCodeResume;
export function prepareClaudeCodeResumeSeed(input: string, sessionId: string): PreparedClaudeCodeResume;
export function prepareClaudeCodeResumeSeed(input: CanonicalEvent[] | string, sessionId: string): PreparedClaudeCodeResume {
  const jsonl = typeof input === "string" ? input : exportClaudeCodeJsonl(input);
  const lines = jsonl.split("\n").filter((line) => line.trim().length > 0);
  const kept: Record<string, unknown>[] = [];
  const sidecar = emptySidecar();
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
          const { content: transformed, demoted } = demoteUnsignedThinkingBlocks(content);
          if (transformed.length === 0) continue;
          messageRecord.content = transformed;
          sanitizeClaudeToolUseIds(transformed);
          if (demoted.length > 0 && typeof obj.uuid === "string") {
            // Record the demotion in the sidecar, keyed by claude line uuid
            // (stable across resumes). importClaudeCodeJsonl reads the
            // sidecar and uses the contentIndex to deterministically
            // promote the matching text block back to a reasoning event.
            setDemotedReasoningMarkers(sidecar, obj.uuid, demoted);
          }
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
  const seedJsonl = kept.length > 0 ? `${kept.map((obj) => JSON.stringify(obj)).join("\n")}\n` : "";
  return { jsonl: seedJsonl, sidecar };
}
