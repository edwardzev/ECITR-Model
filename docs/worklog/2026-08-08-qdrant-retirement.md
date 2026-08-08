# 2026-08-08 Qdrant Prototype Retirement

## Scope

- Task type: retrieval-class architecture retirement
- Repo area: semantic backend, refresh pipelines, benchmarks, tests, generated
  local state, and current-facing documentation
- Branch: `codex/retire-qdrant-prototype`

## What Changed

- Removed the Qdrant semantic backend, managed local runtime, sync command, and
  evidence smoke-check implementation.
- Removed Qdrant options and result fields from manual refresh, autonomous
  refresh, governed promotion, and semantic benchmark paths.
- Removed package commands, active tests, benchmark scenarios, fixtures, and the
  operator runbook that encoded Qdrant as a current capability.
- Standardized active semantic examples on LanceDB or engine-neutral fixtures.
- Kept the file-backed catalog canonical, LanceDB derived, and the heuristic
  semantic backend available as fallback.
- Pruned generated `.local/qdrant` state recoverably after confirming no local
  listener remained.

## Why

- ECITR operated without a Qdrant requirement after LanceDB became the active
  embedded backend.
- A dormant optional service still created maintenance, drift, and operator
  ambiguity.
- The supported topology should match the topology actually operated.

## Files Touched

- Code: refresh importers and CLIs, governed promotion runtime, semantic
  benchmark, package scripts, Qdrant implementation deletion
- Tests and fixtures: refresh, promotion, semantic, retrieval, parameter, case,
  workspace, and tactic discovery coverage
- Docs: current readmes, architecture docs, conversation runbook, research note,
  ADR, and this worklog

## Canonical Docs Updated

- `README.md`
- `src/README.md`
- `docs/architecture/retrieval-control-plane.md`
- `docs/architecture/retrieval-runtime.md`
- `docs/architecture/semantic-backend-interface.md`
- `docs/architecture/workspace-attribution.md`
- `docs/runbooks/conversation-evidence.md`
- `docs/eval/semantic-backend-research-note.md`

## Historical Records Updated

- Changelog: none; the repository has no active changelog surface
- ADR: `docs/adr/0012-retire-qdrant-prototype.md`
- Worklog: this entry

## Legacy Docs Archived or Deprecated

- Removed `docs/runbooks/qdrant-prototype.md` from the active runbook surface.
- Preserved dated Qdrant worklogs unchanged as historical evidence.

## Remaining Uncertainty

- No current requirement justifies a daemon-backed semantic service. A future
  measured concurrency or workload boundary could reopen that decision through
  a new ADR.

## Validation

- Focused refresh, promotion, retrieval, parameter, fixture-linkage, and
  semantic tests passed: 87/87.
- `npm run benchmark:retrieval-improvements` passed; Unicode tokenization
  remained 16/16 and the shadow gate retained zero critical false negatives and
  zero mandatory-policy violations.
- The isolated seeded LanceDB semantic benchmark passed 5/5 scenarios with
  15/15 expected hits and zero forbidden hits.
- The same semantic golden file is not applicable to the live 9,191-row catalog
  because that corpus does not contain its four example fixture IDs; that live
  run was reported as a corpus mismatch, not a passing benchmark.
- `npm run check` passed fixture validation and 286/286 tests.
- An active-reference scan found no Qdrant code, package command, refresh flag,
  report field, test, benchmark, fixture, or operator runbook outside the
  retirement decision and preserved historical documentation.
- Confirmed no process or TCP listener on port 6333 before moving 219 MB of
  generated local Qdrant state to Trash.

## Next Checks

- None for the current retirement. Any future daemon-backed semantic proposal
  starts with a measured workload and a new ADR.
