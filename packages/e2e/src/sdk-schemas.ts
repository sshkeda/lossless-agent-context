import { z } from "zod";

export const claudeSdkTextBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const claudeSdkThinkingBlock = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
});

export const claudeSdkToolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const claudeSdkToolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]),
});

export const claudeSdkContentBlock = z.discriminatedUnion("type", [
  claudeSdkTextBlock,
  claudeSdkThinkingBlock,
  claudeSdkToolUseBlock,
  claudeSdkToolResultBlock,
]);

export const claudeSdkAssistantInner = z.object({
  role: z.literal("assistant"),
  content: z.array(claudeSdkContentBlock),
});

export const claudeSdkUserInner = z.object({
  role: z.literal("user").optional(),
  content: z.union([z.string(), z.array(claudeSdkContentBlock)]),
});

export const jsonRecord = z.record(z.string(), z.unknown());

export type ClaudeSdkAssistantInner = z.infer<typeof claudeSdkAssistantInner>;
export type ClaudeSdkUserInner = z.infer<typeof claudeSdkUserInner>;
export type ClaudeSdkContentBlock = z.infer<typeof claudeSdkContentBlock>;
