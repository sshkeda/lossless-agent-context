import {
  exportCodexJsonl,
  importClaudeCodeJsonl,
  importPiSessionJsonl,
  prepareClaudeCodeResumeSeed,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";

// Round-trip recovery for the cross-provider thinking demotion.
//
// `prepareClaudeCodeResumeSeed` demotes unsigned codex thinking blocks into
// `<thinking>...</thinking>`-wrapped text blocks so claude can resume without
// an API rejection (claude requires a claude-minted signature on every
// thinking block — see the HACK note in prepare-claude-code-resume.ts).
//
// That demotion is intentional, but it would silently leak as plain
// `<thinking>` text into a subsequent codex export if importClaudeCodeJsonl
// just took the text at face value. The recovery is deterministic: at seed
// time we stash the original chain-of-thought on the JSONL line wrapper
// (`losslessAgentContext.demotedReasoning[]`, indexed by contentIndex) — a
// sibling of `message`, never sent to the claude API. On import we read those
// markers and re-promote the matching text blocks back to native
// `reasoning.created` events so the codex export emits a `reasoning` item
// rather than a plain text message. No regex, no false matches on text that
// merely contains the substring `<thinking>`.

describe("cross-provider thinking demotion round-trip", () => {
  it("recovers a native codex reasoning item when re-importing a claude session that contains demoted <thinking> text", () => {
    const codexReasoningText = "**Plan**: Read the file then act.";
    const piJsonl = [
      { type: "session", version: 3, id: "sess-1", timestamp: "2026-04-21T00:00:00.000Z", cwd: "/tmp" },
      { type: "model_change", id: "m1", parentId: null, timestamp: "2026-04-21T00:00:00.100Z", provider: "openai-codex", modelId: "gpt-5.5" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-04-21T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 } },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-21T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: codexReasoningText, thinkingSignature: '{"id":"rs_x","encrypted_content":"OPENAI","summary":[]}' },
            { type: "text", text: "OK done.", textSignature: '{"id":"msg_y"}' },
          ],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.5",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: 2,
        },
      },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    // Step 1: pi session → canonical → claude resume seed (this is what
    // pi-claude-code writes when the user switches from codex to claude).
    const canonicalFromPi = importPiSessionJsonl(piJsonl);
    const seed = prepareClaudeCodeResumeSeed(canonicalFromPi, "claude-sess-1");

    // Sanity: the seed contains the <thinking>-wrapped text but no native
    // thinking block (because we couldn't sign it). The demotion marker is
    // recorded on the line wrapper, not inside `message.content`, so claude
    // never sees it.
    const assistantSeedLines = seed
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .filter((o) => o.type === "assistant");
    expect(assistantSeedLines).toHaveLength(1);
    const seedAssistantText = assistantSeedLines.flatMap((o) =>
      Array.isArray(o.message?.content) ? o.message.content : [],
    );
    const wrappedText = seedAssistantText.find(
      (b: { type?: string; text?: string }) => b?.type === "text" && typeof b.text === "string" && b.text.includes(`<thinking>\n${codexReasoningText}\n</thinking>`),
    );
    expect(wrappedText).toBeDefined();
    expect(seedAssistantText.some((b: { type?: string }) => b?.type === "thinking")).toBe(false);
    // The recovery marker rides on the wrapper, NOT in message.content.
    const recovery = assistantSeedLines[0].losslessAgentContext;
    expect(recovery).toEqual({ demotedReasoning: [{ contentIndex: 0, originalText: codexReasoningText }] });

    // Step 2: re-import the claude seed as canonical events. The recovery
    // logic must promote the `<thinking>...</thinking>` text back to a
    // `reasoning.created` event so semantic intent survives.
    const canonicalFromClaude = importClaudeCodeJsonl(seed);
    const reasoningEvents = canonicalFromClaude.filter((e) => e.kind === "reasoning.created");
    expect(reasoningEvents).toHaveLength(1);
    expect(reasoningEvents[0]?.kind === "reasoning.created" && reasoningEvents[0].payload.text).toBe(codexReasoningText);

    // The remaining text ("OK done.") should still appear as a normal
    // assistant message, not be folded into the reasoning event.
    const assistantTextParts = canonicalFromClaude
      .filter((e): e is Extract<typeof e, { kind: "message.created" }> => e.kind === "message.created" && e.payload.role === "assistant")
      .flatMap((e) => e.payload.parts)
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text);
    expect(assistantTextParts).toContain("OK done.");
    // The demoted <thinking> text must NOT also leak as a text message —
    // promotion replaces, not duplicates.
    expect(assistantTextParts.some((t) => t.includes("<thinking>"))).toBe(false);

    // Step 3: export the recovered canonical to codex. The result must
    // contain a native codex `reasoning` response item with the original
    // chain-of-thought text in its summary, not a plain text message.
    const codexExport = exportCodexJsonl(canonicalFromClaude);
    const codexLines = codexExport.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const reasoningItem = codexLines.find(
      (line) => line?.payload?.type === "reasoning",
    );
    expect(reasoningItem).toBeDefined();
    const summaryEntry = reasoningItem?.payload?.summary?.[0];
    expect(summaryEntry?.type).toBe("summary_text");
    expect(summaryEntry?.text).toBe(codexReasoningText);

    // No `<thinking>` tag should leak into any output_text on the codex side.
    for (const line of codexLines) {
      if (line?.payload?.type !== "message") continue;
      const content = Array.isArray(line.payload.content) ? line.payload.content : [];
      for (const part of content) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          expect(part.text.includes("<thinking>")).toBe(false);
        }
      }
    }
  });

  it("does not promote text blocks that lack a recovery marker, even if they contain <thinking> substrings", () => {
    // Recovery is driven by the `losslessAgentContext.demotedReasoning[]`
    // marker on the line wrapper, not by pattern-matching the text. A text
    // block that merely *mentions* `<thinking>` (e.g. the model discussing
    // the convention itself, or a user pasting an XML-tagged example) must
    // never be misinterpreted as a demoted reasoning block. This test
    // exercises BOTH a stray substring and an exact-shape pattern with no
    // marker — both must be left alone.
    const claudeJsonl = [
      { type: "system", subtype: "init", uuid: "u0", parentUuid: null, timestamp: "2026-04-21T00:00:00.000Z", sessionId: "orig", cwd: "/tmp" },
      {
        type: "assistant",
        parentUuid: "u0",
        uuid: "u1",
        timestamp: "2026-04-21T00:00:01.000Z",
        sessionId: "orig",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I see <thinking>some pattern</thinking> in the docs." },
            { type: "text", text: "<thinking>\nLooks like a thinking block but no marker exists.\n</thinking>" },
          ],
        },
      },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    const canonical = importClaudeCodeJsonl(claudeJsonl);
    expect(canonical.filter((e) => e.kind === "reasoning.created")).toHaveLength(0);
    const textParts = canonical
      .filter((e): e is Extract<typeof e, { kind: "message.created" }> => e.kind === "message.created" && e.payload.role === "assistant")
      .flatMap((e) => e.payload.parts);
    expect(textParts).toHaveLength(2);
    expect(textParts[0]?.type === "text" && textParts[0].text.includes("<thinking>")).toBe(true);
    expect(textParts[1]?.type === "text" && textParts[1].text.startsWith("<thinking>\n")).toBe(true);
  });

  it("only promotes the contentIndex listed in the marker, leaving other text blocks alone", () => {
    // Mixed content: the marker says contentIndex=1 was demoted from a
    // thinking block. contentIndex=0 (a real assistant statement) and
    // contentIndex=2 (model legitimately discussing the convention) must NOT
    // be promoted. Index-based recovery makes this trivially correct.
    const claudeJsonl = [
      { type: "system", subtype: "init", uuid: "u0", parentUuid: null, timestamp: "2026-04-21T00:00:00.000Z", sessionId: "orig", cwd: "/tmp" },
      {
        type: "assistant",
        parentUuid: "u0",
        uuid: "u1",
        timestamp: "2026-04-21T00:00:01.000Z",
        sessionId: "orig",
        losslessAgentContext: {
          demotedReasoning: [
            { contentIndex: 1, originalText: "promoted reasoning" },
          ],
        },
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Spoken intro." },
            { type: "text", text: "<thinking>\npromoted reasoning\n</thinking>" },
            { type: "text", text: "Mention of <thinking>foo</thinking> in passing." },
          ],
        },
      },
    ]
      .map((obj) => JSON.stringify(obj))
      .join("\n") + "\n";

    const canonical = importClaudeCodeJsonl(claudeJsonl);
    const reasoningEvents = canonical.filter((e) => e.kind === "reasoning.created");
    expect(reasoningEvents).toHaveLength(1);
    expect(reasoningEvents[0]?.kind === "reasoning.created" && reasoningEvents[0].payload.text).toBe("promoted reasoning");
    const assistantTexts = canonical
      .filter((e): e is Extract<typeof e, { kind: "message.created" }> => e.kind === "message.created" && e.payload.role === "assistant")
      .flatMap((e) => e.payload.parts)
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text);
    expect(assistantTexts).toContain("Spoken intro.");
    expect(assistantTexts.some((t) => t.includes("Mention of <thinking>"))).toBe(true);
    // The text block at index 1 was promoted to reasoning, so it must NOT
    // also appear as plain text (no duplication).
    expect(assistantTexts.some((t) => t === "<thinking>\npromoted reasoning\n</thinking>")).toBe(false);
  });
});
