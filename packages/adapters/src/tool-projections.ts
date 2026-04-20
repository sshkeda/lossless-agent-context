import type { CanonicalEvent } from "@lossless-agent-context/core";

type ClaudeToolProjection = {
  name: string;
  input: unknown;
};

type JsonRecord = Record<string, unknown>;
type ToolProjectionRule = {
  targetName: string;
  buildInput: (args: JsonRecord | undefined, rawArguments: unknown) => unknown | undefined;
};

const PASSTHROUGH_CLAUDE_TOOL_NAMES = new Set(["Read", "Grep", "Glob", "Bash", "Edit", "Write"]);

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
};

export function projectToolCallToClaude(
  event: Extract<CanonicalEvent, { kind: "tool.call" }>,
): ClaudeToolProjection | null {
  const name = event.payload.name;

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
  return { name: rule.targetName, input };
}
