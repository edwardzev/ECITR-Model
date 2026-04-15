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

## Current Runtime

The current backend is `heuristic-semantic-v1`.

It uses:
- token normalization
- coarse synonym mapping
- atomic-claim support for evidence text
- soft overlap scoring

This backend is intentionally simple and local.

## Prototype Backend

The first stronger prototype backend is `qdrant-hybrid-prototype-v1`.

It is still a derived backend.

It:
- exports persisted ECITR records into contextual index documents
- derives deterministic UUID point IDs from ECITR layer and canonical record ID
- stores canonical metadata as payload
- runs dense+sparse hybrid queries
- returns payload-backed candidates to the semantic lane

It does not:
- replace the file-backed catalog
- change retrieval request or response schemas
- become canonical storage

## Required Future Capabilities

The next stronger backend should support:
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

## Current Recommendation

The next stronger backend should be a hybrid semantic index over persisted ECITR records, not a replacement for the file-backed catalog.

The catalog remains the source of truth.
The semantic backend remains a derived index.
