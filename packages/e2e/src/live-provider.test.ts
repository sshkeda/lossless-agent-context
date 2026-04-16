import { randomUUID } from "node:crypto";
import { importAnthropicMessageTrace, importOpenAIChatCompletionTrace } from "@lossless-agent-context/adapters";
import { canonicalEventSchema } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";

const enabled = process.env.LAC_ENABLE_LIVE_PROVIDER_E2E === "1";
const run = enabled ? it : it.skip;

const OPENAI_MODEL = process.env.LAC_OPENAI_MODEL ?? "gpt-4.1-mini";
const ANTHROPIC_MODEL = process.env.LAC_ANTHROPIC_MODEL ?? "claude-3-5-haiku-latest";
const PROMPT =
  'Compute 2+2. Reply with ONLY minified JSON matching exactly this shape: {"task":"smoke-test","status":"ok","sum":4}';

describe("live provider smoke e2e", () => {
  run("captures OpenAI and Anthropic live responses, imports them, and checks semantic equivalence", async () => {
    expect(process.env.OPENAI_API_KEY).toBeTruthy();
    expect(process.env.ANTHROPIC_API_KEY).toBeTruthy();

    const openaiTrace = await callOpenAI();
    const anthropicTrace = await callAnthropic();

    const openaiEvents = canonicalEventSchema.array().parse(importOpenAIChatCompletionTrace(openaiTrace));
    const anthropicEvents = canonicalEventSchema.array().parse(importAnthropicMessageTrace(anthropicTrace));

    expect(openaiEvents.some(event => event.kind === "model.completed")).toBe(true);
    expect(anthropicEvents.some(event => event.kind === "model.completed")).toBe(true);

    const openaiAssistantText = getFinalAssistantText(openaiEvents);
    const anthropicAssistantText = getFinalAssistantText(anthropicEvents);

    const openaiJson = parseStrictJson(openaiAssistantText);
    const anthropicJson = parseStrictJson(anthropicAssistantText);

    expect(openaiJson).toEqual({ task: "smoke-test", status: "ok", sum: 4 });
    expect(anthropicJson).toEqual({ task: "smoke-test", status: "ok", sum: 4 });
  }, 30_000);
});

async function callOpenAI() {
  const timestamp = new Date().toISOString();
  const request = {
    model: OPENAI_MODEL,
    temperature: 0,
    messages: [
      { role: "system" as const, content: "You are a precise JSON-only assistant." },
      { role: "user" as const, content: PROMPT },
    ],
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(request),
  });

  const body = await response.json();
  expect(response.ok, JSON.stringify(body)).toBe(true);

  return {
    sessionId: `openai-live-${randomUUID()}`,
    timestamp,
    request,
    response: body,
  };
}

async function callAnthropic() {
  const timestamp = new Date().toISOString();
  const request = {
    model: ANTHROPIC_MODEL,
    temperature: 0,
    max_tokens: 128,
    system: "You are a precise JSON-only assistant.",
    messages: [{ role: "user" as const, content: PROMPT }],
  };

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(request),
  });

  const body = await response.json();
  expect(response.ok, JSON.stringify(body)).toBe(true);

  return {
    sessionId: `anthropic-live-${randomUUID()}`,
    timestamp,
    request,
    response: body,
  };
}

function getFinalAssistantText(events: Array<{ kind: string; payload: any }>): string {
  const assistantMessages = events.filter(
    event => event.kind === "message.created" && event.payload.role === "assistant",
  );
  const last = assistantMessages.at(-1);
  const textPart = last?.payload.parts.find((part: { type: string }) => part.type === "text");
  expect(textPart?.text).toBeTruthy();
  return textPart.text;
}

function parseStrictJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error(`Could not parse JSON from provider output: ${trimmed}`);
  }
}
