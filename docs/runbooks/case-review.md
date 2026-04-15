# Case Review Runbook

## Purpose

Explain how an operator reviews, inspects, and promotes draft cases through the existing ECITR review workflow.

## Core Rule

Case review is explicit.

The draft distiller does not approve cases.

## Queue Commands

List pending draft cases:

```bash
npm run review:cases -- list
```

Limit the queue:

```bash
npm run review:cases -- list --limit 10
```

Inspect one draft case together with its staged packet and evidence headers:

```bash
npm run review:cases -- show --case-id case_<id>
```

Generate a bounded completion packet plus support-linked applicability suggestion, then dry-run the resulting draft revision:

```bash
npm run review:cases -- complete --case-id case_<id> --reviewer case-steward --rationale "Generate bounded applicability from extracted facts and boundaries." --dry-run
```

If the draft has no explicit bounded failure boundary, `complete` now attempts a deterministic boundary-recovery lane first. That lane writes a staged recovery packet only when it can recover cited unresolved boundaries from linked evidence payloads. If no honest recovery is possible, the draft remains blocked.

Persist that bounded completion path:

```bash
npm run review:cases -- complete --case-id case_<id> --reviewer case-steward --rationale "Generate bounded applicability from extracted facts and boundaries."
```

Amend one draft case from a JSON patch file before approval:

```bash
npm run review:cases -- amend --case-id case_<id> --reviewer case-steward --rationale "Completed applicability framing." --patch-file /absolute/path/to/case-amendment.json
```

Dry-run the amendment without writing:

```bash
npm run review:cases -- amend --case-id case_<id> --reviewer case-steward --rationale "Preview draft completion." --patch-file /absolute/path/to/case-amendment.json --dry-run
```

Example amendment file:

```json
{
  "applicability": {
    "when_to_apply": [
      "When the same situation recurs under the same constraints."
    ],
    "when_not_to_apply": [
      "When the runtime or scope is materially different."
    ]
  },
  "open_questions": []
}
```

## Decision Command

Dry-run an approval:

```bash
npm run review:cases -- decide --case-id case_<id> --decision approve --reviewer governance-qa-steward --rationale "Framing is complete and evidence-backed." --dry-run
```

Run the read-only benchmark harness against a fixed benchmark manifest:

```bash
npm run benchmark:cases
```

Run it against a specific manifest:

```bash
npm run benchmark:cases -- --manifest /absolute/path/to/case-review-benchmark.json
```

Replay the full current pipeline from original draft state using a labeled cohort manifest:

```bash
npm run benchmark:cases:replay -- --manifest /absolute/path/to/case-replay-benchmark.json
```

The replay benchmark reconstructs the original draft from the stored compilation packet, seeds a temporary catalog with the linked evidence payloads, and runs the current bounded completion path in dry-run mode. Use this for labeled cohorts such as:

- clearly viable cases
- borderline cases
- clearly non-qualifying cases

This is the right surface for testing end-to-end recall/precision from original draft state without mutating canonical records.

Run the next live draft batch through bounded completion plus the current approval gate:

```bash
npm run batch:cases -- --limit 30
```

By default, the batch runner skips case ids that already blocked in prior `batch-*-results.json` logs under `.local/review-drafts`, so repeated batches advance into untouched drafts instead of reprocessing the same blocked queue head.

Include previously blocked drafts again only if you are explicitly re-testing them after an upstream enrichment change:

```bash
npm run batch:cases -- --limit 30 --include-previously-blocked
```

Persist a decision:

```bash
npm run review:cases -- decide --case-id case_<id> --decision approve --reviewer governance-qa-steward --rationale "Framing is complete and evidence-backed."
```

Supported decisions:

- `approve`
- `request_changes`
- `reject`
- `deprecate`

## Persistence Behavior

On a persisted decision:

- the canonical case record is overwritten with the resulting lifecycle state
- a new `review_audit_entry` is written
- the staged packet remains unchanged as the original compiler input

On a persisted amendment:

- the original compilation packet remains unchanged
- a new boundary recovery packet may be written under `staging/case-boundary-recovery-packets/`
- a new bounded completion packet may be written under `staging/case-completion-packets/`
- a new staged amendment packet is written under `staging/case-amendment-packets/`
- the canonical draft case is overwritten in-place as the next `case_version`
- `review_state` resets to `draft`

## Boundary

- approval still fails if the case is incomplete
- approval also fails if applicability is only boilerplate or merely restates the problem without a substantive reuse/exclusion condition
- approval also fails if the only reuse condition is incidental execution scaffolding such as memory opening, skill loading, or session setup
- benchmark runs are read-only and must not write completion packets, amendment packets, or approval decisions
- boundary recovery is deterministic and evidence-cited; it may recover missing failure boundaries from payload blockers or other unresolved evidence text, but it must not invent one when the payload does not expose it
- `complete` is the preferred path for applicability framing because it binds generated lines to extracted facts and boundaries
- manual `amend` remains the explicit override when a reviewer needs to supply wording directly
- active cases must be fully framed and approved
