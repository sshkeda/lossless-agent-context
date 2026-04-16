export type E2EDomain =
  | "fixture-corpus"
  | "real-local-logs"
  | "projection-roundtrip"
  | "replay-engine"
  | "openinference-export"
  | "live-provider-smoke";

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
      requiredVars: [
        "LAC_ENABLE_REAL_LOG_E2E",
      ],
    },
  },
  {
    domain: "projection-roundtrip",
    status: "implemented",
    coverage: [
      "canonical -> AI SDK projection -> canonical -> AI SDK projection",
    ],
  },
  {
    domain: "replay-engine",
    status: "planned",
    coverage: [
      "event timeline replay",
      "checkpoint/fork replay",
      "resume from cursor",
    ],
  },
  {
    domain: "openinference-export",
    status: "planned",
    coverage: [
      "canonical -> OpenInference span export",
      "golden OTEL payload assertions",
    ],
  },
  {
    domain: "live-provider-smoke",
    status: "planned",
    coverage: [
      "provider-native event ingestion from live runs",
      "cross-provider semantic equivalence smoke tests",
    ],
    activation: {
      envFlag: "LAC_ENABLE_LIVE_PROVIDER_E2E",
      requiredVars: [
        "LAC_ENABLE_LIVE_PROVIDER_E2E",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
      ],
    },
  },
];
