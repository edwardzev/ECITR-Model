# ADR 0009: Tactic Revalidation Is An Audited State Change

Status: Accepted

Date: 2026-07-17

## Context

Active tactics become unusable when `revalidate_at` passes. The runtime
correctly fails closed, but ECITR previously had no governed path for deciding
whether an overdue tactic still had current support. Editing the date directly
would restore retrieval without proving that the cases, invariants, evidence,
environment, or tool bounds remained valid.

## Decision

Introduce the versioned `tactic_revalidation_packet` contract and store each
packet as an immutable review artifact under
`review/tactic-revalidations/`.

The tactic review surface may extend `revalidate_at` only for an active tactic
whose cited cases are active and lifecycle-valid, whose cited invariants are
active, whose evidence resolves, and whose invalidation markers are clear. The
reviewer must record the concrete validation surfaces and explicitly accept the
current environment and tool bounds. The packet binds the previous and
resulting tactic snapshots with SHA-256 hashes.

Failed support checks do not change the tactic. Unsupported guidance is routed
through the existing audited deprecation or supersession paths.

## Consequences

- Freshness can be restored without weakening fail-closed retrieval.
- Revalidation decisions are attributable and auditable.
- A stale tactic with stale support cannot be revived by date-only mutation.
- Revalidation remains a review action; it is not an autonomous maintainer
  rewrite.

## Alternatives Rejected

- Automatically add a fixed number of days to every overdue tactic. This has no
  semantic or provenance check.
- Treat active status as sufficient for use. This defeats freshness.
- Force every still-valid tactic through a new promotion identity. This loses
  the distinction between periodic review and material supersession.
