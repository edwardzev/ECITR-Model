# Invariant Promotion Pipeline

## Purpose

Define how ECITR promotes reviewed case-backed patterns into draft invariants.

## Core Rule

Invariants are promoted from explicit staging packets, not directly from ad hoc agent output.

The canonical packet pipeline is:

`supporting cases -> promotion packet -> draft invariant -> review -> active invariant`

The live autonomous higher-promotion loop is:

`active cases -> live candidate staging -> deterministic support check -> promotion judge -> capped activation -> active invariant`

Live candidates are stored under `staging/live-invariant-candidates/`. They are
production staging artifacts, separate from benchmark manifests. Benchmark manifests
remain regression inputs and examples; they are not the production candidate source.

The governed promotion runner first evaluates both invariant and tactic regression
benchmarks. Only after both gates are clean may it run case batching or stage live
candidates. It activates conservatively: no more than three invariants per run by
default. If the promotion judge is unavailable, live candidates stay staged or
judge-skipped and the runner records a warning instead of activating them.

An `activated` or `retired` live candidate is a terminal reviewed artifact. If
later discovery generates different semantic fields for the same deterministic
candidate series, ECITR writes a new staged revision with
`candidate_series_id` and `supersedes_candidate_id`. It never carries the old
terminal decision onto unreviewed semantics.

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

When the legacy whole-pool deriver is used first, the bounded path is:

`uncovered active cases -> staged hypothesis manifest -> candidate promotion packet -> support check -> staged invariant packet -> draft invariant -> review -> active invariant`

The live runner may replace the human-selected hypothesis manifest with generated
candidate staging, but it still must pass deterministic support checks and a promotion
judge before activation.
