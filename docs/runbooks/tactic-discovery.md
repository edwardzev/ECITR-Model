# Tactic Discovery

## Purpose

Evaluate and promote tool-bound current guidance from the active case and invariant pool without bypassing canonical review.

## Benchmark First

Run tactic discovery as a benchmark before writing canonical tactics:

```bash
npm run benchmark:tactics -- --manifest /absolute/path/to/tactic-discovery-benchmark.json
```

The command exits non-zero when any expected decision mismatches. The generic
example manifest must not be paired with the live catalog and treated as a
production health check; pass the intended manifest explicitly.

Each benchmark entry should:
- cite active `source_case_refs`
- cite active `supporting_invariant_refs`
- remain explicitly tool-bound
- include substantive operational steps rather than process scaffolding

Direct tactics are allowed when `promotion_basis` is `case_cluster`. In that mode
`supporting_invariant_refs` may be empty, but the candidate must clear the stronger
case-cluster gate:

- at least two active source cases
- stronger source-case text overlap than invariant-backed tactics
- a repeated action pattern across the supporting cases
- concrete tool binding, version bounds, environment bounds, prerequisites, steps,
  fallbacks, rollback, and freshness fields
- no process-only guidance

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

For direct tactics the allowed path is:

`strong active case cluster -> tactic_promotion_packet(promotion_basis=case_cluster) -> draft tactic -> review -> active tactic`

The governed promotion runner reuses this exact review surface. Benchmark manifests
remain regression inputs. Live direct tactic candidates are staged under
`staging/live-tactic-candidates/`, checked by deterministic support rules and the
promotion judge, and activated within the default cap of five tactics per run.

Both invariant and tactic regression benchmarks are evaluated before case batching,
live-candidate staging, or any other mutation-capable promotion work. A dirty
benchmark therefore blocks the run without leaving partial promotion mutations.

Without `ECITR_PROMOTION_JUDGE=local`, `ECITR_PROMOTION_JUDGE=model`, or another
configured judge adapter, live tactic candidates are staged only and activation is
skipped with a warning.

The model-backed judge uses the same bounded response contract for tactics and
invariants:

```json
{
  "decision": "activate | narrow | retire",
  "rationale": "...",
  "narrowed_entry": null
}
```

For `narrow`, the model may only return known patch fields such as `non_scope`,
`known_breakers`, `prerequisites`, `steps`, `fallbacks`, `rollback`,
`environment_bounds`, and active-facing semantic fields such as `title`, `summary`,
or `action`.

Before activation, live candidates pass a final quality gate. If `title`, `summary`,
or `action` still looks like generated token-bag prose, live candidate labels, shared
signal lists, or underscore-heavy machine tokens, the candidate is retired even when
the judge returned `activate`.
