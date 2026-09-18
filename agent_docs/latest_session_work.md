# Latest Session Work

Deployment `b_fixes_20260917` completed on 2026-09-17.

## Implemented

- `app/api/fpl/bootstrap/route.ts` rejects the fourth forced refresh from one
  client within a minute before any FPL fetch or projection work. Normal reads
  are unchanged; 429 responses include `Retry-After` and `Cache-Control:
  no-store`.
- `lib/http/computeRateLimit.ts` retains the 30/min compute default, supports a
  scoped limit, prunes expired entries, and caps buckets at 1,000.
- `lib/fpl/cache.ts` uses a 1,000-entry LRU memory cap while preserving cache
  updates, TTL checks, and stale fallback.
- Saved-state reads distinguish missing, accepted, malformed, and newer data.
  Refused localStorage data is preserved without writeback and produces a
  recovery notice in Planner and Leagues; compatible import or reset unblocks
  persistence.
- The four heavy compute routes export `maxDuration = 30`, and the central FPL
  client sends `FPL-Terminal/0.1 (+https://github.com/joel1050/fpl-terminal)`.

## Verification

- Full serial unit/integration corpus: 79 files and 650 tests passed.
- Focused B tests cover limiter defaults/custom limits/caps, cache LRU behavior,
  pre-work bootstrap rejection, saved-state outcomes, and exact upstream
  headers.
- Typecheck and production build passed. Build output retains five existing
  dynamic-filesystem tracing warnings.
- Focused B ESLint passed with zero errors and two pre-existing TerminalApp
  unused-variable warnings.
- The two stale transfer UI assertions in `tests/e2e/fpl-terminal.spec.ts`
  were updated to the current panel wording (suggestion count and card-scoped
  dismiss label); the full `fpl-terminal.spec.ts` passes 10/10.
- `tests/e2e/persistence-guard.spec.ts` passed 2/2: Planner and Leagues preserve
  a newer save byte-for-byte, and Planner resumes persistence after a compatible
  import.
- `git diff --check` passed; verification-generated `next-env.d.ts` drift was
  restored and no project-local test server remains.

## Continuation

The combined A/B implementation is uncommitted. The separate RotoWire
publication decision remains open. Existing unrelated working-tree changes in
League UI/tests were preserved.
