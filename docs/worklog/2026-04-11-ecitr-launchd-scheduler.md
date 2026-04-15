# 2026-04-11 ECITR Launchd Scheduler

## Objective

Move daily Codex refresh scheduling out of Codex app automation and into ECITR-owned runtime infrastructure.

## Changes

Added a repo-owned `launchd` helper that:

- builds the canonical daily Codex refresh job definition
- writes the plist into `~/Library/LaunchAgents`
- installs or removes the job through `launchctl`
- reports scheduler status

The job runs the repo's own `src/cli/refresh-codex.js` via the current Node binary, uses the repository as its working directory, and writes stdout/stderr logs under `.local/logs/`.

## Why

Codex app automation was sufficient for the first scheduling pass, but it kept scheduling ownership outside ECITR.

Using `launchd` makes the runtime scheduling model:

- ECITR-owned
- visible at the OS scheduler layer
- independent from Codex app automation semantics

## Verification

Verified the generated plist shape through unit tests.

Installed the `launchd` job locally and confirmed the expected plist path and service target.

## Outcome

Daily Codex refresh scheduling is now owned by ECITR runtime infrastructure rather than the Codex app automation layer.
