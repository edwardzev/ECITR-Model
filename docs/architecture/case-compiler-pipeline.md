# Case Compiler Pipeline

## Purpose

Define how ECITR turns evidence-backed compilation input into reviewable case records without letting agents write active cases directly.

## Core Rule

Cases are compiled from explicit packets.

They are not written directly from freeform agent output.

The pipeline is:

`evidence selection -> compilation packet -> draft case -> review -> active case`

When a draft lacks applicability, the bounded completion path extends that flow to:

`draft case -> completion packet -> amendment packet -> reviewed draft -> active case`

When a draft lacks an explicit bounded failure boundary, the recovery-aware completion path is:

`draft case -> boundary recovery packet -> completion packet -> amendment packet -> reviewed draft -> active case`

## Why This Exists

Without a compiler pipeline:
- agents can skip provenance
- case fields become inconsistent
- review disappears into chat history
- direct writes blur the line between extraction and accepted experience

## Compilation Packet

A compilation packet is a staging artifact that:
- points to one or more evidence refs
- supplies the structured framing needed for a case
- remains separate from the final case record

The packet is not canonical memory.

It is a controlled input to the compiler.

Autonomous distillers may write packets into a local staging area before compiling them.

## Initial Implementation Boundary

The current Step 4 implementation uses one explicit compilation packet as the staging input.

That means ECITR currently collapses:
- evidence selection
- structured framing
- claim extraction decisions

into one reviewable packet boundary.

This is acceptable for the first compiler because:
- provenance remains explicit through evidence refs
- the compiler still cannot publish active cases directly
- a later atomic-claims stage can be added without changing case authority

## Draft Case Rules

The compiler may create only:
- `status: draft`
- `review_state: draft`

The compiler must not directly create active cases.

Drafts may be partial when the source evidence does not expose every framing field explicitly.

Partial drafts must preserve the missing material as explicit `open_questions` instead of fabricating fields.

## Review Gate

The review flow is explicit:

1. compile packet into a draft case
2. review the draft
3. mark the draft as reviewed
4. activate only after approval

## Compiler Responsibilities

The compiler must:
- require evidence refs
- require enough explicit source material to justify a draft
- validate the input packet
- validate the resulting case record
- apply lifecycle checks before returning the draft

Current autonomous distillation may safely map structured evidence into:
- `problem_statement`
- partial `context`
- `action_taken`
- `outcome`
- optional `failure_mode`
- `open_questions`

Activation remains the point where complete framing is mandatory.

Later versions may add:
- source span capture
- atomic claim extraction
- similarity features for retrieval-oriented reuse

The current bounded completion path already requires:
- explicit extracted facts
- explicit extracted boundaries
- deterministic boundary recovery before completion when the draft has no explicit bounded failure boundary
- support-linked applicability suggestions
- amendment before approval

## Compiler Non-Responsibilities

The compiler does not:
- rewrite evidence
- decide invariant promotion
- decide tactic promotion
- define retrieval policy

## Research Rule

External methods may improve extraction quality or ergonomics, but they must still terminate in:
- a compilation packet
- a draft case
- a review gate

So external tooling may change how packets are prepared.

It may not bypass the ECITR case contract.
