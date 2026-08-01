# ADR 0010: Shared-catalog workspace attribution is source-backed and journaled

## Status

Accepted.

## Context

The shared catalog imported records from many registered projects, but unmapped
sources inherited the catalog marker's `ecitr_model` workspace. Repo markers
were ignored for attribution when their catalog path differed from the central
catalog. The earlier selective migration corrected evidence append-only but
silently overwrote linked records and discovered higher-order records only
through parameter references.

## Decision

- Keep one canonical file-backed catalog.
- Treat repo markers and the active agent-ops project registry as workspace
  attribution inputs, not as alternate truth stores.
- Keep execution-time catalog-path equality checks.
- Use only authoritative marker, explicit map, or registry resolution for
  migration; never migrate from catalog fallback alone.
- Append evidence corrections and workspace-derived parameter support records.
- Journal metadata-only corrections to cases, invariants, tactics, and staging
  packets in a validated before/after manifest.
- Preserve reviewed live candidates and append a new staged revision when
  corrected workspace attribution changes candidate semantics.
- Block mixed or unresolved lineage.
- Make migration CLIs dry-run-first and require `--apply` for writes.
- Resolve markerless Git worktrees through `.git/commondir`, and fail closed
  when a configured project registry is unavailable.
- Preflight every registry-wide operation before the first catalog write.

## Consequences

The canonical model and retrieval API do not change. Workspace-scoped retrieval
becomes useful across registered projects, and attribution changes are
auditable. Planning is more expensive because it resolves full lineage and
validates complete before/after records. Derived indexes must be refreshed
after apply.

## Rejected Alternatives

- One canonical catalog per repo: fragments cross-project governance and
  operational search.
- Treat catalog fallback as migration truth: repeats the original attribution
  error.
- Rewrite evidence in place: violates immutability.
- Infer a workspace from a majority of linked records: hides mixed lineage.
- Reuse terminal candidate decisions after semantic regeneration: approves
  content that was never reviewed.
