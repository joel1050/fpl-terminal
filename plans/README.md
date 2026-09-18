# Pre-launch sweep — FPL Terminal

Written 2026-09-17 against `540dd80`. Successor to `LAUNCH.md` (2026-09-03); items
5, 2, 3 and 4 there are done and are not repeated. A1–A6 below were implemented
and verified on 2026-09-17; the original findings and evidence are retained for
context.

## Baseline, measured

- `npm test` — 642 passed, 77 files, 7.2s.
- `npx tsc --noEmit` — clean.
- `npm run build` — succeeds, with one tracing warning (see A2).
- `npx playwright test --list` — 51 tests in 5 files. The `--pass-with-no-tests`
  flag in the test script does not hide an empty run.

The domain engine is in good shape. Blank and double gameweeks, season rollover,
autosubs and money-in-tenths are all handled and tested. Nothing below is about
the maths.

## A — before you post the link

| # | Finding | Impact | Effort | Risk | Evidence | Status |
|---|---------|--------|--------|------|----------|--------|
| A1 | Bump Next past the advisories | `^16.3.1` already admits the patched range; one line | S | LOW | `package-lock.json` resolves Next 16.3.5 and sharp 0.35.4; production audit is clean | Implemented/verified 2026-09-17 |
| A2 | The whole repo ships inside the lambda | 258 of 575 traced files are agent notes, screenshots and tests | S | LOW | Five affected route traces retain all nine generated JSON inputs and exclude non-runtime prefixes; each has 243–251 files | Implemented/verified 2026-09-17 |
| A3 | A shared link renders no preview card | No `metadataBase`, no `openGraph` | S | LOW | `app/layout.tsx` emits canonical, Open Graph, and Twitter metadata from the deployment origin | Implemented/verified 2026-09-17 |
| A4 | A render throw is a blank page | No error boundary anywhere, no `app/error.tsx` | S | LOW | `app/error.tsx` provides a generic retry boundary | Implemented/verified 2026-09-17 |
| A5 | No way to tell one deploy from another | Every bug report is unattributable | S | LOW | Root UI renders a short commit/build stamp | Implemented/verified 2026-09-17 |
| A6 | Agent notes are public | 58 files in `graphify-out/`, plus `output/playwright/`, `agent_docs/` | S | LOW | `.gitignore` covers local artifacts; 116 cached files are staged for removal and remain on disk | Implemented/verified 2026-09-17 |

Decision, not a task: **RotoWire.** `LAUNCH.md` item 1 is still open. The public
repo still ships `data/generated/rotowire-lineups.json` and public projections
still lean on it. Posting to Reddit is what puts eyes on that.

## B — before the traffic arrives

| # | Finding | Impact | Effort | Risk | Evidence | Status |
|---|---------|--------|--------|------|----------|--------|
| B1 | `?refresh=1` is free amplification | Skips the memory cache and the CDN, forces a real FPL fetch plus a 651-player projection, no rate limit | S | LOW | Per-client limiter rejects the fourth forced refresh in a minute before fetch/projection; 429 sends `Retry-After` and `Cache-Control: no-store` | Implemented/verified 2026-09-17 |
| B2 | Two Maps that never evict | One entry per manager, league and player, for the life of the instance | S | MED | Compute limiter prunes expiry and caps 1,000 buckets; FPL cache uses a 1,000-entry LRU with stale fallback preserved | Implemented/verified 2026-09-17 |
| B3 | A refused save vanishes without a word | `parseSavedState` returns null, the squad is silently empty | S | LOW | Malformed/newer localStorage saves remain byte-for-byte intact, block writeback, and show recovery guidance; persistence browser spec passes 2/2 across Planner and Leagues | Implemented/verified 2026-09-17 |
| B4 | No `maxDuration` on the compute routes | `/api/optimizer` measured 4.5s warm | S | LOW | Optimizer, best-XI, transfer-suggestions, and chip-suggestions export `maxDuration = 30` | Implemented/verified 2026-09-17 |
| B5 | FPL sees no User-Agent | A block arrives with no way to talk | S | LOW | Central FPL client sends `FPL-Terminal/0.1 (+https://github.com/joel1050/fpl-terminal)` | Implemented/verified 2026-09-17 |

The B fixes were verified on 2026-09-17 with the full serial unit/integration
corpus (79 files, 650 tests), passing typecheck and production build, focused B
lint with zero errors, and the B3 persistence browser spec passing 2/2. The
default parallel runner is not claimed as passing evidence.

## Considered and rejected

- **Polling in a hidden tab.** Browsers already throttle background timers to
  about one a minute, and `/api/fpl/live` carries `s-maxage=60`, so the edge
  absorbs most of it. Polish, not a blocker.
- **A shared rate limiter (Redis/KV).** Caching landed since `LAUNCH.md` and
  removed most of the pressure. Fix B1 first and re-measure.

## Timing

`bootstrap` is `s-maxage=300`, so a price can be five minutes old. Do not post in
the couple of hours before a deadline.
