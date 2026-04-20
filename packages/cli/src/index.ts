#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import {
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";

type Provider = "pi" | "claude-code" | "codex";

const IMPORTERS: Record<Provider, (input: string) => CanonicalEvent[]> = {
  pi: importPiSessionJsonl,
  "claude-code": importClaudeCodeJsonl,
  codex: importCodexJsonl,
};

const EXPORTERS: Record<Provider, (events: CanonicalEvent[]) => string> = {
  pi: exportPiSessionJsonl,
  "claude-code": exportClaudeCodeJsonl,
  codex: exportCodexJsonl,
};

const USAGE = `Usage: lac convert <input> --to <provider> [--from <provider>] [-o <output>]

Providers: pi | claude-code | codex

Examples:
  lac convert session.jsonl --to claude-code
  lac convert session.jsonl --to codex -o codex.jsonl
  cat session.jsonl | lac convert - --to pi
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
  input: string;
  to: Provider;
  from?: Provider;
  output?: string;
};

function parseArgs(argv: string[]): Args {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const [command, ...rest] = argv;
  if (command !== "convert") fail(`Unknown command: ${command}\n\n${USAGE}`);

  let input: string | undefined;
  let to: Provider | undefined;
  let from: Provider | undefined;
  let output: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--to" || arg === "--from" || arg === "-o" || arg === "--output") {
      const value = rest[i + 1];
      if (!value) fail(`${arg} requires a value`);
      i += 1;
      if (arg === "--to") {
        if (!isProvider(value)) fail(`Invalid --to: ${value}`);
        to = value;
      } else if (arg === "--from") {
        if (!isProvider(value)) fail(`Invalid --from: ${value}`);
        from = value;
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
  if (!to) fail("Missing required --to <provider>");
  return { input, to, from, output };
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const raw = readInput(args.input);
  const from = args.from ?? detectProvider(raw);

  const importer = IMPORTERS[from];
  const exporter = EXPORTERS[args.to];
  const canonical = importer(raw);
  const output = exporter(canonical);

  if (args.output) {
    writeFileSync(args.output, output);
  } else {
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  }
}

main();
