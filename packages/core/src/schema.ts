import { z } from "zod";

export const actorSchema = z.object({
  type: z.enum(["user", "assistant", "tool", "system", "runtime"]),
  provider: z.string().optional(),
  model: z.string().optional(),
  agentId: z.string().optional(),
  toolName: z.string().optional(),
});

export const causalitySchema = z.object({
  parentEventId: z.string().optional(),
  causedByEventId: z.string().optional(),
  turnId: z.string().optional(),
  requestId: z.string().optional(),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
});

export const nativeRefSchema = z.object({
  source: z.string(),
  formatVersion: z.string().optional(),
  rawRef: z.string().optional(),
  raw: z.unknown().optional(),
});

export const contentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
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

export const baseEnvelopeSchema = z.object({
  schemaVersion: z.literal("0.0.1"),
  eventId: z.string(),
  sessionId: z.string(),
  branchId: z.string(),
  seq: z.number().int().nonnegative(),
  timestamp: z.string(),
  actor: actorSchema.optional(),
  causality: causalitySchema.optional(),
  native: nativeRefSchema.optional(),
  extensions: z.record(z.unknown()).optional(),
});

export const sessionCreatedEventSchema = baseEnvelopeSchema.extend({
  kind: z.literal("session.created"),
  payload: z.object({
    title: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    startedAt: z.string(),
    workingDirectory: z.string().optional(),
    tags: z.record(z.string()).optional(),
  }),
});

export const branchCreatedEventSchema = baseEnvelopeSchema.extend({
  kind: z.literal("branch.created"),
  payload: z.object({
    fromBranchId: z.string().optional(),
    fromEventId: z.string().optional(),
    reason: z.string().optional(),
  }),
});

export const modelSelectedEventSchema = baseEnvelopeSchema.extend({
  kind: z.literal("model.selected"),
  payload: z.object({
    provider: z.string(),
    model: z.string(),
  }),
});

export const messageEventSchema = baseEnvelopeSchema.extend({
  kind: z.literal("message.created"),
  payload: z.object({
    role: z.enum(["user", "assistant", "system", "tool"]),
    parts: z.array(contentPartSchema).min(1),
  }),
});

export const reasoningEventSchema = baseEnvelopeSchema.extend({
  kind: z.literal("reasoning.created"),
  payload: z.object({
    visibility: z.enum(["none", "summary", "redacted", "full"]).default("summary"),
    text: z.string().optional(),
    providerExposed: z.boolean().optional(),
    retentionPolicy: z.string().optional(),
  }),
});

export const modelRequestedEventSchema = baseEnvelopeSchema.extend({
  kind: z.literal("model.requested"),
  payload: z.object({
    provider: z.string(),
    model: z.string(),
    input: z.unknown().optional(),
    settings: z.record(z.unknown()).optional(),
  }),
});

export const modelCompletedEventSchema = baseEnvelopeSchema.extend({
  kind: z.literal("model.completed"),
  payload: z.object({
    provider: z.string(),
    model: z.string(),
    output: z.unknown().optional(),
    usage: z.object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      reasoningTokens: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
    }).optional(),
    latencyMs: z.number().nonnegative().optional(),
  }),
});

export const toolCallEventSchema = baseEnvelopeSchema.extend({
  kind: z.literal("tool.call"),
  payload: z.object({
    toolCallId: z.string(),
    name: z.string(),
    arguments: z.unknown().optional(),
  }),
});

export const toolResultEventSchema = baseEnvelopeSchema.extend({
  kind: z.literal("tool.result"),
  payload: z.object({
    toolCallId: z.string(),
    output: z.unknown().optional(),
    isError: z.boolean().default(false),
    error: z.string().optional(),
  }),
});

export const runtimeErrorEventSchema = baseEnvelopeSchema.extend({
  kind: z.literal("runtime.error"),
  payload: z.object({
    code: z.string().optional(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export const providerEventSchema = baseEnvelopeSchema.extend({
  kind: z.literal("provider.event"),
  payload: z.object({
    provider: z.string(),
    eventType: z.string(),
    raw: z.unknown(),
  }),
});

export const canonicalEventSchema = z.discriminatedUnion("kind", [
  sessionCreatedEventSchema,
  branchCreatedEventSchema,
  modelSelectedEventSchema,
  messageEventSchema,
  reasoningEventSchema,
  modelRequestedEventSchema,
  modelCompletedEventSchema,
  toolCallEventSchema,
  toolResultEventSchema,
  runtimeErrorEventSchema,
  providerEventSchema,
]);

export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;
export type ContentPart = z.infer<typeof contentPartSchema>;
