# 2026-04-11 Agent-ops refresh pipeline

## Scope

- Task type: operational workflow hardening
- Repo area: `agent-ops` evidence refresh, local Qdrant sync, retrieval smoke validation

## What Changed

- Added a single refresh pipeline that imports `agent-ops` runs and sessions into `.local/catalog`, recreates and syncs the local Qdrant collection, and runs evidence-only smoke checks against the live imported corpus.
- Added a shared smoke-check helper with explicit expected evidence ids for the current imported corpus.
- Added tests for the refresh orchestration path and smoke-check pass/fail behavior.
- Added a repo command `refresh:agent-ops`.
- Updated the Qdrant runbook to document the new refresh workflow and its defaults.

## Why

- The repo already had working importers and a working Qdrant sync path, but the operator workflow still required multiple manual commands and ad hoc validation.
- A single refresh command makes the local evidence corpus repeatable to refresh, index, and sanity-check before new ingestion tranches arrive.

## Files Touched

- Code:
  - `src/importers/agent-ops-refresh.js`
  - `src/cli/refresh-agent-ops.js`
  - `src/retrieval/evidence-smoke-check.js`
  - `package.json`
- Tests:
  - `tests/agent-ops-refresh.test.js`
  - `tests/evidence-smoke-check.test.js`
- Docs:
  - `README.md`
  - `docs/runbooks/qdrant-prototype.md`

## Canonical Docs Updated

- `README.md`
- `docs/runbooks/qdrant-prototype.md`

## Historical Records Updated

- Changelog: none
- ADR: none
- Worklog: this entry

## Legacy Docs Archived or Deprecated

- None

## Remaining Uncertainty

- The smoke scenarios are intentionally tied to the current imported `agent-ops` corpus. If those anchor runs are removed or materially rewritten later, the smoke check set should be refreshed rather than silently weakened.

## Next Checks

- When the ChatGPT export arrives, ingest it into `.local/catalog` and rerun `npm run refresh:agent-ops`.
