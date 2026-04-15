# ADR 0001: Authority Chain And Layer Separation

## Status

Accepted

## Context

Prior memory approaches tend to blur raw evidence, interpreted cases, durable patterns, current tactics, and runtime retrieval into one store or one retrieval surface.

That creates:
- semantic drift
- poor re-interpretability
- weak supersession
- retrieval systems that start acting as semantic authorities

## Decision

ECITR separates:
- Evidence
- Cases
- Invariants
- Tactics
- Retrieval

Authority flows one way:

`Evidence -> Cases -> Invariants/Tactics`

Retrieval is outside the authority chain.

## Consequences

- raw evidence remains re-interpretable
- higher-order records can be revised without rewriting evidence
- retrieval engines remain replaceable
- each layer can evolve with clearer ownership boundaries
