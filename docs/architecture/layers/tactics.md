# Tactics Layer

## Purpose

Store current, bounded action guidance for what should be done now.

## Owns

- tool-bound procedures
- version- and environment-specific guidance
- prerequisites
- fallback paths
- rollback paths
- expiry and revalidation rules

## Does Not Own

- durable structural truths
- evidence storage
- case authority
- retrieval ownership

## Authority

Tactics are authoritative only when fresh, verified, and scope-matched.

## Core Rules

- tool names belong here, not in invariants
- every tactic needs explicit scope and version bounds
- every tactic needs expiry or revalidation metadata
- superseded tactics remain readable but are not default-retrieved

## Failure Modes

- tactics treated as timeless truth
- missing version bounds
- stale tactics resurfacing without freshness checks

See:
- `docs/architecture/tactic-promotion-freshness.md`
