export const DEFAULT_BRANCH_ID = "main";

export const PI_SESSION_VERSION = 3;
export const CLAUDE_CODE_IDS_EXTENSION = "lac:claudeCodeLine";
export const TARGET_IDS_FIELD = "__lac_targets";
export const CODEX_ASSISTANT_PARTS_FIELD = "assistantParts";
// Suffix appended to a claude-code seed JSONL path to locate its lac
// recovery sidecar file. The sidecar lives outside Claude Code's parse
// path entirely (see recovery-sidecar.ts for why).
//   `~/.claude/projects/<slug>/<sessionId>.jsonl`
//   `~/.claude/projects/<slug>/<sessionId>.jsonl.lossless.json`  ← sidecar
export const LOSSLESS_SIDECAR_FILE_SUFFIX = ".lossless.json";
