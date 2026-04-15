# Invariants Layer

## Purpose

Store durable claims that should survive tool and framework churn.

## Owns

- tool-agnostic patterns
- applicability boundaries
- non-applicability boundaries
- stable cross-case reasoning
- invariant supersession

## Does Not Own

- current implementation advice
- tool-specific choices
- retrieval tuning
- evidence rewriting

## Authority

Invariants are authoritative for durable patterns, not for current tactics.

## Core Rules

- invariants must avoid tool names unless the statement is explicitly scoped
- promotion requires multiple supporting cases or explicit human approval
- counterexamples must be stored, not hidden
- invariants are revisable and versioned

## Failure Modes

- disguised tactics pretending to be invariants
- vague universal claims
- missing non-applicability
- one-case promotion

See:
- `docs/architecture/invariant-promotion-pipeline.md`
