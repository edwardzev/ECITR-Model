# ADR 0006: Invariants And Tactics Are Promoted Through Staging Packets

## Status

Accepted

## Context

Without staging packets, promotion from cases into higher-order memory becomes conversational and hard to audit.

## Decision

Invariant and tactic promotion in ECITR must start from explicit staging packets and produce draft records before activation.

## Consequences

- promotion inputs remain separate from canonical records
- review surfaces stay explicit
- provenance from cases and evidence remains auditable
