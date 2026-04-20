import {
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import { describe, expect, it } from "vitest";
import { parseJsonlObjectLines } from "../jsonl";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const LOSSLESS_CASES = [{ name: "lossless" }] as const;

describe("edge case: image content blocks", () => {
  describe("claude-code", () => {
    const claudeImageInput = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-15T12:00:00.000Z",
      sessionId: "claude-image-1",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "user",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-image-1",
      cwd: "/tmp",
      message: {
        role: "user",
        content: [
          { type: "text", text: "what is in this image?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
        ],
      },
    })}\n`;

    function findImagePart(events: ReturnType<typeof importClaudeCodeJsonl>) {
      for (const event of events) {
        if (event.kind !== "message.created") continue;
        for (const part of event.payload.parts) {
          if (part.type === "image") return part;
        }
      }
      return undefined;
    }

    it("preserves image content block from claude-code user message", () => {
      const events = importClaudeCodeJsonl(claudeImageInput);
      const imagePart = findImagePart(events);
      expect(imagePart).toBeDefined();
      if (imagePart?.type !== "image") throw new Error("type narrowing");
      expect(imagePart.imageRef).toBe(PNG_BASE64);
      expect(imagePart.mediaType).toBe("image/png");
    });

    for (const { name } of LOSSLESS_CASES) {
      it(`round-trips image block claude → claude (${name})`, () => {
        const events = importClaudeCodeJsonl(claudeImageInput);
        const exported = exportClaudeCodeJsonl(events);
        const reimported = importClaudeCodeJsonl(exported);
        const imagePart = findImagePart(reimported);
        expect(imagePart).toBeDefined();
        if (imagePart?.type !== "image") throw new Error("type narrowing");
        expect(imagePart.imageRef).toBe(PNG_BASE64);
      });
    }
  });

  describe("codex", () => {
    const codexImageInput = `${JSON.stringify({
      timestamp: "2026-04-15T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "codex-image-1", timestamp: "2026-04-15T12:00:00.000Z", cwd: "/tmp", model_provider: "openai" },
    })}\n${JSON.stringify({
      timestamp: "2026-04-15T12:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "describe this image" },
          { type: "input_image", image_url: `data:image/png;base64,${PNG_BASE64}` },
        ],
      },
    })}\n`;

    function findImagePart(events: ReturnType<typeof importCodexJsonl>) {
      for (const event of events) {
        if (event.kind !== "message.created") continue;
        for (const part of event.payload.parts) {
          if (part.type === "image") return part;
        }
      }
      return undefined;
    }

    it("preserves input_image content from codex user message", () => {
      const events = importCodexJsonl(codexImageInput);
      const imagePart = findImagePart(events);
      expect(imagePart).toBeDefined();
      if (imagePart?.type !== "image") throw new Error("type narrowing");
      expect(imagePart.imageRef).toContain(PNG_BASE64);
    });

    for (const { name } of LOSSLESS_CASES) {
      it(`round-trips image block codex → codex (${name})`, () => {
        const events = importCodexJsonl(codexImageInput);
        const exported = exportCodexJsonl(events);
        const reimported = importCodexJsonl(exported);
        const imagePart = findImagePart(reimported);
        expect(imagePart).toBeDefined();
      });
    }
  });

  describe("cross-provider image preservation", () => {
    const claudeImageInput = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-15T12:00:00.000Z",
      sessionId: "claude-image-2",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "user",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-image-2",
      cwd: "/tmp",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
        ],
      },
    })}\n`;

    function findImagePart(events: ReturnType<typeof importClaudeCodeJsonl>) {
      for (const event of events) {
        if (event.kind !== "message.created") continue;
        for (const part of event.payload.parts) {
          if (part.type === "image") return part;
        }
      }
      return undefined;
    }

    for (const { name } of LOSSLESS_CASES) {
      it(`claude → pi → claude preserves image block (${name})`, () => {
        const canonical1 = importClaudeCodeJsonl(claudeImageInput);
        const piText = exportPiSessionJsonl(canonical1);
        const canonical2 = importPiSessionJsonl(piText);
        const claudeText = exportClaudeCodeJsonl(canonical2);
        const final = importClaudeCodeJsonl(claudeText);
        const imagePart = findImagePart(final);
        expect(imagePart).toBeDefined();
        if (imagePart?.type !== "image") throw new Error("type narrowing");
        expect(imagePart.imageRef).toBe(PNG_BASE64);
      });

      it(`claude → codex → claude preserves image block (${name})`, () => {
        const canonical1 = importClaudeCodeJsonl(claudeImageInput);
        const codexText = exportCodexJsonl(canonical1);
        const canonical2 = importCodexJsonl(codexText);
        const claudeText = exportClaudeCodeJsonl(canonical2);
        const final = importClaudeCodeJsonl(claudeText);
        const imagePart = findImagePart(final);
        expect(imagePart).toBeDefined();
        if (imagePart?.type !== "image") throw new Error("type narrowing");
        expect(imagePart.imageRef).toBe(PNG_BASE64);
      });
    }
  });

  describe("assistant image preservation through codex", () => {
    const claudeAssistantImageInput = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: "2026-04-15T12:00:00.000Z",
      sessionId: "claude-image-3",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-image-3",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Here is the image." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
        ],
      },
    })}\n`;

    function findAssistantImagePart(events: ReturnType<typeof importClaudeCodeJsonl>) {
      for (const event of events) {
        if (event.kind !== "message.created" || event.payload.role !== "assistant") continue;
        for (const part of event.payload.parts) {
          if (part.type === "image") return part;
        }
      }
      return undefined;
    }

    it("codex export uses sidecar metadata instead of output_text JSON fallback for assistant images", () => {
      const canonical = importClaudeCodeJsonl(claudeAssistantImageInput);
      const codexText = exportCodexJsonl(canonical);
      const lines = parseJsonlObjectLines(codexText);
      const assistantLine = lines.find(
        (line) =>
          line.type === "response_item" &&
          (line.payload as Record<string, unknown> | undefined)?.type === "message" &&
          (line.payload as Record<string, unknown> | undefined)?.role === "assistant",
      );

      expect(assistantLine).toBeDefined();
      const payload = assistantLine?.payload as Record<string, unknown> | undefined;
      const content = Array.isArray(payload?.content) ? payload.content : [];
      expect(content).toEqual([{ type: "output_text", text: "Here is the image." }]);

      const targets = assistantLine?.__lac_targets as Record<string, unknown> | undefined;
      const codex = targets?.codex as Record<string, unknown> | undefined;
      const assistantParts = codex?.assistantParts;
      expect(Array.isArray(assistantParts)).toBe(true);
      expect(assistantParts).toEqual([
        { type: "text", text: "Here is the image." },
        { type: "image", imageRef: PNG_BASE64, mediaType: "image/png" },
      ]);
    });

    it("claude assistant image survives claude → codex → claude", () => {
      const canonical1 = importClaudeCodeJsonl(claudeAssistantImageInput);
      const codexText = exportCodexJsonl(canonical1);
      const canonical2 = importCodexJsonl(codexText);
      const claudeText = exportClaudeCodeJsonl(canonical2);
      const final = importClaudeCodeJsonl(claudeText);
      const imagePart = findAssistantImagePart(final);
      expect(imagePart).toBeDefined();
      if (imagePart?.type !== "image") throw new Error("type narrowing");
      expect(imagePart.imageRef).toBe(PNG_BASE64);
      expect(imagePart.mediaType).toBe("image/png");
    });
  });
});
