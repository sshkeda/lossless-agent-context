import {
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  prepareClaudeCodeResumeSeed,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";

// Symmetric to cross-provider-thinking-roundtrip.test.ts.
//
// That file covers codex → claude → codex (foreign codex reasoning demoted
// into `<thinking>` text on the claude leg, then promoted back to native
// codex reasoning via the recovery markers).
//
// This file covers the OPPOSITE direction: claude → codex → claude. A real
// claude-signed thinking block goes through codex export, then back into
// claude via prepareClaudeCodeResumeSeed. Codex stores reasoning as
// `summary_text` only (the original claude signature is opaque to codex),
// so naively the signature would be lost across the hop and the seed prep
// would fall back to the demote-to-`<thinking>`-text path. lac actually
// preserves the original claude signature in the canonical event's
// extensions, so the round-trip ends up REUSING the signature when re-
// exporting to claude — the thinking block survives natively, not as
// demoted text. Either outcome (native signed thinking OR demoted text
// with recovery marker) preserves the user-visible reasoning content;
// this test asserts the reasoning text survives end-to-end via SOME path
// and that whichever path is taken includes enough metadata to re-export
// the reasoning natively on a future leg.
//
// Why this matters: a user who started in claude, switched to codex, then
// switched back to claude must not lose their early claude reasoning to
// the round-trip — that reasoning is the context the next turn depends on.

describe("symmetric claude → codex → claude thinking round-trip", () => {
  it("preserves claude signed thinking text content across the codex hop", () => {
    const claudeReasoningText = "Let me think about this carefully — the user wants X, so I should do Y.";
    const claudeJsonl = [
      { type: "system", subtype: "init", uuid: "u0", parentUuid: null, timestamp: "2026-04-21T00:00:00.000Z", sessionId: "orig", cwd: "/tmp" },
      { type: "user", parentUuid: "u0", uuid: "u1", timestamp: "2026-04-21T00:00:01.000Z", sessionId: "orig", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } },
      {
        type: "assistant",
        parentUuid: "u1",
        uuid: "u2",
        timestamp: "2026-04-21T00:00:02.000Z",
        sessionId: "orig",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: claudeReasoningText, signature: "sig-valid-claude-hmac" },
            { type: "text", text: "Here's the answer." },
          ],
        },
      },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    // Step 1: claude session → canonical
    const canonicalFromClaude = importClaudeCodeJsonl(claudeJsonl);
    expect(canonicalFromClaude.filter((e) => e.kind === "reasoning.created")).toHaveLength(1);

    // Step 2: canonical → codex export. The claude signature is opaque to
    // codex; we expect it to land as a `reasoning` item with summary text.
    const codexExport = exportCodexJsonl(canonicalFromClaude);
    let codexReasoningTextFound: string | undefined;
    for (const line of codexExport.split("\n").filter((l) => l.trim())) {
      const obj = JSON.parse(line);
      if (obj?.payload?.type !== "reasoning") continue;
      const summary = obj.payload.summary;
      if (Array.isArray(summary)) {
        for (const entry of summary) {
          if (entry?.type === "summary_text" && typeof entry.text === "string") {
            codexReasoningTextFound = entry.text;
            break;
          }
        }
      }
    }
    expect(codexReasoningTextFound).toBe(claudeReasoningText);

    // Step 3: codex export → re-import to canonical
    const canonicalFromCodex = importCodexJsonl(codexExport);
    expect(canonicalFromCodex.filter((e) => e.kind === "reasoning.created")).toHaveLength(1);

    // Step 4: canonical → claude resume seed. The reasoning has no claude
    // signature any more (it never could; codex doesn't mint claude HMACs),
    // so the seed prep treats it as foreign-unsigned and demotes it to
    // `<thinking>...</thinking>` text with a recovery marker.
    const seed = prepareClaudeCodeResumeSeed(canonicalFromCodex, "target-claude-sess");

    // Property A: the reasoning TEXT still appears in the seed via SOME
    // path. Two valid outcomes:
    //   (i)  native signed thinking: claude signature was preserved through
    //        the codex hop via lac extensions and re-attached on export.
    //   (ii) demoted to `<thinking>...</thinking>` text with a recovery
    //        marker on the wrapper.
    // Either outcome keeps the user-visible chain-of-thought; we assert
    // SOME path landed it in the seed.
    let reasoningSurvivedAsThinking = false;
    let reasoningSurvivedAsDemotedText = false;
    let demotedTextHasRecoveryMarker = false;
    for (const line of seed.split("\n").filter((l) => l.trim())) {
      const obj = JSON.parse(line);
      if (obj.type !== "assistant") continue;
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      for (const [contentIndex, block] of content.entries()) {
        if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.includes(claudeReasoningText)) {
          // (i) Native thinking. Must carry a non-empty signature or
          // claude's API will reject the resume.
          expect(typeof block.signature === "string" && block.signature.length > 0, "native thinking block must have a signature").toBe(true);
          reasoningSurvivedAsThinking = true;
        }
        if (block?.type === "text" && typeof block.text === "string" && block.text.includes(claudeReasoningText)) {
          reasoningSurvivedAsDemotedText = true;
          // (ii) Demoted text. Must have a recovery marker on the wrapper
          // pointing at this contentIndex so a future codex re-export can
          // restore the native reasoning item.
          const markers = obj.losslessAgentContext?.demotedReasoning ?? [];
          if (markers.some((m: { contentIndex: number; originalText: string }) => m.contentIndex === contentIndex && m.originalText === claudeReasoningText)) {
            demotedTextHasRecoveryMarker = true;
          }
        }
      }
    }
    expect(
      reasoningSurvivedAsThinking || reasoningSurvivedAsDemotedText,
      "claude reasoning text was lost across codex hop — neither native thinking nor demoted text survived",
    ).toBe(true);
    if (reasoningSurvivedAsDemotedText && !reasoningSurvivedAsThinking) {
      // If we took the demote path we also need the recovery marker to make
      // a future hop back to codex deterministic. (If signature survived,
      // no marker needed — the signed thinking round-trips natively.)
      expect(demotedTextHasRecoveryMarker, "demoted reasoning text is missing its recovery marker on the wrapper").toBe(true);
    }

    // Property B: re-importing this seed back through lac restores a
    // reasoning event with the original text — closes the loop. A future
    // codex re-export would reproduce a native reasoning item again.
    const canonicalFromSeed = importClaudeCodeJsonl(seed);
    const reasoningTextsAfterReimport = canonicalFromSeed
      .filter((e): e is Extract<typeof e, { kind: "reasoning.created" }> => e.kind === "reasoning.created")
      .map((e) => e.payload.text);
    expect(reasoningTextsAfterReimport).toContain(claudeReasoningText);

    // Property C: the assistant text "Here's the answer." survives the
    // round-trip (regression check: we don't fold assistant text into the
    // reasoning by accident, and we don't drop it).
    const allAssistantText = canonicalFromSeed
      .filter((e): e is Extract<typeof e, { kind: "message.created" }> => e.kind === "message.created" && e.payload.role === "assistant")
      .flatMap((e) => e.payload.parts)
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text);
    expect(allAssistantText).toContain("Here's the answer.");
  });

  it("preserves text across a deeper claude → codex → claude → codex round-trip", () => {
    // 4-hop variant: do the round-trip twice in a row. Catches drift that
    // accumulates across multiple cross-provider switches (which is what a
    // real user does over a long session).
    const claudeReasoningText = "Plan the next step.";
    const initialClaudeJsonl = [
      { type: "system", subtype: "init", uuid: "u0", parentUuid: null, timestamp: "2026-04-21T00:00:00.000Z", sessionId: "orig", cwd: "/tmp" },
      { type: "user", parentUuid: "u0", uuid: "u1", timestamp: "2026-04-21T00:00:01.000Z", sessionId: "orig", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      {
        type: "assistant",
        parentUuid: "u1",
        uuid: "u2",
        timestamp: "2026-04-21T00:00:02.000Z",
        sessionId: "orig",
        message: { role: "assistant", content: [
          { type: "thinking", thinking: claudeReasoningText, signature: "sig-valid-claude" },
          { type: "text", text: "ok" },
        ] },
      },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    // Hop 1: claude → codex
    const canonical1 = importClaudeCodeJsonl(initialClaudeJsonl);
    const codex1 = exportCodexJsonl(canonical1);
    // Hop 2: codex → claude (via prepareClaudeCodeResumeSeed)
    const canonical2 = importCodexJsonl(codex1);
    const claudeSeed = prepareClaudeCodeResumeSeed(canonical2, "round-trip-1");
    // Hop 3: claude (the seed) → codex
    const canonical3 = importClaudeCodeJsonl(claudeSeed);
    const codex2 = exportCodexJsonl(canonical3);
    // Hop 4: codex → claude (via seed prep again)
    const canonical4 = importCodexJsonl(codex2);
    const finalClaudeSeed = prepareClaudeCodeResumeSeed(canonical4, "round-trip-2");

    // The reasoning text should still be present at the end of the chain
    // via SOME path (native thinking with signature OR demoted text with
    // recovery marker OR raw `<thinking>`-wrapped text).
    let foundInFinalSeed = false;
    for (const line of finalClaudeSeed.split("\n").filter((l) => l.trim())) {
      const obj = JSON.parse(line);
      if (obj.type !== "assistant") continue;
      const content = obj.message?.content ?? [];
      for (const block of content) {
        if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.includes(claudeReasoningText)) {
          foundInFinalSeed = true;
        }
        if (block?.type === "text" && typeof block.text === "string" && block.text.includes(claudeReasoningText)) {
          foundInFinalSeed = true;
        }
      }
      const recovery = obj.losslessAgentContext?.demotedReasoning ?? [];
      if (recovery.some((m: { originalText: string }) => m.originalText === claudeReasoningText)) {
        foundInFinalSeed = true;
      }
    }
    expect(foundInFinalSeed, "claude reasoning text was lost across a 4-hop round-trip").toBe(true);
  });
});
