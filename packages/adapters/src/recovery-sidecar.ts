// Centralized contract for the lac recovery sidecar.
//
// When a one-way cross-format conversion drops/demotes/sanitizes
// information that the downstream format can't carry natively, the
// recovery markers are written to a SIDECAR file alongside the seed
// (e.g. `<sessionId>.lossless.json` next to `<sessionId>.jsonl`) instead
// of into a wrapper field on the JSONL itself.
//
// Why a sidecar instead of a wrapper field:
//
//   The wrapper-field approach (a top-level field on each JSONL line that
//   the downstream parser ignores) RELIES on the parser being lenient
//   about unknown fields — an undocumented assumption that could silently
//   regress if Claude Code ever ships a stricter session loader. There is
//   no official user-metadata field in the Claude Code session JSONL
//   format (verified against Claude Code docs, the SDK types, and the
//   Managed Agents API as of 2026-04). A sidecar file is OUTSIDE Claude
//   Code's parse path entirely, so it's immune to schema changes in the
//   JSONL format.
//
// Every new sidecar marker MUST:
//   1. Add a typed field to LosslessSidecarEntry below.
//   2. Add a setter helper alongside the existing ones (set*).
//   3. Add a reader helper alongside the existing ones (read*).
//   4. Have the importer that needs it call the reader — never read raw
//      sidecar JSON directly.
//
// Going through the helpers (instead of touching the sidecar shape by
// hand) keeps the contract typed end-to-end. TypeScript will surface any
// mismatch between producer and consumer at compile time.

import { LOSSLESS_SIDECAR_FILE_SUFFIX } from "./defaults";

/**
 * A single demoted-thinking recovery marker. Records that the text block
 * at `contentIndex` in the assistant `message.content[]` array was
 * produced by demoting a foreign (unsigned) thinking block, and carries
 * the original chain-of-thought text so a downstream codex export (or any
 * other native-reasoning consumer) can restore the reasoning event.
 */
/**
 * Records that a text content block at `contentIndex` was originally empty
 * ("") but was substituted with "(no content)" to satisfy the Anthropic API
 * constraint ("messages: text content blocks must be non-empty"). On
 * reimport the consumer restores the original empty string so that other
 * providers (e.g. Codex) see the true empty response.
 *
 * When `wholeContent` is true, the entire `message.content` was a bare
 * empty string (not an array) — the importer should restore `content: ""`.
 */
export interface EmptyTextSubstitutionMarker {
  contentIndex: number;
  wholeContent?: boolean;
}

/**
 * A single demoted-thinking recovery marker. Records that the text block
 * at `contentIndex` in the assistant `message.content[]` array was
 * produced by demoting a foreign (unsigned) thinking block, and carries
 * the original chain-of-thought text so a downstream codex export (or any
 * other native-reasoning consumer) can restore the reasoning event.
 */
export interface DemotedReasoningMarker {
  contentIndex: number;
  originalText: string;
  sourceProvider?: string;
  wrapper?: "reasoning.v1";
}

/**
 * The complete shape of a single sidecar entry — keyed by the claude line
 * uuid (which is stable across resumes). Any new recovery marker MUST be
 * added here so the central contract reflects every kind of recovery info
 * the codebase relies on.
 */
export interface LosslessSidecarEntry {
  demotedReasoning?: DemotedReasoningMarker[];
  emptyTextSubstitutions?: EmptyTextSubstitutionMarker[];
  foreign?: unknown;
  canonicalOverrides?: unknown[];
}

/**
 * The full sidecar shape: a flat map from claude line uuid → markers for
 * that line. Empty/missing entries mean the line has no recovery info to
 * apply (which is the common case — most lines are just normal claude
 * content that doesn't need any).
 */
export interface LosslessSidecar {
  byLineUuid: Record<string, LosslessSidecarEntry>;
}

export function emptySidecar(): LosslessSidecar {
  return { byLineUuid: {} };
}

export function isEmptySidecar(sidecar: LosslessSidecar): boolean {
  return Object.keys(sidecar.byLineUuid).length === 0;
}

/**
 * Convention: the sidecar file lives next to the seed jsonl, with a fixed
 * suffix appended. `~/foo/bar.jsonl` → `~/foo/bar.jsonl.lossless.json`.
 * Writing the sidecar file is the caller's responsibility (lac doesn't
 * touch the filesystem); this helper just gives the canonical path.
 */
export function sidecarPathForSeedPath(seedJsonlPath: string): string {
  return `${seedJsonlPath}${LOSSLESS_SIDECAR_FILE_SUFFIX}`;
}

/**
 * Serializer the caller hands to `writeFile`. Pretty-printed for
 * readability when debugging — the file is small (one entry per demoted
 * line, a handful of bytes each).
 */
export function serializeSidecar(sidecar: LosslessSidecar): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

/**
 * Parser for a sidecar file's text. Returns an empty sidecar (not an
 * error) if the input is malformed or missing — the caller should fall
 * through to "no recovery info available" handling rather than crashing.
 * That graceful degradation is the point: the importer must work whether
 * the seed was lac-produced or hand-written.
 */
export function parseSidecar(text: string | undefined): LosslessSidecar {
  if (!text) return emptySidecar();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptySidecar();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptySidecar();
  const byLineUuid = (parsed as Record<string, unknown>).byLineUuid;
  if (!byLineUuid || typeof byLineUuid !== "object" || Array.isArray(byLineUuid)) return emptySidecar();
  const validated: Record<string, LosslessSidecarEntry> = {};
  for (const [uuid, raw] of Object.entries(byLineUuid as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const entry: LosslessSidecarEntry = {};
    if (Array.isArray(record.demotedReasoning)) {
      const markers: DemotedReasoningMarker[] = [];
      for (const m of record.demotedReasoning) {
        if (!m || typeof m !== "object" || Array.isArray(m)) continue;
        const mr = m as Record<string, unknown>;
        if (typeof mr.contentIndex === "number" && typeof mr.originalText === "string") {
          markers.push({
            contentIndex: mr.contentIndex,
            originalText: mr.originalText,
            ...(typeof mr.sourceProvider === "string" ? { sourceProvider: mr.sourceProvider } : {}),
            ...(mr.wrapper === "reasoning.v1" ? { wrapper: "reasoning.v1" as const } : {}),
          });
        }
      }
      if (markers.length > 0) entry.demotedReasoning = markers;
    }
    if (Array.isArray(record.emptyTextSubstitutions)) {
      const markers: EmptyTextSubstitutionMarker[] = [];
      for (const m of record.emptyTextSubstitutions) {
        if (!m || typeof m !== "object" || Array.isArray(m)) continue;
        const mr = m as Record<string, unknown>;
        if (typeof mr.contentIndex === "number") {
          markers.push({
            contentIndex: mr.contentIndex,
            ...(mr.wholeContent === true ? { wholeContent: true } : {}),
          });
        }
      }
      if (markers.length > 0) entry.emptyTextSubstitutions = markers;
    }
    if ("foreign" in record) entry.foreign = record.foreign;
    if (Array.isArray(record.canonicalOverrides)) entry.canonicalOverrides = record.canonicalOverrides;
    if (Object.keys(entry).length > 0) validated[uuid] = entry;
  }
  return { byLineUuid: validated };
}

/**
 * Writer for the demoted-reasoning marker on a specific line. Idempotent
 * within a single sidecar object — calling twice for the same line uuid
 * replaces the previous markers (the producer always knows the full set
 * for a line at the moment it produces them).
 */
export function setDemotedReasoningMarkers(
  sidecar: LosslessSidecar,
  lineUuid: string,
  markers: DemotedReasoningMarker[],
): void {
  if (markers.length === 0) return;
  const existing = sidecar.byLineUuid[lineUuid] ?? {};
  sidecar.byLineUuid[lineUuid] = { ...existing, demotedReasoning: markers };
}

/**
 * Reader for the demoted-reasoning marker, indexed by contentIndex for
 * O(1) lookups during the per-block import walk. Returns an empty Map if
 * the line has no markers — caller falls through to default handling.
 */
export function setLineMetadata(
  sidecar: LosslessSidecar,
  lineUuid: string,
  metadata: { foreign?: unknown; canonicalOverrides?: unknown[] },
): void {
  const next: LosslessSidecarEntry = { ...(sidecar.byLineUuid[lineUuid] ?? {}) };
  if (metadata.foreign !== undefined) next.foreign = metadata.foreign;
  if (metadata.canonicalOverrides !== undefined && metadata.canonicalOverrides.length > 0) {
    next.canonicalOverrides = metadata.canonicalOverrides;
  }
  if (Object.keys(next).length > 0) sidecar.byLineUuid[lineUuid] = next;
}

export function readLineMetadata(
  sidecar: LosslessSidecar | undefined,
  lineUuid: string | undefined,
): { foreign?: unknown; canonicalOverrides?: unknown[] } | undefined {
  if (!sidecar || !lineUuid) return undefined;
  const entry = sidecar.byLineUuid[lineUuid];
  if (!entry) return undefined;
  const metadata: { foreign?: unknown; canonicalOverrides?: unknown[] } = {};
  if (entry.foreign !== undefined) metadata.foreign = entry.foreign;
  if (entry.canonicalOverrides !== undefined) metadata.canonicalOverrides = entry.canonicalOverrides;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function setEmptyTextSubstitutionMarkers(
  sidecar: LosslessSidecar,
  lineUuid: string,
  markers: EmptyTextSubstitutionMarker[],
): void {
  if (markers.length === 0) return;
  const existing = sidecar.byLineUuid[lineUuid] ?? {};
  sidecar.byLineUuid[lineUuid] = { ...existing, emptyTextSubstitutions: markers };
}

export function readEmptyTextSubstitutionsByContentIndex(
  sidecar: LosslessSidecar | undefined,
  lineUuid: string | undefined,
): Map<number, EmptyTextSubstitutionMarker> {
  const map = new Map<number, EmptyTextSubstitutionMarker>();
  if (!sidecar || !lineUuid) return map;
  const entry = sidecar.byLineUuid[lineUuid];
  const list = entry?.emptyTextSubstitutions;
  if (!Array.isArray(list)) return map;
  for (const marker of list) {
    map.set(marker.contentIndex, marker);
  }
  return map;
}

export function readDemotedReasoningByContentIndex(
  sidecar: LosslessSidecar | undefined,
  lineUuid: string | undefined,
): Map<number, string> {
  const map = new Map<number, string>();
  if (!sidecar || !lineUuid) return map;
  const entry = sidecar.byLineUuid[lineUuid];
  const list = entry?.demotedReasoning;
  if (!Array.isArray(list)) return map;
  for (const marker of list) {
    map.set(marker.contentIndex, marker.originalText);
  }
  return map;
}
