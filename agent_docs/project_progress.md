# Project Progress

## Goal and Scope

Redesign the Planner and Leagues UI around a pitch. The squad shows as a pitch,
with a table view as the alternative. The market is a dense dark table. Phones
get a bottom tab bar and one screen per tab. The design follows
`docs/superpowers/specs/2026-10-06-pitch-ui-redesign-design.md`. Squad rules,
calculations, the optimizer, and the saved state do not change.

## Current Position

Tasks 1–13 of `docs/superpowers/plans/2026-10-06-pitch-ui-redesign.md` are done
on branch `worktree-ui-pitch-redesign`. The four delivery stages are
foundations, squad, players, and leagues.

Next: the controller's final pass, then the user's manual testing. A pull
request waits until the user approves.

## Verification

At Stage 4 (Task 12): 744 unit tests pass, typecheck is clean, and lint has
0 errors and 5 warnings in files this branch does not touch. Playwright passes
116 of 117. The one failure, `tests/e2e/fpl-terminal.spec.ts:371`, also fails
on the unmodified base commit.

## Next Milestone

The user approves the redesign after manual testing. Then the branch goes up as
a pull request.
