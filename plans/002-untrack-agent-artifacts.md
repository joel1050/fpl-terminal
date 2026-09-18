# Plan 002: Stop tracking working artifacts in the public repo

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 540dd80..HEAD -- .gitignore`
> If `.gitignore` changed since this plan was written, compare the "Current
> state" excerpt against the live file before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `540dd80`, 2026-09-17

## Why this matters

The repo at `github.com/joel1050/fpl-terminal` is **public** (confirmed:
`gh repo view --json visibility` returns `PUBLIC`), and the app is about to be
posted to Reddit, which is what brings people to look at it. Three directories
of working artifacts are tracked in it: browser page dumps, test screenshots,
and agent query notes whose filenames read like work-in-progress complaints.

They cost twice. Once socially — they are the first thing a curious reader
finds. Once mechanically — they are **6.9 MB of the 7.7 MB of junk** currently
traced into every serverless function bundle (measured from
`.next/server/app/api/optimizer/route.js.nft.json`), which slows cold starts.
Plan 003 fixes the tracing; this plan removes the cause so 003 has less to
exclude.

Nothing here is a secret leak. `.env*` has never been committed and `.gitignore`
already covers it. This is about what the repo says about itself.

## Current state

Tracked working artifacts, measured with `git ls-files <dir> | xargs du -ck`:

| Directory | Tracked files | Size | What it is |
|---|---|---|---|
| `.playwright-cli/` | 46 | **6.9 MB** | Accessibility-tree page dumps from ad-hoc browser sessions, named `page-2026-08-21T06-38-54-366Z.yml` |
| `output/playwright/` | 12 | 1.7 MB | Before/after PNG screenshots from layout work, e.g. `add-column-gap-before.png` |
| `graphify-out/` | 58 | 820 KB | Agent knowledge-graph output and query notes, e.g. `memory/query_20260821_185012_we_have_a_problem_with_xp_calculations__if_you_sor.md` |

`.gitignore` as it stands (the whole file):

```
node_modules/
.next/
out/
coverage/
playwright-report/
test-results/
data/generated/*
!data/generated/historical-match-stats.json
!data/generated/historical-players.json
!data/generated/player-mappings.json
!data/generated/rotowire-lineups.json
!data/generated/rotowire-player-mappings.json
!data/generated/team-strength.json
!data/generated/club-elo.json
data/snapshots/
.env*
!.env.example
*.log
*.tsbuildinfo
.DS_Store
.vercel

# codex-workflow-managed-start
.codex_workflow_hidden_resources/
AGENTS.md
# codex-workflow-managed-end
```

Note what it already covers — `playwright-report/`, `test-results/`,
`data/snapshots/`, `.env*` — and what it does not: `.playwright-cli/`,
`output/`, `graphify-out/`, `.claude/`.

**`.claude/` is not tracked** (`git ls-files .claude` returns nothing) but it is
also not ignored, so a `git add -A` would commit it. It contains a git worktree;
`LAUNCH.md` records that a bare `npm run lint` reports over 12,000 problems
because ESLint walks it. Ignoring it fixes both.

### What must NOT be removed

- `agent_docs/` (7 files, 36 KB) — `AGENTS.md` names these as the project's
  canonical durable documents (`project_overview.md`, `project_diary.md` and
  the rest). They are meant to be in the repo. Leave them tracked.
- `docs/superpowers/plans/` (1 file, 52 KB) — a design document, not an
  artifact. Leave it tracked.
- `data/generated/*.json` — the allowlisted entries in `.gitignore` are the
  app's real data inputs and the deployment reads them. Leave them exactly as
  they are.
- `plans/` — this directory. Leave it tracked.

## Commands you will need

| Purpose   | Command                       | Expected on success            |
|-----------|-------------------------------|--------------------------------|
| Tests     | `npm test`                    | 642 passed, 77 files           |
| Typecheck | `npm run typecheck`           | exit 0, no output              |
| Build     | `npm run build`               | exit 0, route table printed    |
| E2E       | `npx playwright test`         | 51 passed in 5 files           |
| Lint      | `npx eslint app lib components store types scripts tests` | exit 0 |

Note the lint command: `npm run lint` walks the stray worktree under `.claude/`
and reports thousands of unrelated problems. Use the scoped form above.

## Scope

**In scope** (the only files you should modify):
- `.gitignore`
- The index entries for `.playwright-cli/`, `output/`, `graphify-out/`
  (removed with `git rm --cached`, which leaves the files on disk)

**Out of scope** (do NOT touch, even though they look related):
- `agent_docs/`, `docs/`, `plans/` — see "What must NOT be removed".
- The `# codex-workflow-managed-start` / `-end` block at the bottom of
  `.gitignore`. It is written by tooling. Add your entries **above** it; edits
  inside it will be overwritten.
- Git history. This plan removes files from the tip, not from past commits —
  see "Maintenance notes".
- Any file under `data/`.

## Git workflow

- Branch: `advisor/002-untrack-artifacts`
- Commit style, from `git log --oneline`: lowercase conventional prefix, e.g.
  `chore: refresh lineup data`. Use `chore: untrack working artifacts`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extend `.gitignore`

Insert these lines **above** the `# codex-workflow-managed-start` line, keeping
the existing entries in place:

```
.claude/
.playwright-cli/
output/
graphify-out/
```

**Verify**: `git check-ignore -v .claude .playwright-cli output graphify-out`
→ four lines, each naming `.gitignore` and the rule that matched.

**Verify**: `git check-ignore agent_docs docs plans` → **no output** and a
non-zero exit code, meaning none of the three is ignored. If any of them is
reported as ignored, your rule is too broad — that is a STOP condition.

### Step 2: Remove the three directories from the index

`--cached` removes them from git's index while leaving them on disk, which is
what you want: the files stay available locally and simply stop being tracked.

```bash
git rm -r --cached --quiet .playwright-cli output graphify-out
```

**Verify**: `git ls-files .playwright-cli output graphify-out | wc -l` → `0`

**Verify**: `ls .playwright-cli output graphify-out` → all three still exist on
disk with their contents. If any directory is gone, you used `git rm` without
`--cached`; restore with `git checkout HEAD -- <dir>` and report.

**Verify**: `git ls-files agent_docs docs | wc -l` → `8` (7 in `agent_docs`,
1 in `docs`). If this is `0`, you removed the wrong directories — restore and
report.

### Step 3: Confirm nothing in the app depended on them

Nothing in the application should import from these directories, but confirm
rather than assume:

```bash
grep -rn "graphify-out\|playwright-cli\|output/playwright" app lib components store types scripts tests next.config.ts playwright.config.ts
```

**Verify**: no output. If there is a match, **stop and report it** — a source
file reads one of these directories and untracking it will break a deployment.

### Step 4: Confirm the app still builds and passes

```bash
npm run typecheck && npm test && npm run build && npx playwright test
```

**Verify**: typecheck exits 0; `Tests  642 passed (642)`; build exits 0;
`51 passed`.

> The build warning beginning "Static analysis determined that this filesystem
> access causes the whole project to be traced" is **expected and
> pre-existing**. Plan 003 fixes it. Do not treat it as a failure.

### Step 5: Confirm the diff is what you intended

```bash
git status --porcelain | grep -v '^D ' | head
```

**Verify**: the only non-deletion entry is the modification to `.gitignore`.
Every other entry should be a deletion (`D `) under one of the three
directories.

## Test plan

No new tests. This plan changes no application behaviour — it changes which
files git tracks. The existing suite is the regression net, and step 3 is the
real check: it proves no source file reads the untracked paths.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `git ls-files .playwright-cli output graphify-out | wc -l` prints `0`
- [ ] `git ls-files agent_docs docs | wc -l` prints `8`
- [ ] `git check-ignore -v .claude .playwright-cli output graphify-out` prints four rules
- [ ] `git check-ignore agent_docs docs plans` prints nothing
- [ ] The three directories still exist on disk
- [ ] `grep -rn "graphify-out\|playwright-cli\|output/playwright" app lib components store types scripts tests next.config.ts playwright.config.ts` returns nothing
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with 642 passing
- [ ] `npm run build` exits 0
- [ ] `npx playwright test` exits 0 with 51 passing
- [ ] `plans/README.md` status row for 002 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 3's grep finds a source file referencing any of the three directories.
- `git check-ignore` reports `agent_docs`, `docs` or `plans` as ignored.
- Any of the three directories disappears from disk after step 2.
- A test that passed before this plan fails after it.
- You are tempted to rewrite git history to purge these files from past
  commits. **Do not.** That is a force-push against a public repo and it is the
  operator's decision, not yours. Report it as a recommendation instead.

## Maintenance notes

- **This removes the files from the tip, not from history.** Anyone can still
  read them in past commits. Rewriting history with `git filter-repo` would
  purge them, but it force-pushes a public repo and breaks every existing
  clone. That is a deliberate call for the operator to make. Given the content
  is working notes rather than credentials, stopping the bleeding at the tip is
  a defensible place to stop.
- Plan 003 trims the serverless bundle. Doing this plan first means 003 has
  6.9 MB less to exclude, and its measurements will differ from the numbers
  recorded in that plan by roughly that amount — which is the expected outcome,
  not drift.
- Ignoring `.claude/` also fixes the bare `npm run lint` command, which
  currently walks a worktree there. After this plan, check whether
  `npm run lint` reports a sane number; if it does, the scoped eslint
  invocation in the docs can be simplified later.
- A reviewer should confirm the diff contains no deletion under `agent_docs/`,
  `docs/`, `data/` or `plans/`.
