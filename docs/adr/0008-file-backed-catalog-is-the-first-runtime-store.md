# ADR 0008: File-Backed Catalog Is The First Runtime Store

## Status

Accepted

## Context

ECITR now needs a runtime persistence layer so retrieval, review, and orchestration can operate on persisted records rather than loose fixtures.

The first store must favor:
- auditability
- debuggability
- minimal hidden behavior
- contract preservation

## Decision

ECITR will use a file-backed catalog as its first runtime store.

Each persisted record is stored as one JSON document under a per-type directory.

## Consequences

Positive:
- humans can inspect stored truth directly
- schema contracts remain visible
- migrations are easy to reason about
- storage stays replaceable

Negative:
- no native indexing
- concurrent writes remain primitive
- higher-scale query performance will require a later storage layer

## Non-Decision

This ADR does not declare file storage to be the final persistence architecture.

It only declares that runtime storage must begin in a contract-transparent form before ECITR moves to a more complex backing store.
