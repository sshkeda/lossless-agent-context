import { z } from "zod";

export const openInferenceSpanSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  attributes: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export type OpenInferenceSpan = z.infer<typeof openInferenceSpanSchema>;
