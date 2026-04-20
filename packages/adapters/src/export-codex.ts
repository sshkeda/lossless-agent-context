import type { CanonicalEvent, Citation, ContentPart } from "@lossless-agent-context/core";
import { attachClaudeCodeTargetIds, readStoredClaudeCodeIds } from "./claude-code-ids";
import {
  emitTargetGroupedLines,
  FOREIGN_FIELD,
  type ForeignEnvelope,
  inferSessionIdForTarget,
  inferWorkingDirectory,
  renderCanonicalEventLine,
} from "./cross-provider";
import { CODEX_ASSISTANT_PARTS_FIELD, TARGET_IDS_FIELD } from "./defaults";
import { stringifyToolOutput } from "./utils";

export function exportCodexJsonl(events: CanonicalEvent[]): string {
  const sessionId = inferSessionIdForTarget(events, "codex");
  const cwd = inferWorkingDirectory(events);
  const modelProvider = inferCodexModelProvider(events);
  const hasSessionEvent = events.some((event) => event.kind === "session.created");
  let emittedSession = false;
  let emittedThreadRegistration = false;

  function attachTargetMetadata(
    line: Record<string, unknown>,
    event: CanonicalEvent,
    codexMetadata?: Record<string, unknown>,
  ): Record<string, unknown> {
    const ids = readStoredClaudeCodeIds(event);
    const withClaudeIds = attachClaudeCodeTargetIds(line, ids);
    if (!codexMetadata) return withClaudeIds;
    const targets =
      withClaudeIds[TARGET_IDS_FIELD] &&
      typeof withClaudeIds[TARGET_IDS_FIELD] === "object" &&
      !Array.isArray(withClaudeIds[TARGET_IDS_FIELD])
        ? ({ ...(withClaudeIds[TARGET_IDS_FIELD] as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    targets.codex = codexMetadata;
    withClaudeIds[TARGET_IDS_FIELD] = targets;
    return withClaudeIds;
  }

  function makeBase(timestamp: string, sidecar: ForeignEnvelope): Record<string, unknown> {
    const base: Record<string, unknown> = { timestamp };
    base[FOREIGN_FIELD] = sidecar;
    return base;
  }

  function makeSessionMetaPayload(timestamp: string, provider: string | undefined): Record<string, unknown> {
    return {
      id: sessionId,
      timestamp,
      ...(provider !== undefined ? { model_provider: provider } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
  }

  function makeThreadRegistrationLine(timestamp: string, sidecar: ForeignEnvelope): Record<string, unknown> | null {
    if (emittedThreadRegistration) return null;
    emittedThreadRegistration = true;
    return {
      ...makeBase(timestamp, sidecar),
      type: "event_msg",
      payload: {
        type: "thread_name_updated",
        thread_id: sessionId,
        thread_name: sessionId,
      },
    };
  }

  function renderEvent(event: CanonicalEvent, native: ForeignEnvelope): Record<string, unknown> | null {
    const ts = event.timestamp;

    if (event.kind === "session.created") {
      if (emittedSession) return null;
      emittedSession = true;
      return {
        ...makeBase(ts, native),
        type: "session_meta",
        payload: makeSessionMetaPayload(ts, event.payload.provider ?? modelProvider),
      };
    }

    if (event.kind === "model.selected") {
      return {
        ...makeBase(ts, native),
        type: "event_msg",
        payload: {
          type: "model_change",
          message: event.payload.model,
          provider: event.payload.provider,
        },
      };
    }

    if (event.kind === "message.created") {
      const role = event.payload.role;
      if (role === "assistant") {
        const content = event.payload.parts.flatMap((part) => partToCodexAssistantContent(part));
        return {
          ...makeBase(ts, native),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content,
          },
        };
      }
      const codexRole = role === "system" ? "system" : "user";
      const content = event.payload.parts.map((part) => partToCodexUserContent(part));
      return {
        ...makeBase(ts, native),
        type: "response_item",
        payload: {
          type: "message",
          role: codexRole,
          content,
        },
      };
    }

    if (event.kind === "reasoning.created") {
      return {
        ...makeBase(ts, native),
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: event.payload.text ?? "" }],
        },
      };
    }

    if (event.kind === "tool.call") {
      const args = event.payload.arguments;
      return {
        ...makeBase(ts, native),
        type: "response_item",
        payload: {
          type: "function_call",
          name: event.payload.name,
          arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
          call_id: event.payload.toolCallId,
        },
      };
    }

    if (event.kind === "tool.result") {
      return {
        ...makeBase(ts, native),
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: event.payload.toolCallId,
          output: stringifyToolOutput(event.payload.output),
        },
      };
    }

    return null;
  }

  const { lines } = emitTargetGroupedLines(events, "codex", (group, native) => {
    const out: Record<string, unknown>[] = [];
    for (let index = 0; index < group.length; index++) {
      const event = group[index];
      if (!event) continue;
      if (event.kind === "message.created") {
        const mergedEvents = [event];
        let nextIndex = index + 1;
        while (nextIndex < group.length) {
          const next = group[nextIndex];
          if (!next || next.kind !== "message.created" || next.payload.role !== event.payload.role) break;
          mergedEvents.push(next);
          nextIndex++;
        }
        index = nextIndex - 1;

        const parts = mergedEvents.flatMap((item) => item.payload.parts);
        const role = event.payload.role;
        if (role === "assistant") {
          const line: Record<string, unknown> = {
            ...makeBase(event.timestamp, native),
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: parts.flatMap((part) => partToCodexAssistantContent(part)),
            },
          };
          out.push(attachTargetMetadata(line, event, buildCodexAssistantMetadata(parts)));
        } else {
          const codexRole = role === "system" ? "system" : "user";
          const line: Record<string, unknown> = {
            ...makeBase(event.timestamp, native),
            type: "response_item",
            payload: {
              type: "message",
              role: codexRole,
              content: parts.map((part) => partToCodexUserContent(part)),
            },
          };
          out.push(attachTargetMetadata(line, event));
        }
        continue;
      }

      const line = renderEvent(event, native);
      if (line !== null) {
        out.push(attachTargetMetadata(line, event));
        if (event.kind === "session.created") {
          const registration = makeThreadRegistrationLine(event.timestamp, native);
          if (registration) out.push(registration);
        }
      } else {
        out.push(attachTargetMetadata(renderCanonicalEventLine(event, native), event));
      }
    }
    return out.length > 0 ? out : null;
  });

  if (!hasSessionEvent) {
    const first = events[0];
    if (first?.native?.source && first.native.raw !== undefined) {
      const synthetic: Record<string, unknown> = {
        timestamp: first.timestamp,
        type: "session_meta",
        payload: makeSessionMetaPayload(first.timestamp, modelProvider),
      };
      synthetic[FOREIGN_FIELD] = { source: first.native.source, raw: first.native.raw };
      attachTargetMetadata(synthetic, first);
      lines.unshift(JSON.stringify(synthetic));
      const registration = makeThreadRegistrationLine(first.timestamp, {
        source: first.native.source,
        raw: first.native.raw,
      });
      if (registration) lines.splice(1, 0, JSON.stringify(registration));
    }
  }

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function inferCodexModelProvider(events: CanonicalEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind === "session.created" && event.payload.provider !== undefined) return event.payload.provider;
  }
  for (const event of events) {
    if (event.kind === "model.selected") return event.payload.provider;
  }
  for (const event of events) {
    if (event.actor?.provider !== undefined) return event.actor.provider;
  }
  return undefined;
}

function partToCodexUserContent(part: ContentPart): Record<string, unknown> {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "image": {
      const url = part.imageRef.startsWith("data:")
        ? part.imageRef
        : `data:${part.mediaType ?? "image/png"};base64,${part.imageRef}`;
      return { type: "input_image", image_url: url };
    }
    case "file":
      return {
        type: "input_text",
        text: JSON.stringify({
          fileId: part.fileId,
          filename: part.filename ?? null,
          mediaType: part.mediaType ?? null,
        }),
      };
    case "json":
      return { type: "input_text", text: JSON.stringify(part.value) };
  }
}

function partToCodexAssistantContent(part: ContentPart): Record<string, unknown>[] {
  if (part.type === "text") {
    return [
      {
        type: "output_text",
        text: part.text,
        ...(part.citations ? { annotations: part.citations.map(citationToCodexAnnotation) } : {}),
      },
    ];
  }
  return [];
}

function buildCodexAssistantMetadata(parts: ContentPart[]): Record<string, unknown> | undefined {
  if (parts.every((part) => part.type === "text")) return undefined;
  return { [CODEX_ASSISTANT_PARTS_FIELD]: parts };
}

function citationToCodexAnnotation(citation: Citation): Record<string, unknown> {
  switch (citation.type) {
    case "url_citation":
      return {
        type: "url_citation",
        ...(citation.url ? { url: citation.url } : {}),
        ...(citation.title ? { title: citation.title } : {}),
        ...(citation.startIndex !== undefined ? { start_index: citation.startIndex } : {}),
        ...(citation.endIndex !== undefined ? { end_index: citation.endIndex } : {}),
      };
    case "file_citation":
      return {
        type: "file_citation",
        ...(citation.fileId ? { file_id: citation.fileId } : {}),
        ...(citation.filename ? { filename: citation.filename } : {}),
        ...(citation.startIndex !== undefined ? { start_index: citation.startIndex } : {}),
        ...(citation.endIndex !== undefined ? { end_index: citation.endIndex } : {}),
      };
    case "provider_citation":
      return {
        ...((citation.raw && typeof citation.raw === "object" && !Array.isArray(citation.raw)
          ? citation.raw
          : { raw: citation.raw }) as Record<string, unknown>),
        type: citation.citationType,
      };
  }
}
