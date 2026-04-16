import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { importClaudePrintResult, importCodexExecJsonl, importPiSessionJsonl, type ClaudePrintResult } from "@lossless-agent-context/adapters";
import { canonicalEventSchema, type CanonicalEvent } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";

const enabled = process.env.LAC_ENABLE_LIVE_PROVIDER_E2E === "1";
const run = enabled ? it : it.skip;

const PROMPT =
  'Reply with ONLY minified JSON matching exactly this shape: {"task":"cli-smoke","status":"ok","sum":4}. Compute 2+2 first and set sum accordingly.';
const SYSTEM = "You are a precise JSON-only assistant.";

describe("live provider smoke e2e", () => {
  run("uses local claude, codex, and pi CLIs with existing auth and checks semantic equivalence", async () => {
    const claudeEvents = canonicalEventSchema.array().parse(runClaudeCliSmoke());
    const codexEvents = canonicalEventSchema.array().parse(runCodexCliSmoke());
    const piEvents = canonicalEventSchema.array().parse(runPiCliSmoke());

    const claudeJson = parseStrictJson(getFinalAssistantText(claudeEvents));
    const codexJson = parseStrictJson(getFinalAssistantText(codexEvents));
    const piJson = parseStrictJson(getFinalAssistantText(piEvents));

    expect(claudeJson).toEqual({ task: "cli-smoke", status: "ok", sum: 4 });
    expect(codexJson).toEqual({ task: "cli-smoke", status: "ok", sum: 4 });
    expect(piJson).toEqual({ task: "cli-smoke", status: "ok", sum: 4 });
  }, 60_000);
});

function runClaudeCliSmoke(): CanonicalEvent[] {
  const result = spawnSync(
    "claude",
    [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--tools",
      "",
      "--system-prompt",
      SYSTEM,
    ],
    {
      input: PROMPT,
      encoding: "utf8",
    },
  );

  expect(result.status, result.stderr).toBe(0);
  const parsed = JSON.parse(result.stdout.trim()) as ClaudePrintResult;
  return importClaudePrintResult(parsed, PROMPT);
}

function runCodexCliSmoke(): CanonicalEvent[] {
  const result = spawnSync(
    "codex",
    [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--json",
      "-",
    ],
    {
      input: `${SYSTEM}\n\n${PROMPT}`,
      encoding: "utf8",
    },
  );

  expect(result.status, result.stderr).toBe(0);
  const stdout = result.stdout
    .split(/\r?\n/)
    .filter(line => line.trim().startsWith("{"))
    .join("\n");
  return importCodexExecJsonl(stdout, PROMPT);
}

function runPiCliSmoke(): CanonicalEvent[] {
  const sessionDir = mkdtempSync(join(tmpdir(), "lac-pi-cli-"));
  const result = spawnSync(
    "pi",
    [
      "-p",
      "--mode",
      "json",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--system-prompt",
      SYSTEM,
      "--session-dir",
      sessionDir,
    ],
    {
      input: PROMPT,
      encoding: "utf8",
    },
  );

  expect(result.status, result.stderr).toBe(0);
  const sessionFile = readSingleSessionFile(sessionDir);
  return importPiSessionJsonl(readFileSync(sessionFile, "utf8"));
}

function readSingleSessionFile(sessionDir: string): string {
  const files = readdirSync(sessionDir);
  expect(files.length).toBe(1);
  return join(sessionDir, files[0]!);
}

function getFinalAssistantText(events: CanonicalEvent[]): string {
  const assistantMessages = events.filter(
    (event): event is Extract<CanonicalEvent, { kind: "message.created" }> =>
      event.kind === "message.created" && event.payload.role === "assistant",
  );
  const last = assistantMessages.at(-1);
  const textPart = last?.payload.parts.find(
    (part): part is Extract<typeof part, { type: "text" }> => part.type === "text",
  );
  expect(textPart?.text).toBeTruthy();
  return textPart!.text;
}

function parseStrictJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error(`Could not parse JSON from CLI output: ${trimmed}`);
  }
}
