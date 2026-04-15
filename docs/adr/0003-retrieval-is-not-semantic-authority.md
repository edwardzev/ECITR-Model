# ADR 0003: Retrieval Is Not Semantic Authority

## Status

Accepted

## Context

Retrieval is often treated as the memory system itself.

That confuses:
- finding records
- deciding what records mean
- deciding which records are authoritative

As retrieval engines improve, this confusion becomes more dangerous because better search can hide weak contracts.

## Decision

Retrieval in ECITR is a control plane that:
- classifies requests
- chooses layers and budgets
- generates candidates
- ranks and fuses results
- explains surfaced records

Retrieval does not own semantics or canonical truth.

## Consequences

- retrieval backends remain replaceable
- benchmark wins do not automatically change canonical meaning
- record schemas stay engine-neutral
- evaluation must cover both retrieval quality and authority safety
