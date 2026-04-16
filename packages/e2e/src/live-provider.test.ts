import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getSessionMessages, InMemorySessionStore } from "@anthropic-ai/claude-agent-sdk";
import {
  type ClaudePrintResult,
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importClaudePrintResult,
  importCodexExecJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import { type CanonicalEvent, canonicalEventSchema } from "@lossless-agent-context/core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { buildSessionContext, parseSessionEntries, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { claudeSdkAssistantInner, jsonRecord } from "./sdk-schemas";

const claudePrintResultSchema = z
  .object({
    type: z.string(),
    subtype: z.string().optional(),
    result: z.string(),
    session_id: z.string().optional(),
    duration_ms: z.number().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
      })
      .optional(),
    modelUsage: z
      .record(
        z.string(),
        z.object({
          inputTokens: z.number().optional(),
          outputTokens: z.number().optional(),
          totalTokens: z.number().optional(),
        }),
      )
      .optional(),
  })
  .catchall(z.unknown());

const enabled = process.env.LAC_ENABLE_LIVE_PROVIDER_E2E === "1";
const run = enabled ? it : it.skip;

const PROMPT =
  'Reply with ONLY minified JSON matching exactly this shape: {"task":"cli-smoke","status":"ok","sum":4}. Compute 2+2 first and set sum accordingly.';
const SYSTEM = "You are a precise JSON-only assistant.";

describe("live provider smoke e2e", () => {
  run(
    "uses local claude, codex, and pi CLIs with existing auth and checks semantic equivalence",
    () => {
      const claudeEvents = canonicalEventSchema.array().parse(runClaudeCliSmoke());
      const codexEvents = canonicalEventSchema.array().parse(runCodexCliSmoke());
      const piEvents = canonicalEventSchema.array().parse(runPiCliSmoke());

      const claudeJson = parseStrictJson(getFinalAssistantText(claudeEvents));
      const codexJson = parseStrictJson(getFinalAssistantText(codexEvents));
      const piJson = parseStrictJson(getFinalAssistantText(piEvents));

      expect(claudeJson).toEqual({ task: "cli-smoke", status: "ok", sum: 4 });
      expect(codexJson).toEqual({ task: "cli-smoke", status: "ok", sum: 4 });
      expect(piJson).toEqual({ task: "cli-smoke", status: "ok", sum: 4 });
    },
    60_000,
  );

  run(
    "live Codex output survives cross-provider conversion to Pi and Claude SDK shapes",
    async () => {
      const { events: codexEvents, jsonl: codexJsonl } = runCodexCliSession();
      expect(parseStrictJson(getFinalAssistantText(codexEvents))).toEqual({
        task: "cli-smoke",
        status: "ok",
        sum: 4,
      });

      const reimportedCodex = importCodexJsonl(codexJsonl);
      expect(getFinalAssistantText(reimportedCodex)).toBe(getFinalAssistantText(codexEvents));

      const piText = exportPiSessionJsonl(reimportedCodex);
      const piEntries = parseSessionEntries(piText).filter((e): e is SessionEntry => e.type !== "session");
      const piContext = buildSessionContext(piEntries);
      expect(parseStrictJson(extractPiAssistantText(piContext.messages))).toEqual({
        task: "cli-smoke",
        status: "ok",
        sum: 4,
      });

      const claudeText = exportClaudeCodeJsonl(reimportedCodex);
      const claudeLines = claudeText
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => jsonRecord.parse(JSON.parse(line)));
      const sessionId = randomUUID();
      const cwd = "/tmp/lossless-agent-context-live-codex-validation";
      for (const line of claudeLines) {
        line.sessionId = sessionId;
        line.cwd = cwd;
      }
      const store = new InMemorySessionStore();
      await store.append({ projectKey: resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"), sessionId }, claudeLines);
      const messages = await getSessionMessages(sessionId, { sessionStore: store, dir: cwd });
      const assistantSdkMessage = messages.find((m) => m.type === "assistant");
      expect(assistantSdkMessage).toBeDefined();
      const sdkText = extractClaudeSdkAssistantText(assistantSdkMessage?.message);
      expect(parseStrictJson(sdkText)).toEqual({
        task: "cli-smoke",
        status: "ok",
        sum: 4,
      });
    },
    60_000,
  );

  run(
    "live Pi session survives cross-provider conversion to Codex and Claude SDK shapes",
    () => {
      const { events: piEvents, jsonl: piJsonl } = runPiCliSession();
      expect(parseStrictJson(getFinalAssistantText(piEvents))).toEqual({
        task: "cli-smoke",
        status: "ok",
        sum: 4,
      });
      expect(piJsonl.length).toBeGreaterThan(0);

      const codexText = exportCodexJsonl(piEvents);
      const reimportedFromCodex = importCodexJsonl(codexText);
      expect(parseStrictJson(getFinalAssistantText(reimportedFromCodex))).toEqual({
        task: "cli-smoke",
        status: "ok",
        sum: 4,
      });

      const claudeText = exportClaudeCodeJsonl(piEvents);
      const reimportedFromClaude = importClaudeCodeJsonl(claudeText);
      expect(parseStrictJson(getFinalAssistantText(reimportedFromClaude))).toEqual({
        task: "cli-smoke",
        status: "ok",
        sum: 4,
      });
    },
    60_000,
  );

  run(
    "live Claude print result survives cross-provider conversion to Pi and Codex",
    () => {
      const claudeEvents = runClaudeCliSmoke();
      expect(parseStrictJson(getFinalAssistantText(claudeEvents))).toEqual({
        task: "cli-smoke",
        status: "ok",
        sum: 4,
      });

      const piText = exportPiSessionJsonl(claudeEvents);
      const piEntries = parseSessionEntries(piText).filter((e): e is SessionEntry => e.type !== "session");
      const piContext = buildSessionContext(piEntries);
      expect(parseStrictJson(extractPiAssistantText(piContext.messages))).toEqual({
        task: "cli-smoke",
        status: "ok",
        sum: 4,
      });

      const codexText = exportCodexJsonl(claudeEvents);
      const reimportedFromCodex = importCodexJsonl(codexText);
      expect(parseStrictJson(getFinalAssistantText(reimportedFromCodex))).toEqual({
        task: "cli-smoke",
        status: "ok",
        sum: 4,
      });
    },
    60_000,
  );
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
  const parsed: ClaudePrintResult = claudePrintResultSchema.parse(JSON.parse(result.stdout.trim()));
  return importClaudePrintResult(parsed, PROMPT);
}

function runCodexCliSmoke(): CanonicalEvent[] {
  return runCodexCliSession().events;
}

function runCodexCliSession(): { events: CanonicalEvent[]; jsonl: string } {
  const result = spawnSync("codex", ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "-"], {
    input: `${SYSTEM}\n\n${PROMPT}`,
    encoding: "utf8",
  });

  expect(result.status, result.stderr).toBe(0);
  const stdout = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"))
    .join("\n");
  return { events: importCodexExecJsonl(stdout, PROMPT), jsonl: stdout };
}

function runPiCliSmoke(): CanonicalEvent[] {
  return runPiCliSession().events;
}

function runPiCliSession(): { events: CanonicalEvent[]; jsonl: string } {
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
  const jsonl = readFileSync(sessionFile, "utf8");
  return { events: importPiSessionJsonl(jsonl), jsonl };
}

function readSingleSessionFile(sessionDir: string): string {
  const files = readdirSync(sessionDir);
  expect(files.length).toBe(1);
  const file = files[0];
  if (!file) throw new Error(`expected one session file in ${sessionDir}`);
  return join(sessionDir, file);
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
  const text = textPart?.text;
  expect(text).toBeTruthy();
  if (!text) throw new Error("expected assistant text part");
  return text;
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

type PiAssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

function isPiAssistantMessage(message: AgentMessage): message is PiAssistantMessage {
  return message.role === "assistant";
}

function extractPiAssistantText(messages: ReadonlyArray<AgentMessage>): string {
  return messages
    .filter(isPiAssistantMessage)
    .flatMap((m) => m.content)
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function extractClaudeSdkAssistantText(message: unknown): string {
  const result = claudeSdkAssistantInner.safeParse(message);
  if (!result.success) return "";
  return result.data.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}
