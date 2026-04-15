# Case Refresh Runbook

## Purpose

Explain how ECITR autonomously distills canonical evidence into staged case packets and draft case records.

## Core Rule

Case refresh is ECITR-native and draft-only.

It does not approve or activate cases.

## Runtime Command

Run the autonomous case distiller against the local catalog:

```bash
npm run refresh:cases
```

Dry run:

```bash
npm run refresh:cases -- --dry-run
```

## Current Source Scope

The first autonomous distiller supports evidence payloads that already look like structured run records.

Today that means evidence with explicit:

- `objective`
- `steps_completed`
- `findings`

Unsupported evidence, including unconstrained chat transcripts, is skipped rather than normalized.

## Output

Case refresh writes:

- staging packets under `staging/case-compilation-packets/`
- draft canonical cases under `cases/`

Drafts may carry `open_questions` when the source evidence does not expose complete case framing.

## Review Boundary

- draft cases remain non-retrievable by default
- activation still requires explicit review
- non-draft cases must be complete and may not retain unresolved `open_questions`
