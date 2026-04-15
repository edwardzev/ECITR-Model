# Invariant Discovery

Use this surface to benchmark candidate invariants against the current active case pool
before writing any invariant records.

## Purpose

Invariant discovery is a bounded preparation step.

It:
- may start from an explicit human-written benchmark manifest or from a staged
  hypothesis manifest derived from active cases
- prepares an `invariant_promotion_packet` from an explicit hypothesis
- checks whether the candidate is actually supported across those cases
- dry-runs draft compilation and approval

By default the benchmark does not write canonical invariants.

Once a candidate is benchmark-approved, ECITR can persist the exact
`invariant_promotion_packet` and promote it through the canonical review flow.

## Command

```bash
npm run benchmark:invariants -- --manifest /absolute/path/to/invariant-discovery-benchmark.json
```

Optional:

- `--catalog-root /absolute/path/to/catalog`

## Whole-Pool Entry Point

To derive conservative staging-only hypotheses from the active uncovered case pool first:

```bash
npm run derive:invariants -- \
  --max-candidates 25 \
  --max-candidates-per-case 3 \
  --max-rare-token-df 6 \
  --min-shared-clauses 1 \
  --min-shared-rare-tokens 4 \
  --min-rare-score 3
```

This command:
- reads only `active` cases
- excludes cases already covered by active invariants by default
- requires at least one repeated promotable clause across the candidate case set
- writes only `staging/invariant-hypothesis-manifests/<derivation_id>.json`
- never writes canonical invariants directly

Use the emitted manifest for review, then benchmark or promote only the candidates that
still look semantically real.

## Manifest Shape

Each entry provides:

- `expected_decision`
- `promotion_basis`
- `title`
- `summary`
- `statement`
- `source_case_refs`
- `why_it_is_stable`
- `scope`
- `non_scope`
- `applicability_conditions`
- `non_applicability_conditions`
- `known_breakers`
- `tool_agnosticity_level`
- `confidence`

The discovery surface unions `evidence_refs` from the supporting cases automatically.

When the manifest came from `derive:invariants`, each entry also carries derivation
metadata about:
- repeated normalized clauses
- repeated rare tokens
- source case titles
- the live support-check result that produced the staged expectation

## Readiness Rules

Discovery blocks a candidate when:

- any `source_case_ref` is missing
- any `source_case_ref` is not `active`
- a `multi_case` candidate has fewer than two supporting cases
- the candidate text is not strongly supported by every source case
- the supporting cases do not share enough stable common support for one invariant

## First Use

Start with a small benchmark set:

- clearly promotable multi-case patterns
- borderline patterns that might be too narrow
- deliberate blocks such as mismatched case groups or single-case multi-case claims

Tune the discovery benchmark before writing any live invariant packets.

When using the new whole-pool deriver, review the staged hypothesis manifest before
promotion work. The deriver is intentionally conservative, but repeated clauses can still
be operationally specific rather than truly invariant.

## Promotion Command

Promote a benchmark-approved candidate into the canonical catalog:

```bash
npm run review:invariants -- promote-candidate \
  --manifest /absolute/path/to/invariant-discovery-benchmark.json \
  --label approve_candidate_label \
  --reviewer governance-qa-steward \
  --rationale "Benchmark-approved invariant candidate promoted into canonical review flow."
```

This command:
- re-runs the support check against live active cases
- writes `staging/invariant-promotion-packets/<promotion_id>.json`
- compiles the draft invariant
- applies the invariant review decision
- writes the canonical invariant record and review audit entry

The same promotion surface is also used by the governed morning promotion runner, which only attempts benchmark-approved entries and skips candidates that are already active.
