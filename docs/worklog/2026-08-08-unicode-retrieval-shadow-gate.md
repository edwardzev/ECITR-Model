# 2026-08-08 Unicode Retrieval and Shadow Gate

## Scope

- Task type: retrieval-class change and bounded external adaptation
- Repo area: retrieval normalization, project-memory observations, benchmarks,
  tests, and canonical retrieval documentation
- Branch: `codex/unicode-retrieval-shadow-gate`

## What Changed

- Added one shared Unicode-aware retrieval tokenizer.
- Aligned lexical, metadata, temporal, heuristic-semantic, hash, and hybrid
  sparse tokenization.
- Preserved underscore identifiers and non-Latin scripts, folded Latin
  diacritics, split punctuation/separators, and retained negation.
- Versioned hash and hybrid sparse embedding signatures with `unicode-v2` so an
  incompatible derived index is not silently reused.
- Added `ecitr-conservative-shadow-v1` to project-memory consultations.
- Kept gate enforcement disabled and actual requested retrieval unchanged.
- Added mandatory preflight and failure-retry override evaluation.
- Added constructed tokenization and gate benchmark suites and a repeatable CLI.

No canonical schema, record, workspace marker, catalog data, or `agent-ops`
surface changed.

## Benchmark Results

Tokenizer benchmark, 16 scenarios:

| Metric | Legacy ASCII tokenizer | Shared `unicode-v2` tokenizer |
|---|---:|---:|
| Passing scenarios | 5/16 | 16/16 |
| Expected-result hit rate | 33.33% | 100% |
| Mean reciprocal rank | 0.3333 | 1.0000 |
| Negative scenarios with retrieval | 1/1 | 0/1 |

The suite covers punctuation, slash, colon, hyphen, Latin diacritics,
underscore identifiers, negation, Hebrew, Arabic, Cyrillic, and CJK.

Shadow gate benchmark, 22 scenarios:

| Metric | Result |
|---|---:|
| Accuracy | 90.91% |
| Recall | 100% |
| Specificity | 77.78% |
| False negatives | 0 |
| False positives | 2 |
| Critical false negatives | 0 |
| Mandatory-policy violations | 0 |
| Mandatory overrides exercised | 3 |
| Query-usefulness accuracy | 100% |

The two false positives are deliberate fail-open outcomes for ambiguous
requests. This is safer than hiding memory, but it also means the gate has not
earned enforcement authority.

## Validation

- Focused tokenizer, gate, lane, embedding, project-memory, exact-identifier,
  semantic backend, and semantic benchmark tests passed.
- A project-memory integration test proves that a proposed skip still executes
  retrieval.
- A derived-index integration test proves that the pre-Unicode hash signature
  is rejected as non-current.
- `npm run benchmark:retrieval-improvements` passed.
- `npm run check` passed with 304 tests and zero failures.

## Canonical Docs Updated

- `README.md`
- `docs/architecture/retrieval-control-plane.md`
- `docs/architecture/retrieval-runtime.md`
- `docs/architecture/semantic-backend-interface.md`
- `docs/architecture/orchestrator-runtime.md`
- `benchmarks/README.md`

## Historical Records Updated

- ADR: `docs/adr/0011-unicode-retrieval-normalization-and-shadow-gating.md`
- Evaluation note: `docs/eval/waku-retrieval-adaptation-note.md`
- Worklog: this entry
- Changelog: none; the repository has no active changelog surface

## Remaining Uncertainty

- Gate scenarios are constructed and primarily use English classification cues.
- No labeled live shadow corpus was evaluated in this change.
- Derived LanceDB or Qdrant indexes were not resynced as part of this local code
  change.

## Decision

- Adopt the shared Unicode tokenizer.
- Keep the gate in shadow mode.
- Do not allow the gate to suppress retrieval until a later retrieval-class
  review has labeled live false-negative evidence and an explicit rollback
  contract.
