# ADR 0004: Evidence Writes Must Pass Through A Validation Gate

## Status

Accepted

## Context

External substrates and agent-side tooling can create pressure to write raw memory artifacts directly into storage.

That makes it easy for:
- invalid evidence records
- missing hashes or provenance
- silent schema drift
- substrate-specific assumptions

to enter the canonical memory system.

## Decision

All evidence writes in ECITR must pass through a validation gate that:
- validates the canonical `EvidenceRecord`
- applies evidence lifecycle checks
- calls the substrate adapter only after validation succeeds

## Consequences

- the substrate remains subordinate
- write safety does not depend on agent discipline
- schema and lifecycle regressions can be caught in tests
- MemPalace or any future substrate can be swapped without changing the canonical write contract
