# AGENTS.md

- Assume `pi`, `claude`, and `codex` CLIs are installed and authenticated.
- Tests must fail if any required CLI or auth prerequisite is missing; do not skip those tests because prerequisites are absent.
- When changing code in this repo, run the fullest machine-local verification gate that the repo defines when feasible, not just the portable/default suite.
- Do not avoid machine-local verification merely because it depends on local CLIs, auth, or real session logs; this repo explicitly assumes those prerequisites exist.
- If a full machine-local verification command fails, report the exact failing command and error rather than downgrading the verification claim.
- Product intent is strict losslessness. Preserve all source information across imports/exports and keep emitted logs as close to native as possible without dropping data.
- The strongest fidelity requirement is byte-identical native round-trips (`provider -> LAC -> other -> LAC -> provider`) wherever the target provider format can represent the source exactly.
- Treat "provider resumes its own round-tripped session natively" as a first-class acceptance criterion, not just semantic equivalence.
- Do not reframe same-provider failures as needing native-file replay special cases; if reconstruction is not byte-identical, the reconstruction is wrong.
- Do not accept "works in practice" or "close enough" as success. The rebuilt native session must be the original native session.
- If a workaround makes a failing resume path "work" by dropping native session semantics, treat it as diagnostic only, not a valid final fix.
- Current known gap: Claude resume seeds built from synthetic cross-provider history are still not natively lossless. The real fix is exact native Claude raw replay fidelity, not semantic reconstruction.
- Do not add lossy export modes, native-only fallbacks that discard information, or tests that normalize away missing fidelity.

## Determinism via metadata, not inference

When a transformation is one-way at the API surface (e.g. demoting a foreign
thinking block to `<thinking>`-wrapped text because claude rejects unsigned
thinking) but you need to reverse it on a later import, **mark the change at
the moment you make it** instead of trying to detect it later from the
content shape.

- Stash the recovery information in a SIDECAR file alongside the JSONL,
  NOT in any field on the JSONL itself. The sidecar lives outside the
  downstream provider's parse path entirely (e.g. `<seed>.jsonl.lossless.json`
  next to `<seed>.jsonl`), so there's zero dependence on the provider's
  tolerance for unknown fields.
- Use the typed helpers in `recovery-sidecar.ts` (`setDemotedReasoningMarkers`,
  `readDemotedReasoningByContentIndex`, etc.) to read/write markers — every
  new marker kind goes through that module so the central `LosslessSidecar`
  contract reflects every recovery shape lac depends on. TypeScript surfaces
  any mismatch between producer and consumer at compile time.
- Each marker lists the exact `contentIndex` (or other deterministic key)
  it applies to, plus the original payload needed for reversal. Index-based
  recovery is exact — zero false positives on text that merely *resembles*
  the demoted shape.
- Never rely on regex / sentinel strings / pattern-matching content to
  recover one-way transforms. A model legitimately discussing the convention
  ("here's how `<thinking>` tags work...") must not get misclassified.
- The same rule applies upstream: if you must drop or transform something
  that another provider's importer will need, write the drop/transform fact
  into the sidecar so the round-trip back is deterministic instead of
  guessed.

This is the lac-side half of the broader principle "don't infer whether a
thing is recoverable, mark it at the point you know." Same rule applies in
any consumer of these JSONL files (e.g. pi-claude-code's bridge, which uses
the same trick on tool result `details` to differentiate synthetic fallbacks
from real results).
