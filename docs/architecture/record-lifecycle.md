# Record Lifecycle

## Purpose

Define the allowed status transitions, revision rules, and supersession rules for every canonical ECITR record type.

## Core Rule

Lifecycle rules are part of the architecture, not an implementation detail.

If a record can become active, deprecated, or superseded, that path must be explicit and testable.

## Evidence

Evidence does not have a mutable status lifecycle.

Rules:
- evidence is immutable once written
- corrections create new evidence records
- `correction_of` links to earlier evidence without mutating it
- `parent_evidence_id` traces lineage without changing factual authority

Evidence may be appended, linked, or deprecated at the storage-management level, but the factual record is never rewritten.

## Cases

`case_id` identifies the case series.

`case_version` increments when the same case framing is revised.

`supersedes_case_id` is reserved for replacing a different case series whose framing proved materially wrong or incomplete.

### Allowed Status Transitions

- `draft -> active`
- `draft -> deprecated`
- `active -> deprecated`
- `active -> superseded`
- `deprecated -> superseded`

### Revision Rules

- a revised case in the same series keeps the same `case_id`
- the next revision must increment `case_version`
- evidence refs remain mandatory on every revision
- evidence still wins on factual conflicts
- operator-authored draft completion should preserve an explicit amendment packet outside the canonical case file

### Validation Rules

- `active` and `superseded` cases must still satisfy the strong non-draft gate:
  - complete framing
  - substantive applicability
  - no unresolved `open_questions`
- `deprecated` cases preserve historical record state and do not need to satisfy the current active-case gate
- this distinction exists so ECITR can retire historically promoted weak cases without rewriting or fabricating stronger framing

## Invariants

`id` identifies a concrete invariant record.

`series_key` identifies the invariant lineage across versions.

### Allowed Status Transitions

- `draft -> active`
- `draft -> rejected`
- `draft -> deprecated`
- `active -> superseded`
- `active -> deprecated`
- `superseded -> deprecated`

### Supersession Rules

- the newer invariant keeps the same `series_key`
- the newer invariant points to the older one with `supersedes`
- the older invariant points forward with `superseded_by`
- the older invariant must move to `superseded`
- rejected invariants do not supersede active ones

## Tactics

`id` identifies a concrete tactic record.

`series_key` identifies the tactic lineage across versions.

### Allowed Status Transitions

- `draft -> active`
- `draft -> rejected`
- `draft -> deprecated`
- `active -> superseded`
- `active -> deprecated`
- `superseded -> deprecated`

### Supersession Rules

- the newer tactic keeps the same `series_key`
- the newer tactic points to the older one with `supersedes`
- the older tactic points forward with `superseded_by`
- the older tactic must move to `superseded`
- every active tactic must keep `expiry_at` or `revalidate_at`

## Review Rule

Lifecycle and supersession rules must be enforced in:
- docs
- tests
- write-time validation gates

If one of those surfaces diverges, the architecture is no longer trustworthy.
