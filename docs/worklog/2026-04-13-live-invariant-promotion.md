# 2026-04-13 Live Invariant Promotion

## Objective

Turn the benchmark-approved invariant discovery candidates into real canonical
invariants without bypassing the existing promotion and review contracts.

## Completed

- Added a reusable invariant review surface that promotes a benchmark-approved
  candidate into the canonical catalog through:
  - staged `invariant_promotion_packet`
  - draft invariant compilation
  - review approval
  - `review_audit_entry` persistence
- Added `npm run review:invariants -- promote-candidate ...`.
- Added staging storage under `staging/invariant-promotion-packets/`.
- Promoted three benchmark-approved live invariant candidates into canonical
  active invariants.

## Why This Shape

- The discovery benchmark remains the precision gate for invariant hypotheses.
- Live promotion now reuses the benchmark-approved packet content rather than
  inventing a second promotion path.
- The canonical catalog keeps both the staged packet and the review audit entry,
  so invariant activation remains inspectable.

## Follow-up

- If more invariant candidates are added to the benchmark, promote only those
  that still pass the current support check at promotion time.
- If invariant editing becomes routine, add an invariant queue/show/decision
  surface rather than continuing with manifest-driven point promotions only.
