export type E2EDomain =
  | "fixture-corpus"
  | "real-local-logs"
  | "projection-roundtrip"
  | "replay-engine"
  | "openinference-export"
  | "live-provider-smoke"
  | "provider-roundtrip"
  | "cross-provider"
  | "sdk-validation";

export type DomainStatus = "implemented" | "planned";

export type DomainEntry = {
  domain: E2EDomain;
  status: DomainStatus;
  coverage: string[];
  activation?: {
    envFlag: string;
    requiredVars: string[];
  };
};

export const systemE2EMatrix: DomainEntry[] = [
  {
    domain: "fixture-corpus",
    status: "implemented",
    coverage: [
      "Pi JSONL -> canonical",
      "Claude Code JSONL -> canonical",
      "Codex JSONL -> canonical",
      "AI SDK messages -> canonical",
      "canonical -> AI SDK projection",
    ],
  },
  {
    domain: "real-local-logs",
    status: "implemented",
    coverage: [
      "Optional local Pi session import via env",
      "Optional local Claude Code session import via env",
      "Optional local Codex session import via env",
    ],
    activation: {
      envFlag: "LAC_ENABLE_REAL_LOG_E2E",
      requiredVars: ["LAC_ENABLE_REAL_LOG_E2E"],
    },
  },
  {
    domain: "projection-roundtrip",
    status: "implemented",
    coverage: ["canonical -> AI SDK projection -> canonical -> AI SDK projection"],
  },
  {
    domain: "replay-engine",
    status: "implemented",
    coverage: ["event timeline replay", "checkpoint/fork replay", "resume from cursor"],
  },
  {
    domain: "openinference-export",
    status: "implemented",
    coverage: ["canonical -> OpenInference span export", "golden OTEL payload assertions"],
  },
  {
    domain: "live-provider-smoke",
    status: "implemented",
    coverage: [
      "provider-native CLI event ingestion from live runs",
      "cross-provider semantic equivalence smoke tests",
      "local authenticated claude / codex / pi CLI smoke runs",
    ],
    activation: {
      envFlag: "LAC_ENABLE_LIVE_PROVIDER_E2E",
      requiredVars: ["LAC_ENABLE_LIVE_PROVIDER_E2E"],
    },
  },
  {
    domain: "provider-roundtrip",
    status: "implemented",
    coverage: [
      "Pi JSONL -> canonical -> Pi JSONL semantic equivalence",
      "Claude Code JSONL -> canonical -> Claude Code JSONL semantic equivalence",
      "Codex JSONL -> canonical -> Codex JSONL semantic equivalence",
      "double-roundtrip stability",
      "regression guard: every source line referenced by canonical event native.raw",
    ],
  },
  {
    domain: "cross-provider",
    status: "implemented",
    coverage: [
      "Pi -> Claude Code -> Pi byte-equivalent via semantic Claude lines + __lac_foreign sidecar",
      "Pi -> Codex -> Pi byte-equivalent via foreign envelope carry-through",
      "Claude Code -> Pi -> Claude Code byte-equivalent via foreign envelope carry-through",
      "Claude Code -> Codex -> Claude Code byte-equivalent via foreign envelope carry-through",
      "Codex -> Pi -> Codex byte-equivalent via foreign envelope carry-through",
      "Codex -> Claude Code -> Codex byte-equivalent via foreign envelope carry-through",
    ],
  },
  {
    domain: "sdk-validation",
    status: "implemented",
    coverage: [
      "Pi -> Claude conversion is parsed by the real @anthropic-ai/claude-agent-sdk getSessionMessages",
      "user/assistant chain returned with original Pi text + tool call payloads intact",
    ],
  },
];
