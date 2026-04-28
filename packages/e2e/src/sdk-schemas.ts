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

export const codexInputTextBlock = z.object({
  type: z.literal("input_text"),
  text: z.string(),
});

export const codexInputImageBlock = z.object({
  type: z.literal("input_image"),
  image_url: z.string(),
});

export const codexOutputTextBlock = z.object({
  type: z.literal("output_text"),
  text: z.string(),
  annotations: z.array(z.unknown()).optional(),
});

export const codexUserContentBlock = z.discriminatedUnion("type", [codexInputTextBlock, codexInputImageBlock]);

export const codexAssistantContentBlock = z.discriminatedUnion("type", [codexOutputTextBlock]);

export const codexMessagePayload = z.discriminatedUnion("role", [
  z.object({
    type: z.literal("message"),
    role: z.literal("assistant"),
    content: z.array(codexAssistantContentBlock),
  }),
  z.object({
    type: z.literal("message"),
    role: z.literal("user"),
    content: z.array(codexUserContentBlock),
  }),
  z.object({
    type: z.literal("message"),
    role: z.literal("system"),
    content: z.array(codexUserContentBlock),
  }),
  z.object({
    type: z.literal("message"),
    role: z.literal("developer"),
    content: z.array(codexUserContentBlock),
  }),
]);

export const codexReasoningPayload = z.object({
  type: z.literal("reasoning"),
  summary: z.array(
    z.object({
      type: z.literal("summary_text"),
      text: z.string(),
    }),
  ),
});

export const codexFunctionCallPayload = z.object({
  type: z.literal("function_call"),
  name: z.string(),
  arguments: z.string(),
  call_id: z.string(),
});

export const codexCustomToolCallPayload = z.object({
  type: z.literal("custom_tool_call"),
  name: z.string(),
  input: z.string(),
  call_id: z.string(),
  status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
  id: z.string().optional(),
});

export const codexFunctionCallOutputPayload = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.string(),
});

export const codexCustomToolCallOutputPayload = z.object({
  type: z.literal("custom_tool_call_output"),
  call_id: z.string(),
  output: z.string(),
  id: z.string().optional(),
});

export const codexWebSearchCallPayload = z
  .object({
    type: z.literal("web_search_call"),
    status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
    id: z.string().optional(),
  })
  .catchall(z.unknown());

export const codexImageGenerationCallPayload = z
  .object({
    type: z.literal("image_generation_call"),
    status: z.enum(["generating", "in_progress", "completed", "incomplete", "failed"]).optional(),
    id: z.string().optional(),
    revised_prompt: z.string().optional(),
  })
  .catchall(z.unknown());

export const codexResponseItemPayload = z.union([
  codexMessagePayload,
  codexReasoningPayload,
  codexFunctionCallPayload,
  codexCustomToolCallPayload,
  codexFunctionCallOutputPayload,
  codexCustomToolCallOutputPayload,
  codexWebSearchCallPayload,
  codexImageGenerationCallPayload,
]);

export const codexAgentMessagePayload = z.object({
  type: z.literal("agent_message"),
  message: z.string(),
});

export const codexAgentReasoningPayload = z.object({
  type: z.literal("agent_reasoning"),
  text: z.string(),
});

export const codexModelChangePayload = z.object({
  type: z.literal("model_change"),
  message: z.string(),
  provider: z.string(),
});

export const codexEventMsgPayload = z
  .object({
    type: z.string(),
  })
  .catchall(z.unknown());

export const codexSessionMetaLine = z.object({
  timestamp: z.string(),
  type: z.literal("session_meta"),
  payload: z.object({
    id: z.string(),
    timestamp: z.string(),
    cwd: z.string().optional(),
    originator: z.string().optional(),
    cli_version: z.string().optional(),
    source: z.string().optional(),
    model_provider: z.string().optional(),
  }),
});

export const codexResponseItemLine = z.object({
  timestamp: z.string(),
  type: z.literal("response_item"),
  payload: codexResponseItemPayload,
});

export const codexEventMsgLine = z.object({
  timestamp: z.string(),
  type: z.literal("event_msg"),
  payload: codexEventMsgPayload,
});

export const codexTurnContextLine = z.object({
  timestamp: z.string(),
  type: z.literal("turn_context"),
  payload: z.unknown(),
});

export const codexCompactedLine = z.object({
  timestamp: z.string(),
  type: z.literal("compacted"),
  payload: z.unknown(),
});

export const codexNativeLine = z.discriminatedUnion("type", [
  codexSessionMetaLine,
  codexResponseItemLine,
  codexEventMsgLine,
  codexTurnContextLine,
  codexCompactedLine,
]);

export type CodexNativeLine = z.infer<typeof codexNativeLine>;
