import { readFileSync } from "node:fs";
import {
  exportCodexJsonl,
  importClaudeCodeJsonl,
  importPiSessionJsonl,
  prepareClaudeCodeResumeSeed,
} from "@lossless-agent-context/adapters";
import { type CanonicalEvent } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";
import { detectRecentRealLogPaths, requireRealLogPaths } from "./runtime-detection";

// Property-based round-trip on real local pi session logs.
//
// The goal: prove that for every actual cross-provider session the user
// has accumulated, the codex → claude → codex pipeline preserves
// (a) the chain-of-thought from each reasoning item that had recoverable
//     text — either via the demotion-recovery path (codex reasoning) or
//     directly (claude signed thinking), and
// (b) every tool call pair (each `function_call` has a matching
//     `function_call_output` and vice versa) — sanitization must not
//     break pairing.
//
// Important: some older pi versions wrote sessions with a broken
// pi-claude-code that may have inconsistent toolCallIds or other shape
// quirks. Those would individually false-fail this test through no fault
// of the current code. So per-session issues are collected and reported,
// but the test only HARD-FAILS if a significant fraction of sessions
// show the same problem (suggesting a real regression in our pipeline).
// Investigate the listed session paths if findings show up.

requireRealLogPaths();

// Cast a wide net. Cross-provider sessions are a subset of all pi sessions,
// so to reliably catch a few we look at the most recent 50.
const recentPiPaths = detectRecentRealLogPaths(50).pi;

function hasCrossProviderContent(canonical: CanonicalEvent[]): boolean {
  // pi imports stamp every event with `native.source = "pi"`, so the
  // original provider info isn't directly readable there. Instead, look at
  // `model.selected` payloads — pi emits one each time the user switches
  // providers via `/model`. A session with at least one codex provider
  // selection AND at least one claude provider selection has the
  // cross-provider shape we want to round-trip.
  const providers = new Set<string>();
  for (const event of canonical) {
    if (event.kind !== "model.selected") continue;
    const provider = event.payload.provider;
    if (typeof provider === "string") providers.add(provider);
  }
  const hasCodex = [...providers].some((p) => p === "openai-codex" || p === "codex");
  const hasClaude = [...providers].some((p) => p === "claude-code" || p === "claude");
  return hasCodex && hasClaude;
}

function countReasoningWithText(canonical: CanonicalEvent[]): number {
  let count = 0;
  for (const event of canonical) {
    if (event.kind !== "reasoning.created") continue;
    if (typeof event.payload.text === "string" && event.payload.text.trim().length > 0) count++;
  }
  return count;
}

function countCodexReasoningItemsInExport(codexJsonl: string): number {
  let count = 0;
  for (const line of codexJsonl.split("\n")) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      typeof (obj as Record<string, unknown>).payload === "object"
    ) {
      const payload = (obj as Record<string, unknown>).payload as Record<string, unknown> | null;
      if (payload && payload.type === "reasoning") {
        const summary = payload.summary;
        if (Array.isArray(summary)) {
          for (const entry of summary) {
            if (entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "summary_text") {
              const text = (entry as Record<string, unknown>).text;
              if (typeof text === "string" && text.trim().length > 0) {
                count++;
                break;
              }
            }
          }
        }
      }
    }
  }
  return count;
}

function collectToolPairsByCallId(canonical: CanonicalEvent[]): { calls: Set<string>; results: Set<string> } {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const event of canonical) {
    if (event.kind === "tool.call") calls.add(event.payload.toolCallId);
    if (event.kind === "tool.result") results.add(event.payload.toolCallId);
  }
  return { calls, results };
}

describe("cross-provider real-log round-trip", () => {
  if (recentPiPaths.length === 0) {
    it.skip("no real pi sessions found at ~/.pi/agent/sessions/ — skipping", () => undefined);
    return;
  }

  it("reasoning + tool pairs survive cross-provider round-trip across recent real sessions", () => {
    const findings: Array<{ path: string; issue: string }> = [];
    let crossProviderSessionsExamined = 0;

    for (const path of recentPiPaths) {
      let text: string;
      let canonicalFromPi: CanonicalEvent[];
      try {
        text = readFileSync(path, "utf8");
        canonicalFromPi = importPiSessionJsonl(text);
      } catch (err) {
        findings.push({ path, issue: `failed to import pi session: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }

      if (!hasCrossProviderContent(canonicalFromPi)) continue;
      crossProviderSessionsExamined++;

      const originalReasoningCount = countReasoningWithText(canonicalFromPi);
      const originalToolPairs = collectToolPairsByCallId(canonicalFromPi);
      const originalMatchedPairs = [...originalToolPairs.calls].filter((id) => originalToolPairs.results.has(id));

      let canonicalFromClaude: CanonicalEvent[];
      let codexExport: string;
      try {
        const { jsonl: seed, sidecar } = prepareClaudeCodeResumeSeed(canonicalFromPi, "test-target-session-id");
        canonicalFromClaude = importClaudeCodeJsonl(seed, { sidecar });
        codexExport = exportCodexJsonl(canonicalFromClaude);
      } catch (err) {
        findings.push({ path, issue: `pipeline threw: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }

      // Property A: reasoning text count must not drop. Both codex demoted
      // reasoning (via recovery markers) and claude signed thinking
      // (passthrough) become reasoning.created on re-import → reasoning
      // items in codex export.
      const recoveredReasoningCount = countCodexReasoningItemsInExport(codexExport);
      if (recoveredReasoningCount < originalReasoningCount) {
        findings.push({
          path,
          issue: `reasoning loss: ${originalReasoningCount} → ${recoveredReasoningCount}`,
        });
      }

      // Property B: tool call/result pairing preserved. Sanitization must
      // be deterministic so paired blocks land on the same sanitized id.
      const recoveredPairs = collectToolPairsByCallId(canonicalFromClaude);
      const stillMatched = originalMatchedPairs.filter((id) => {
        const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
        return (
          (recoveredPairs.calls.has(id) && recoveredPairs.results.has(id)) ||
          (recoveredPairs.calls.has(sanitized) && recoveredPairs.results.has(sanitized))
        );
      });
      if (stillMatched.length < originalMatchedPairs.length) {
        findings.push({
          path,
          issue: `tool pair loss: ${originalMatchedPairs.length} matched → ${stillMatched.length} matched`,
        });
      }
    }

    // Always report what we found so the user can investigate. Some old pi
    // sessions may have been written by buggy pi-claude-code versions and
    // have inconsistent toolCallIds or other shape quirks — those will show
    // up here as findings without indicating a current code regression.
    if (findings.length > 0) {
      console.warn(
        `cross-provider round-trip findings (${findings.length} across ${crossProviderSessionsExamined} cross-provider sessions). ` +
          `Investigate paths if a recent code change broke many at once; isolated entries are typically old buggy sessions:`,
      );
      for (const f of findings) console.warn(`  - ${f.issue}: ${f.path}`);
    }
    if (crossProviderSessionsExamined === 0) {
      console.warn(
        "WARNING: no cross-provider sessions found in the last 50 pi sessions. " +
          "Run a session that uses both providers (codex + claude) to populate test coverage.",
      );
    }

    // Hard-fail only if MORE THAN HALF of examined sessions showed
    // findings — that would suggest a current pipeline regression rather
    // than scattered old-data corruption. Single-digit findings across
    // dozens of sessions are typically pre-existing.
    if (crossProviderSessionsExamined > 0) {
      expect(
        findings.length,
        `${findings.length} of ${crossProviderSessionsExamined} cross-provider sessions failed round-trip — likely a pipeline regression. See warnings above.`,
      ).toBeLessThan(crossProviderSessionsExamined * 0.5);
    }
  });
});
