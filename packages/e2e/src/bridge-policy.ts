import type { CanonicalEvent } from "@lossless-agent-context/core";

const PI_CLAUDE_RESUME_BRIDGE_TOOL_NAMES = new Set(["ask_claude_code"]);

/**
 * Test-only resume seeding policy.
 *
 * Pi's Claude Code bridge can emit internal ask_claude_code tool cycles that are
 * transport noise for the swap/resume smoke path. The product exporters still
 * preserve those events losslessly; the native Claude resume smoke strips them
 * explicitly before seeding a Claude session.
 *
 * If product policy changes, update this helper and the dedicated regression test
 * together instead of baking the policy into adapter logic implicitly.
 */
export function stripPiClaudeBridgeToolCyclesForClaudeResume(events: CanonicalEvent[]): CanonicalEvent[] {
  const bridgeToolCallIds = new Set(
    events
      .filter(
        (event): event is Extract<CanonicalEvent, { kind: "tool.call" }> =>
          event.kind === "tool.call" && PI_CLAUDE_RESUME_BRIDGE_TOOL_NAMES.has(event.payload.name),
      )
      .map((event) => event.payload.toolCallId),
  );

  return events.filter((event) => {
    if (event.kind === "tool.call") return !bridgeToolCallIds.has(event.payload.toolCallId);
    if (event.kind === "tool.result") return !bridgeToolCallIds.has(event.payload.toolCallId);
    return true;
  });
}
