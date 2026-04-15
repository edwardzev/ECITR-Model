# 2026-04-11 Native conversation evidence

## Scope

- Task type: evidence substrate expansion
- Repo area: direct chat capture into canonical evidence

## What Changed

- Added an ECITR-native conversation snapshot writer that stores chat transcript snapshots as canonical `EvidenceRecord`s with `source_type: "chat"`.
- Added a CLI for capturing chat snapshots from a JSON messages file.
- Added tests for chat evidence writing, snapshot chaining, and retrieval by transcript text.
- Updated the evidence layer documentation and added a dedicated conversation evidence runbook.

## Why

- `agent-ops` was acceptable for one-time backfill, but it must not remain the runtime owner of ECITR evidence capture.
- ECITR now has its own direct path for persisting this thread class into the evidence corpus.

## Files Touched

- Code:
  - `src/evidence/conversation-snapshot.js`
  - `src/cli/capture-conversation-snapshot.js`
  - `package.json`
- Tests:
  - `tests/conversation-snapshot.test.js`
- Docs:
  - `README.md`
  - `docs/architecture/layers/evidence.md`
  - `docs/runbooks/conversation-evidence.md`

## Canonical Docs Updated

- `README.md`
- `docs/architecture/layers/evidence.md`
- `docs/runbooks/conversation-evidence.md`

## Historical Records Updated

- Changelog: none
- ADR: none
- Worklog: this entry

## Remaining Uncertainty

- The new capture path is native and self-sufficient inside ECITR, but platform-level automatic interception of every future UI turn still depends on the caller actually invoking the capture path.

## Next Checks

- Persist the active thread into `.local/catalog` as chat evidence and resync the derived index if the conversation should be retrievable immediately.
