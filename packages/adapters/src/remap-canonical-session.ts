import type { CanonicalEvent } from "@lossless-agent-context/core";
import { rewriteIds } from "./cross-provider";

export function remapCanonicalSession(events: CanonicalEvent[], sessionId: string): CanonicalEvent[] {
  const first = events[0];
  return rewriteIds(events, sessionId, first?.branchId ?? "main", 0);
}
