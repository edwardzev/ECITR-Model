# Support Graph

## Purpose

Define the derived support-graph layer that improves navigation, explainability, and change auditing without changing ECITR's canonical truth model.

## Status

The support graph is a derived internal layer.

It is:
- rebuilt from persisted ECITR records
- subordinate to canonical records
- usable for navigation, related-record expansion, and audit diffs

It is not:
- a canonical record layer
- a public retrieval result layer
- a replacement for ECITR retrieval planning or fusion

## Inputs

The graph is built from persisted runtime catalogs:
- `evidence`
- `cases`
- `invariants`
- `tactics`
- `atomic_claim_sets`
- `parameter_definitions`
- `parameter_observations`

The graph compiles relationships that already exist in canonical or support records.

## Output Artifacts

Support-graph artifacts live outside the canonical storage catalog under:

- `.local/support-graph/snapshots/`
- `.local/support-graph/diffs/`
- `.local/support-graph/latest.json`
- `.local/support-graph/latest-diff.json`

These files are derived artifacts, not canonical records.

Each snapshot also carries an internal `basis_hash` derived from graph-relevant runtime catalog fields so downstream consumers can prove the snapshot still matches the current catalog state before using it.

## Node Scope

V1 node categories are:
- `evidence`
- `case`
- `invariant`
- `tactic`
- `atomic_claim_set`
- `parameter_definition`
- `parameter_observation`
- `source_artifact`

Canonical ECITR records remain canonical only in their native record stores.

The support graph reindexes them for traversal.

## Edge Scope

V1 edges are deterministic and source-backed.

They are derived from:
- explicit canonical references such as `evidence_refs`, `source_case_refs`, `supporting_invariant_refs`, `supersedes`, `correction_of`, and `parent_evidence_id`
- deterministic support extraction surfaces such as atomic claim sets and parameter observations

V1 does not add speculative similarity edges or community-derived authority edges.

## Confidence Labels

The support graph uses the following confidence labels:
- `DECLARED`
- `EXTRACTED`
- `INFERRED`
- `AMBIGUOUS`

V1 emits only:
- `DECLARED`
- `EXTRACTED`

Rules:
- `DECLARED` means the relationship came directly from a canonical record field
- `EXTRACTED` means the relationship came from a deterministic support extraction artifact
- labels help humans judge support quality
- labels do not change canonical truth or review authority

## Query Model

V1 graph queries are internal only.

The supported internal operations are:
- neighbors
- shortest path explanation
- related-node expansion
- graph diff inspection

These tools:
- operate over the derived graph snapshot
- remain record-addressed and explicit
- do not replace the public retrieval API
- must fail closed when snapshot freshness cannot be proven against the current runtime catalogs

## Diff Model

Graph diff compares successive snapshots and reports:
- added nodes
- removed nodes
- added edges
- removed edges
- changed edge support or confidence
- changed neighborhoods for canonical records

This is an audit aid for refresh and review.

It is not a promotion authority.

## Refresh Placement

The support graph is refreshed after:
1. evidence import
2. parameter refresh
3. case refresh
4. governed promotion and reconciliation

It runs before downstream semantic sync so any retrieval enrichment can consume the latest derived graph if needed later.

Current retrieval use is explanation-only after fusion. The graph may add explanation lines for already-selected winners, but it does not change result selection or ordering in this wave.

## Non-Goals

V1 explicitly does not do the following:
- expose graph nodes or edges as public retrieval result types
- treat communities as taxonomy
- allow inferred edges to drive promotion decisions
- replace planner or fusion logic
- persist graph artifacts as canonical catalog records
