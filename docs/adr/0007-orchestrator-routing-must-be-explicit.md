# ADR 0007: Orchestrator Routing Must Be Explicit

## Status

Accepted

## Context

If orchestration stays conversational and implicit, role ownership drifts and cross-layer work becomes hard to audit.

## Decision

The first orchestrator runtime in ECITR will route explicit task packets through a role registry and emit delegation plans.

## Consequences

- role ownership remains visible
- Researcher usage becomes explicit
- governance review can be triggered deterministically
