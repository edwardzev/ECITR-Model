# Tactic Discovery

## Purpose

Evaluate and promote tool-bound current guidance from the active case and invariant pool without bypassing canonical review.

## Benchmark First

Run tactic discovery as a benchmark before writing canonical tactics:

```bash
npm run benchmark:tactics -- --manifest /absolute/path/to/tactic-discovery-benchmark.json
```

Each benchmark entry should:
- cite active `source_case_refs`
- cite active `supporting_invariant_refs`
- remain explicitly tool-bound
- include substantive operational steps rather than process scaffolding

## Promotion Path

Once a benchmark candidate is clean, promote it through the review surface:

```bash
npm run review:tactics -- promote-candidate \
  --manifest /absolute/path/to/tactic-discovery-benchmark.json \
  --label approve_operator_morning_review_projection \
  --reviewer tactic-steward \
  --rationale "Candidate is grounded in active cases and invariants."
```

Use `--dry-run` first when checking a candidate without writing canonical state.

## Inspection

Inspect a canonical tactic and its staged packet:

```bash
npm run review:tactics -- show --tactic-id tac_example_id
```

## Rule

Discovery may evaluate tactic hypotheses, but canonical tactics are written only through:

`supporting cases + supporting invariants -> tactic_promotion_packet -> draft tactic -> review -> active tactic`

The governed morning promotion runner reuses this exact review surface and only attempts benchmark-approved tactic entries that are not already active.
