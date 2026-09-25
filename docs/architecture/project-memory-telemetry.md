# Project-memory telemetry

This derived telemetry contract extends the existing invocation store. It does
not change canonical records, retrieval ranking, selected-record eligibility,
retrieval-skip enforcement, or model defaults. The Orchestrator execution-loop
entry and the existing search/skip CLI wrappers are instrumented producers.

## Opportunity and attempt identity

A new invocation has a nested `telemetry.schema_version: 2`, validated against
`schemas/project_memory_telemetry_v2.schema.json`. Version 1 keeps its unchanged
`schemas/project_memory_telemetry.schema.json` contract. The outer invocation
remains version 1 so old fields and selected-record receipts keep their meaning.
Old artifacts and anchors retain their version without backfill. `logConsultation` remains a post-execution
compatibility surface and explicitly cannot prove a pre-decision opportunity
or an instrumented attempt duration.

`beginTaskOpportunity` uses literal workspace ID, workspace root, catalog root,
task ID and an existing lifecycle identity. Precedence is `episode_id`, then
`session_ref`, then `run_ref`. Task titles and thread IDs are not episode IDs.
Optional joins cannot alter a supplied higher-priority episode identity.
Callers must use the same identity source throughout that episode; supplying a
new episode identity identifies new work. Missing lifecycle identity creates an
explicit `unjoined_boundary` and a fresh ID, rather than conflating every use of
the same task/thread. Absent context stays null with a reason. These fields
declare identity; their presence alone does not prove an exact source join.

Version 2 adds `opportunity.attribution`: `status` is `absent`, `unresolved`,
`invalid` or `verified`, with a bounded `reason` and `checked_at`. The existing
source map's `agent_ops_registry_path` identifies the owner of canonical
`memory/sessions/YYYY/MM/session_*.json` references. The runtime preserves the
supplied reference exactly, checks the filename against the stored `id`, checks
the literal `project_id` against one registry entry, and checks a supplied
`thread_ref`. No alias, bare-ID expansion, nearest-session search, arbitrary URL
or native-thread inference is performed. A missing session is unjoined; a bare
ID is invalid. Failed attribution does not change the consult/skip policy.

`task_project_id` comes from the session. `retrieval_workspace_id` comes from
the marker and is not replaced by that task project. Their observed relation is
`same_workspace` or `cross_workspace`. An unequal pair needs the caller's
explicit `task_workspace_relation: cross_workspace` declaration; an absent
declaration is unresolved and a contradictory one is invalid. This verifies
source metadata and matching declarations, not the business appropriateness or
authorization of the cross-workspace work. No redundant task-project CLI input
is needed for a canonical session.

`source_map`, `registry`, `session` and optional `run` source descriptors retain
the exact reference and SHA-256 of inspected bytes, plus only relevant identity
fields. All reads are local, bounded to 1 MiB each, regular-file only, reject
symlink/path aliases, and check stable bytes during capture. A supplied canonical
run reference must match the session's `run_ref`, the run's `session_ref` and
project, and non-missing thread identities. Missing thread/run metadata stays
missing; an active session receives no invented outcome. No business bodies are
copied into telemetry.

Before reusing an anchor, the producer checks supplied immutable episode,
session, thread, task and workspace-relation declarations, plus observed stable
session identity. Conflicts fail before changing its telemetry. A later optional
run reference may be source-checked but cannot rebind the stored anchor. Hashes
are capture-time provenance: a normal session closeout may change source bytes
without changing the stable ID/project/thread relation. Existing version 1
anchors remain attribution-unverified and are never silently upgraded.

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
attempt durations are not wall-clock duration or user-active time. Recorded
elapsed intervals can include scheduling delay and machine suspension; they are
not CPU time and must not be automatically subtracted or reinterpreted without
separate evidence.

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

References remain optional. Missing references do not reject an otherwise valid
usage callback. Guidance asks callers to include a decision/output reference
when memory materially influenced work, and reports expose reported-use callbacks
and IDs without complete references.

Reports distinguish returned IDs, content preparation, reported inspection,
reported use, evidence-link declarations, independently corroborated use and
measured benefit. The last two remain unavailable until an independent verifier
and matched outcome evaluation exist. An empty callback, reported no influence,
and no recorded callback are different states. Receipt preparation does not
prove attention, host delivery or influence.

The reader's compact `application_review` guidance asks the caller to compare
current task facts with inclusion and exclusion conditions. Use the existing
decision or output reference to distinguish a specific supported application,
a broad analogy, and a rejected application. No new form, classification input
or automatic semantic evaluator is introduced. For example, a case about a
data-seed selector can inform row-effect verification of another data seed. An
explicit schema-only exclusion rules out applying that case to a schema-only
migration; reusing its broad verification idea is an analogy. An analogy may be
reported as influential, but cannot become demonstrated case application.

Derived `usage_followthrough.application_review` lists
`prepared_used_record_ids` and
`used_record_ids_without_available_read_receipts`. Preparation means available
at receipt time only, not current eligibility or semantic application. Its
`specific_application` and `measured_benefit` remain unavailable. The report's
`use_stages.specific_application` likewise stays unavailable regardless of
receipt, inspected-ID or reference coverage. References are not followed, and
legacy callbacks without receipts remain accepted. Inspected but rejected
records may retain selected/inspected IDs with no used IDs. Empty and explicit
no-influence callbacks remain supported.

## Reporting and coverage

Report version 3 groups versioned opportunities and counts attempts separately.
`declared_lifecycle_task_opportunities` preserves the count with supplied lifecycle
identity. `joined_task_opportunities` now counts only source-verified version 2
attribution; `unjoined_task_opportunities` includes all other opportunities.
`episode_attribution.by_status` separates verified, absent, unresolved, invalid,
legacy-unverified and conflicting snapshots. This is source-metadata coverage,
not task-outcome or business-intent verification. Version 1 remains readable and
contributes its existing invocation/attempt/usage facts without acquiring a
source-verified attribution claim.
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

The additive `usage_followthrough` report contains
`missing_callback_invocations` and `missing_use_reference_invocations`, with
literal workspace/catalog/opportunity/invocation/attempt identities and missing
used-record references. Its scope is the loaded, accepted invocation population;
it cannot enumerate absent artifacts. A callback on a later sibling attempt does
not satisfy an earlier attempt. Producing the report performs no callbacks or
reference repair.

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
`--retry-of`, plus `--task-workspace-relation same_workspace|cross_workspace`.
Use the exact `session_ref` returned by `open_memory_session`, including its
`memory/sessions/YYYY/MM/` path and `.json` suffix; a bare `session_...` ID is not
resolvable context. Use existing literal lifecycle references; do not create a second
tracking ID just for telemetry. No-consult also accepts `--query` and `--trigger`
so shadow observation uses the actual task/trigger. A search failure that reached
the producer returns the persisted invocation identity in its error envelope.

As an explicit convenience, `--session-file` selects the exact absolute path of
an existing canonical session under the configured owner root. It derives the
canonical session reference and stored thread reference from that one file,
then uses the existing owner/session/project attribution checks. It rejects
relative paths, traversal, symlinks, files outside the owner layout, malformed
identity and conflicting explicit flags before artifact creation. It does not
scan sessions, infer a current thread, create a sidecar, change owner routing or
choose a newest session. Missing stored thread identity remains null. An explicit
cross-workspace declaration is still necessary for unequal projects; no lane,
run outcome or business authority is inferred. Current direct flags retain their
existing behavior, including visible invalid/unresolved attribution. Conflicting
repeated telemetry options are rejected rather than letting their order erase an
earlier identity or audit boundary; identical repeats are accepted.

Search/skip responses now expose compact `episode_attribution` status/reason and
literal identities. `usage_followthrough` gives the exact invocation/attempt
target and `missing`, `recorded` or `not_applicable` callback state. The callback
response additionally lists used record IDs missing decision/output references.
These are derived response fields, not new persisted ledgers or enforcement.

Usage accepts `--inspected-record-ids`, `--use-evidence-file` (the bounded array
of reference declarations described above), and repeatable `--use-evidence`
JSON objects with the same fields. Inline objects are bounded to 8 KiB each;
combined links retain the existing 100-link and per-field limits. File and inline
entries are combined without inventing associations or following references.
Existing search, selected-reader and empty-usage callbacks remain supported.
No additional callback is required for reading or telemetry collection.

Tests may inject `telemetrySourceMapPath` into `ProjectMemorySurface` to use an
isolated owner fixture. CLI wrappers keep the existing checkout source-map route;
there is no new arbitrary owner-root CLI override. See [ADR 0013](../adr/0013-project-memory-episode-attribution.md)
and [ADR 0014](../adr/0014-project-memory-workflow-followthrough.md).
