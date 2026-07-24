# Tactic Promotion And Freshness

## Purpose

Define how ECITR promotes case-backed current guidance into tactics and how those tactics are evaluated for freshness.

## Core Rule

Tactics are promoted from explicit staging packets and must remain freshness-aware after activation.

The pipeline is:

`supporting cases + supporting invariants -> promotion packet -> draft tactic -> review -> active tactic -> freshness checks`

## Discovery Rule

Tactic discovery should remain benchmarked before promotion.

Discovery may evaluate candidate tactics from active supporting cases and active supporting invariants, but canonical tactics are written only through staged `tactic_promotion_packet` artifacts and review.

## Freshness Rule

An active tactic is not automatically usable.

It must still survive freshness checks such as:
- expiry date
- revalidation date
- invalidation markers
- environment mismatch

## Revalidation Rule

Revalidation is a governed review action, not a timestamp edit.

An active tactic may receive a later `revalidate_at` only when an immutable,
schema-versioned tactic revalidation packet records:

- the previous and next freshness boundaries;
- the reviewer, rationale, and review time;
- active, lifecycle-valid source cases;
- active supporting invariants, when cited;
- resolvable evidence;
- explicit review of invalidation markers, environment bounds, and tool bounds;
- the validation surfaces used; and
- hashes of the previous and resulting tactic records.

If any cited support is missing, inactive, or invalid, the tactic must remain
unusable and be deprecated or superseded. Revalidation packets are immutable
and live under `review/tactic-revalidations/` in the catalog root.

## Runtime Rule

Retrieval may surface active tactics by default only when they are still fresh enough for the current request mode.

## Scope Rule

Every tactic must keep:
- tool bindings
- version bounds
- environment bounds
- fallbacks
- rollback
