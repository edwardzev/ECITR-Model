# 2026-04-11 Case Amendment Surface

## Summary

Implemented the missing operator step between draft case generation and approval.

Draft cases can now be completed through an explicit amendment surface instead of relying on silent overwrites or premature approval attempts.

## What Changed

- added a dedicated `case_amendment_packet` schema and fixture
- added a file-backed store for staged amendment packets under `staging/case-amendment-packets/`
- added `review:cases amend` to revise draft cases in-place as the next `case_version`
- reset amended drafts back to `review_state=draft`
- exposed amendment history in `review:cases show`
- documented the amendment flow in the review and lifecycle docs

## Scope Notes

- amendment is limited to draft case framing fields
- evidence refs remain unchanged during amendment
- amendment does not auto-approve a case
- amendment remains explicit operator authorship, not autonomous distillation
