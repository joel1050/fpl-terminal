# Project Progress

Deployment `b_fixes_20260917` is complete.

## Goal and Scope

Implement the five pre-traffic B fixes in `plans/README.md`: protect forced
bootstrap refreshes, bound process-lifetime Maps, preserve refused saved state,
declare compute-route duration limits, and identify upstream FPL requests.

## Current Position

Forced bootstrap refreshes are limited to three per client per minute before
upstream or projection work; ordinary cached reads remain unrestricted. The
rate bucket and FPL memory Maps are capped at 1,000 entries with expiry or LRU
eviction. Rejected malformed/newer saves remain byte-for-byte intact, block
writeback, and show recovery guidance in Planner and Leagues until reset or a
compatible replacement.

The optimizer, best-XI, transfer-suggestions, and chip-suggestions routes now
declare a 30-second maximum duration. Official FPL fetches send a descriptive
`FPL-Terminal/0.1` User-Agent with the public repository URL.

## Verification

The full unit/integration corpus passes serially at 79 files and 650 tests.
Typechecking and the production build pass; the build retains five existing
dynamic-filesystem tracing warnings. Focused B lint has zero errors and two
pre-existing TerminalApp unused-variable warnings. The focused persistence
browser suite passes 2/2 and proves both workspaces preserve a refused save and
that a compatible import resumes persistence.

The default parallel `npm test` and one broad lint attempt hung while stale
verification workers were present; stale project-local processes were removed,
and the serial full corpus plus focused lint completed successfully.

## Next Milestone

Review and commit the combined pre-launch A/B diff. The RotoWire publication
decision remains open before the public link is shared.
