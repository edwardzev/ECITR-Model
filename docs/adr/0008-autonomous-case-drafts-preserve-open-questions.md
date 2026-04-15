# ADR 0008: Autonomous Case Drafts Preserve Open Questions

## Status

Accepted

## Context

ECITR now owns enough canonical evidence to distill draft cases automatically.

However, much of that evidence does not expose every case framing field explicitly.

If the autonomous distiller fabricates missing fields just to satisfy the case schema, the cases layer stops being auditable.

If it refuses to write anything until every field is explicit, the cases layer cannot become operational from the existing evidence corpus.

## Decision

Autonomous case distillation may produce partial `draft` cases.

Missing framing must be preserved as explicit `open_questions`.

Activation remains strict:
- only reviewed cases may become active
- non-draft cases must carry complete framing
- approved or active cases may not retain unresolved `open_questions`

Compilation packets remain explicit staging artifacts and are written to local staging storage before draft case persistence.

## Consequences

- ECITR can autonomously generate reviewable draft cases from canonical evidence
- the system does not fabricate `failure_mode` or applicability where the source does not state them
- reviewers get a concrete backlog instead of conversational case proposals
- retrieval authority remains clean because incomplete drafts do not become active automatically
