# Archival note

Archived with `--skip-specs`: this change's spec deltas had drifted behind
`openspec/specs/` because later changes (e.g. protection-response-shape work)
already merged overlapping requirement text into the main specs before this
one was archived. Verified manually that the target requirements/scenarios
this change intended (e.g. "Protection success is a closed object, confirmed
by exact numeric equality" in `abi-position-management-api`) are already
present in the current main specs. No scenario content was lost; only the
automatic delta-merge step was skipped because it would have been redundant
and the CLI's own drift check flagged it as unsafe to auto-apply.

Task list is fully complete (all items checked). Live evidence for this
change's rollout acceptance is as recorded in its own tasks.md — see that
file for exactly which claims are live-proven versus automated/integration-
proven; this note does not add or assert new evidence beyond what tasks.md
already states.
