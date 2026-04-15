# ADR 0002: Evidence Substrate Boundary

## Status

Accepted

## Context

External systems such as MemPalace may provide strong verbatim storage and retrieval for evidence.

However, strong recall over evidence does not by itself define:
- cases
- invariants
- tactics
- retrieval authority

## Decision

ECITR may use MemPalace or a similar engine as an evidence substrate only.

Such substrates may own:
- verbatim storage
- evidence recall
- evidence identifiers or substrate references

They may not become the canonical owner of:
- cases
- invariants
- tactics
- retrieval policy

## Consequences

- evidence storage can improve without collapsing layer boundaries
- future tools may re-distill older evidence
- substrate replacement remains possible
- higher-order semantics remain governed inside ECITR
