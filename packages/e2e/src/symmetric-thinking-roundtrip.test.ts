import {
  emptySidecar,
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
    const claudeJsonl = `${[
      {
        type: "system",
        subtype: "init",
        uuid: "u0",
        parentUuid: null,
        timestamp: "2026-04-21T00:00:00.000Z",
        sessionId: "orig",
        cwd: "/tmp",
      },
      {
        type: "user",
        parentUuid: "u0",
        uuid: "u1",
        timestamp: "2026-04-21T00:00:01.000Z",
        sessionId: "orig",
        message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
      },
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
      .join("\n")}\n`;

    // Step 1: claude session → canonical
    const canonicalFromClaude = importClaudeCodeJsonl(claudeJsonl, emptySidecar());
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
    const { jsonl: seed, sidecar } = prepareClaudeCodeResumeSeed(canonicalFromCodex, "target-claude-sess");

    // Property A — STRICT: the reasoning round-trips as a NATIVE signed
    // thinking block. lac preserves the original claude signature in the
    // canonical event's extensions and re-attaches it when exporting back
    // to claude, so the round-trip should never fall back to the demote-
    // to-text path. If this assertion ever flips to false, lac silently
    // stopped preserving the signature — that's a real regression in
    // determinism (we'd be relying on the noisier text-demotion path
    // when the cleaner native path was previously available).
    let nativeThinking: { signature: unknown; thinking: string } | undefined;
    let demotedText: { contentIndex: number } | undefined;
    for (const line of seed.split("\n").filter((l) => l.trim())) {
      const obj = JSON.parse(line);
      if (obj.type !== "assistant") continue;
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      for (const [contentIndex, block] of content.entries()) {
        if (
          block?.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.includes(claudeReasoningText)
        ) {
          nativeThinking = { signature: block.signature, thinking: block.thinking };
        }
        if (block?.type === "text" && typeof block.text === "string" && block.text.includes(claudeReasoningText)) {
          demotedText = { contentIndex };
        }
      }
    }
    expect(
      nativeThinking,
      "claude signature was NOT preserved across the codex hop — reasoning fell back to the noisier demote-to-text path. " +
        "Investigate canonical event extensions / lac signature passthrough.",
    ).toBeDefined();
    expect(
      typeof nativeThinking?.signature === "string" && (nativeThinking.signature as string).length > 0,
      "native thinking block must carry a non-empty signature or claude's API will reject the resume",
    ).toBe(true);
    expect(
      demotedText,
      "reasoning text appeared as both native thinking AND demoted text — we have duplication, not a clean round-trip",
    ).toBeUndefined();

    // Property B: re-importing this seed back through lac restores a
    // reasoning event with the original text — closes the loop. A future
    // codex re-export would reproduce a native reasoning item again.
    // Pass the sidecar so the re-import has access to any recovery markers
    // (here there shouldn't be any since the signature path was native,
    // but we always pass the sidecar for completeness).
    const canonicalFromSeed = importClaudeCodeJsonl(seed, sidecar);
    const reasoningTextsAfterReimport = canonicalFromSeed
      .filter((e): e is Extract<typeof e, { kind: "reasoning.created" }> => e.kind === "reasoning.created")
      .map((e) => e.payload.text);
    expect(reasoningTextsAfterReimport).toContain(claudeReasoningText);

    // Property C: the assistant text "Here's the answer." survives the
    // round-trip (regression check: we don't fold assistant text into the
    // reasoning by accident, and we don't drop it).
    const allAssistantText = canonicalFromSeed
      .filter(
        (e): e is Extract<typeof e, { kind: "message.created" }> =>
          e.kind === "message.created" && e.payload.role === "assistant",
      )
      .flatMap((e) => e.payload.parts)
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text);
    expect(allAssistantText).toContain("Here's the answer.");
  });

  it("falls back deterministically to demote-to-text when no signature is available", () => {
    // Direct fallback test: hand prepareClaudeCodeResumeSeed a claude jsonl
    // line whose thinking block has NO signature (this is exactly what a
    // future codex round-trip would produce if lac stopped preserving the
    // signature, OR what an in-the-wild jsonl from a non-lac source might
    // already contain). The seed prep MUST take the demote path, AND that
    // path MUST be deterministic — visible historical `<reasoning>` text AND
    // a recovery marker on the wrapper so a future re-export deterministically
    // reproduces the reasoning event.
    const reasoningText = "Pretend the signature is missing.";
    const malformedClaudeJsonl = `${[
      {
        type: "system",
        subtype: "init",
        uuid: "u0",
        parentUuid: null,
        timestamp: "2026-04-21T00:00:00.000Z",
        sessionId: "orig",
        cwd: "/tmp",
      },
      {
        type: "assistant",
        parentUuid: "u0",
        uuid: "u1",
        timestamp: "2026-04-21T00:00:01.000Z",
        sessionId: "orig",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: reasoningText },
            { type: "text", text: "ok" },
          ],
        },
      },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n")}\n`;

    const { jsonl: seed, sidecar } = prepareClaudeCodeResumeSeed(malformedClaudeJsonl, "fallback-target");
    const seedAssistantLines = seed
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .filter((o) => o.type === "assistant");
    expect(seedAssistantLines).toHaveLength(1);
    const line = seedAssistantLines[0];
    const content = line.message?.content ?? [];

    // No native thinking blocks survive (claude API would reject unsigned).
    expect(content.some((b: { type?: string }) => b?.type === "thinking")).toBe(false);

    // A historical reasoning text block at a known content index:
    const thinkingTextBlocks = content.filter(
      (b: { type?: string; text?: string }) =>
        b?.type === "text" &&
        typeof b.text === "string" &&
        b.text ===
          `<reasoning>\nHistorical assistant reasoning for continuity. Verify current state with tools.\n\n> ${reasoningText}\n</reasoning>`,
    );
    expect(thinkingTextBlocks).toHaveLength(1);

    // Recovery marker in the SIDECAR (NOT on the JSONL line wrapper),
    // indexed by line uuid + contentIndex so re-import is deterministic.
    // This is the core "mark, don't infer" invariant — the marker IS the
    // contract; without it, the re-import can't restore the reasoning
    // event without falling back to fragile pattern-matching. The seed
    // JSONL itself stays pristine claude-code format.
    expect(line.losslessAgentContext).toBeUndefined();
    const lineUuid = line.uuid;
    expect(typeof lineUuid).toBe("string");
    expect(sidecar.byLineUuid[lineUuid]?.demotedReasoning?.[0]).toEqual({
      contentIndex: 0,
      originalText: reasoningText,
      wrapper: "reasoning.v1",
    });

    // Re-import must restore the reasoning event using the sidecar marker.
    const canonical = importClaudeCodeJsonl(seed, sidecar);
    const reasoning = canonical.filter((e) => e.kind === "reasoning.created");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.kind === "reasoning.created" && reasoning[0].payload.text).toBe(reasoningText);
  });

  it("preserves text across a deeper claude → codex → claude → codex round-trip", () => {
    // 4-hop variant: do the round-trip twice in a row. Catches drift that
    // accumulates across multiple cross-provider switches (which is what a
    // real user does over a long session).
    const claudeReasoningText = "Plan the next step.";
    const initialClaudeJsonl = `${[
      {
        type: "system",
        subtype: "init",
        uuid: "u0",
        parentUuid: null,
        timestamp: "2026-04-21T00:00:00.000Z",
        sessionId: "orig",
        cwd: "/tmp",
      },
      {
        type: "user",
        parentUuid: "u0",
        uuid: "u1",
        timestamp: "2026-04-21T00:00:01.000Z",
        sessionId: "orig",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      },
      {
        type: "assistant",
        parentUuid: "u1",
        uuid: "u2",
        timestamp: "2026-04-21T00:00:02.000Z",
        sessionId: "orig",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: claudeReasoningText, signature: "sig-valid-claude" },
            { type: "text", text: "ok" },
          ],
        },
      },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n")}\n`;

    // Hop 1: claude → codex
    const canonical1 = importClaudeCodeJsonl(initialClaudeJsonl, emptySidecar());
    const codex1 = exportCodexJsonl(canonical1);
    // Hop 2: codex → claude (via prepareClaudeCodeResumeSeed)
    const canonical2 = importCodexJsonl(codex1);
    const { jsonl: claudeSeed, sidecar: sidecar1 } = prepareClaudeCodeResumeSeed(canonical2, "round-trip-1");
    // Hop 3: claude (the seed) → codex. Pass the sidecar through so any
    // demoted-reasoning markers from hop 2 are honored on this re-import.
    const canonical3 = importClaudeCodeJsonl(claudeSeed, sidecar1);
    const codex2 = exportCodexJsonl(canonical3);
    // Hop 4: codex → claude (via seed prep again)
    const canonical4 = importCodexJsonl(codex2);
    const { jsonl: finalClaudeSeed } = prepareClaudeCodeResumeSeed(canonical4, "round-trip-2");

    // STRICT: across all 4 hops, the reasoning rides as native signed
    // thinking (signature preserved through every codex hop via lac
    // extensions). It must NEVER fall back to the demote-to-text path
    // here — these fixtures all start with a valid signature, so any
    // appearance of historical reasoning wrapper text would mean lac dropped the
    // signature somewhere in the chain.
    let nativeThinkingFound = false;
    let demotedTextFound = false;
    for (const line of finalClaudeSeed.split("\n").filter((l) => l.trim())) {
      const obj = JSON.parse(line);
      if (obj.type !== "assistant") continue;
      const content = obj.message?.content ?? [];
      for (const block of content) {
        if (
          block?.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.includes(claudeReasoningText)
        ) {
          nativeThinkingFound = true;
          expect(
            typeof block.signature === "string" && (block.signature as string).length > 0,
            "thinking block must carry a signature",
          ).toBe(true);
        }
        if (block?.type === "text" && typeof block.text === "string" && block.text.includes(claudeReasoningText)) {
          demotedTextFound = true;
        }
      }
    }
    expect(nativeThinkingFound, "claude reasoning text was lost across a 4-hop round-trip").toBe(true);
    expect(
      demotedTextFound,
      "reasoning fell back to the demote-to-text path during the 4-hop round-trip — signature was dropped somewhere in the chain",
    ).toBe(false);
  });
});
