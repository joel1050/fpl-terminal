<!-- codex-workflow-bootstrap-template -->
# Project Diary

## 2026-09-09 — Backtest remeasurement

- A passing whole-corpus validator is not enough by itself. Keep small synthetic
  parity tests that cover historical and fallback priors, form and no-form paths,
  every position, and component-level output so a specific plumbing regression
  fails locally.
- Every `playerRates` backtest caller must pass the walk-forward strength snapshot.
  Omitting it silently exercises a different fallback-prior path from production
  for players without usable historical evidence.
- Backtest arm names must be derived from or checked against current production
  constants. The stale 0.9/24 form label and duplicate current-clamp arm made old
  measurements look like comparisons when they were not.
- Team-level Elo results answer two different questions. Elo combined with a
  widened strength level is rejected; Elo substituted at the shipped spread is
  unresolved. Preserve that distinction because the two scripts also construct
  their fixture base differently.
- FPL xG starts at gameweek 16 in 2022/23, so that season cannot choose form or
  conversion constants even when a later anchor produces rows.
- Selected minima from wide sweeps are exploratory. Require a consistent
  cross-season direction and a paired interval excluding zero before proposing
  a production constant.

During workflow deployments, the main agent updates this document directly.

Maintain a compact project-experience reference that prevents repeated mistakes.
Record only distinct decisions, discarded approaches, mistakes, and reusable
lessons that can affect future work. Consolidate repetition; preserve the
context, reason, outcome, and applicability of each lesson. Do not record
session chronology, releases, commits, routine maintenance, or raw logs.

## Decisions and Lessons

## 2026-09-10 — FDR sensitivity

- The original ClubElo divisor 150 was a display preference, not calibration
  evidence. A later venue-neutral, continuous-path experiment selected 300 on
  2023/24 and improved held-out team-xG error on 2024/25–2025/26. Historical
  ratings are Elo proxies; the result does not validate the ClubElo source itself.
- For live-input experiments, verify the parameterized evaluator against actual
  production scoring components. Historical harness parity does not establish
  parity on the continuous FDR path.
- Inspect usable team-history coverage, not just file count: older GW1–2 xG
  snapshots lack opponent/venue fields, while GW3 has them. The presence of
  any complete fixture activates the joint fitter, so these inputs fit GW3
  only rather than falling back to an aggregate blend of all three rounds.

## 2026-09-17 — Pre-launch A fixes

- A permissive manifest range does not update an installed deployment by
  itself. Keep the manifest when it already admits the patched release and move
  only the lockfile; verify both the installed versions and a production-only
  audit. `npm audit fix --omit=dev` can prune local development packages, so a
  normal `npm install` may be needed before running the full toolchain.
- Dynamic filesystem parameters can make output tracing include the repository.
  Fix that at the deployment boundary with route-scoped includes and excludes,
  then inspect every affected `.nft.json`: a successful build alone does not
  prove required runtime data survived or junk disappeared.
- Removing working artifacts from Git should use cached-only index deletion and
  matching ignore rules. Verify the local directories still exist and that
  canonical project documents and generated runtime data remain tracked.
- Git ignore rules do not make a broad ESLint invocation safe when its flat
  configuration still walks generated or nested-worktree paths. Keep scoped
  runtime lint as the reliable gate until the lint configuration owns those
  exclusions explicitly.

## 2026-09-17 — Pre-traffic B fixes

- Rate-limit the expensive cache-bypass path, not ordinary cached reads. An
  in-memory per-client limiter is instance-local by design, so cap its bucket
  Map and return non-cacheable 429 responses; add shared infrastructure only if
  traffic proves instance-local protection insufficient.
- A refused persisted save is different from no save. Preserve that distinction
  through hydration, block automatic writeback, and keep the recovery notice in
  ephemeral state until an explicit compatible import, replacement, or reset.
- Bound process caches where keys include user-controlled IDs. A small LRU cap
  preserves recent stale fallback while preventing manager, league, and player
  lookups from growing for the lifetime of an instance.
- Route duration exports are deployment hints, not application timeouts. Keep
  request validation, solver error handling, and upstream aborts as the actual
  runtime safeguards.
