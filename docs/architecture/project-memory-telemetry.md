# Project-memory telemetry

This derived telemetry contract extends the existing invocation store. It does
not change canonical records, retrieval ranking, selected-record eligibility,
retrieval-skip enforcement, or model defaults. The Orchestrator execution-loop
entry and the existing search/skip CLI wrappers are instrumented producers.

## Opportunity and attempt identity

A new invocation has a nested `telemetry.schema_version: 1`, validated against
`schemas/project_memory_telemetry.schema.json`. The outer invocation remains
version 1 so old fields and selected-record receipts keep their meaning. Old
artifacts are read without backfill. `logConsultation` remains a post-execution
compatibility surface and explicitly cannot prove a pre-decision opportunity
or an instrumented attempt duration.

`beginTaskOpportunity` uses literal workspace ID, workspace root, catalog root,
task ID and an existing lifecycle identity. Precedence is `episode_id`, then
`session_ref`, then `run_ref`. Task titles and thread IDs are not episode IDs.
Optional joins cannot alter a supplied higher-priority episode identity.
Callers must use the same identity source throughout that episode; supplying a
new episode identity identifies new work. Missing lifecycle identity creates an
explicit `unjoined_boundary` and a fresh ID, rather than conflating every use of
the same task/thread. Absent context stays null with a reason.

The first existing `meminv` is the opportunity anchor and first attempt. Its
path is `memory-invocations/anchors/v1/meminv_opportunity_<hash>.json`, independent
of the call date; subsequent attempts use the existing dated paths. All records
use the same invocation owner, reader, lock and report. There is no second task
ledger and no extra agent logging step. Atomic link publication and exclusive
updates prevent competing processes from replacing the anchor. Retries retain
separate invocation and attempt IDs, requests, returned records and read
receipts under the shared opportunity. A caller may declare `retry_of`; missing
retry ancestry is not invented.

The anchor is persisted pending before internal consult/skip dispatch. Direct
search and no-consult wrappers receive an action the external agent has already
selected. Their boundary is `caller_selected_before_dispatch`; it proves neither
observation nor timing of that earlier agent choice. Only the instrumented
`OrchestratorExecutionLoop.run` entry records `before_decision`, before that
executor chooses its own branch. Native external-agent choice coverage remains
unavailable. An existing caller-selected anchor is never retroactively relabeled
by a later executor call.

Exactly one shadow gate observation is recorded in the anchor, using the
explicit query or labeled task objective/title. Query input is hashed in this
new metadata. Gate evaluation, proposed decision, effective mandatory policy
and actual consult/skip outcome are separate. A no-consult outcome is never
reported as `retrieve_always`. The classifier remains shadow-only. Missing
input or gate failure remains an explicit coverage gap.

A resolved consult and skip cannot contradict each other within one opportunity.
A rejected mandatory skip is recorded `blocked`; an actual consultation can
subsequently satisfy that requirement. Mandatory preflight and failure-retry
rules remain binding. Explicit `micro` and `strict_no_write` / `strict no-write
audit` contexts create no invocation artifact. CLI search/skip require a real
workspace marker and matching explicit selectors; configuration failure reports
a capture gap without writing to a fallback workspace.

## Attempts and measurement

Consultation starts a durable `running` attempt before catalog loading and
retrieval. Successful, failed and observed cancelled paths record a terminal
state; unexpected process termination leaves `running` with no fabricated
terminal time. Error capture contains bounded codes, not backend messages or
business bodies. Abort before execution is observed cancellation; the runtime
does not promise to cancel a backend that does not support cancellation.

`duration_ms` uses a monotonic clock around instrumented execution. Catalog
load, corpus fingerprint and retrieval phases are separately measured. Initial
artifact creation and terminal persistence are outside that duration; external
workflow measurements must include their cost. Gate duration belongs to the
opportunity. Phase durations are not model tokens and summed overlapping
attempt durations are not wall-clock duration or user-active time.

Corpus hashes use `ecitr-structural-json-v1` over the loaded catalog snapshot.
The shared search factory observes its actual backend ID and, where present,
embedding signature and a bounded local index-basis hash. A basis-file hash
identifies that observed file; it is not independent proof that every index row
was used. Custom runtimes and the intervention passthrough may leave these
fields unavailable. No missing field is filled from configured model defaults,
lexical token counts, inferred prices or zero. Project-memory model usage and
cost remain unavailable because this runtime does not expose them.

## Use evidence

The existing callback supports `inspectedRecordIds` and `useEvidence`, an array
of `{record_id, decision_ref?, output_ref?, support_ref?, reviewer_ref?}`. A link
requires a decision or output reference and a returned ID reported used by that
callback. Strings are declarations: even a reviewer reference cannot set
corroborated use. No referenced file, URL or business output is followed by the
callback. New metadata has bounded strings/lists and rejects invented verified
fields. Callback writes preserve selected-record preparation receipts.

Reports distinguish returned IDs, content preparation, reported inspection,
reported use, evidence-link declarations, independently corroborated use and
measured benefit. The last two remain unavailable until an independent verifier
and matched outcome evaluation exist. An empty callback, reported no influence,
and no recorded callback are different states. Receipt preparation does not
prove attention, host delivery or influence.

## Reporting and coverage

Report version 2 groups versioned opportunities and counts attempts separately.
Shadow observations are split into `pre_decision_observations` (instrumented
executor choice only) and `caller_selected_before_dispatch_observations`.
`observed_opportunities`, proposed skips and mandatory overrides retain all
observed gate data. `external_agent_choice_coverage` is null with the reason
`native_agent_decision_boundary_not_observed`; a direct wrapper observation
cannot fill that missing population.
`legacy_compatibility.task_opportunities` retains the old invocation proxy for
comparison; legacy artifacts are excluded from the new task denominator.
Unavailable/unsupported metadata remains a coverage gap. Reported use is never
renamed actual use or benefit.

Exact duplicate deliveries deduplicate. Compatible pending-to-terminal and
receipt-superset snapshots can progress. Contradictory immutable identities,
terminal results, callbacks, receipt contents or incomparable snapshot forks
are quarantined and listed, rather than choosing whichever timestamp is newer.
Conflicting repeated attempt IDs are excluded from attempt and usage metrics.

A report cannot enumerate tasks that never entered an instrumented boundary.
Optional `--population-file` supplies a versioned JSON manifest with
`schema_version: 1`, `enumeration_ref`, `opportunities` (exact workspace ID,
catalog root and opportunity ID), and a structural `sha256` of that array.
The report verifies the hash/context, lists missing and orphaned opportunities,
and explicitly leaves the manifest's independence for external review. A
caller-supplied count or artifact population is not full-system coverage proof.

## Existing CLI workflow

Search and no-consult wrappers accept `--episode-id`, `--thread-ref`,
`--session-ref`, `--run-ref`, `--lane`, `--audit-mode`, `--decision-reason` and
`--retry-of`. Use existing literal lifecycle references; do not create a second
tracking ID just for telemetry. No-consult also accepts `--query` and `--trigger`
so shadow observation uses the actual task/trigger. A search failure that reached
the producer returns the persisted invocation identity in its error envelope.

Usage adds `--inspected-record-ids` and `--use-evidence-file` (the bounded array
of reference declarations described above). Existing search, selected-reader
and empty-usage callbacks remain supported. No additional callback is required
for reading or telemetry collection.
