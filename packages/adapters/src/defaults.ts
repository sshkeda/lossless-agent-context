export const DEFAULT_BRANCH_ID = "main";

export const PI_SESSION_VERSION = 3;
export const CLAUDE_CODE_IDS_EXTENSION = "lac:claudeCodeLine";
export const TARGET_IDS_FIELD = "__lac_targets";
export const CODEX_ASSISTANT_PARTS_FIELD = "assistantParts";
// Top-level field on a claude-code session JSONL line (sibling of `message`)
// that carries lac-specific recovery markers across a one-way conversion.
// Currently used to record `<thinking>`-text demotions so the round-trip back
// to a native reasoning event is deterministic instead of regex-based.
export const LOSSLESS_RECOVERY_KEY = "losslessAgentContext";
