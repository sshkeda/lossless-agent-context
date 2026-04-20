import {
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";

const ARBITRARY_BYTES_BASE64 = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01, 0x80, 0x81, 0x7f]).toString("base64");

function findFirstImageRef(
  events:
    | ReturnType<typeof importClaudeCodeJsonl>
    | ReturnType<typeof importCodexJsonl>
    | ReturnType<typeof importPiSessionJsonl>,
) {
  for (const event of events) {
    if (event.kind !== "message.created") continue;
    for (const part of event.payload.parts) {
      if (part.type === "image") return part.imageRef;
    }
  }
  return undefined;
}

describe("binary content encoded as base64 survives exactly", () => {
  it("pi -> claude -> codex -> pi preserves arbitrary byte payloads encoded in image fields", () => {
    const piText = `${JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-binary-1",
      timestamp: "2026-04-16T12:00:00.000Z",
      cwd: "/tmp",
    })}
${JSON.stringify({
  type: "message",
  id: "binary-msg",
  parentId: null,
  timestamp: "2026-04-16T12:00:01.000Z",
  message: {
    role: "user",
    content: [{ type: "image", data: ARBITRARY_BYTES_BASE64, mimeType: "application/octet-stream" }],
    timestamp: 1776340801000,
  },
})}
`;

    const canonical1 = importPiSessionJsonl(piText);
    expect(findFirstImageRef(canonical1)).toBe(ARBITRARY_BYTES_BASE64);

    const claudeText = exportClaudeCodeJsonl(canonical1);
    const canonical2 = importClaudeCodeJsonl(claudeText);
    expect(findFirstImageRef(canonical2)).toBe(ARBITRARY_BYTES_BASE64);

    const codexText = exportCodexJsonl(canonical2);
    const canonical3 = importCodexJsonl(codexText);
    expect(findFirstImageRef(canonical3)).toBe(ARBITRARY_BYTES_BASE64);

    const finalPiText = exportPiSessionJsonl(canonical3);
    const finalCanonical = importPiSessionJsonl(finalPiText);
    expect(findFirstImageRef(finalCanonical)).toBe(ARBITRARY_BYTES_BASE64);
  });

  it("codex data URLs preserve arbitrary byte payloads exactly on import", () => {
    const codexText = `${JSON.stringify({
      timestamp: "2026-04-16T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "codex-binary-1", timestamp: "2026-04-16T12:00:00.000Z", cwd: "/tmp", model_provider: "openai" },
    })}
${JSON.stringify({
  timestamp: "2026-04-16T12:00:01.000Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url: `data:application/octet-stream;base64,${ARBITRARY_BYTES_BASE64}` }],
  },
})}
`;

    const events = importCodexJsonl(codexText);
    expect(findFirstImageRef(events)).toBe(ARBITRARY_BYTES_BASE64);
  });
});
