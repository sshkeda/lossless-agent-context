import type { CanonicalEvent } from "@lossless-agent-context/core";
import { CANONICAL_OVERRIDE_FIELD, FOREIGN_FIELD } from "./cross-provider";
import { exportClaudeCodeJsonl } from "./export-claude-code";
import {
  emptySidecar,
  type EmptyTextSubstitutionMarker,
  type LosslessSidecar,
  setDemotedReasoningMarkers,
  setEmptyTextSubstitutionMarkers,
  setLineMetadata,
} from "./recovery-sidecar";
import { deterministicUuid } from "./utils";

// Claude Code is distributed here as a native/Bun executable, but the bundled
// JavaScript is still inspectable. These resume-normalization rules are grounded
// in Claude Code 2.1.121's embedded session persistence/resume code plus real
// Claude/API validation behavior, then locked with e2e tests in
// prepare-claude-code-resume.test.ts and claude-sdk-validation.test.ts. If Claude
// Code changes its accepted JSONL shape, re-inspect the installed binary and
// update these rules alongside a fixture/test demonstrating the new shape.

// Types Claude Code 2.1.121 routes through its session persistence/resume layer.
// Internal excerpt from the bundled JS (`KzK`):
//   user/assistant/attachment/system/progress => "dedup-transcript"
//   summary/custom-title/ai-title/last-prompt/tag/agent-name/agent-color/
//   agent-setting/pr-link/frame-link/file-history-snapshot/attribution-snapshot/
//   speculation-accept/mode/permission-mode/worktree-state/queue-operation/
//   marble-origami-commit/marble-origami-snapshot => "always"
//   content-replacement/fork-context-ref => "route-by-agent"
// Keep every known-native type in resume seeds; dropping metadata loses native
// context. Anything outside this set (e.g. lac/provider-specific event lines) is
// still filtered from resume seeds only. Generic `exportClaudeCodeJsonl` remains
// the raw lossless conversion path.
const CLAUDE_ACCEPTED_TYPES = new Set([
  "user",
  "assistant",
  "attachment",
  "system",
  "progress",
  "summary",
  "custom-title",
  "ai-title",
  "last-prompt",
  "tag",
  "agent-name",
  "agent-color",
  "agent-setting",
  "pr-link",
  "frame-link",
  "file-history-snapshot",
  "attribution-snapshot",
  "speculation-accept",
  "mode",
  "permission-mode",
  "worktree-state",
  "queue-operation",
  "marble-origami-commit",
  "marble-origami-snapshot",
  "content-replacement",
  "fork-context-ref",
]);

// Claude rejects historical tool_result blocks carrying this legacy field when
// they are replayed through resume. The original details remain recoverable via
// sidecar/native metadata; the resume seed must not include the rejected field.
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
// when it contains characters outside `^[a-zA-Z0-9_-]+$`. This comes from the
// API validation error observed when resuming converted Codex sessions and is
// covered by resume-seed tests. This bites cross-
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
// text block wrapped as historical cross-provider reasoning. Claude reads this
// as part of the historical assistant turn — not as signed native reasoning —
// so the reasoning survives the resume and informs the next turn without using
// the overloaded `<thinking>` tag. This is intentionally a compatibility
// fallback: preserve cross-provider reasoning when native Claude reasoning is
// impossible, while making it visible text rather than pretending we minted a
// valid Claude thinking block.
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
  sourceProvider?: string;
  wrapper: "reasoning.v1";
};

function escapeReasoningAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function quoteHistoricalReasoning(text: string): string {
  return text
    .replace(/<\/reasoning>/gi, "<\\/reasoning>")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function historicalReasoningWrapper(text: string, sourceProvider: string | undefined): string {
  const source = sourceProvider ? ` source="${escapeReasoningAttribute(sourceProvider)}"` : "";
  return `<reasoning${source}>\nHistorical assistant reasoning for continuity. Verify current state with tools.\n\n${quoteHistoricalReasoning(text)}\n</reasoning>`;
}

function demoteUnsignedThinkingBlocks(
  content: unknown[],
  sourceProvider: string | undefined,
): {
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
    transformed.push({ type: "text", text: historicalReasoningWrapper(text, sourceProvider) });
    demoted.push({
      contentIndex,
      originalText: text,
      ...(sourceProvider ? { sourceProvider } : {}),
      wrapper: "reasoning.v1",
    });
  }
  return { content: transformed, demoted };
}

// Anthropic's API rejects text content blocks with empty strings:
//   "messages: text content blocks must be non-empty"
// Strip empty text blocks from message content arrays, and replace empty
// bare-string content with a placeholder so the message stays valid.
// Claude Code uses the same pattern internally (QE="(no content)" in the
// bundled cli.js — see o8(), fV(), n9() which all substitute empty text
// with "(no content)" before building API messages).
//
// Returns { keep, markers } — keep=false means the message should be
// dropped entirely (all content was empty). markers records which blocks
// were substituted so the sidecar can restore "" on reimport.
function stripEmptyTextBlocks(message: Record<string, unknown>): {
  keep: boolean;
  markers: EmptyTextSubstitutionMarker[];
} {
  const content = message.content;
  if (typeof content === "string") {
    if (content.length === 0) {
      message.content = "(no content)";
      return { keep: true, markers: [{ contentIndex: 0, wholeContent: true }] };
    }
    return { keep: true, markers: [] };
  }
  if (!Array.isArray(content)) return { keep: true, markers: [] };
  const markers: EmptyTextSubstitutionMarker[] = [];
  const filtered: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      filtered.push(block);
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string" && record.text.length === 0) {
      markers.push({ contentIndex: filtered.length });
      // Replace with placeholder instead of dropping, to preserve the
      // block's position in the content array for sidecar indexing.
      filtered.push({ type: "text", text: "(no content)" });
      continue;
    }
    filtered.push(block);
  }
  if (filtered.length === 0) return { keep: false, markers: [] };
  message.content = filtered;
  return { keep: true, markers };
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

function sourceProviderFromLine(line: Record<string, unknown>): string | undefined {
  const foreign = line[FOREIGN_FIELD];
  if (foreign && typeof foreign === "object" && !Array.isArray(foreign)) {
    const raw = (foreign as Record<string, unknown>).raw;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const message = (raw as Record<string, unknown>).message;
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const provider = (message as Record<string, unknown>).provider;
        if (typeof provider === "string" && provider.length > 0) return provider;
      }
      const payload = (raw as Record<string, unknown>).payload;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const provider = (payload as Record<string, unknown>).provider;
        if (typeof provider === "string" && provider.length > 0) return provider;
      }
    }
    const source = (foreign as Record<string, unknown>).source;
    if (typeof source === "string" && source.length > 0) return source;
  }
  return undefined;
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
   * restore one-way transforms (e.g. historical reasoning text demotions back
   * to native `reasoning.created` events). Empty-ish sidecars (no markers
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
 *    valid claude signature are demoted to visible historical `<reasoning>`
 *    text and recorded in the sidecar for deterministic restoration.
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
export function prepareClaudeCodeResumeSeed(
  input: CanonicalEvent[] | string,
  sessionId: string,
): PreparedClaudeCodeResume {
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
    const sourceProvider = sourceProviderFromLine(obj);

    if (typeof obj.uuid === "string") {
      const foreign = obj[FOREIGN_FIELD];
      const canonicalOverrides = obj[CANONICAL_OVERRIDE_FIELD];
      setLineMetadata(sidecar, obj.uuid, {
        foreign,
        ...(Array.isArray(canonicalOverrides) ? { canonicalOverrides } : {}),
      });
      delete obj[FOREIGN_FIELD];
      delete obj[CANONICAL_OVERRIDE_FIELD];
    }

    if (type === "assistant") {
      const message = obj.message;
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const messageRecord = message as Record<string, unknown>;
        const content = messageRecord.content;
        if (Array.isArray(content)) {
          const { content: transformed, demoted } = demoteUnsignedThinkingBlocks(content, sourceProvider);
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
        const emptyTextResult = stripEmptyTextBlocks(messageRecord);
        if (!emptyTextResult.keep) continue;
        if (emptyTextResult.markers.length > 0 && typeof obj.uuid === "string") {
          setEmptyTextSubstitutionMarkers(sidecar, obj.uuid, emptyTextResult.markers);
        }
        ensureAssistantMessageId(obj, lineIndex);
      }
    }

    if (type === "user") {
      const message = obj.message;
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const messageRecord = message as Record<string, unknown>;
        const content = messageRecord.content;
        stripRejectedToolResultFields(content);
        sanitizeClaudeToolUseIds(content);
        const emptyTextResult = stripEmptyTextBlocks(messageRecord);
        if (!emptyTextResult.keep) continue;
        if (emptyTextResult.markers.length > 0 && typeof obj.uuid === "string") {
          setEmptyTextSubstitutionMarkers(sidecar, obj.uuid, emptyTextResult.markers);
        }
      }
    }

    obj.sessionId = sessionId;
    kept.push(obj);
  }
  const seedJsonl = kept.length > 0 ? `${kept.map((obj) => JSON.stringify(obj)).join("\n")}\n` : "";
  return { jsonl: seedJsonl, sidecar };
}
