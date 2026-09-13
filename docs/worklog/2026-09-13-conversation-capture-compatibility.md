# Codex conversation capture compatibility

## Change packet

Status: implementation accepted and bounded live backfill verified. The task delivery receipt records source publication and canonical capture-path verification separately.

Owner: Orchestrator; implementation by the Evidence Steward; independent Governance and QA review.

Affected layer: Evidence and its derived local import-state metadata. Change class: Migration, because compatibility and fingerprint-state expectations change. Canonical Evidence schema, identity authority, reviewed knowledge and retrieval policy remain unchanged.

### Motivation

The native importer recognizes legacy printed `user_message` and `agent_message` events. Current Codex rollout streams can instead represent printed messages as typed completed items. The legacy parser returns zero visible messages for such sources, and the local fingerprint cache can suppress reconsideration on later refreshes. Successful process execution therefore does not establish successful conversation capture.

### Accepted direction

- Preserve legacy printed-event payloads and IDs where the original capture was valid.
- Preserve current completed user and assistant body text exactly and in source order. Do not substitute internal model-input projections for printed conversation text.
- Use explicit message and thread identity to distinguish projections, inherited context and legitimate repeated messages. Unsupported or ambiguous associations remain visible coverage gaps.
- Preserve available source identity, phase provenance and citation metadata for the new representation. Recognize final-answer checkpoints without changing the existing checkpoint policy.
- Report excluded nontext content. Body-text fidelity is distinct from preservation of attachments or every UI feature.
- Version derived parser/fingerprint compatibility so old skipped sources are reconsidered without overwriting immutable evidence or clearing unrelated history.
- Provide an exact, hash- and thread-bound source manifest for controlled backfill. Validate all selected source boundaries and capture plans before writes; process the same source bytes that passed preflight.
- Distinguish capture coverage from process success. Cached gaps, unsupported sources, exclusions and committed results remain attributable.

### Scope and authority

The user approved mapping the gaps, repairing the importer, bounded exact backfill, integrity verification, publication and verification of the active capture process. This permits the stated Evidence repair and delivery; it does not authorize a change to retrieval policy, case/invariant/tactic promotion, native log rewriting or a blanket catalog migration.

Live backfill is limited to a recorded manifest of confirmed affected sources. A source with ambiguous identity, incompatible existing immutable content or an unverified source boundary is excluded with its reason. Existing catalog records and payloads are preserved.

### Risks and validation

Relevant risks are duplicate projections, injected-context capture, lost clarification prompts, inherited parent content attributed to a child, missing historical phase metadata, silent nontext loss, unchanged-file suppression, partial writes and misleading successful-job status.

Validation requires legacy/current/mixed synthetic regressions, exact Unicode/whitespace and repeated-message checks, unsupported and malformed-source checks, manifest path/hash/thread/whole-batch preflight tests, fingerprint migration and idempotence tests, and full repository checks. Independent review must accept the concrete implementation before delivery.

A live preservation baseline covers all existing Evidence record and payload hashes, plus canonical cases, invariants and tactics. A source inventory establishes the expected candidates without treating every uncaptured file as eligible. Bounded dry-run and stored-payload readback must reconcile expected source messages, identities, hashes and per-source outcomes. Repeating the same accepted source boundary must not create duplicates.

### Rollback and recovery

Code can be reverted through the normal reviewed source-delivery path. This does not undo immutable Evidence already captured. Do not delete or rewrite new evidence to simulate rollback. Retain the exact manifest, source/result identities and committed/uncertain outcomes; inspect current state before resuming an interrupted batch. Incompatible prior evidence requires a separately specified correction, not automatic replacement. Preserve unselected import-state entries.

### Documentation impact

Update the canonical conversation-evidence runbook with the supported representations, fidelity boundary, fingerprint compatibility, bounded manifest usage, coverage interpretation and recovery procedure. Keep historical delivery claims in this worklog separate from the current operating contract.

## Delivery evidence

- Evidence Steward format review accepted the printed-item authority and explicit context, ancestry, phase and nontext boundaries. Governance and QA accepted the final implementation after two formal revision rounds.
- Review intercepted response-only body substitution, ambiguous mixed deduplication, selected-import case-seed writes, ledger preservation/version gaps and a legacy visible-body compatibility bypass. The final code reports incompatible prior snapshots as `repair_required`, including when revised extraction has zero visible messages.
- Final focused suite: 40 passed. Required `npm run check`: fixtures valid; 456 passed, zero failed or skipped. `git diff --check` passed.
- Read-only native inventory at the recorded baseline: 1,759 files, 180 without a prior conversation snapshot; 176 of those contain current completed messages. This inventory is not a claim that every uncaptured source is eligible.
- An initial mixed selection rejected two ambiguous older sources and marked the supported peer not attempted before any writes. The executed selection was restricted to three supported parent tasks with exact path, thread and source-hash bindings.
- Live backfill verified on 2026-09-13: three new snapshots containing 244 printed messages (10, 15 and 219). Independent extraction matched every stored ordered message, timestamp, phase and provenance record; source-boundary and payload hashes matched.
- Preservation readback verified all 18,327 prior Evidence payloads and all 18,977 prior canonical records unchanged, plus 1,742 unselected checkpoint entries unchanged. Existing payload verification hashed 267,857,802 bytes at baseline.
- The two source files still unchanged after capture were replayed with zero new imports. The active task source had grown, so its old full-file manifest was not reused or described as an unchanged-file replay.
- No overlapping capture process was observed immediately before the controlled write. Selected capture suppressed case-seed linking. No full autonomous live refresh or higher-layer promotion was run as part of verification.

The task's metadata-only receipts retain the inventory, accepted source hashes, test log, exact source manifest, per-source capture results and independent preservation readback. The installed scheduler loads the canonical repository on each run; source activation is verified after publication through that same repository's capture entry point. The next scheduled full refresh is a separate observation.

This closes the bounded compatibility-and-capture contract. Historical sources with ambiguous input projections, inherited attribution or unsupported content remain explicit coverage gaps. Attachment fidelity, cross-host/cloud coverage, backup retention and complete historical capture are not established by this batch.
