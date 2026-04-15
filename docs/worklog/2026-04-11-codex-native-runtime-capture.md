# 2026-04-11 Codex-native runtime capture

## Scope

- Task type: runtime evidence ingestion expansion
- Repo area: ongoing Codex conversation capture into canonical evidence

## What Changed

- Added a Codex-native rollout importer that reads local Codex rollout files from `~/.codex`.
- Mapped printed `user_message` and `agent_message` events into immutable `EvidenceRecord`s with `source_type: "chat"`.
- Added a Codex refresh pipeline that imports rollout evidence, syncs the derived Qdrant index, and runs structural capture checks.
- Added tests for rollout import, snapshot chaining, duplicate-source handling, and refresh orchestration.
- Updated the canonical runbooks and evidence layer docs to distinguish historical `agent-ops` backfill from ongoing Codex-native runtime capture.

## Why

- `agent-ops` was acceptable as a one-time historical backfill source, but it must not remain the runtime owner of ECITR memory.
- Codex already stores its own local rollout artifacts, so ECITR can ingest ongoing conversation evidence directly from Codex-native sources.
- The requirement is to preserve every symbol printed in Codex conversations, which is best grounded in the Codex rollout event stream rather than derived summaries.

## Files Touched

- Code:
  - `src/importers/codex-rollouts.js`
  - `src/importers/codex-refresh.js`
  - `src/cli/import-codex.js`
  - `src/cli/refresh-codex.js`
  - `package.json`
- Tests:
  - `tests/codex-rollouts-import.test.js`
  - `tests/codex-refresh.test.js`
- Docs:
  - `README.md`
  - `docs/architecture/layers/evidence.md`
  - `docs/runbooks/conversation-evidence.md`
  - `docs/runbooks/qdrant-prototype.md`

## Canonical Docs Updated

- `README.md`
- `docs/architecture/layers/evidence.md`
- `docs/runbooks/conversation-evidence.md`
- `docs/runbooks/qdrant-prototype.md`

## Historical Records Updated

- Changelog: none
- ADR: none
- Worklog: this entry

## Remaining Uncertainty

- ECITR now has a Codex-native runtime import path, but zero-gap “every live turn immediately captured” still depends on a refresh trigger or a future Codex-side hook.

## Next Checks

- Run `npm run refresh:codex` against the real `~/.codex` corpus and verify the imported thread count and derived index sync.
