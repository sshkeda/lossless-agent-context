# AGENTS.md

- Assume `pi`, `claude`, and `codex` CLIs are installed and authenticated.
- Tests must fail if any required CLI or auth prerequisite is missing; do not skip those tests because prerequisites are absent.
- When changing code in this repo, run the fullest machine-local verification gate that the repo defines when feasible, not just the portable/default suite.
- Do not avoid machine-local verification merely because it depends on local CLIs, auth, or real session logs; this repo explicitly assumes those prerequisites exist.
- If a full machine-local verification command fails, report the exact failing command and error rather than downgrading the verification claim.
- Product intent is strict losslessness. Preserve all source information across imports/exports and keep emitted logs as close to native as possible without dropping data.
- Do not add lossy export modes, native-only fallbacks that discard information, or tests that normalize away missing fidelity.
- Do not update this `AGENTS.md` unless the user explicitly asks to update it.
