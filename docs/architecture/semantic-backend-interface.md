# Semantic Backend Interface

## Purpose

Separate the semantic retrieval lane from any specific retrieval engine.

The lane stays part of ECITR control logic.
The backend becomes a replaceable execution substrate.

## Core Rule

The semantic backend may score or retrieve candidates, but it does not own:
- canonical records
- retrieval planning
- layer budgets
- authority decisions

## File-Backed Fallback

The file-backed fallback backend is `heuristic-semantic-v2`.

It uses:
- the shared Unicode-aware `unicode-v2` retrieval tokenizer
- coarse synonym mapping
- atomic-claim support for evidence text
- soft overlap scoring

This backend is intentionally simple and local. It remains available when the
derived LanceDB table is missing or incompatible with the current catalog and
embedding signature.

## Supported Derived Backend

The sole supported derived semantic backend is
`lancedb-local-semantic-v1`.

It:
- consumes the shared contextual semantic export and writes LanceDB rows
- stores dense vectors and primitive ECITR metadata in an embedded local table
- overwrites the derived table from the catalog during sync
- creates a full-text index over contextual text for later hybrid retrieval
- returns metadata-filtered candidates to the semantic lane
- refreshes as an independent autonomous stage after support-graph refresh,
  including when a promotion benchmark blocks canonical promotion
- backs project-memory semantic retrieval when the matching local table exists

Alternate catalog roots receive isolated sibling support-graph, report, and
LanceDB roots unless an operator explicitly supplies a derived-state location.

It does not:
- replace the file-backed catalog
- require a long-running daemon
- change retrieval request or response schemas
- become canonical storage

The earlier daemon-backed prototype is retired under
[ADR 0012](../adr/0012-retire-qdrant-prototype.md). Historical worklogs remain
as evidence of that experiment, but the prototype is not a supported runtime,
comparison path, CLI surface, or refresh target.

## Future Evolution Criteria

Any future semantic backend change should preserve or improve:
- dense and sparse retrieval or equivalent hybrid retrieval
- metadata filtering before final ranking
- batch candidate retrieval per allowed layer
- explainable result provenance
- optional reranking

## Replacement Rule

Changing the semantic backend must not require changes to:
- canonical record schemas
- retrieval request or response schemas
- planner contracts
- layer authority rules

The backend may evolve.
The retrieval contract may not drift with it.

Sparse and deterministic hash embedding signatures include the tokenizer
version. This prevents a derived index created with incompatible tokenization
from being treated as current.

## Shared Export

Derived semantic backends must consume the shared contextual export projection in
`src/retrieval/semantic-export.js`.

The exporter owns:
- retrievable-layer filtering
- contextual text construction
- workspace and project-scope metadata
- deterministic derived document IDs
- content hashes for derived index sync

Backend-specific modules may transform that projection into engine-native
documents, points, rows, or payloads. They must not redefine ECITR semantic text
or eligibility rules independently.

Vector-only candidates must carry backend-specific relevance qualification.
Without a calibrated threshold, semantic-only candidates fail closed unless
another retrieval lane independently corroborates the record.

## Current Recommendation

Use LanceDB as the embedded derived semantic index over persisted ECITR records.
Introducing another engine requires a new measured retrieval-class decision; it
must not be restored as an ungoverned dormant prototype.

The catalog remains the source of truth.
The semantic backend remains a derived index.
