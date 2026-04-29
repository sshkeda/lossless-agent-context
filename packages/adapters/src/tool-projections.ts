import type { CanonicalEvent } from "@lossless-agent-context/core";

type ClaudeToolProjection = {
  name: string;
  input: unknown;
};

type PiToolProjection = {
  name: string;
  arguments: unknown;
};

type JsonRecord = Record<string, unknown>;
type ToolProjectionRule = {
  targetName: string;
  buildInput: (args: JsonRecord | undefined, rawArguments: unknown) => unknown | undefined;
};
type ReverseToolProjectionRule = {
  targetName: string;
  buildArguments: (args: JsonRecord | undefined, rawArguments: unknown) => unknown | undefined;
};

export const PI_MCP_PROXY_PREFIX = "pi_mcp_proxy__";
const CLAUDE_PI_MCP_PREFIX = "mcp__pi-tools__";
const PI_CLAUDE_CODE_TOOL_PROVENANCE_KEY = "pi-claude-code/toolProvenance";

export function normalizePiMcpToolName(name: string): string {
  if (name.startsWith(PI_MCP_PROXY_PREFIX)) return name.slice(PI_MCP_PROXY_PREFIX.length);
  if (name.startsWith(CLAUDE_PI_MCP_PREFIX)) return name.slice(CLAUDE_PI_MCP_PREFIX.length);
  return name;
}

const PASSTHROUGH_CLAUDE_TOOL_NAMES = new Set(["Read", "Grep", "Glob", "Bash", "Edit", "Write", "LS"]);

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function readString(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function readBoolean(record: JsonRecord | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function withDefinedFields(base: JsonRecord, fields: Array<[string, unknown]>): JsonRecord {
  for (const [key, value] of fields) {
    if (value !== undefined) base[key] = value;
  }
  return base;
}

function projectRead(args: JsonRecord | undefined): JsonRecord | undefined {
  const path = readString(args, "path");
  if (!path) return undefined;
  return withDefinedFields({ file_path: path }, [
    ["offset", readNumber(args, "offset")],
    ["limit", readNumber(args, "limit")],
  ]);
}

function projectBashCommand(args: JsonRecord | undefined, commandKey: string): JsonRecord | undefined {
  const command = readString(args, commandKey);
  if (!command) return undefined;
  return withDefinedFields({ command }, [["description", readString(args, "description")]]);
}

function readClaudeCodeTimeoutMsProvenance(event: Extract<CanonicalEvent, { kind: "tool.call" }>): number | undefined {
  const provenance = event.extensions?.[PI_CLAUDE_CODE_TOOL_PROVENANCE_KEY];
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const record = provenance as Record<string, unknown>;
  if (record.sourceExecutor !== "claude-code" || record.sourceToolName !== "Bash") return undefined;
  const semantics = record.argumentSemantics;
  if (!semantics || typeof semantics !== "object" || Array.isArray(semantics)) return undefined;
  const timeout = (semantics as Record<string, unknown>).timeout;
  if (!timeout || typeof timeout !== "object" || Array.isArray(timeout)) return undefined;
  const timeoutRecord = timeout as Record<string, unknown>;
  if (timeoutRecord.unit !== "ms") return undefined;
  return typeof timeoutRecord.value === "number" && Number.isFinite(timeoutRecord.value) && timeoutRecord.value > 0
    ? timeoutRecord.value
    : undefined;
}

function projectWrite(args: JsonRecord | undefined): JsonRecord | undefined {
  const path = readString(args, "path");
  const content = readString(args, "content");
  if (!path || content === undefined) return undefined;
  return { file_path: path, content };
}

function projectSingleEdit(path: string, editRecord: JsonRecord, replaceAll: boolean): JsonRecord | undefined {
  const oldString = readString(editRecord, "oldText");
  const newString = readString(editRecord, "newText");
  if (oldString === undefined || newString === undefined) return undefined;
  return {
    file_path: path,
    old_string: oldString,
    new_string: newString,
    replace_all: replaceAll,
  };
}

function projectEdit(args: JsonRecord | undefined): JsonRecord | undefined {
  const path = readString(args, "path");
  if (!path) return undefined;

  const singleEdit = projectSingleEdit(path, args ?? {}, readBoolean(args, "replaceAll") ?? false);
  if (singleEdit) return singleEdit;

  const edits = args?.edits;
  if (!Array.isArray(edits) || edits.length !== 1) return undefined;
  const editRecord = asRecord(edits[0]);
  if (!editRecord) return undefined;
  return projectSingleEdit(path, editRecord, false);
}

function projectGrep(args: JsonRecord | undefined): JsonRecord | undefined {
  const pattern = readString(args, "pattern");
  if (!pattern) return undefined;
  return withDefinedFields({ pattern }, [
    ["path", readString(args, "path")],
    ["glob", readString(args, "glob")],
    ["output_mode", readString(args, "output_mode")],
    ["head_limit", readNumber(args, "head_limit")],
    ["-i", readBoolean(args, "-i")],
  ]);
}

function projectGlob(args: JsonRecord | undefined): JsonRecord | undefined {
  const pattern = readString(args, "pattern");
  if (!pattern) return undefined;
  return { pattern };
}

function projectLs(args: JsonRecord | undefined): JsonRecord {
  return withDefinedFields({}, [
    ["path", readString(args, "path")],
    ["limit", readNumber(args, "limit")],
  ]);
}

function normalizeClaudeRead(args: JsonRecord | undefined): JsonRecord | undefined {
  const path = readString(args, "file_path");
  if (!path) return undefined;
  return withDefinedFields({ path }, [
    ["offset", readNumber(args, "offset")],
    ["limit", readNumber(args, "limit")],
  ]);
}

function normalizeClaudeBash(args: JsonRecord | undefined): JsonRecord | undefined {
  const command = readString(args, "command");
  if (!command) return undefined;
  return withDefinedFields({ command }, [["description", readString(args, "description")]]);
}

function normalizeClaudeWrite(args: JsonRecord | undefined): JsonRecord | undefined {
  const path = readString(args, "file_path");
  const content = readString(args, "content");
  if (!path || content === undefined) return undefined;
  return { path, content };
}

function normalizeClaudeEdit(args: JsonRecord | undefined): JsonRecord | undefined {
  const path = readString(args, "file_path");
  const oldText = readString(args, "old_string");
  const newText = readString(args, "new_string");
  if (!path || oldText === undefined || newText === undefined) return undefined;
  if (readBoolean(args, "replace_all") === true) return undefined;
  return { path, edits: [{ oldText, newText }] };
}

function normalizeClaudeGrep(args: JsonRecord | undefined): JsonRecord | undefined {
  const pattern = readString(args, "pattern");
  if (!pattern) return undefined;
  return withDefinedFields({ pattern }, [
    ["path", readString(args, "path")],
    ["glob", readString(args, "glob")],
    ["output_mode", readString(args, "output_mode")],
    ["head_limit", readNumber(args, "head_limit")],
    ["-i", readBoolean(args, "-i")],
  ]);
}

function normalizeClaudeGlob(args: JsonRecord | undefined): JsonRecord | undefined {
  const pattern = readString(args, "pattern");
  if (!pattern) return undefined;
  return withDefinedFields({ pattern }, [
    ["path", readString(args, "path")],
    ["limit", readNumber(args, "limit")],
  ]);
}

function normalizeClaudeLs(args: JsonRecord | undefined): JsonRecord | undefined {
  return withDefinedFields({}, [
    ["path", readString(args, "path")],
    ["limit", readNumber(args, "limit")],
  ]);
}

const TOOL_PROJECTION_RULES: Record<string, ToolProjectionRule> = {
  read: {
    targetName: "Read",
    buildInput: (args) => projectRead(args),
  },
  bash: {
    targetName: "Bash",
    buildInput: (args) => projectBashCommand(args, "command"),
  },
  exec_command: {
    targetName: "Bash",
    buildInput: (args) => projectBashCommand(args, "cmd"),
  },
  write: {
    targetName: "Write",
    buildInput: (args) => projectWrite(args),
  },
  edit: {
    targetName: "Edit",
    buildInput: (args) => projectEdit(args),
  },
  grep: {
    targetName: "Grep",
    buildInput: (args) => projectGrep(args),
  },
  glob: {
    targetName: "Glob",
    buildInput: (args) => projectGlob(args),
  },
  ls: {
    targetName: "LS",
    buildInput: (args) => projectLs(args),
  },
};

const CLAUDE_TO_PI_TOOL_PROJECTION_RULES: Record<string, ReverseToolProjectionRule> = {
  Read: {
    targetName: "read",
    buildArguments: (args) => normalizeClaudeRead(args),
  },
  Bash: {
    targetName: "bash",
    buildArguments: (args) => normalizeClaudeBash(args),
  },
  Write: {
    targetName: "write",
    buildArguments: (args) => normalizeClaudeWrite(args),
  },
  Edit: {
    targetName: "edit",
    buildArguments: (args) => normalizeClaudeEdit(args),
  },
  Grep: {
    targetName: "grep",
    buildArguments: (args) => normalizeClaudeGrep(args),
  },
  Glob: {
    targetName: "find",
    buildArguments: (args) => normalizeClaudeGlob(args),
  },
  LS: {
    targetName: "ls",
    buildArguments: (args) => normalizeClaudeLs(args),
  },
};

export function projectToolCallToClaude(
  event: Extract<CanonicalEvent, { kind: "tool.call" }>,
): ClaudeToolProjection | null {
  const name = normalizePiMcpToolName(event.payload.name);

  if (PASSTHROUGH_CLAUDE_TOOL_NAMES.has(name)) {
    return {
      name,
      input: event.payload.arguments ?? {},
    };
  }

  const rule = TOOL_PROJECTION_RULES[name];
  if (!rule) return null;

  const args = asRecord(event.payload.arguments);
  const input = rule.buildInput(args, event.payload.arguments);
  if (input === undefined) return null;
  if (name === "bash" && rule.targetName === "Bash" && input && typeof input === "object" && !Array.isArray(input)) {
    const timeoutMs = readClaudeCodeTimeoutMsProvenance(event);
    if (timeoutMs !== undefined) {
      return { name: rule.targetName, input: { ...(input as JsonRecord), timeout: timeoutMs } };
    }
  }
  return { name: rule.targetName, input };
}

export function projectClaudeToolCallToPi(name: string, input: unknown): PiToolProjection {
  const normalizedName = normalizePiMcpToolName(name);
  const args = asRecord(input);
  const rule = CLAUDE_TO_PI_TOOL_PROJECTION_RULES[normalizedName];
  if (!rule) {
    return { name: normalizedName, arguments: input ?? {} };
  }
  const normalizedArguments = rule.buildArguments(args, input);
  if (normalizedArguments === undefined) {
    return { name: normalizedName, arguments: input ?? {} };
  }
  return { name: rule.targetName, arguments: normalizedArguments };
}
