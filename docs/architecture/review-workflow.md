# Review Workflow

## Purpose

Define the explicit review path for records that move from draft or active states into approved, rejected, or deprecated outcomes.

## Scope

The review workflow owns:
- review decision packets
- transition validation
- activation and rejection rules
- persisted audit metadata returned from a decision

The review workflow does not own:
- record authorship
- retrieval ranking
- evidence mutation
- draft amendment authoring

## Decision Types

- `approve`
- `request_changes`
- `reject`
- `deprecate`

## Record-Type Behavior

### Cases

- `approve`: draft case becomes reviewed then active
- `request_changes`: draft case becomes `review_state=reviewed` but stays draft
- `reject`: draft case becomes deprecated
- `deprecate`: active case becomes deprecated

For cases, `deprecate` is the lifecycle path for retiring a historically approved case that no longer meets the current active-case gate. The deprecated case remains canonical and auditable, but retrieval should no longer treat it as usable runtime case memory.

Draft amendment happens before those review decisions and is a separate operator action. It revises a draft case in the same series, increments `case_version`, and resets `review_state` to `draft`.

### Invariants

- `approve`: draft invariant becomes active
- `request_changes`: draft invariant stays draft
- `reject`: draft invariant becomes rejected
- `deprecate`: active or superseded invariant becomes deprecated

### Tactics

- `approve`: draft tactic becomes active if freshness checks pass
- `request_changes`: draft tactic stays draft
- `reject`: draft tactic becomes rejected
- `deprecate`: active or superseded tactic becomes deprecated

## Review Packet Rule

A review packet is not embedded into the canonical record.

It is an external decision artifact that explains:
- who reviewed
- when they reviewed
- which decision they made
- why they made it

## Audit Entry Rule

Every applied review decision should produce a `review_audit_entry`.

The audit entry records:
- the decision id
- the previous and resulting lifecycle state
- the previous and resulting review state when present
- reviewer and rationale
- a hash of the resulting record snapshot

The audit entry is append-only support evidence for governance. It does not replace the canonical record.

## Runtime Rule

Retrieval should exclude non-active higher-order records by default.

The review workflow exists partly so runtime surfaces do not need to guess whether drafts or rejected records are safe to use.
