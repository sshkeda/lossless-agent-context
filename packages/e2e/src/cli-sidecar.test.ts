import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importCodexJsonl, parseSidecar, sidecarPathForSeedPath } from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";

const CLI_PATH = new URL("../../cli/src/index.ts", import.meta.url).pathname;

function runLac(args: string[]): void {
  execFileSync("bun", [CLI_PATH, ...args], {
    cwd: new URL("../../..", import.meta.url).pathname,
    stdio: "pipe",
    encoding: "utf8",
  });
}

describe("lac CLI sidecar handling", () => {
  it("writes and later reads Claude Code recovery sidecars", () => {
    const dir = mkdtempSync(join(tmpdir(), "lac-cli-sidecar-"));
    const piPath = join(dir, "pi.jsonl");
    const claudePath = join(dir, "claude.jsonl");
    const codexPath = join(dir, "codex.jsonl");
    const reasoningText = "Plan from codex that Claude cannot sign.";

    writeFileSync(
      piPath,
      `${[
        { type: "session", version: 3, id: "sess-1", timestamp: "2026-04-21T00:00:00.000Z", cwd: "/tmp" },
        {
          type: "message",
          id: "assistant-1",
          parentId: null,
          timestamp: "2026-04-21T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: reasoningText,
                thinkingSignature: '{"id":"rs_1","encrypted_content":"opaque","summary":[]}',
              },
              { type: "text", text: "Done." },
            ],
          },
        },
      ]
        .map((obj) => JSON.stringify(obj))
        .join("\n")}\n`,
    );

    runLac(["prepare-claude-code-resume", piPath, "--from", "pi", "-o", claudePath]);

    const sidecarPath = sidecarPathForSeedPath(claudePath);
    const sidecar = parseSidecar(readFileSync(sidecarPath, "utf8"));
    expect(Object.values(sidecar.byLineUuid).some((entry) => entry.demotedReasoning?.length)).toBe(true);

    runLac(["convert", claudePath, "--from", "claude-code", "--to", "codex", "-o", codexPath]);

    const codexEvents = importCodexJsonl(readFileSync(codexPath, "utf8"));
    expect(
      codexEvents.some((event) => event.kind === "reasoning.created" && event.payload.text === reasoningText),
    ).toBe(true);
  });
});
