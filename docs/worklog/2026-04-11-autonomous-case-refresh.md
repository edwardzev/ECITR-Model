# 2026-04-11 Autonomous Case Refresh

## Summary

Implemented the first ECITR-native cases runtime.

The new path distills supported canonical evidence into explicit staging packets and draft case records without relying on `agent-ops` at runtime and without bypassing the review gate.

## What Changed

- relaxed the case and case-compilation-packet schemas so draft records may preserve unresolved framing as `open_questions`
- tightened lifecycle rules so only complete, approved cases may become active
- added a file-backed staging packet store for case compilation packets
- added `refresh:cases` to distill structured run evidence into staged packets and draft cases
- added `refresh:autonomous` to chain Codex evidence refresh and case drafting for nightly ECITR-owned operation
- repointed the launchd scheduler surface to the autonomous refresh command
- documented the new cases runtime and the open-question draft policy

## Scope Notes

- the first autonomous distiller supports structured run-shaped evidence only
- chat evidence remains in the evidence layer until a truthful case-framing strategy exists
- case activation remains an explicit review decision
