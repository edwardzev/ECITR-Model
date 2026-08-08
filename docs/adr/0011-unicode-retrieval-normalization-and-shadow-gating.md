# ADR 0011: Unicode Retrieval Normalization and Shadow Gating

## Status

Accepted on 2026-08-08.

## Context

ECITR had three ASCII-only tokenizers across execution lanes, the heuristic
semantic backend, and hash-derived embeddings. They preserved hyphen and colon
inconsistently with ordinary prose and discarded Hebrew, Arabic, Cyrillic, CJK,
and other non-Latin text. Latin diacritics also prevented equivalent spellings
such as `Müller` and `Muller` from matching.

An external assessment also raised a separate hypothesis: some requests may not
need long-term project memory. That hypothesis is useful to measure, but an
incorrect skip can hide mandatory or critical context.

## Decision

ECITR will:

1. own one shared Unicode-aware retrieval tokenizer;
2. apply it to lexical, metadata, temporal, heuristic-semantic, hash, and hybrid
   sparse tokenization;
3. version derived embedding signatures when tokenizer behavior changes;
4. run an ECITR-owned conservative retrieval classifier in shadow mode only;
5. let mandatory preflight and failure-retry policy override any proposed skip;
6. keep actual requested retrieval behavior unchanged as `retrieve_always`;
7. benchmark false negatives, false positives, mandatory-policy violations, and
   query usefulness separately.

No Waku code, prompt, runtime dependency, or canonical data is imported.

## Rejected Alternatives

- Keep independent tokenizers: rejected because drift is already observable.
- Import an external gate implementation: rejected because ECITR policy and
  authority boundaries must remain locally owned.
- Enable skip enforcement after constructed scenarios: rejected because the
  benchmark is not a labeled live workload.
- Expand the workspace marker schema for gate flags: rejected because shadow
  evaluation needs no new authority or configuration contract.

## Consequences

- Correct multilingual and separator-aware matching improves immediately in
  file-backed retrieval.
- Old derived semantic indexes have incompatible sparse or hash behavior and
  require resync; signature checks prevent silent reuse where supported.
- Invocation artifacts gain a derived `retrieval_gate` observation.
- The gate may produce conservative false positives; that cost is accepted in
  shadow mode to protect recall.
- Enabling suppression requires a later retrieval-class change with labeled
  live evidence and an explicit rollback contract.

## Validation

- tokenizer regression scenarios for punctuation, separators, diacritics,
  identifiers, negation, and non-Latin scripts
- lane and embedding alignment tests
- existing exact-identifier and semantic benchmark regressions
- labeled gate scenarios for memory dependence, general knowledge,
  current-thread-only requests, possible no-answer lookups, audits,
  verification, and mandatory MSBC policy
- full `npm run check`
