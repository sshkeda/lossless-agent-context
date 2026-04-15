import type { CanonicalEvent } from "@lossless-agent-context/core";
import { z } from "zod";
import { DEFAULT_BRANCH_ID, createEvent } from "./utils";

const aiSdkPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string().optional() }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("tool-result"),
    toolCallId: z.string(),
    toolName: z.string().optional(),
    output: z.unknown().optional(),
    isError: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("file"),
    fileId: z.string(),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
  }),
]);

const aiSdkMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  parts: z.array(aiSdkPartSchema),
});

export type AiSdkMessageLike = z.infer<typeof aiSdkMessageSchema>;

export function importAiSdkMessages(messages: AiSdkMessageLike[], sessionId = "ai-sdk-session"): CanonicalEvent[] {
  const parsed = z.array(aiSdkMessageSchema).parse(messages);
  const branchId = DEFAULT_BRANCH_ID;
  const events: CanonicalEvent[] = [];

  createEvent(events, {
    sessionId,
    branchId,
    timestamp: new Date(0).toISOString(),
    kind: "session.created",
    payload: {
      startedAt: new Date(0).toISOString(),
      title: "AI SDK import",
    },
    native: { source: "ai-sdk" },
  });

  for (const message of parsed) {
    for (const part of message.parts) {
      if (part.type === "text") {
        createEvent(events, {
          sessionId,
          branchId,
          timestamp: new Date(0).toISOString(),
          kind: "message.created",
          actor: { type: message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : message.role },
          payload: { role: message.role, parts: [{ type: "text", text: part.text }] },
          native: { source: "ai-sdk", raw: message },
        });
        continue;
      }

      if (part.type === "reasoning") {
        createEvent(events, {
          sessionId,
          branchId,
          timestamp: new Date(0).toISOString(),
          kind: "reasoning.created",
          actor: { type: "assistant" },
          payload: {
            visibility: "summary",
            text: part.text,
            providerExposed: true,
          },
          native: { source: "ai-sdk", raw: message },
        });
        continue;
      }

      if (part.type === "tool-call") {
        createEvent(events, {
          sessionId,
          branchId,
          timestamp: new Date(0).toISOString(),
          kind: "tool.call",
          actor: { type: "assistant", toolName: part.toolName },
          payload: {
            toolCallId: part.toolCallId,
            name: part.toolName,
            arguments: part.input,
          },
          native: { source: "ai-sdk", raw: message },
        });
        continue;
      }

      if (part.type === "tool-result") {
        createEvent(events, {
          sessionId,
          branchId,
          timestamp: new Date(0).toISOString(),
          kind: "tool.result",
          actor: { type: "tool", toolName: part.toolName },
          payload: {
            toolCallId: part.toolCallId,
            output: part.output,
            isError: Boolean(part.isError),
          },
          native: { source: "ai-sdk", raw: message },
        });
        continue;
      }

      if (part.type === "file") {
        createEvent(events, {
          sessionId,
          branchId,
          timestamp: new Date(0).toISOString(),
          kind: "message.created",
          actor: { type: message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : message.role },
          payload: {
            role: message.role,
            parts: [{
              type: "file",
              fileId: part.fileId,
              filename: part.filename,
              mediaType: part.mediaType,
            }],
          },
          native: { source: "ai-sdk", raw: message },
        });
      }
    }
  }

  return events;
}
