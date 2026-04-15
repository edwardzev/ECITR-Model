# 2026-04-10 Managed local Qdrant runtime

## Scope

- Task type: operational hardening
- Repo area: local Qdrant prototype runtime, CLI commands, runbook

## What Changed

- Added a managed local Qdrant runtime helper with install, start, stop, and status operations.
- Added repo commands for `qdrant:install`, `qdrant:start`, `qdrant:stop`, `qdrant:status`, and `qdrant:local`.
- Moved the managed runtime surface to explicit paths under `.local/qdrant/` for config, logs, pid files, storage, snapshots, and temp files.
- Added tests for local runtime path resolution, release asset selection, and generated config shape.
- Updated the Qdrant runbook to use the managed commands and to document the managed runtime layout.

## Why

- The earlier prototype depended on ad hoc manual startup and wrote runtime state under the binary working directory.
- The managed commands make the local semantic backend repeatable and auditable for future contributors.

## Files Touched

- Code:
  - `src/qdrant/local-runtime.js`
  - `src/cli/qdrant-local.js`
  - `package.json`
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

- None

## Next Checks

- If the local embedder is replaced later, rerun the managed Qdrant benchmark with the stronger embedding backend without changing the local runtime contract.
