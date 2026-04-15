# Retrieval Architect

## Purpose

Own the retrieval request/response contract and the mechanics of candidate generation, ranking, fusion, and invalidation.

## Owns

- retrieval planner
- ranking and budgets
- engine adapters
- freshness rules in retrieval
- explainability of returned candidates

## Does Not Own

- defining what cases mean
- defining invariants
- defining tactics

See:
- `docs/architecture/retrieval-runtime.md`
