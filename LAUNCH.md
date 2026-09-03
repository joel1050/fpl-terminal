# Launch checklist

Written 2026-09-03 against the live deployment at `https://chatgpt-orpin-omega.vercel.app`
(Vercel project `joel1050s-projects/fpl-terminal`, public repo `joel1050/fpl-terminal`).

Items 2, 3 and 4 are **done** — see "What changed" at the bottom. They are kept here with
their reasoning so the decisions behind them stay readable.

## What is already sound

Do not spend time here.

- `npm test` — 441 passed, 0 failed, 5s.
- `npm run typecheck` — clean.
- `npx eslint app lib components store types scripts` — clean. A bare `npm run lint`
  reports 12,148 problems because ESLint walks a stray git worktree under
  `.claude/worktrees/`. None of it is your source. See "Repo hygiene" below.
- Production loads with no console errors. `/api/optimizer` answers in 4.5s,
  `/api/best-xi` in 1.9s, `/api/fpl/bootstrap` in 0.9s gzipped.
- Every dynamic route validates its input strictly: `/^\d+$/` plus range and
  safe-integer checks on team id, league id, gameweek and page. Bodies go through
  `.strict()` Zod schemas with array caps.
- No secret was ever committed. `.env*` is ignored, only `.env.example` is in history,
  and the Vercel project has no environment variables at all.

## Blockers — settle before you tell anyone the URL

### 1. RotoWire scraping and redistribution — still your call

The name no longer reaches a browser (see "What changed"), and the deployment no longer
scrapes. Neither of those settles the question underneath.

`lib/availability/rotowire.ts:1` scrapes `https://www.rotowire.com/soccer/lineups.php`
and parses its HTML. The result, `data/generated/rotowire-lineups.json`, is committed to
a **public** repo and feeds projections served to the public.

Private use and public redistribution of a paid site's data are different things. This is
your call, not a technical fix, but make it a decision rather than an oversight. Options:

- Drop RotoWire from the public build. Availability precedence already treats negative FPL
  status as absolute, so falling back to FPL status plus historical start rates works —
  projections get looser, nothing breaks.
- Keep the fetch server-side and stop shipping the file in a public repo.
- Ask RotoWire for permission.

### 2. No affiliation notice — DONE

The mode screen now carries it, under the status line: not affiliated with, endorsed by, or
connected to the Premier League or Fantasy Premier League; data from public FPL endpoints;
projections are estimates, not advice. Still avoid Premier League and club badges.

### 3. Read-only filesystem — PARTLY DONE, one decision left

Two write paths ran against a read-only deployment filesystem. Both are fixed; the
resilience question underneath is still open.

**Fixed — the request-time lineup scrape is gone.** `autoRefreshEnabled()` returned
`process.env.NODE_ENV !== "test"`, which opts a deployed build *in*. The committed lineup
snapshot's `fetchedAt` is frozen at build time, so it passed the 24-hour staleness bar a day
after release and never came back under it. The deployment was therefore set to scrape the
lineup source from its own address every 15 minutes for ever, fail the write, and forward
the raw error to every browser in `metadata.lineups.error`.

The whole automatic path is now deleted, not gated — the max age, the retry cooldown, the
in-flight guard and the enable switch with it. `refreshRotowireLineups` remains, with
`scripts/ingestRotowireLineups.ts` as its only caller. Lineups change by hand:
`npm run data:lineups`, commit, deploy.

**Fixed — snapshot writes.** They now go to `/tmp/fpl-snapshots` on a deployed build, so
they stop throwing on every successful fetch. Be clear about what this buys: `/tmp` lives
exactly as long as the instance, same as the in-memory cache above it, so this is
warning-noise cleanup, not resilience.

**Fixed — the lineup age came back.** Gating the refresh had a side effect worth naming: the
disabled path returned no `fetchedAt` and no `ageSeconds`, so a deployed build reported
`{"refreshed":false,"reason":"disabled"}` and the freshness signal was gone. The request path
now reads the snapshot's age directly, so `metadata.lineups` carries `fetchedAt` and
`ageSeconds` again — which matters more now that the snapshot only moves when you deploy.

**Still open — the actual floor.** A cold instance with FPL down has no memory cache and no
snapshot, so users get a hard 503. The fix is a baseline snapshot committed to the repo and
read last: `data/snapshots/bootstrap.json` is 1.7 MB and `fixtures.json` is small, and
`outputFileTracingIncludes` in `next.config.ts` already has the pattern to ship them.

Decide before doing it: that is 1.7 MB more in a public repo, and it goes stale. Ship only
`bootstrap.json` and `fixtures.json` — the `entry-*` and league snapshots in that directory
are individual managers' FPL data and do not belong in a public repo.

### 4. Saved squads have no version stamp — DONE

`exportTerminalState` now stamps `version: SAVED_STATE_VERSION` (1), so both the local
storage write and the downloaded export file carry it, and `parseSavedState` checks it. Both
readers — the planner and the leagues page — go through that one function, so neither can
drift from the other.

The rules, and why each one:

- **No version means version 0, and it loads.** Every squad saved before today is
  unversioned. Refusing those would have cleared real users' saved squads on the very deploy
  that added the version, which is the problem the version exists to prevent.
- **A newer version is refused.** A second tab on a newer deploy may have written fields
  this build cannot interpret. Refusing leaves that save untouched for the build that
  understands it, rather than guessing and writing back a corrupted squad.
- **Bump only for a breaking change** — a renamed or re-typed field. Adding an optional
  field needs no bump: every field is already sanitized on read, so an older save just
  arrives without it. That field-level sanitizing was already there and is what has been
  quietly migrating saves all along; the stamp gives it a place to branch when sanitizing is
  not enough.

## Will hurt under real traffic

### 5. Nothing is cached over HTTP

`/api/fpl/bootstrap` is `force-dynamic` with `Cache-Control: no-store`. Confirmed live:
`x-vercel-cache: MISS`. Every visitor, on every page load, triggers a function that fetches
FPL, projects 651 players, and returns **7.4 MB** (645 KB gzipped). The `memory` Map in
`lib/fpl/cache.ts` is per instance, so each cold lambda repeats the whole thing.

The payload itself is survivable — the documented 4.5 MB function response cap does not bite
here, I checked — but the cost and the upstream load do.

Highest-leverage change on this list: put a shared cache header on it.

```ts
// lib/fpl/http.ts
"Cache-Control": "public, s-maxage=60, stale-while-revalidate=300"
```

That collapses origin work to one run per window for the whole world, and repeat visitors
stop paying for the transfer. Do the same for
`/api/fpl/entry/[id]/event/[gw]/picks`, `/api/fpl/fixtures` and `/api/fpl/live/[gw]`.
Keep `no-store` only on the `?refresh=1` path.

Two cautions:

- **Tighten the window near a deadline.** Prices move about 01:30 UTC each day and team news
  moves right up to kickoff, and squad legality is computed from `now_cost`. A 60s
  `s-maxage` with `stale-while-revalidate=300` can serve six-minute-old prices in the exact
  hour that costs someone a transfer. Shorten it, or drop `stale-while-revalidate`, once the
  next deadline is close — and check the freshness badge is visible on the planner, not just
  present in the payload. `FreshnessMetadata` already carries `ageSeconds` and `stale`.
- **`public` on a per-entry path is fine here, but only here.** Picks are public FPL data, so
  a shared cache holding one manager's response is harmless. Do not carry the pattern over to
  anything that later holds private state.

While you are in there, two things ship in that payload for no one:

- The `projection` field is 6.6 KB per player, 4.3 MB of the 7.4 MB. Consider trimming the
  per-horizon breakdown out of the list payload and serving it from `/api/fpl/player/[id]`
  when a card opens.
- `selection.evidence` is parsed at `components/terminal/TerminalApp.tsx:154` and never
  rendered — 733 entries nobody reads. Either surface it on the player card, which is what
  it was built for, or drop it from the list payload and serve it per player.

### 6. Opening one league costs up to 150 function calls

`components/leagues/useLeaguesData.ts:448` fetches picks for every league member, in chunks,
one request each. A 150-member league is 150 invocations, each proxying to FPL. It is cached
client-side per gameweek, but the first open is expensive and every new visitor pays it
again. Caching (item 5) fixes most of this, since members overlap between visitors.

### 7. FPL may block you

All requests now leave from Vercel's IPs rather than your laptop. FPL rate-limits hard
around deadlines, and a block hits every user at once. Item 5 is the mitigation. Also worth
sending a real `User-Agent` in `lib/fpl/client.ts` with a contact address, so a block comes
with a chance to talk.

### 8. The rate limiter is per instance

`lib/http/computeRateLimit.ts` holds buckets in a module-level Map, so the real ceiling is
30 requests per minute times however many lambdas are warm. Fine as a brake, not a defence.
Upstash Redis or Vercel KV if you want a real one — but caching removes most of the pressure
first, so do that before this.

## Operations

### 9. Predicted lineups go stale between deploys

`npm run data:lineups` is manual by design — you refresh the snapshot, commit it, deploy.
Between deploys users see the predicted XI from whenever you last did that.

A cron writing to KV is off the table; you chose manual control. What is left is honesty:
show the snapshot age in the UI. `metadata.lineups` already carries `fetchedAt` and
`ageSeconds` on every bootstrap response, and nothing renders them yet.

The stronger version, if you want it later: have the selection model stop weighting the
snapshot once it is old, rather than presenting week-old predictions with the same
confidence as this morning's. That is a projection change, not a plumbing one — see
`lib/availability/selection.ts`.

### 10. Set `maxDuration`

No route sets it. `/api/optimizer` measured 4.5s in production with warm upstream data.
Add a slower FPL response or a cold HiGHS WASM init and it gets close to the default.

```ts
export const maxDuration = 30; // in each compute route
```

### 11. No error monitoring

Launching publicly with no Sentry and no Vercel Analytics means breakage is silent until
someone tells you. Both are quick to add.

## Polish

- **No error pages.** No `app/error.tsx`, `app/global-error.tsx` or `app/not-found.tsx`. An
  unhandled render throw is a blank page today.
- **No share metadata.** No `metadataBase`, no `openGraph`, no `twitter` block in
  `app/layout.tsx`, so a shared link renders bare. No `robots.ts`, no `sitemap.ts`
  (`/robots.txt` returns 404).
- **No security headers** beyond the HSTS Vercel adds. There is no `vercel.json` at all —
  create one for headers, or use `next.config.ts` `headers()`. Worth having:
  `Content-Security-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `X-Content-Type-Options: nosniff`.
- **Repo hygiene.** `.claude` is not in `.gitignore`; the worktree sitting there is one
  `git add -A` away from a public commit. `graphify-out/` **is** tracked — 40 files of agent
  notes in a public repo. Confirm you want both public.
- **Dead config.** `DEEPSEEK_API_KEY` sits in your local `.env` but `lib/ai/` no longer
  exists. Nothing leaked, it was never committed. Delete the line.

## Suggested order

1. Cache headers on the FPL routes (item 5) — one file, biggest effect.
2. `FPL_SNAPSHOT_DIR=/tmp` (item 3) — one environment variable.
3. Decide the RotoWire question (item 1).
4. Affiliation notice, error pages, share metadata (items 2 and polish).
5. State version stamp (item 4).
6. `maxDuration`, error monitoring, lineup cron (items 10, 11, 9).

---

## What changed

Applied 2026-09-03. `npm test` 441 passed, `npm run test:e2e` 45 passed,
`npm run typecheck` clean, `npx eslint app lib components store types scripts tests` clean.

**None of this is live until you redeploy.** The build running at
`chatgpt-orpin-omega.vercel.app` right now is still the one that scrapes the lineup source
every fifteen minutes and forwards the raw failure to browsers.

**The lineup source is no longer named anywhere a browser can reach.**

- `types/player.ts` — the evidence source union is now
  `PREDICTED_XI | TEAM_NEWS | HISTORICAL_STARTS | CURRENT_SEASON | FPL_STATUS`.
- `lib/availability/selection.ts` — the detail strings beside it read "Predicted to start",
  "Confirmed in the published XI", "Not in the predicted XI", "Team news: QUES".
- `lib/fpl/normalize.ts` — `metadata.lineups` is now a narrow `LineupSnapshotStatus`
  carrying only `refreshed`, `reason`, `fetchedAt` and `ageSeconds`. The `error` field is
  gone from the wire: its text comes from a scraper and a filesystem, and neither should
  reach a browser. The server still logs it.
- `components/terminal/TerminalApp.tsx`, `app/globals.css` — the parser accepts the new
  names, and the unused `.data-badge.rotowire` style is gone.
- Server-side module and file names still say RotoWire. They should — that is what they
  read. None of them ships to a browser.

**Guard against it coming back:** `tests/data/client-payload-provenance.test.ts` asserts
`/rotowire/i` matches nothing in the selection evidence, the published lineup status, or a
whole serialized bootstrap body. One case runs the model over the snapshot actually in
`data/generated`, so a label the scrape starts emitting next month is caught by the data
rather than by a fixture. All four assertions were checked by reintroducing the name and
watching them fail.

Verified end to end: `/api/fpl/bootstrap` on the running app returns 0 occurrences of
"rotowire", against 1,466 before.

**Also changed:** the affiliation notice (item 2), the production scrape and snapshot paths
(item 3), and the saved-state version (item 4).

`tests/data/deployed-build.test.ts` covers the deployment-only behaviour: it mocks
`fetchRotowireLineups` and asserts a bootstrap request never calls it, asserts the lineup age
still reaches the payload, and sets `VERCEL=1` with `NODE_ENV=production` to reach the
snapshot-directory branch that no test or checkout would otherwise run. All of it was checked
by reintroducing the fault and watching the test fail.

`tests/data/rotowire-refresh.test.ts` now covers the manual path that remains: the snapshot
and its mappings are written together, and a fetch that fails or maps no players leaves the
committed file untouched. Those assertions were salvaged from the deleted automatic tests —
they protect the import you still run by hand. Nothing in the suite reaches the network.

Nothing is committed. Run `git diff` before you stage — this checkout had unrelated
uncommitted work in `components/terminal/TerminalApp.tsx` and `store/terminalStore.ts`
before any of this, and it is still there.
