# ADR 0012: Retire the Qdrant Prototype

## Status

Accepted on 2026-08-08.

## Decision

ECITR will retire and prune its Qdrant prototype. LanceDB is the sole supported
derived semantic backend; the file-backed catalog remains canonical and the
heuristic semantic backend remains the fail-closed fallback.

## Context

Qdrant entered ECITR as a comparison prototype before an embedded semantic
backend was proven. It added a managed daemon, collection lifecycle, refresh
flags, CLI commands, smoke checks, tests, and documentation.

ECITR subsequently operated with the embedded LanceDB path and did not develop
a need for the daemon-backed path. Keeping Qdrant optional still imposed code,
documentation, test, local-state, and operator-surface maintenance while
providing no current production capability.

## Options Considered

1. Keep the prototype dormant and opt-in.
   This preserved a ready comparison path, but continued to expose unsupported
   commands and refresh contracts and invited derived-state drift.
2. Deprecate the commands but retain the implementation.
   This reduced operator visibility but left dead code, tests, and local runtime
   state to maintain.
3. Retire and prune the operational path.
   This makes the supported topology literal while retaining historical
   evidence in dated worklogs and this ADR.

## Chosen Approach

Remove Qdrant runtime code, backend code, CLI commands, refresh and benchmark
hooks, active tests, current runbooks, package scripts, and generated local
state. Preserve dated worklogs as immutable historical records. Keep the
historical research comparison, clearly labeled as non-operational.

## Consequences

- Positive: one supported derived semantic backend and one derived-index
  lifecycle remain.
- Positive: refresh reports and commands no longer advertise an inactive
  service.
- Positive: local daemon binaries, storage, logs, and configuration can be
  pruned.
- Negative: ECITR no longer has a ready daemon-backed comparison implementation.
- Operational impact: semantic benchmark and governed refresh paths target
  LanceDB only.
- Operational impact: future daemon-backed adoption requires a new measured ADR
  rather than restoring the retired prototype by default.

## Evidence

- Source files: `src/retrieval/semantic-backends/lancedb-backend.js`,
  `src/runtime/governed-promotion-runner.js`
- Config or schema files: `package.json`
- Related docs: `docs/architecture/semantic-backend-interface.md`,
  `docs/eval/semantic-backend-research-note.md`

## Legacy / Supersession Notes

- Historical Qdrant worklogs remain unchanged and may reference files and
  commands that no longer exist.
- The active Qdrant runbook is removed because it is no longer an executable
  operator contract.

## Uncertainty

- None for the current topology. A future measured concurrency or service
  requirement may justify a new backend decision.
