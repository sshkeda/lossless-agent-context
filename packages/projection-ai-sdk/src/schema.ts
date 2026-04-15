import { z } from "zod";

export const uiMessagePartSchema = z.discriminatedUnion("type", [
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
    output: z.unknown().optional(),
    isError: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("file"),
    fileId: z.string(),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
  }),
  z.object({
    type: z.literal("image"),
    imageRef: z.string(),
    mediaType: z.string().optional(),
  }),
  z.object({ type: z.literal("json"), value: z.unknown() }),
]);

export const uiMessageProjectionSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  parts: z.array(uiMessagePartSchema).min(1),
});

export type UiMessageProjection = z.infer<typeof uiMessageProjectionSchema>;
