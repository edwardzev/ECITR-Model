# Invariant Promotion Pipeline

## Purpose

Define how ECITR promotes reviewed case-backed patterns into draft invariants.

## Core Rule

Invariants are promoted from explicit staging packets, not directly from ad hoc agent output.

The pipeline is:

`supporting cases -> promotion packet -> draft invariant -> review -> active invariant`

Before live promotion, ECITR may run a discovery benchmark over the active case pool.
That benchmark does not write invariants. It prepares candidate promotion packets from
explicit invariant hypotheses plus active supporting case refs, checks whether the
candidate is sufficiently supported across those cases, and only then treats the packet
as promotion-ready.

ECITR may also derive a staging-only hypothesis manifest from the uncovered active case
pool first. That derivation does not promote anything and does not write invariant
records. It exists only to surface reviewable hypotheses for the benchmark layer.

Once a candidate is benchmark-approved, ECITR may persist the exact
`invariant_promotion_packet` under staging and then run the existing review workflow to
write the canonical invariant and review audit entry.

## Promotion Basis

Default expectation:
- multiple supporting cases

Single-case promotion is allowed only when the packet explicitly says the promotion is human-approved despite limited support.

## Compiler Rule

The promotion pipeline may create draft invariants only.

Activation is a separate review action.

## Scope Rule

The packet must force explicit:
- applicability
- non-applicability
- known breakers
- tool-agnosticity level

## Discovery Rule

Invariant discovery starts from active supporting cases, not raw evidence and not
historical statuses alone.

The discovery workflow is:

`active supporting cases -> candidate promotion packet -> support check -> draft invariant -> review`

Candidate discovery must not auto-promote anything directly. It only prepares
reviewable invariant packets and benchmark results.

The operational promotion workflow is:

`active supporting cases -> candidate promotion packet -> support check -> staged invariant packet -> draft invariant -> review -> active invariant`

When the whole-pool deriver is used first, the bounded path is:

`uncovered active cases -> staged hypothesis manifest -> candidate promotion packet -> support check -> staged invariant packet -> draft invariant -> review -> active invariant`
