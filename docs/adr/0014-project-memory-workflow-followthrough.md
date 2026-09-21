# Project-memory workflow follow-through

Status: accepted for bounded implementation, 2026-09-21.

Owner: Retrieval Architect, with Orchestrator and Governance/QA review.
Class: additive retrieval-interface change; no persisted schema migration.

## Problem

The seven-day observation retained 149 exact decision/outcome links out of 202
recorded episodes. Six reported uses had no decision/output reference. Two
individual searches lacked callbacks although a later sibling search in each
opportunity had one. Existing interfaces support these connections, but require
repeated context flags and a separate JSON file for reference declarations.
The missing episodes cannot be reconstructed safely from timing or thread alone.

## Decision

Add `--session-file` to the existing search and skip entry points. The caller
explicitly selects an existing canonical owner session; bounded source validation
derives only its exact session and stored thread references. The file must match
the configured owner layout, filename/id and registered project. Reject aliases,
outside-owner paths and conflicting flags before writing an invocation. Unequal
task/retrieval projects still need an explicit cross-workspace declaration.
Do not introduce a context sidecar, new producer, current-session scan or implicit
thread binding. Existing direct flags retain invalid/unresolved attribution
behavior; contradictory repeated options now fail instead of silently taking
the last value. Identical repeats remain accepted.

Add repeatable inline `--use-evidence` objects using the existing callback's
record/reference fields and limits. References remain optional declarations.
Expose attribution status and exact callback targets in producer responses, and
list missing callbacks/references by invocation in the existing report. A sibling
callback never fills another attempt's gap. No callback or use is synthesized.

## Compatibility and boundaries

Nested telemetry remains version 2; version 1 remains readable. Existing artifact
schemas, historical bytes, retrieval decisions/ranking, canonical records and
report-v3 metric meanings are unchanged. Response/report additions are derived.
The wrappers still cannot observe tasks that never call them, force callers to
report honestly, prove native pre-choice coverage, inspect linked output meaning
or establish memory benefit. Fixtures establish interface behavior only.

## Validation and rollback

Use isolated owner metadata, workspaces and catalogs with the actual wrappers.
Cover consultation/read/inline-reference callback, explicit skip, cross-workspace
declaration, sibling attempts with one missing callback, missing reference
visibility, invalid claims/context and legacy-byte preservation. Run focused
regressions and `npm run check`; independent consumer review is required before
activation. No production corpus writes are part of these tests.

Rollback reverts these source/guidance changes. Existing invocations retain their
schemas and remain readable. Callers using the new flags must return to the
existing literal context flags and evidence-file option. There is no data
migration to reverse.
