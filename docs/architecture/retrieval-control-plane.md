# Retrieval Control Plane

## Purpose

Define retrieval as an explicit control plane rather than a vague search step.

Retrieval is responsible for deciding:
- what kind of request is being handled
- which layers are eligible
- how many candidates each layer may contribute
- how conflicts and staleness are treated
- how results are explained back to the caller

## Workspace Visibility Rule

Retrieval should not depend on an agent remembering that a corpus exists.

In the current discretionary phase, a workspace may expose project memory through a visible runtime affordance backed by `ecitr.project.json`.

That phase is intentionally weaker than mandatory preflight:
- memory is visible
- memory is callable through an explicit named surface such as `search_project_memory`
- marker-driven requests carry the workspace's explicit `workspace_id`
- invocation is logged
- consultation remains discretionary unless workspace policy later tightens

When a matching local LanceDB table exists, `search_project_memory` may use it as
the semantic lane's derived local backend. If the table is absent, or the catalog
does not match the default local index, project memory falls back to the
file-backed heuristic semantic backend.

Nearest-neighbor presence is not relevance proof. Until a backend-specific
threshold is calibrated by golden retrieval scenarios, vector-only LanceDB
candidates fail closed unless lexical or metadata lanes corroborate them.

This does not change the control-plane contract:
- the catalog remains canonical
- LanceDB remains a derived index
- invocation artifacts are still written for auditability
- LanceDB is the only supported derived semantic backend

## Shadow Retrieval Gate

The project-memory surface evaluates `ecitr-conservative-shadow-v1` when a
retrieval request is already being executed. The gate emits:

- a proposed `retrieve` or `skip` classification
- the policy-effective decision
- a reason, confidence, and bounded evidence labels
- a query-usefulness assessment
- whether mandatory workspace policy overrode a proposed skip

This gate is observation-only:

- `mode` is `shadow`
- `enforcement` is `disabled`
- `actual_behavior` is `retrieve_always`
- a proposed skip cannot suppress an explicit project-memory search or runtime
  intervention
- the gate does not create a retrieval request for a task that did not already
  request retrieval

Mandatory `preflight` and `failure_retry` policy in `ecitr.project.json` always
produces an effective `retrieve` decision for the matching trigger. Gate output
is stored only in the existing derived memory-invocation artifact; it does not
become a canonical record.

Enforcement requires a separate retrieval-class decision backed by labeled live
shadow observations. Constructed benchmark success is not sufficient to let the
gate suppress retrieval.

## Audit Mode Write Boundary

`search_project_memory` is not a pure filesystem read in the current runtime.
Consultation writes derived invocation artifacts so later usage can be audited.

Audit behavior:

- In `strict no-write audit`, do not call `search_project_memory` if invocation
  artifact creation would violate the user's write boundary. Report the conflict
  instead.
- In `controlled read-only discovery audit`, invocation artifacts are allowed
  when retrieval is required or explicitly useful, but the final report must
  disclose that ECITR wrote derived invocation artifacts.
- A workspace with mandatory preflight or failure-retry retrieval cannot be
  fully audited in strict no-write mode when the audit requires retrieval, unless
  a separate no-log retrieval path is implemented and approved.

## Control Flow

`request -> classify -> plan -> candidate generation -> rank -> fuse -> conflict check -> explain -> return`

## Step Contracts

### 1. Classify

Determine:
- intent
- workspace identity
- scope
- urgency
- whether current-action guidance is needed
- whether proof or audit evidence is required

### 2. Plan

Choose:
- allowed layers
- per-layer result budgets
- freshness strictness
- whether evidence retrieval is needed immediately or only on escalation

### 3. Candidate Generation

Use layer-appropriate engines:
- tactics and invariants may use structured indexes
- cases may use similarity or hybrid retrieval
- evidence may use MemPalace or another recall substrate

Candidate generation may differ by layer, but canonical records remain engine-neutral.

Candidate generation must be relevance-bearing. Planner proof requirements,
recency, and graph adjacency may not create a candidate by themselves.

### 4. Rank

Combine:
- layer priority
- scope match
- applicability
- evidence support
- outcome quality
- freshness
- duplication penalty
- conflict penalty

### 5. Fuse

Return a layered result, not a flattened bag of matches.

Default presentation order:
1. tactics
2. invariants
3. cases
4. evidence

### 6. Conflict Check

Explicitly detect:
- stale tactics that contradict newer evidence
- invariants unsupported by current cases
- cross-project leakage
- cross-workspace leakage when a request carries `workspace_id`
- duplicated matches masquerading as independent support

### 7. Explain

Every retrieval response should state:
- why the top records were surfaced
- which layers were consulted
- which conflicts or exclusions were applied
- when retrieval abstained because no eligible relevant record matched

## Default Budgets

These are planning defaults, not hard constants:
- tactics: 3 to 5
- invariants: 5 to 8
- cases: 5 to 10
- evidence: 3 to 5

Evidence is not the default flood surface.

## Non-Goals

- making retrieval responsible for semantics
- forcing one backend choice for all layers
- assuming one benchmark can stand in for the full memory system
- assuming corpus usage will happen reliably without explicit runtime visibility and metrics

## Review Rule

Any retrieval control-plane change is a retrieval-class change under `docs/change-control.md`.
