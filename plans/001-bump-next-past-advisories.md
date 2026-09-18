# Plan 001: Move Next off the versions carrying the two critical advisories

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 540dd80..HEAD -- package.json package-lock.json`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `540dd80`, 2026-09-17

## Why this matters

`npm audit --omit=dev` reports one critical and one high advisory against the
installed production dependencies. The app is about to be posted publicly, so
the window in which an unpatched framework matters goes from "nobody knows the
URL" to "a few thousand people do". The manifest range already admits the
patched versions, so this is a lockfile move rather than a migration, and it is
the cheapest item on the whole pre-launch list. Do not spend time analysing
whether the advisories are reachable in this app — the analysis costs more than
the fix.

## Current state

- `package.json` — the manifest. Relevant lines:

```json
  "dependencies": {
    "@tanstack/react-query": "^5.101.4",
    "highs": "^1.15.2",
    "next": "^16.3.1",
```

- The installed version is behind the range the manifest already allows:

```
$ node -p "require('next/package.json').version"
16.3.1
```

- `npm audit --omit=dev` today reports:

```
next  16.0.0 - 16.3.2
Severity: critical
  (two advisories: a Windows-hosted-server RCE, and an Image Optimization
   API RCE involving AVIF files)
fix available via `npm audit fix`

sharp  <0.35.4
Severity: high
  (libheif vulnerabilities, reached through sharp)
fix available via `npm audit fix`

2 vulnerabilities (1 high, 1 critical)
```

- `sharp` is not a direct dependency. It is pulled in transitively and is the
  image-optimization backend. There is **no `next/image` usage in this repo** —
  `grep -rn "next/image\|<Image" app components` returns nothing — so `sharp`
  moves only as a side effect of the `next` bump.

- The repo has two lockfiles in the tree: `package-lock.json` (288 KB) and
  `pnpm-lock.yaml`. **npm is the package manager in use** — every script in
  `package.json` is run with `npm`, and `README.md` documents `npm install`.
  Touch `package-lock.json` only.

## Commands you will need

| Purpose   | Command                       | Expected on success            |
|-----------|-------------------------------|--------------------------------|
| Install   | `npm install`                 | exit 0                         |
| Audit     | `npm audit --omit=dev`        | exit 0, "found 0 vulnerabilities" |
| Typecheck | `npm run typecheck`           | exit 0, no output              |
| Tests     | `npm test`                    | 642 passed, 77 files           |
| Build     | `npm run build`               | exit 0, route table printed    |
| E2E       | `npx playwright test`         | 51 passed in 5 files           |

## Scope

**In scope** (the only files you should modify):
- `package.json` — only if the range needs widening (see step 1)
- `package-lock.json`

**Out of scope** (do NOT touch, even though they look related):
- `pnpm-lock.yaml` — a stale second lockfile. Leave it exactly as it is;
  updating it implies a package-manager switch nobody asked for.
- Any application source under `app/`, `lib/`, `components/`, `store/`.
  If the bump requires a source change, that is a STOP condition, not a
  licence to edit.
- `next.config.ts` — plan 003 owns that file. Editing it here will collide.

## Git workflow

- Branch: `advisor/001-bump-next`
- The repo's commit style is lowercase conventional-commit prefixes — recent
  examples from `git log --oneline`: `chore: refresh lineup data`.
  Use `chore: bump next past GHSA advisories`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Take the patched versions

Run:

```bash
npm audit fix --omit=dev
```

`^16.3.1` already admits `16.3.3` and later, so this should resolve without
touching `package.json`. If `npm audit fix` reports that a fix is only
available with `--force`, **stop** — `--force` installs semver-major bumps and
is a STOP condition for this plan.

**Verify**: `npm audit --omit=dev` → `found 0 vulnerabilities`

**Verify**: `node -p "require('next/package.json').version"` → a version
`16.3.3` or higher.

### Step 2: Confirm nothing regressed

Run each of these in order and confirm the expected result before continuing:

```bash
npm run typecheck
```
**Verify**: exit 0, no diagnostics printed.

```bash
npm test
```
**Verify**: `Test Files  77 passed (77)` and `Tests  642 passed (642)`.

```bash
npm run build
```
**Verify**: exit 0 and the route table prints, ending with the `○ (Static)` /
`ƒ (Dynamic)` legend.

> A build warning beginning "Static analysis determined that this filesystem
> access causes the whole project to be traced" is **expected and pre-existing**.
> Plan 003 fixes it. Do not treat it as a failure and do not fix it here.

```bash
npx playwright test
```
**Verify**: `51 passed`. If Playwright reports missing browsers, run
`npx playwright install chromium` first — that is a local environment step,
not a source change.

### Step 3: Confirm the diff is only the two files

```bash
git status --porcelain
```

**Verify**: the output lists only `package-lock.json`, and `package.json` only
if step 1 needed to widen the range. Anything else listed is a STOP condition.

## Test plan

No new tests. This plan changes no behaviour, so the existing suite is the
regression net: the 642 unit tests plus the 51 Playwright specs must pass
unchanged. Do not add, skip, or weaken a test to get this plan green — a test
that fails after the bump is a real finding to report, not an obstacle.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm audit --omit=dev` reports `found 0 vulnerabilities`
- [ ] `node -p "require('next/package.json').version"` prints `16.3.3` or higher
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with 642 passing
- [ ] `npm run build` exits 0
- [ ] `npx playwright test` exits 0 with 51 passing
- [ ] `git status --porcelain` lists no file outside the in-scope list
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `npm audit fix` cannot resolve without `--force`, or proposes a major bump
  of `next` (17.x) — a major upgrade is a migration and needs its own plan.
- Any test in the 642, or any of the 51 Playwright specs, fails after the bump
  and passed before it. Report which test and the failure output.
- `npm run build` fails with anything other than the known filesystem-tracing
  **warning** described in step 2.
- The bump appears to require editing a file under `app/`, `lib/`,
  `components/` or `store/`.
- `npm audit --omit=dev` still reports advisories after the fix. Report the
  remaining advisory text verbatim; do not start hand-editing the lockfile.

## Maintenance notes

- `sharp` is transitive and only present as the image-optimization backend.
  If a future change introduces `next/image`, `sharp` moves from incidental to
  load-bearing and its advisories start mattering directly.
- The stray `pnpm-lock.yaml` will keep drifting from `package-lock.json` and
  will keep confusing audits. Deleting it is worth doing, but deliberately and
  separately — it is not part of this plan.
- A reviewer should check the diff touches lockfile entries only, and that no
  test was edited.
