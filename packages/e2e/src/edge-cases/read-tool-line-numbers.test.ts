import {
  emptySidecar,
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import type { CanonicalEvent } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";
import { parseJsonlLines, parseJsonlObjectLines } from "../jsonl";

/**
 * Tests that Read tool output is handled correctly across providers,
 * particularly Claude Code's `cat -n` line number injection.
 *
 * Claude Code's Read tool returns content like:
 *   1\t{ "key": "value" }
 *   2\t  "nested": true
 *
 * Other providers (Pi, Codex) return raw file content without line numbers.
 * These tests verify:
 * 1. Same-provider roundtrips preserve line numbers verbatim
 * 2. Cross-provider conversions handle the format difference correctly
 * 3. The canonical representation stores the correct content
 */

// -------------------------------------------------------------------
// Fixture helpers
// -------------------------------------------------------------------

const SAMPLE_FILE_CONTENT = `export function hello() {\n  console.log("world");\n}\n`;

/** Claude Code Read tool output: cat -n format with tab-separated line numbers */
const CLAUDE_READ_OUTPUT = `1\texport function hello() {\n2\t  console.log("world");\n3\t}\n`;

/** Raw file content as Pi/Codex would return it */
const RAW_READ_OUTPUT = SAMPLE_FILE_CONTENT;

function makeClaudeSessionWithRead(opts: {
  readOutput: string;
  toolName?: string;
  filePath?: string;
}): string {
  const toolName = opts.toolName ?? "Read";
  const filePath = opts.filePath ?? "/tmp/hello.ts";
  return [
    JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-20T10:00:00.000Z",
      sessionId: "claude-read-test",
      cwd: "/tmp",
      version: "2.1.76",
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-20T10:00:01.000Z",
      sessionId: "claude-read-test",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that file." },
          {
            type: "tool_use",
            id: "toolu_read_1",
            name: toolName,
            input: { file_path: filePath },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-04-20T10:00:02.000Z",
      sessionId: "claude-read-test",
      cwd: "/tmp",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_read_1",
            content: opts.readOutput,
            is_error: false,
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-20T10:00:03.000Z",
      sessionId: "claude-read-test",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The file exports a hello function." }],
      },
    }),
    "",
  ].join("\n");
}

function makePiSessionWithRead(opts: { readOutput: string }): string {
  return [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-read-test",
      timestamp: "2026-04-20T10:00:00.000Z",
      cwd: "/tmp",
    }),
    JSON.stringify({
      type: "message",
      id: "msg_user_1",
      parentId: null,
      timestamp: "2026-04-20T10:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "read hello.ts" }],
        timestamp: 1776300001000,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "msg_asst_1",
      parentId: "msg_user_1",
      timestamp: "2026-04-20T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_read_pi", name: "read", arguments: { path: "/tmp/hello.ts" } },
        ],
        api: "pi-mock-api",
        provider: "anthropic",
        model: "claude-opus-4-6",
        stopReason: "toolUse",
        timestamp: 1776300002000,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "msg_result_1",
      parentId: "msg_asst_1",
      timestamp: "2026-04-20T10:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_read_pi",
        toolName: "read",
        content: [{ type: "text", text: opts.readOutput }],
        isError: false,
        timestamp: 1776300003000,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "msg_asst_2",
      parentId: "msg_result_1",
      timestamp: "2026-04-20T10:00:04.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The file exports a hello function." }],
        api: "pi-mock-api",
        provider: "anthropic",
        model: "claude-opus-4-6",
        stopReason: "endTurn",
        timestamp: 1776300004000,
      },
    }),
    "",
  ].join("\n");
}

function makeCodexSessionWithRead(opts: { readOutput: string }): string {
  return [
    JSON.stringify({
      timestamp: "2026-04-20T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "codex-read-test",
        timestamp: "2026-04-20T10:00:00.000Z",
        cwd: "/tmp",
        model_provider: "openai",
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-20T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "read_file",
        arguments: JSON.stringify({ path: "/tmp/hello.ts" }),
        call_id: "call_read_codex",
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-20T10:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_read_codex",
        output: opts.readOutput,
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-20T10:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "The file exports a hello function.",
      },
    }),
    "",
  ].join("\n");
}

// -------------------------------------------------------------------
// Same-provider roundtrips: verify line numbers are preserved verbatim
// -------------------------------------------------------------------

describe("edge case: Read tool line numbers — same-provider roundtrip", () => {
  it("claude-code: cat -n line numbers survive roundtrip byte-for-byte", () => {
    const input = makeClaudeSessionWithRead({ readOutput: CLAUDE_READ_OUTPUT });
    const events = importClaudeCodeJsonl(input, emptySidecar());
    const exported = exportClaudeCodeJsonl(events);

    expect(parseJsonlLines(exported)).toEqual(parseJsonlLines(input));
  });

  it("claude-code: multiline cat -n output with wide line numbers roundtrips", () => {
    // Simulate a file with 100+ lines where line numbers are 3 digits
    const lines = Array.from({ length: 120 }, (_, i) => `${i + 1}\tline ${i + 1} content`);
    const bigOutput = lines.join("\n");

    const input = makeClaudeSessionWithRead({ readOutput: bigOutput });
    const events = importClaudeCodeJsonl(input, emptySidecar());
    const exported = exportClaudeCodeJsonl(events);

    expect(parseJsonlLines(exported)).toEqual(parseJsonlLines(input));
  });

  it("pi: raw read output survives roundtrip byte-for-byte", () => {
    const input = makePiSessionWithRead({ readOutput: RAW_READ_OUTPUT });
    const events = importPiSessionJsonl(input);
    const exported = exportPiSessionJsonl(events);

    expect(parseJsonlLines(exported)).toEqual(parseJsonlLines(input));
  });

  it("codex: raw read output survives roundtrip byte-for-byte", () => {
    const input = makeCodexSessionWithRead({ readOutput: RAW_READ_OUTPUT });
    const events = importCodexJsonl(input);
    const exported = exportCodexJsonl(events);

    expect(parseJsonlLines(exported)).toEqual(parseJsonlLines(input));
  });
});

// -------------------------------------------------------------------
// Canonical representation: verify tool result content in events
// -------------------------------------------------------------------

describe("edge case: Read tool line numbers — canonical representation", () => {
  it("claude-code Read tool result has line numbers STRIPPED in canonical payload.output", () => {
    const input = makeClaudeSessionWithRead({ readOutput: CLAUDE_READ_OUTPUT });
    const events = importClaudeCodeJsonl(input, emptySidecar());

    const toolResults = events.filter(
      (e): e is Extract<CanonicalEvent, { kind: "tool.result" }> => e.kind === "tool.result",
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].payload.toolCallId).toBe("toolu_read_1");

    // The canonical output should have line numbers stripped (clean content)
    const output = toolResults[0].payload.output;
    expect(output).toBeDefined();
    expect(typeof output).toBe("string");
    // Should NOT have cat -n line number prefixes
    expect(output).not.toMatch(/^\d+\t/m);
    // Should have the raw file content
    expect(output).toContain("export function hello()");
    expect(output).toContain('console.log("world")');
    // Verify it matches the expected stripped content
    expect(output).toBe(RAW_READ_OUTPUT);
  });

  it("claude-code Read tool result preserves original in native.raw for lossless roundtrip", () => {
    const input = makeClaudeSessionWithRead({ readOutput: CLAUDE_READ_OUTPUT });
    const events = importClaudeCodeJsonl(input, emptySidecar());

    const toolResults = events.filter(
      (e): e is Extract<CanonicalEvent, { kind: "tool.result" }> => e.kind === "tool.result",
    );
    expect(toolResults).toHaveLength(1);
    // native.raw should still contain the original line with line numbers
    const nativeRaw = toolResults[0].native?.raw;
    expect(nativeRaw).toBeDefined();
    const rawStr = JSON.stringify(nativeRaw);
    expect(rawStr).toContain("1\\t");
  });

  it("pi read tool result is stored in canonical payload.output without line numbers", () => {
    const input = makePiSessionWithRead({ readOutput: RAW_READ_OUTPUT });
    const events = importPiSessionJsonl(input);

    const toolResults = events.filter(
      (e): e is Extract<CanonicalEvent, { kind: "tool.result" }> => e.kind === "tool.result",
    );
    expect(toolResults).toHaveLength(1);

    const output = toolResults[0].payload.output;
    const outputStr = typeof output === "string" ? output : JSON.stringify(output);
    // Should NOT have cat -n line number prefixes
    expect(outputStr).not.toMatch(/^\d+\t/m);
    expect(outputStr).toContain("export function hello()");
  });

  it("claude-code Grep tool result is NOT stripped (line numbers are meaningful)", () => {
    // Grep output has line numbers that are part of the semantic content
    const grepOutput = "src/main.ts:1:import { foo } from 'bar'\nsrc/main.ts:5:foo()";
    const input = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-20T10:00:00.000Z",
        sessionId: "claude-grep-test",
        cwd: "/tmp",
        version: "2.1.76",
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-20T10:00:01.000Z",
        sessionId: "claude-grep-test",
        cwd: "/tmp",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_grep_1", name: "Grep", input: { pattern: "foo" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-20T10:00:02.000Z",
        sessionId: "claude-grep-test",
        cwd: "/tmp",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_grep_1", content: grepOutput, is_error: false },
          ],
        },
      }),
      "",
    ].join("\n");

    const events = importClaudeCodeJsonl(input, emptySidecar());
    const toolResults = events.filter(
      (e): e is Extract<CanonicalEvent, { kind: "tool.result" }> => e.kind === "tool.result",
    );
    expect(toolResults).toHaveLength(1);
    // Grep output should be preserved exactly — no stripping
    expect(toolResults[0].payload.output).toBe(grepOutput);
  });

  it("codex read tool result is stored in canonical payload.output without line numbers", () => {
    const input = makeCodexSessionWithRead({ readOutput: RAW_READ_OUTPUT });
    const events = importCodexJsonl(input);

    const toolResults = events.filter(
      (e): e is Extract<CanonicalEvent, { kind: "tool.result" }> => e.kind === "tool.result",
    );
    expect(toolResults).toHaveLength(1);

    const output = toolResults[0].payload.output;
    const outputStr = typeof output === "string" ? output : JSON.stringify(output);
    expect(outputStr).not.toMatch(/^\d+\t/m);
    expect(outputStr).toContain("export function hello()");
  });
});

// -------------------------------------------------------------------
// Cross-provider: claude -> pi/codex and back
// -------------------------------------------------------------------

describe("edge case: Read tool line numbers — cross-provider conversion", () => {
  it("claude-code -> pi -> claude-code preserves original Read output with line numbers", () => {
    const input = makeClaudeSessionWithRead({ readOutput: CLAUDE_READ_OUTPUT });

    const canonical1 = importClaudeCodeJsonl(input, emptySidecar());
    const piText = exportPiSessionJsonl(canonical1);
    const canonical2 = importPiSessionJsonl(piText);
    const claudeText = exportClaudeCodeJsonl(canonical2);

    // Full lossless roundtrip
    expect(parseJsonlLines(claudeText)).toEqual(parseJsonlLines(input));
  });

  it("claude-code -> codex -> claude-code preserves original Read output with line numbers", () => {
    const input = makeClaudeSessionWithRead({ readOutput: CLAUDE_READ_OUTPUT });

    const canonical1 = importClaudeCodeJsonl(input, emptySidecar());
    const codexText = exportCodexJsonl(canonical1);
    const canonical2 = importCodexJsonl(codexText);
    const claudeText = exportClaudeCodeJsonl(canonical2);

    expect(parseJsonlLines(claudeText)).toEqual(parseJsonlLines(input));
  });

  it("pi -> claude-code -> pi preserves original raw Read output", () => {
    const input = makePiSessionWithRead({ readOutput: RAW_READ_OUTPUT });

    const canonical1 = importPiSessionJsonl(input);
    const claudeText = exportClaudeCodeJsonl(canonical1);
    const canonical2 = importClaudeCodeJsonl(claudeText, emptySidecar());
    const piText = exportPiSessionJsonl(canonical2);

    expect(parseJsonlLines(piText)).toEqual(parseJsonlLines(input));
  });

  it("codex -> claude-code -> codex preserves original raw Read output", () => {
    const input = makeCodexSessionWithRead({ readOutput: RAW_READ_OUTPUT });

    const canonical1 = importCodexJsonl(input);
    const claudeText = exportClaudeCodeJsonl(canonical1);
    const canonical2 = importClaudeCodeJsonl(claudeText, emptySidecar());
    const codexText = exportCodexJsonl(canonical2);

    expect(parseJsonlLines(codexText)).toEqual(parseJsonlLines(input));
  });

  it("claude-code -> pi -> codex -> claude-code preserves Read line numbers through 3-hop chain", () => {
    const input = makeClaudeSessionWithRead({ readOutput: CLAUDE_READ_OUTPUT });

    const canonical1 = importClaudeCodeJsonl(input, emptySidecar());
    const piText = exportPiSessionJsonl(canonical1);
    const canonical2 = importPiSessionJsonl(piText);
    const codexText = exportCodexJsonl(canonical2);
    const canonical3 = importCodexJsonl(codexText);
    const claudeText = exportClaudeCodeJsonl(canonical3);

    expect(parseJsonlLines(claudeText)).toEqual(parseJsonlLines(input));
  });
});

// -------------------------------------------------------------------
// Complex Read outputs: edge cases in line number formatting
// -------------------------------------------------------------------

describe("edge case: Read tool line numbers — complex content", () => {
  it("claude-code: output with tab characters in file content doesn't confuse roundtrip", () => {
    // File content itself has tabs — the cat -n prefix is still the FIRST tab after the number
    const output = `1\t\tindented with tab\n2\t\t\tdouble indented\n3\tnormal line\n`;
    const input = makeClaudeSessionWithRead({ readOutput: output });
    const events = importClaudeCodeJsonl(input, emptySidecar());
    const exported = exportClaudeCodeJsonl(events);

    expect(parseJsonlLines(exported)).toEqual(parseJsonlLines(input));
  });

  it("claude-code: output with empty lines preserves blank line numbering", () => {
    // Claude Code shows empty lines as just the number + tab
    const output = `1\tline one\n2\t\n3\tline three\n`;
    const input = makeClaudeSessionWithRead({ readOutput: output });
    const events = importClaudeCodeJsonl(input, emptySidecar());
    const exported = exportClaudeCodeJsonl(events);

    expect(parseJsonlLines(exported)).toEqual(parseJsonlLines(input));
  });

  it("claude-code: output with offset (starting at line 50) roundtrips correctly", () => {
    // When Read is called with offset, line numbers don't start at 1
    const output = `50\t  return result;\n51\t}\n52\t\n53\texport default main;\n`;
    const input = makeClaudeSessionWithRead({ readOutput: output });
    const events = importClaudeCodeJsonl(input, emptySidecar());
    const exported = exportClaudeCodeJsonl(events);

    expect(parseJsonlLines(exported)).toEqual(parseJsonlLines(input));
  });

  it("claude-code: output containing JSON with numeric keys doesn't false-match line number pattern", () => {
    // JSON content that looks like line numbers but isn't
    const fileContent = `{"1": "one", "2": "two"}`;
    const output = `1\t${fileContent}\n`;
    const input = makeClaudeSessionWithRead({ readOutput: output });
    const events = importClaudeCodeJsonl(input, emptySidecar());
    const exported = exportClaudeCodeJsonl(events);

    expect(parseJsonlLines(exported)).toEqual(parseJsonlLines(input));
  });

  it("claude-code: binary-like output with no line numbers roundtrips as-is", () => {
    // Some Read tool outputs (e.g., truncated binary) might not have line numbers
    const output = "Unable to read binary file: /tmp/image.png";
    const input = makeClaudeSessionWithRead({ readOutput: output });
    const events = importClaudeCodeJsonl(input, emptySidecar());
    const exported = exportClaudeCodeJsonl(events);

    expect(parseJsonlLines(exported)).toEqual(parseJsonlLines(input));
  });

  it("pi: read output with content that resembles cat -n format roundtrips without mutation", () => {
    // Pi returns raw content, but what if the file itself contains "1\t..." patterns?
    const trickContent = `1\tThis looks like cat -n output\n2\tBut it's actual file content\n`;
    const input = makePiSessionWithRead({ readOutput: trickContent });
    const events = importPiSessionJsonl(input);
    const exported = exportPiSessionJsonl(events);

    expect(parseJsonlLines(exported)).toEqual(parseJsonlLines(input));
  });
});

// -------------------------------------------------------------------
// Multiple Read calls in one session
// -------------------------------------------------------------------

describe("edge case: Read tool line numbers — multiple reads in session", () => {
  it("claude-code: multiple Read tool results with different files all roundtrip", () => {
    const input = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-20T10:00:00.000Z",
        sessionId: "claude-multi-read",
        cwd: "/tmp",
        version: "2.1.76",
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-20T10:00:01.000Z",
        sessionId: "claude-multi-read",
        cwd: "/tmp",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: "/tmp/a.ts" } },
            { type: "tool_use", id: "toolu_r2", name: "Read", input: { file_path: "/tmp/b.ts" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-20T10:00:02.000Z",
        sessionId: "claude-multi-read",
        cwd: "/tmp",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_r1",
              content: `1\tconst a = 1;\n2\texport default a;\n`,
              is_error: false,
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_r2",
              content: `1\tconst b = 2;\n2\tconst c = 3;\n3\texport { b, c };\n`,
              is_error: false,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-20T10:00:03.000Z",
        sessionId: "claude-multi-read",
        cwd: "/tmp",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Both files read." }],
        },
      }),
      "",
    ].join("\n");

    const events = importClaudeCodeJsonl(input, emptySidecar());
    const exported = exportClaudeCodeJsonl(events);

    expect(parseJsonlLines(exported)).toEqual(parseJsonlLines(input));

    // Verify both tool results exist in canonical form
    const toolResults = events.filter((e) => e.kind === "tool.result");
    expect(toolResults).toHaveLength(2);
  });

  it("claude-code: multiple Read results survive claude -> pi -> codex -> claude chain", () => {
    const input = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        timestamp: "2026-04-20T10:00:00.000Z",
        sessionId: "claude-multi-chain",
        cwd: "/tmp",
        version: "2.1.76",
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-20T10:00:01.000Z",
        sessionId: "claude-multi-chain",
        cwd: "/tmp",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_m1", name: "Read", input: { file_path: "/tmp/x.ts" } },
            { type: "tool_use", id: "toolu_m2", name: "Read", input: { file_path: "/tmp/y.ts" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-20T10:00:02.000Z",
        sessionId: "claude-multi-chain",
        cwd: "/tmp",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_m1",
              content: `1\timport { z } from "zod";\n2\t\n3\texport const schema = z.object({});\n`,
              is_error: false,
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_m2",
              content: `1\t// This file is intentionally empty\n`,
              is_error: false,
            },
          ],
        },
      }),
      "",
    ].join("\n");

    const canonical1 = importClaudeCodeJsonl(input, emptySidecar());
    const piText = exportPiSessionJsonl(canonical1);
    const canonical2 = importPiSessionJsonl(piText);
    const codexText = exportCodexJsonl(canonical2);
    const canonical3 = importCodexJsonl(codexText);
    const claudeText = exportClaudeCodeJsonl(canonical3);

    expect(parseJsonlLines(claudeText)).toEqual(parseJsonlLines(input));
  });
});

// -------------------------------------------------------------------
// Byte-level identity checks (string equality, not just JSON equality)
// -------------------------------------------------------------------

describe("edge case: Read tool line numbers — byte-level identity", () => {
  it("claude-code: exported JSONL is string-identical (not just JSON-equal) after roundtrip", () => {
    const input = makeClaudeSessionWithRead({ readOutput: CLAUDE_READ_OUTPUT });
    const events = importClaudeCodeJsonl(input, emptySidecar());
    const exported = exportClaudeCodeJsonl(events);

    // String identity — stricter than JSON equality
    expect(exported).toBe(input);
  });

  it("pi: exported JSONL is string-identical after roundtrip", () => {
    const input = makePiSessionWithRead({ readOutput: RAW_READ_OUTPUT });
    const events = importPiSessionJsonl(input);
    const exported = exportPiSessionJsonl(events);

    expect(exported).toBe(input);
  });

  it("codex: exported JSONL is string-identical after roundtrip", () => {
    const input = makeCodexSessionWithRead({ readOutput: RAW_READ_OUTPUT });
    const events = importCodexJsonl(input);
    const exported = exportCodexJsonl(events);

    expect(exported).toBe(input);
  });

  it("claude-code: double roundtrip through all providers produces identical bytes", () => {
    const input = makeClaudeSessionWithRead({ readOutput: CLAUDE_READ_OUTPUT });

    // First full cycle: claude -> pi -> codex -> claude
    const c1 = importClaudeCodeJsonl(input, emptySidecar());
    const piText1 = exportPiSessionJsonl(c1);
    const c2 = importPiSessionJsonl(piText1);
    const codexText1 = exportCodexJsonl(c2);
    const c3 = importCodexJsonl(codexText1);
    const claudeText1 = exportClaudeCodeJsonl(c3);

    // Second full cycle
    const c4 = importClaudeCodeJsonl(claudeText1, emptySidecar());
    const piText2 = exportPiSessionJsonl(c4);
    const c5 = importPiSessionJsonl(piText2);
    const codexText2 = exportCodexJsonl(c5);
    const c6 = importCodexJsonl(codexText2);
    const claudeText2 = exportClaudeCodeJsonl(c6);

    // Both cycles should produce identical output
    expect(claudeText2).toEqual(claudeText1);
    // And both should match the original
    expect(parseJsonlLines(claudeText1)).toEqual(parseJsonlLines(input));
  });
});
