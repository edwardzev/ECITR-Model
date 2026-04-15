# Storage Catalog

## Purpose

Define the first runtime persistence layer for ECITR records without collapsing layer contracts into a database-specific design.

## Current Choice

The first runtime store is a file-backed catalog.

This means:
- each persisted record is stored as one JSON file
- record directories are separated by record type
- schemas remain the contract boundary
- retrieval and orchestration read through the catalog, not from ad hoc fixture loading

## Why This First

The first store must be:
- inspectable by humans
- easy to diff
- easy to audit
- replaceable later

A file-backed catalog satisfies those requirements with minimal hidden behavior.

## Scope

The catalog owns:
- record persistence
- record loading
- per-type directory layout
- runtime catalog assembly for retrieval

The catalog does not own:
- evidence substrate writes
- verbatim evidence payload storage
- semantic interpretation
- review authority
- retrieval ranking

## Directory Layout

The file-backed catalog uses one directory per persisted record type:

- `evidence/`
- `cases/`
- `invariants/`
- `tactics/`
- `atomic-claim-sets/`
- `review-audit-entries/`

Each file name is the canonical record identifier plus `.json`.

Verbatim evidence payloads live beside the catalog as sidecar files under:

- `payloads/evidence/<source>/<kind>/<YYYY>/<MM>/`

`EvidenceRecord.verbatim_payload_ref` points to that sidecar copy. The payload copy preserves the original bytes; the canonical record in `evidence/` only stores the reference and hashes.

Loose staging artifacts remain outside the canonical directories. The current autonomous case distiller writes reviewable packets under:

- `staging/case-compilation-packets/`
- `staging/case-boundary-recovery-packets/`
- `staging/case-completion-packets/`
- `staging/case-amendment-packets/`
- `staging/invariant-promotion-packets/`
- `staging/tactic-promotion-packets/`

## Persistence Rules

- schemas must validate before persistence
- lifecycle rules must validate before persistence for lifecycle-bearing records
- overwrite is disallowed by default
- overwrite is allowed only for explicit state transitions or repair flows
- runtime retrieval reads only from persisted active data, not from loose staging packets

## Runtime Catalog Shape

The runtime retrieval catalog exposes:
- `tactics`
- `invariants`
- `cases`
- `evidence`
- `atomic_claim_sets`
- `review_audit_entries`

`atomic_claim_sets` are support records. They inform retrieval, but they are not returned as a top-level retrieval result layer.

`review_audit_entries` are support records. They preserve governance evidence, not retrievable semantic truth.

## Future Replacement Rule

The file-backed catalog is a first runtime store, not a permanent architectural commitment.

Any later store must preserve:
- schema contracts
- identifier stability
- per-record auditability
- explicit overwrite rules
- clean export back to file-shaped records
