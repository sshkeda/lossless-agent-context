#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  emptySidecar,
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
  isEmptySidecar,
  parseSidecar,
  prepareClaudeCodeResumeSeed,
  serializeSidecar,
  sidecarPathForSeedPath,
} from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";

type Provider = "pi" | "claude-code" | "codex";
type Command = "convert" | "prepare-claude-code-resume";

const IMPORTERS: Record<Exclude<Provider, "claude-code">, (input: string) => CanonicalEvent[]> = {
  pi: importPiSessionJsonl,
  codex: importCodexJsonl,
};

const EXPORTERS: Record<Provider, (events: CanonicalEvent[]) => string> = {
  pi: exportPiSessionJsonl,
  "claude-code": exportClaudeCodeJsonl,
  codex: exportCodexJsonl,
};

const USAGE = `Usage:
  lac convert <input> --to <provider> [--from <provider>] [-o <output>]
  lac prepare-claude-code-resume <input> [--from <provider>] -o <output> [--session-id <id>]

Providers: pi | claude-code | codex

Examples:
  lac convert session.jsonl --to claude-code -o claude.jsonl
  lac convert claude.jsonl --to codex -o codex.jsonl
  lac prepare-claude-code-resume session.jsonl --from pi -o claude-seed.jsonl
  cat session.jsonl | lac convert - --to pi

When reading Claude Code JSONL from a file path, lac reads the adjacent recovery
sidecar if present: <file>.lossless.json. The prepare-claude-code-resume command
writes <output>.lossless.json when recovery metadata is needed.
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function isProvider(value: string): value is Provider {
  return value === "pi" || value === "claude-code" || value === "codex";
}

function detectProvider(input: string): Provider {
  const firstLine = input.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) fail("Cannot detect provider: input is empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    fail("Cannot detect provider: first line is not valid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    fail("Cannot detect provider: first line is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;

  if (record.type === "session" && record.version === 3) return "pi";
  if (record.type === "session_meta") return "codex";
  if (typeof record.sessionId === "string") return "claude-code";

  fail("Cannot detect provider from first line; pass --from <provider> explicitly");
}

type Args = {
  command: Command;
  input: string;
  to?: Provider;
  from?: Provider;
  output?: string;
  sessionId?: string;
};

function parseArgs(argv: string[]): Args {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const [commandRaw, ...rest] = argv;
  if (commandRaw !== "convert" && commandRaw !== "prepare-claude-code-resume") {
    fail(`Unknown command: ${commandRaw}\n\n${USAGE}`);
  }
  const command = commandRaw;

  let input: string | undefined;
  let to: Provider | undefined;
  let from: Provider | undefined;
  let output: string | undefined;
  let sessionId: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) fail("Missing argument");
    if (arg === "--to" || arg === "--from" || arg === "-o" || arg === "--output" || arg === "--session-id") {
      const value = rest[i + 1];
      if (!value) fail(`${arg} requires a value`);
      i += 1;
      if (arg === "--to") {
        if (!isProvider(value)) fail(`Invalid --to: ${value}`);
        to = value;
      } else if (arg === "--from") {
        if (!isProvider(value)) fail(`Invalid --from: ${value}`);
        from = value;
      } else if (arg === "--session-id") {
        sessionId = value;
      } else {
        output = value;
      }
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (arg !== "-" && arg.startsWith("-")) fail(`Unknown flag: ${arg}`);
    if (input !== undefined) fail(`Unexpected positional argument: ${arg}`);
    input = arg;
  }

  if (!input) fail(USAGE);
  if (command === "convert" && !to) fail("Missing required --to <provider>");
  if (command === "prepare-claude-code-resume" && !output) fail("prepare-claude-code-resume requires -o <output>");
  return {
    command,
    input,
    ...(to !== undefined ? { to } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

function readInput(path: string): string {
  try {
    if (path === "-") return readFileSync(0, "utf8");
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error) fail(`Cannot read ${path}: ${error.message}`);
    fail(`Cannot read ${path}`);
  }
}

function readClaudeSidecar(inputPath: string): ReturnType<typeof emptySidecar> {
  if (inputPath === "-") return emptySidecar();
  const path = sidecarPathForSeedPath(inputPath);
  if (!existsSync(path)) return emptySidecar();
  return parseSidecar(readFileSync(path, "utf8"));
}

function importCanonical(from: Provider, raw: string, inputPath: string): CanonicalEvent[] {
  if (from === "claude-code") return importClaudeCodeJsonl(raw, readClaudeSidecar(inputPath));
  return IMPORTERS[from](raw);
}

function writeOutput(path: string | undefined, output: string): void {
  if (path) {
    writeFileSync(path, output);
  } else {
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const raw = readInput(args.input);
  const from = args.from ?? detectProvider(raw);

  try {
    const canonical = importCanonical(from, raw, args.input);
    if (args.command === "prepare-claude-code-resume") {
      if (!args.output) fail("prepare-claude-code-resume requires -o <output>");
      const targetSessionId = args.sessionId ?? canonical[0]?.sessionId ?? "lac-claude-code-session";
      const prepared = prepareClaudeCodeResumeSeed(canonical, targetSessionId);
      writeFileSync(args.output, prepared.jsonl);
      if (!isEmptySidecar(prepared.sidecar)) {
        writeFileSync(sidecarPathForSeedPath(args.output), serializeSidecar(prepared.sidecar));
      }
      return;
    }

    if (!args.to) fail("Missing required --to <provider>");
    writeOutput(args.output, EXPORTERS[args.to](canonical));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to ${args.command} from ${from}: ${message}`);
  }
}

main();
