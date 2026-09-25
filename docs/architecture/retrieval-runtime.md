# Retrieval Runtime

## Purpose

Define how ECITR executes retrieval plans after planning has already selected the allowed layers and budgets.

## Core Rule

Execution is still layer-aware.

The runtime may use multiple lanes, but fusion happens only after:
- planner constraints are applied
- layer boundaries are respected
- stale or invalid candidates are checked

Support records may enrich lane inputs, but they do not become independent retrieval result layers.

When a retrieval request carries `workspace_id`, every returned canonical record must match that workspace before ranking can influence the result set. Missing workspace identity is treated as non-matching for that request.

Stored `blocked` scope on cases and evidence is ineligible for every request
scope, including `global`. The shared eligibility gate rejects these records
before result budgets are applied and before intervention graph neighbors are
admitted. Nonblocked scope rules and workspace/lifecycle/approval precedence
remain unchanged. Exclusion diagnostics may identify rejected records; this
result-admission rule does not change support-graph explanation visibility.

## Runtime Stages

1. accept a planner output
2. execute eligible lanes
3. collect candidate sets
4. reject candidates without sufficient relevance support
5. detect freshness and boundary conflicts
6. diversify evidence by source lineage
7. fuse surviving candidates
8. emit a retrieval response with explanations and bounded conflicts

## Runtime Intervention Layer

ECITR now supports a thin runtime intervention layer for hot-path agent use.

The intervention layer:
- composes a normal retrieval request for `preflight` or `failure_retry`
- reuses the existing retrieval planner and runtime
- trims the runtime output into a smaller grouped selection for immediate use
- may use the support graph only as secondary, explanation-safe expansion
- writes derived intervention artifacts under `.local/runtime-interventions/`
- must reuse the same eligibility gates as direct retrieval before admitting graph-expanded candidates

The intervention layer does not:
- add new canonical record types
- change retrieval request or response schemas
- expose support records as new public result groups
- change ranking authority or bypass freshness, scope, or approval gates

## Project-Memory Telemetry

The existing execution-loop records shadow observations before its own branch
choice; search/skip wrappers record caller-selected observations before internal
dispatch. Both retain opportunity identity and separate retrieval attempts;
external-agent choice coverage is unavailable.
See [project-memory-telemetry](./project-memory-telemetry.md) for the versioned
derived contract, failure/usage evidence boundaries and coverage limits.

## Selected-Record Reader

`ProjectMemorySurface.readProjectMemoryRecords` (alias
`read_project_memory_records`) is the explicit read step after a consultation.
It accepts `invocationId`, ordered `recordIds`, and an optional
`evidenceExcerpt: { recordId, startLine, endLine }`. The execution loop exposes
the same passthrough. CLI and installed-style wrapper entry points are:

```bash
npm run memory:read-records -- --invocation-id meminv_... --record-ids case_...,ev_...
~/.codex/skills/ecitr-memory/scripts/read_project_memory_records \
  --invocation-id meminv_... --record-ids ev_... \
  --evidence-id ev_... --start-line 1 --end-line 20
```

Run from the marked workspace, or supply `--workspace-root`. Explicit
`--workspace-id` and `--catalog-root` must match current marker routing.
`ECITR_MODEL_ROOT` selects the wrapper's source checkout for isolated testing.
The reader requires one unambiguous consultation, its original valid request,
matching workspace/catalog/marker scope, and one to five distinct literal IDs
from its layer-grouped returned IDs. Effective allowed layers come from the
existing planner, including policy-required evidence for audit/verification.
It does not rerank or substitute unreturned corrections. IDs are limited to
160 UTF-8 bytes, invocation IDs to 136, and catalog-relative source references
to 1024; oversized or malformed input metadata is rejected, not truncated.

New consultations retain `retrieval_basis` from the catalog snapshot already
used for retrieval. `ecitr-structural-json-v1` recursively sorts object keys,
preserves array order and parsed values, serializes with compact `JSON.stringify`,
and hashes the UTF-8 bytes with SHA-256. Basis entries retain the actual version
where defined. Read-time structural hashes and versions must match that basis.
Raw canonical-file hashes remain distinct from structural hashes. A valid
legacy consultation without basis may return eligible current content as
`legacy_unpinned`, with `retrieval_time_match: unknown`. A request-null invocation
is denied; historical scope is never reconstructed.

Before disclosure, the reader rechecks owner schema/lifecycle validators,
workspace eligibility, active case approval, tactic freshness and the complete
evidence-correction graph. Invalid graphs fail closed. Selected corrected
evidence is `stale`; the newer leaf is not substituted. Stored blocked project
scope is denied even for a global request. The reader retains its separate
`blocked_scope` disclosure guard for earlier consultations, in addition to the
shared retrieval helper's `scope_conflict` exclusion.

Successful results carry complete `record` bodies for cases, invariants and
tactics, preserving constraints, negative applicability, prerequisites,
fallbacks, rollback and literal absence. Evidence defaults to canonical metadata
(`content_kind: evidence_metadata`); it does not read a payload by default.
An explicit excerpt reads only a catalog-owned `payloads/evidence/` sidecar,
checks real-path containment, verifies its stored `payload_hash`, and returns
the exact decoded bytes in `excerpt`. It never follows `source_locator`.
`source_hash_verified: false` identifies the stored upstream hash as an
unverified claim, even when the sidecar payload hash is verified.

`source`, `payload_source` and `excerpt_source` identify their own catalog files
with `catalog_ref`, `sha256`, zero-based `byte_start`/exclusive `byte_end`,
one-based inclusive `start_line`/`end_line`, and `total_lines`. Canonical spans
cover the full source file. Payload and excerpt hashes identify their respective
byte snapshots. LF terminates its preceding line; CRLF is preserved, terminal
LF creates no extra empty line, and an empty file has zero lines. Invalid UTF-8,
out-of-range excerpts, and excerpts over 80 lines or 8 KiB are denied.

Every selected canonical file and the optional payload is bounded to 1 MiB
before reading; hashes, decoding and spans use the same in-memory byte snapshot.
Nonregular sources are rejected before reading; nonblocking opens also prevent
a concurrent replacement with a FIFO from waiting for a writer.
Oversized sources return `input_budget_exceeded`. Complete correction-graph
validation reads every canonical evidence file on each call, with the same
per-file limit; neither total evidence file count nor total I/O is bounded by
that limit. This version establishes no production latency or total-work bound.

The entire compact JSON CLI response, excluding only its final newline, is
limited to 64 KiB. All result/receipt/envelope metadata is reserved before bodies
are considered in caller order. A body that does not fit returns `denied` with
`budget_exceeded`; operative constraints are never silently shortened. Each
result has `record_id`, `layer`, `result` (`available`, `empty`, `denied`, `stale`),
`reason`, `basis_state`, `content_kind`, and available source/hash/version
metadata. Missing sources are `empty`; none of these states implies attention
or applicability to a live task.

The derived `application_review` envelope provides concise caller guidance to
check inclusion and exclusion conditions against current task facts and to
distinguish specific application from analogy in an existing decision/output
reference. It is reserved inside the same response budget before record bodies,
does not modify canonical records or receipts, and does not certify semantic
application. Full operative conditions are never shortened to fit the guidance.

The same invocation retains at most 20 distinct `read_receipts`, containing
selection/excerpt request, result metadata, hashes/spans and `prepared_at`, but
no body or excerpt text. The duplicate key includes ordered selection, excerpt
request, snapshot hashes/basis states and outcome reasons, excluding timestamps.
Identical reads reuse the existing receipt, including at the cap. A further
distinct read fails explicitly without evicting history. Reading never sets
`used_record_ids`, `selected_record_ids` or `used_memory`. The separate usage
callback remains a self-report; it may be empty or retain legacy meaning without
a receipt. A receipt proves preparation, not host delivery, attention or use.

Reader and usage updates share a per-invocation exclusive lock, reload current
state under it, preserve unknown fields, and persist through a flushed temporary
file plus atomic rename. Invocation input is read through a bounded, no-follow,
nonblocking descriptor with fatal UTF-8 decoding. Descriptor/path identity and
the original bytes are checked again immediately before replacement; detected
drift denies publication. Invalid UTF-8 is rejected without normalizing unknown
field bytes. Lock contention waits at most two seconds, then fails;
the implementation never steals a lock based on age and removes only its own
lock. A failed replacement preserves the prior artifact. The CLI emits no body
or successful receipt claim until persistence succeeds. Invocation input/output
artifacts have a separate 4 MiB limit: oversized input is rejected, and an update
that would exceed it fails before replacement. This compatibility limit also
applies to legacy usage callbacks. Usage is otherwise writable at the receipt
cap. No canonical records, indexes, promotions or additional invocations are
written by reading. Strict no-write audits must not call this mutating surface.

## Lane Model

Initial lanes are simple and explicit:
- lexical lane
- metadata lane
- semantic lane
- temporal lane

The lexical, metadata, and temporal lanes use the shared `unicode-v2` retrieval
tokenizer. The current heuristic semantic backend uses the same tokenizer, as do
the sparse and hash-derived parts of semantic embeddings. External dense models
continue to receive their normal raw text input.

The tokenizer contract is:

- preserve Unicode letters, numbers, combining marks, and underscore-delimited
  identifiers such as `ECITR_LANCEDB_URI`
- split punctuation, slash, colon, and hyphen consistently
- fold Latin diacritics so `Müller` and `Muller` normalize together
- retain Hebrew, Arabic, Cyrillic, CJK, and other non-Latin scripts
- remove only the small shared relevance stop-word set
- retain negation such as `no` and `not`

The implementation has an ASCII fast path after the same NFKD/lowercase pass.
ASCII has no combining marks, and only a-z set the Latin-base flag. All
non-ASCII processing and final NFC remain unchanged. Differential tests against
the prior algorithm cover every code point, surrogate values, mixed scripts and
combining sequences. This changes execution cost, not `unicode-v2` semantics or
embedding signatures.

Each retrieval execution owns a fresh payload snapshot map, shared by its
factory index-basis check, lexical/semantic/temporal lanes and indexed-backend
basis assertion. The map reuses payload-derived segments only within that
execution. It is not stored on a catalog, runtime or backend; later executions
observe file edits, removal and creation. Standalone text reads are fresh by
default. Both complete correction-graph validations and indexed basis checks
still run. No ranking, fusion, scope, expiry or index qualification is cached.

Index synchronization similarly owns a fresh map shared by row export and basis
publication across the asynchronous embedding/table-write step. This keeps the
written rows and basis tied to one payload snapshot. An intervening payload edit
is detected by the next fresh basis check instead of producing a matching basis
for stale rows. It does not make the file-backed catalog an atomic filesystem
snapshot or permit canonical evidence edits.

The synthetic performance benchmark can create a new fixture directory and run
the same input through two source checkouts:

```bash
node src/cli/benchmark-retrieval-performance.js create --fixture-root /tmp/ecitr-performance-fixture --evidence-count 1000
node src/cli/benchmark-retrieval-performance.js run --fixture-root /tmp/ecitr-performance-fixture --runtime-root /path/to/checkout --iterations 2
```

It preserves fixture hashes and full response/diagnostic hashes, checks input
preservation, and reports catalog-load, fingerprint and retrieval timings. Run
baseline and candidate in separate processes with alternating order. Its
heuristic backend and absent graph do not establish installed indexed-path or
ordinary-task speed. First-process query is distinct from cold filesystem
caches, and overlapping lane elapsed times must not be summed.

Tokenizer changes are derived-index compatibility changes. Hash and OpenAI
hybrid embedding signatures include the tokenizer version. A local LanceDB
basis built with the prior signature is rejected as non-current and project
memory falls back to the file-backed heuristic backend until the derived index
is resynced.

LanceDB basis validation receives the complete immutable evidence correction
graph. Lane-facing catalogs still contain only current correction leaves, and
semantic export and row mapping derive the same current-only view from the full
graph. Removing correction parents before basis validation is invalid because
it makes a current derived index appear stale without changing what retrieval
is allowed to return.

There is no query-independent evidence fallback. Proof-oriented requests may
increase the evidence budget, but they must not manufacture arbitrary evidence
when no evidence record is relevant.

The semantic lane runs through a replaceable semantic backend interface so retrieval quality can improve without changing ECITR schemas or authority boundaries.

Semantic-only candidates must be qualified by the backend before fusion admits
them. The heuristic backend qualifies exact normalized-token matches. LanceDB
candidates remain unqualified unless an evaluated backend-specific distance
boundary is configured. Lexical or metadata corroboration may still admit a
candidate from LanceDB.

Parameter support records may enrich lexical, metadata, and semantic text for evidence, cases, and tactics. This enrichment does not change the retrieval request or response contracts.

Derived support-graph artifacts may enrich retrieval explanations after fusion, but they remain subordinate to canonical records and do not become public retrieval result types.

Normal retrieval graph use in the current wave is explanation-only:
- it appends explanation lines after fusion
- it does not add, remove, reorder, or rerank selected results
- it must fail closed when the support-graph snapshot is missing or stale relative to the current runtime catalogs

Later lanes may include graph or policy-aware retrieval, but those are extensions rather than prerequisites.

## Fusion Rule

Fusion may combine multiple lane scores for the same record, but it must still return results grouped by canonical layer.

The runtime must not collapse all layers into one generic ranked list.

## Conflict Rule

The runtime must surface conflicts such as:
- stale tactics
- invalidated tactics
- cross-project leakage when scope metadata exists
- cross-workspace leakage when workspace metadata exists
- duplicate support that only appears independent

Public conflict text is intentionally bounded. Full exclusion counts remain in
internal runtime diagnostics so intervention metrics do not depend on truncated
human-readable strings.

When no eligible relevant record survives, retrieval returns empty canonical
result groups and an explicit abstention explanation.

Evidence diversity uses workspace plus source locator as a source-lineage key.
One source artifact may occupy at most one evidence slot, with higher score and
newer capture time winning.

See:
- `docs/architecture/parameter-memory.md`
- `docs/architecture/support-graph.md`
- `docs/adr/0011-unicode-retrieval-normalization-and-shadow-gating.md`
