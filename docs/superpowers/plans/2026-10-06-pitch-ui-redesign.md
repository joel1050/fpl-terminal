# Pitch UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the planner's presentation as a pitch plus dense dark lists (lean on phones, full data on desktop) and give Leagues the same tokens and phone navigation.

**Architecture:** Presentation only. Pure rules (availability status, squad alerts) move or land in `lib/`. New components under `components/shell`, `components/terminal/{squad,rail,players,fixtures}` replace the rendering parts of `TerminalApp.tsx`; its hooks and handlers stay. CSS moves to design tokens in `app/globals.css`, with new component styles in `app/ui.css` imported from `globals.css`.

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before touching routing or CSS import behaviour), React 19, Zustand, Vitest, Playwright, plain CSS.

**Spec:** `docs/superpowers/specs/2026-10-06-pitch-ui-redesign-design.md`

## Global Constraints

- Work only in the worktree `.claude/worktrees/ui-pitch-redesign` (branch `worktree-ui-pitch-redesign`). Stage explicit paths; never `git add -A`.
- Never hand-edit `data/` or `tests/fixtures/` to make a test pass.
- Prices stay integer tenths; no change to `lib/` maths, optimizer, squad rules or the saved-state `SAVED_STATE_VERSION` (new store fields are optional).
- Every existing accessible name (aria-label, role+name) keeps its text, e.g. "Make Haaland captain", "Lock Haaland", "Squad projection metrics", regions "Starting XI", "Bench", "Player universe", "Squad builder and analysis", "Transfer suggestions", group "Select planning gameweek", "Select chip for this Gameweek".
- Keep test ids: `squad-roster`, `build-stamp`, and the Leagues ids.
- Tests may be edited only to follow changed markup. Never remove or loosen an assertion. List each edited test in the PR.
- Text floor: 12px on phones (≤ 900px), 11.5px on desktop table headers.
- Tap targets ≥ 40px on phones.
- Colour meanings: amber = captain, active sort, primary action, selected tab; orange = availability doubt; green→red scale = fixture difficulty only; red = errors, Reset.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Gates after every task: `npx vitest run <focused>`; after every stage: `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:e2e`, `npm run build`. Run Playwright serially (`--workers=1`) and check `uptime` first; the machine is often loaded by other sessions, and a flake must be re-run alone before it is believed.

## Review Focus

- A squad with fewer than 15 players (draft) must render empty tokens, no crash, no alerts for missing players.
- A player with `chanceOfPlaying` 0 or status `i/s/u/n` shows as unavailable even if RotoWire evidence says he starts.
- Blank gameweek (no fixture) and double gameweek (two) render sensibly in token, table and alerts.
- Long names (e.g. "Dewsbury-Hall", RTL team names in Leagues) never overflow a 76px phone token.
- Old saved state with no `squadView`/`playerColumns` loads and shows Pitch with default columns.
- Action sheet closes on Esc and on outside tap, returns focus to its token, and a locked player cannot be removed from it.
- 1280×720: nothing overlaps; squad column scrolls as one panel.

---

## Stage 1: Foundations

### Task 1: Move `availabilityOf` into `lib/availability/status.ts`

**Files:**
- Create: `lib/availability/status.ts`
- Create: `tests/ui/availability-status.test.ts`
- Modify: `components/terminal/TerminalApp.tsx` (delete local `availabilityOf` at ~line 417, import it)

**Interfaces:**
- Produces: `export type Availability = "AVAILABLE" | "DOUBTFUL" | "UNAVAILABLE"` and `export function availabilityOf(player: Pick<Player, "status" | "chanceOfPlaying">): Availability`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { availabilityOf } from "@/lib/availability/status";

const p = (status: string, chanceOfPlaying?: number) => ({ status, chanceOfPlaying });

describe("availabilityOf", () => {
  it.each(["i", "u", "n", "s"])("treats status %s as unavailable", (s) => {
    expect(availabilityOf(p(s))).toBe("UNAVAILABLE");
  });
  it("treats d as doubtful", () => expect(availabilityOf(p("d"))).toBe("DOUBTFUL"));
  it("treats a chance under 75 as doubtful", () => expect(availabilityOf(p("a", 50))).toBe("DOUBTFUL"));
  it("treats a chance of 75 as available", () => expect(availabilityOf(p("a", 75))).toBe("AVAILABLE"));
  it("ignores case and spaces in status", () => expect(availabilityOf(p(" I "))).toBe("UNAVAILABLE"));
  it("treats a plain player as available", () => expect(availabilityOf(p("a"))).toBe("AVAILABLE"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/ui/availability-status.test.ts`
Expected: FAIL, cannot resolve `@/lib/availability/status`.

- [ ] **Step 3: Implement**

```ts
import type { Player } from "@/types";

export type Availability = "AVAILABLE" | "DOUBTFUL" | "UNAVAILABLE";

/** FPL status wins: a negative status is absolute (domain invariant 6). */
export function availabilityOf(player: Pick<Player, "status" | "chanceOfPlaying">): Availability {
  const status = player.status.trim().toLowerCase();
  if (["i", "u", "n", "s"].includes(status)) return "UNAVAILABLE";
  if (status === "d") return "DOUBTFUL";
  if (typeof player.chanceOfPlaying === "number" && player.chanceOfPlaying < 75) return "DOUBTFUL";
  return "AVAILABLE";
}
```

In `TerminalApp.tsx`, delete the local `availabilityOf` function, add `import { availabilityOf, type Availability } from "@/lib/availability/status";`, and replace `TerminalFilters["availability"]` return-type uses of the old function with `Availability` where needed (`profileAvailabilityLabel` takes `ReturnType<typeof availabilityOf>` and still works).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/ui && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/availability/status.ts tests/ui/availability-status.test.ts components/terminal/TerminalApp.tsx
git commit -m "refactor: move availabilityOf to lib/availability/status"
```

### Task 2: `squadAlerts`

**Files:**
- Create: `lib/analysis/squadAlerts.ts`
- Create: `tests/analysis/squad-alerts.test.ts`
- Modify: `types/analysis.ts` (append `SquadAlert`)

**Interfaces:**
- Consumes: `availabilityOf` (Task 1); `weeklyPlayerMetrics(player, gw)` from `lib/squad/weeklyLineup.ts` returning `{ points, minutes, ... }`.
- Produces:

```ts
export interface SquadAlert {
  kind: "AVAILABILITY" | "HARD_RUN" | "BLANK" | "DOUBLE";
  playerId: number;
  title: string;   // "Palmer doubtful, 75%"
  detail: string;  // "1st on bench · 55 min expected · 3.1 xP"
}
export function squadAlerts(input: {
  squad: Player[]; starterIds: number[]; benchOrder: number[];
  benchGoalkeeperId: number; gameweek: number;
}): SquadAlert[]
```

- [ ] **Step 1: Append the type to `types/analysis.ts`**

```ts
export interface SquadAlert {
  kind: "AVAILABILITY" | "HARD_RUN" | "BLANK" | "DOUBLE";
  playerId: number;
  title: string;
  detail: string;
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { squadAlerts } from "@/lib/analysis/squadAlerts";
import type { Player } from "@/types";

type Row = { gameweek: number; difficulty?: number; opponentShortName?: string; isHome?: boolean };
function p(id: number, over: Partial<Player> & { rows?: Row[] } = {}): Player {
  const rows = over.rows ?? [1, 2, 3, 4, 5].map((gameweek) => ({ gameweek, difficulty: 2 }));
  return {
    id, displayName: `P${id}`, status: "a", position: "MID", priceTenths: 50, teamShortName: "ABC",
    fixtures: rows.map((r) => ({ opponentTeamId: 9, opponentShortName: "XYZ", isHome: true, ...r })),
    projection: { fixtures: [], nextGW: 3, next3: 9, next5: 15, next10: 30, expectedMinutes: 80 },
    current: { minutes: 900 },
    ...over,
  } as unknown as Player;
}
const base = (squad: Player[]) => ({ squad, starterIds: squad.slice(0, 11).map((x) => x.id), benchOrder: squad.slice(12).map((x) => x.id), benchGoalkeeperId: squad[11]?.id ?? 0, gameweek: 1 });

describe("squadAlerts", () => {
  const squad = Array.from({ length: 15 }, (_, i) => p(i + 1));

  it("returns nothing for a healthy squad", () => {
    expect(squadAlerts(base(squad))).toEqual([]);
  });

  it("flags a doubtful starter with status and chance", () => {
    const s = squad.map((x) => (x.id === 3 ? p(3, { status: "d", chanceOfPlaying: 50 }) : x));
    const out = squadAlerts(base(s));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "AVAILABILITY", playerId: 3 });
    expect(out[0].title).toContain("doubtful, 50%");
  });

  it("says where a doubtful bench player sits", () => {
    const s = squad.map((x) => (x.id === 13 ? p(13, { status: "d", chanceOfPlaying: 75 }) : x));
    expect(squadAlerts(base(s))[0].detail).toContain("1st on bench");
  });

  it("puts unavailable before doubtful", () => {
    const s = squad.map((x) => (x.id === 2 ? p(2, { status: "d", chanceOfPlaying: 50 }) : x.id === 5 ? p(5, { status: "i" }) : x));
    expect(squadAlerts(base(s)).map((a) => a.playerId)).toEqual([5, 2]);
  });

  it("flags a starter whose next five average difficulty is 3.6 or worse", () => {
    const hard = (d: number[]) => d.map((difficulty, i) => ({ gameweek: i + 1, difficulty }));
    const at36 = squad.map((x) => (x.id === 4 ? p(4, { rows: hard([4, 4, 4, 3, 3]) }) : x)); // 3.6
    const at35 = squad.map((x) => (x.id === 4 ? p(4, { rows: hard([4, 4, 3, 3, 3]) }) : x)); // 3.4
    expect(squadAlerts(base(at36)).map((a) => a.kind)).toEqual(["HARD_RUN"]);
    expect(squadAlerts(base(at35))).toEqual([]);
  });

  it("flags a blank and a double gameweek", () => {
    const s = squad.map((x) =>
      x.id === 6 ? p(6, { rows: [{ gameweek: 2 }] }) :
      x.id === 7 ? p(7, { rows: [{ gameweek: 1 }, { gameweek: 1 }] }) : x);
    const kinds = squadAlerts(base(s)).map((a) => a.kind).sort();
    expect(kinds).toEqual(["BLANK", "DOUBLE"]);
  });

  it("caps the list at five", () => {
    const s = squad.map((x) => p(x.id, { status: "i" }));
    expect(squadAlerts(base(s))).toHaveLength(5);
  });

  it("copes with a draft squad of fewer than 15", () => {
    const draft = squad.slice(0, 6);
    expect(() => squadAlerts({ squad: draft, starterIds: [], benchOrder: [], benchGoalkeeperId: 0, gameweek: 1 })).not.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/analysis/squad-alerts.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

```ts
import { availabilityOf } from "@/lib/availability/status";
import { weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";
import type { Player, SquadAlert } from "@/types";

const MAX_ALERTS = 5;
const HARD_RUN_AVERAGE = 3.6;
const ORDINAL = ["1st", "2nd", "3rd"];

function slotLabel(id: number, input: { starterIds: number[]; benchOrder: number[]; benchGoalkeeperId: number }): string {
  if (input.starterIds.includes(id)) return "starter";
  if (id === input.benchGoalkeeperId) return "bench GK";
  const index = input.benchOrder.indexOf(id);
  return index >= 0 ? `${ORDINAL[index]} on bench` : "squad";
}

export function squadAlerts(input: {
  squad: Player[]; starterIds: number[]; benchOrder: number[]; benchGoalkeeperId: number; gameweek: number;
}): SquadAlert[] {
  const unavailable: SquadAlert[] = [];
  const doubtful: SquadAlert[] = [];
  const hardRun: SquadAlert[] = [];
  const schedule: SquadAlert[] = [];

  for (const player of input.squad) {
    const level = availabilityOf(player);
    if (level !== "AVAILABLE") {
      const week = weeklyPlayerMetrics(player, input.gameweek);
      const chance = player.chanceOfPlaying === undefined ? "" : `, ${player.chanceOfPlaying}%`;
      (level === "UNAVAILABLE" ? unavailable : doubtful).push({
        kind: "AVAILABILITY",
        playerId: player.id,
        title: `${player.displayName} ${level === "UNAVAILABLE" ? "unavailable" : "doubtful"}${chance}`,
        detail: `${slotLabel(player.id, input)} · ${Math.round(week.minutes)} min expected · ${week.points.toFixed(1)} xP`,
      });
    }

    const upcoming = player.fixtures.filter((f) => f.gameweek >= input.gameweek).slice(0, 5);
    if (input.starterIds.includes(player.id) && upcoming.length === 5) {
      const average = upcoming.reduce((sum, f) => sum + (f.difficulty ?? 3), 0) / 5;
      if (average >= HARD_RUN_AVERAGE) {
        const runXp = [0, 1, 2, 3, 4].reduce((sum, i) => sum + weeklyPlayerMetrics(player, input.gameweek + i).points, 0);
        hardRun.push({
          kind: "HARD_RUN", playerId: player.id,
          title: `${player.displayName} has a hard run`,
          detail: `${upcoming.map((f) => f.opponentShortName).join(" · ")} → ${runXp.toFixed(1)} xP over 5 GWs`,
        });
      }
    }

    const count = player.fixtures.filter((f) => f.gameweek === input.gameweek).length;
    if (count === 0) schedule.push({ kind: "BLANK", playerId: player.id, title: `${player.displayName} has no fixture`, detail: `Blank gameweek ${input.gameweek}` });
    if (count > 1) schedule.push({ kind: "DOUBLE", playerId: player.id, title: `${player.displayName} plays twice`, detail: `Double gameweek ${input.gameweek}` });
  }

  return [...unavailable, ...doubtful, ...hardRun, ...schedule].slice(0, MAX_ALERTS);
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/analysis/squad-alerts.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/analysis/squadAlerts.ts tests/analysis/squad-alerts.test.ts types/analysis.ts
git commit -m "feat: squadAlerts rules for availability, hard runs and blank/double weeks"
```

### Task 3: Store fields `squadView` and `playerColumns`

**Files:**
- Modify: `store/terminalStore.ts` (type `TerminalState`, `initial`, actions, `PersistedTerminalState`, `hydrate`, `exportTerminalState`)
- Modify: `components/terminal/TerminalApp.tsx` (add both to the persist `useEffect` dependency list)
- Test: `tests/store/ui-preferences.test.ts`

**Interfaces:**
- Produces on the store: `squadView: "PITCH" | "TABLE"`, `setSquadView(view)`, `playerColumns: PlayerColumnKey[]`, `setPlayerColumns(keys)`; exported `PlayerColumnKey = "own" | "form" | "next3" | "next5" | "value5" | "next10" | "value10" | "xgi" | "start"` and `DEFAULT_PLAYER_COLUMNS: PlayerColumnKey[] = ["own", "form", "next3", "next5", "start"]`. `SortKey` gains `"next3"`.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PLAYER_COLUMNS, exportTerminalState, parseSavedStateResult, useTerminalStore } from "@/store/terminalStore";

describe("ui preferences", () => {
  beforeEach(() => useTerminalStore.getState().reset());

  it("defaults to the pitch and the default columns", () => {
    const s = useTerminalStore.getState();
    expect(s.squadView).toBe("PITCH");
    expect(s.playerColumns).toEqual(DEFAULT_PLAYER_COLUMNS);
  });

  it("round-trips through export and hydrate", () => {
    const s = useTerminalStore.getState();
    s.setSquadView("TABLE");
    s.setPlayerColumns(["own", "xgi"]);
    const raw = JSON.stringify(exportTerminalState(useTerminalStore.getState()));
    useTerminalStore.getState().reset();
    const parsed = parseSavedStateResult(raw);
    expect(parsed.status).toBe("accepted");
    if (parsed.status === "accepted") useTerminalStore.getState().hydrate(parsed.state);
    expect(useTerminalStore.getState().squadView).toBe("TABLE");
    expect(useTerminalStore.getState().playerColumns).toEqual(["own", "xgi"]);
  });

  it("loads an old save without the fields using the defaults", () => {
    const old = JSON.stringify({ ...exportTerminalState(useTerminalStore.getState()), squadView: undefined, playerColumns: undefined });
    const parsed = parseSavedStateResult(old);
    if (parsed.status === "accepted") useTerminalStore.getState().hydrate(parsed.state);
    expect(useTerminalStore.getState().squadView).toBe("PITCH");
    expect(useTerminalStore.getState().playerColumns).toEqual(DEFAULT_PLAYER_COLUMNS);
  });

  it("drops unknown column keys and a bad view", () => {
    const base = exportTerminalState(useTerminalStore.getState());
    const parsed = parseSavedStateResult(JSON.stringify({ ...base, squadView: "WAT", playerColumns: ["own", "nope", 3] }));
    if (parsed.status === "accepted") useTerminalStore.getState().hydrate(parsed.state);
    expect(useTerminalStore.getState().squadView).toBe("PITCH");
    expect(useTerminalStore.getState().playerColumns).toEqual(["own"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/store/ui-preferences.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement.** Near the other exported types add:

```ts
export type PlayerColumnKey = "own" | "form" | "next3" | "next5" | "value5" | "next10" | "value10" | "xgi" | "start";
export const PLAYER_COLUMN_KEYS: PlayerColumnKey[] = ["own", "form", "next3", "next5", "value5", "next10", "value10", "xgi", "start"];
export const DEFAULT_PLAYER_COLUMNS: PlayerColumnKey[] = ["own", "form", "next3", "next5", "start"];
export type SquadView = "PITCH" | "TABLE";
function sanitizeColumns(value: unknown): PlayerColumnKey[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return PLAYER_COLUMN_KEYS.filter((key) => value.includes(key));
}
```

Add `"next3"` to `SortKey`. Add to `PersistedTerminalState`: `squadView?: SquadView; playerColumns?: PlayerColumnKey[];`. Add to `TerminalState`: fields and `setSquadView: (view: SquadView) => void; setPlayerColumns: (keys: PlayerColumnKey[]) => void;`. In `initial`: `squadView: "PITCH" as SquadView, playerColumns: DEFAULT_PLAYER_COLUMNS`. Actions: `setSquadView: (squadView) => set({ squadView })`, `setPlayerColumns: (keys) => set({ playerColumns: sanitizeColumns(keys) ?? DEFAULT_PLAYER_COLUMNS })`. In `hydrate`'s `set({...})`: `squadView: state.squadView === "TABLE" ? "TABLE" : "PITCH", playerColumns: sanitizeColumns(state.playerColumns) ?? DEFAULT_PLAYER_COLUMNS`. In `exportTerminalState`: `squadView: state.squadView, playerColumns: state.playerColumns`. Add `store.squadView, store.playerColumns` to the persistence `useEffect` deps in `TerminalApp.tsx`. The universe sort map in `TerminalApp.tsx` gets `next3: (player) => week(player)?.next3 ?? 0` and `UniverseWeekMetrics` gains `next3` computed with `projectedPointsForGameweeks(fixtures, gameweek, 3)`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/store && npm run typecheck`
Expected: PASS, including every existing store test.

- [ ] **Step 5: Commit**

```bash
git add store/terminalStore.ts components/terminal/TerminalApp.tsx tests/store/ui-preferences.test.ts
git commit -m "feat: persist squad view and players-table columns"
```

### Task 4: Design tokens, type scale and phone text floor

**Files:**
- Create: `app/ui.css`
- Modify: `app/globals.css` (`:root` tokens, `@import "./ui.css"` after the tailwind import, body font, remove sizes under 12px in phone media blocks)
- Test: `tests/e2e/ui-foundations.spec.ts`

**Interfaces:**
- Produces CSS custom properties: `--bg --surface --surface-2 --line --text --muted --accent --warn --warn-text --good --bad --fdr-1..5 --fdr-1-bg..--fdr-5-bg --font-ui --font-num`. Existing variables (`--panel`, `--amber`, `--green`, `--red`, `--cyan`, `--border`…) stay defined and are aliased to the new values so untouched CSS keeps working: `--panel: var(--surface); --amber: var(--accent); --green: var(--good); --red: var(--bad); --border: var(--line); --background: var(--bg); --text`, `--muted` per spec.

- [ ] **Step 1: Write the failing browser test.** Reuse the helpers in `tests/e2e/fpl-terminal.spec.ts` (`mockNetwork`/`chooseMode`/`IMPORT_MODE`; copy the same `beforeEach` setup, importing from `tests/fixtures/network.ts` as that file does).

```ts
test("phone text never goes under 12px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // same import-a-team setup as fpl-terminal.spec.ts
  const small = await page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim();
      const el = n.parentElement;
      if (!text || !el || el.closest("[hidden]") || el.offsetParent === null) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) out.push(`${size}px "${text.slice(0, 24)}"`);
    }
    return out;
  });
  expect(small).toEqual([]);
});
```

Add the same check for the Players tab and `/leagues` once those exist (Tasks 11, 12 extend this spec).

- [ ] **Step 2: Run to see it fail**

Run: `npx playwright test tests/e2e/ui-foundations.spec.ts --workers=1`
Expected: FAIL listing many 7–11px strings.

- [ ] **Step 3: Implement.** Put the token block from the spec table in `:root`; set `body { font-family: var(--font-prose), system-ui, sans-serif; font-size: 14px; }` and `.num, .metric-strip strong, td.n { font-family: var(--font-mono), ui-monospace, monospace; font-variant-numeric: tabular-nums }`. In `app/ui.css` add a phone block:

```css
@media (max-width: 900px) {
  :root { --min-text: 12px; }
  .terminal-app *, .leagues-app * { letter-spacing: normal; }
  .terminal-app [class], .leagues-app [class] { font-size: max(var(--min-text), 1em); }
}
```

Then grep `app/globals.css` for `font-size: [1-9]px` and `font-size: 1[01]px` inside the `max-width: 900px` and `560px` blocks and set each to `12px`. Remove `text-transform: uppercase` from data cells (`.status-cell strong`, table cells); keep it on nothing. The `max()` rule is a net; the explicit edits are the fix. If `max(12px, 1em)` fights a legitimately larger inherited size, switch to a per-class `12px` edit instead.

- [ ] **Step 4: Run test and the existing e2e suite**

Run: `npx playwright test --workers=1`
Expected: PASS (visual change only; fix any test that matched upper-case text by switching to a case-insensitive regex).

- [ ] **Step 5: Commit**

```bash
git add app/ui.css app/globals.css tests/e2e/ui-foundations.spec.ts
git commit -m "style: design tokens and a 12px text floor on phones"
```

### Task 5: `Sheet`, `BottomTabBar`, `MoreSheet`, `TopBar`

**Files:**
- Create: `components/shell/Sheet.tsx`, `components/shell/BottomTabBar.tsx`, `components/shell/MoreSheet.tsx`, `components/shell/TopBar.tsx`
- Modify: `components/terminal/TerminalApp.tsx` (topbar JSX at ~1287–1299; remove `.mobile-tabs` nav), `components/leagues/LeagueScreen.tsx` (add `BottomTabBar`), `app/ui.css`
- Modify tests: `tests/e2e/planning-gameweek.spec.ts` (`.mobile-tabs button MARKET` at line 127 → `getByRole("button", {name:"Players"})` in the tab bar; the "planner header on one line" test at ~183 → assert the new top bar has one row ≤ 56px and actions `["Refresh","More"]`), `tests/e2e/leagues.spec.ts` (`.leagues-mobile-tabs` stays)
- Test: `tests/e2e/shell.spec.ts`

**Interfaces:**
- `Sheet`: `export function Sheet(props: { open: boolean; onClose: () => void; title: string; variant?: "bottom" | "popover"; anchorRef?: React.RefObject<HTMLElement | null>; children: React.ReactNode }): JSX.Element | null`. Renders `<dialog>`-like `role="dialog" aria-modal="true" aria-label={title}`, closes on Esc and backdrop click, restores focus to the element focused at open.
- `BottomTabBar`: `export function BottomTabBar(props: { active: "SQUAD" | "PLAYERS" | "LEAGUES"; onSquad?: () => void; onPlayers?: () => void; onMore: () => void }): JSX.Element`. On `/` Squad and Players are buttons; on `/leagues` they are `<Link href="/">` and set a store flag via `useTerminalStore.getState().setMobileTab(...)` before navigating. Leagues is `<Link href="/leagues">`. Renders `<nav aria-label="Main">`, hidden above 900px by CSS. Labels: "Squad", "Players", "Leagues", "More".
- `MoreSheet`: `export function MoreSheet(props: { open: boolean; onClose: () => void; onRefresh: () => void; onExport: () => void; onImportClick: () => void; onReset: () => void; onReverse?: () => void; reverseBusy?: boolean; reverseDisabled?: boolean; settings?: React.ReactNode; onModeChooser?: () => void }): JSX.Element`. Buttons: "Refresh", "Export", "Import", "Reverse all changes", optimizer settings slot, "Choose mode", "Reset" (last, `className="danger"`).
- `TopBar`: `export function TopBar(props: { planningGameweek: number; liveGameweek: number; onGameweek: (n: number) => void; deadline: string | null; statusSlot: React.ReactNode; onRefresh: () => void; more: React.ReactNode }): JSX.Element`. The GW stepper keeps `role="group" aria-label="Select planning Gameweek"` and the two arrow buttons keep `aria-label="Previous planning Gameweek"` / `"Next planning Gameweek"`.

- [ ] **Step 1: Write the failing test** (`tests/e2e/shell.spec.ts`): on 390×844 the bottom bar shows Squad/Players/Leagues/More; tapping Players shows the market region; tapping More opens a dialog containing Refresh, Export, Import, Reset with Reset last; Reset asks `window.confirm` (accept the dialog handler and assert the squad clears). On 1440×900 the tab bar is hidden and the top bar shows `Select planning Gameweek` and a "More" menu button that opens the same sheet as a popover.

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test tests/e2e/shell.spec.ts --workers=1`
Expected: FAIL (no tab bar).

- [ ] **Step 3: Implement.** `Sheet` skeleton:

```tsx
"use client";
import { useEffect, useRef } from "react";

export function Sheet({ open, onClose, title, variant = "bottom", children }: { open: boolean; onClose: () => void; title: string; variant?: "bottom" | "popover"; children: React.ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); previous?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={`sheet-backdrop ${variant}`} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} className={`sheet ${variant}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="sheet-head"><strong>{title}</strong><button type="button" className="sheet-close" aria-label={`Close ${title}`} onClick={onClose}>×</button></div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
```

CSS in `app/ui.css`: `.sheet-backdrop { position: fixed; inset: 0; z-index: 60; background: rgb(0 0 0 / .5); display: flex; }` `.sheet-backdrop.bottom { align-items: flex-end }` `.sheet.bottom { width: 100%; max-height: 80dvh; border-radius: 16px 16px 0 0; background: var(--surface); padding-bottom: env(safe-area-inset-bottom) }` `.sheet.popover { margin: 56px 18px 0 auto; width: 320px; max-height: 70vh; border-radius: 12px; background: var(--surface); align-self: flex-start }` `.sheet-body { overflow-y: auto }` `.sheet button { min-height: 44px }`. Tab bar: `.tab-bar { position: fixed; inset: auto 0 0 0; z-index: 50; display: none; height: calc(56px + env(safe-area-inset-bottom)); background: var(--surface); border-top: 1px solid var(--line) }` shown `@media (max-width: 900px) { display: grid; grid-template-columns: repeat(4, 1fr) }`, with `padding-bottom` on `.terminal-app, .leagues-app` of 64px on phones. Desktop top bar and phone header share the `TopBar` component; on phones hide the stepper/deadline row behind CSS and show "GW n · deadline" as one line.

In `TerminalApp.tsx`: replace the `<header className="topbar">…</header>` and `<nav className="mobile-tabs">` with `<TopBar …/>`, `<BottomTabBar active={store.activeMobileTab === "MARKET" ? "PLAYERS" : "SQUAD"} onSquad={() => store.setMobileTab("SQUAD")} onPlayers={() => store.setMobileTab("MARKET")} onMore={() => setMoreOpen(true)} />` and `<MoreSheet …/>`, wired to the existing `refresh`, `exportState`, `importRef`, `reset`, `reverseAllChanges`, `StrategyControls`. The `Settings` popover (`details.strategy-settings`) is removed from the squad header; its content renders in the MoreSheet `settings` slot. Keep the panel header's PICK TEAM / OPTIMIZE buttons. Update the e2e tests listed above and the "shows the xP horizon and bench strategy in optimizer Settings" / "closes the optimizer settings popover" tests to open More → settings and assert the same text/controls.

- [ ] **Step 4: Run focused, then the full e2e suite**

Run: `npx playwright test --workers=1 && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/shell app/ui.css components/terminal/TerminalApp.tsx components/leagues/LeagueScreen.tsx tests/e2e
git commit -m "feat: top bar, bottom tab bar and More sheet"
```

### Stage 1 gate

- [ ] Run `npm test && npm run typecheck && npm run lint && npm run test:e2e -- --workers=1 && npm run build`. Expected: all pass. Screenshot `/` at 390×844 and 1440×900 to `/tmp/fplshots/stage1-*.png` and look at them.

---

## Stage 2: Squad

### Task 6: Fixture chips and club colours

**Files:**
- Create: `components/terminal/fixtures/FixtureChips.tsx`, `lib/display/clubColours.ts`
- Test: `tests/ui/club-colours.test.ts`, `tests/ui/fixture-chips.test.ts`
- Modify: `app/ui.css` (`.fc`, `.fc.d1`–`.d5`, `.run`)

**Interfaces:**
- `clubColour(shortName: string): string` returns a hex; unknown names return `"#3a3f45"`.
- `fixtureLabel(f: { opponentShortName: string; isHome: boolean }): string` returns upper-case home, lower-case away (pure, exported from `FixtureChips.tsx`'s sibling `lib/display/fixtureLabel.ts` so it is testable without React).
- `<FixtureChip fixture />`, `<FixtureRun fixtures count={5} />`, `<RunStrip fixtures count={5} />` (5 bars).

- [ ] **Step 1: Failing tests**

```ts
import { clubColour } from "@/lib/display/clubColours";
import { fixtureLabel } from "@/lib/display/fixtureLabel";
it("falls back to grey for an unknown club", () => expect(clubColour("ZZZ")).toBe("#3a3f45"));
it("knows Arsenal", () => expect(clubColour("ARS")).toBe("#ef0107"));
it("upper-cases home and lower-cases away", () => {
  expect(fixtureLabel({ opponentShortName: "LEE", isHome: true })).toBe("LEE");
  expect(fixtureLabel({ opponentShortName: "LEE", isHome: false })).toBe("lee");
});
```

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run tests/ui/club-colours.test.ts tests/ui/fixture-chips.test.ts`
- [ ] **Step 3: Implement.** `clubColours.ts` is a `Record<string,string>` of the 20 current clubs using the hex values in the desktop mock (ARS `#ef0107`, BHA `#0057b8`, IPS `#3a64a3`, NEW `#2a2526`, CHE `#034694`, BRE `#e30613`, HUL `#c98a1b`, LIV `#c8102e`, MCI `#6cabdd`, BOU `#da291c`, MUN `#da291c`, NFO `#dd0000`, and the rest from the FPL bootstrap `teams` list in `tests/fixtures/fpl.ts`; any club not listed uses the fallback). Chip difficulty class is `d${difficulty ?? 3}` clamped 1–5.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `git add lib/display components/terminal/fixtures app/ui.css tests/ui && git commit -m "feat: fixture chips, run strip and club colours"`

### Task 7: Pitch, tokens, KPI strip and action sheet

**Files:**
- Create: `components/terminal/squad/SquadKpis.tsx`, `SquadPitch.tsx`, `PitchToken.tsx`, `PlayerActions.tsx`
- Modify: `components/terminal/TerminalApp.tsx` (replace the `squad-sections` block at ~1317–1328, `MetricStrip`, `SquadSlot`/`MobileLineupBar` usage; delete `SquadSlot`, `MobileLineupBar`, `MetricStrip`, `SquadFixtureBadges` once unused), `app/ui.css`
- Modify tests that use `article.squad-slot`, `.slot-xp`, `.squad-fixture-badges`, `.starting-xi .slot-main`, `.live-metrics`: `tests/e2e/fpl-terminal.spec.ts`, `weekly-lineup.spec.ts`, `planning-gameweek.spec.ts`, `chips.spec.ts` → use `[data-testid="squad-token"][data-player="<name>"]`, `[data-testid="token-xp"]`, `[data-testid="token-fixture"]`. Assertions stay identical.
- Test: `tests/e2e/squad-pitch.spec.ts`

**Interfaces:**
- `PitchToken` props: `{ player: TerminalPlayer; gameweek: number; role: "starter" | "bench"; benchLabel?: string; captain: boolean; vice: boolean; locked: boolean; chip?: ChipKind | null; selected: boolean; swapTarget: boolean; showRun: boolean; onOpen: () => void }`. Renders `<button data-testid="squad-token" data-player={displayName} aria-pressed={selected} aria-label={...}>` containing shirt (club colour + short name), `C`/`V` badge, `!` flag when `availabilityOf(player) !== "AVAILABLE"`, lock glyph, name, `<span data-testid="token-fixture">` (a `FixtureChip` per fixture in the GW, or "BLANK") and `<b data-testid="token-xp">` showing `weeklyPlayerMetrics(...).points * captainMultiplier` formatted with `points()`; the run strip when `showRun`.
- `SquadPitch` props: `{ starters: TerminalPlayer[]; bench: Array<{ player?: TerminalPlayer; position: Position; label: string }>; …handlers; empty: (position: Position) => ReactNode }` and renders `<section aria-label="Starting XI" data-testid="squad-roster">` (rows GK/DEF/MID/FWD) and `<section aria-label="Bench">`. Empty slots render `EmptySlot` unchanged in behaviour.
- `PlayerActions` props: `{ player; starter: boolean; benchLabel?: string; benchIndex: number; captain; vice; locked; lineupActive; sellingPriceTenths?; onClose; onInfo; onCaptain; onViceCaptain; onSwap; onMoveBench(direction: -1 | 1); onToggleLock; onRemove }`. Wraps `Sheet` (variant `"bottom"` when `useMatchMedia("(max-width: 900px)")`, else `"popover"`). Buttons keep the exact aria-labels from the old `MobileLineupBar` / `SquadSlot` ("Make X captain", "Make X vice-captain", "Select X to move to bench", "Select X to move into the starting XI", "Move X up the bench order", "Move X down the bench order", "Open X details", "Lock X"/"Unlock X", "Remove X"). Remove is `disabled` for a locked player.
- `SquadKpis` props: `{ projected: number | undefined; gameweek: number; value: number; bankSlot: ReactNode; freeTransfers: number | undefined; rating: number | undefined }`, `aria-label="Squad projection metrics"`. `bankSlot` is the existing `BankMetric` (kept in `TerminalApp.tsx` or moved verbatim to `components/terminal/squad/BankMetric.tsx` with its exports `parseBankInput`/`steppedBankText` re-exported from `TerminalApp.tsx` so `tests/ui/bank-input.test.ts` keeps passing).

- [ ] **Step 1: Write the failing browser test** (`squad-pitch.spec.ts`, import-a-team setup): at 390×844 all 15 `squad-token`s are fully inside the viewport (bounding box within `0..844 - 56`), the captain's token contains `C`, and no descendant of the squad panel has `scrollHeight > clientHeight + 1` with `overflow-y` auto/scroll. At 1440×900 each token has a `.run` strip. Clicking the captain-candidate token opens a dialog named after the player with a "Make X captain" button; clicking it moves the `C` badge and survives `page.reload()`. Swap: click a starter → "Select X to move to bench" → click a bench token → the dialog opens for the bench token → "Select Y to move into the starting XI" completes the swap (assert Y is now in `region "Starting XI"`). Esc closes the sheet and focus returns to the token. A locked player's Remove button is disabled.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Pitch CSS (in `app/ui.css`): `.pitch { position: relative; background: repeating-linear-gradient(180deg,#12301f 0 56px,#143522 56px 112px); border-radius: 12px; display: grid; grid-template-rows: repeat(4, 1fr); padding: 14px 8px; min-height: 372px }` desktop `min-height: 448px`; `.pitch-row { display: flex; justify-content: space-evenly; align-items: flex-start }`; `.token { width: 76px }` desktop `100px`; shirt/arms/badge styles copied from `/tmp/fplshots/desk.html` (`.shirt`, `.cap`, `.flag`, `.nm`, `.xp`). Starter rows come from `currentGWPlan.starterIds` grouped by position (as the old code did) or the draft `byPosition` slices. In `TerminalApp.tsx`, keep `renderSquadPlayer`'s logic, but have it return `PitchToken`; `activateSquadSlot` now sets `actionPlayerId` state, and `<PlayerActions>` renders for that player on both phone and desktop (the desktop branch that called `openPlayer` is dropped; "Open X details" calls `openPlayer`). The two-step swap highlight uses `swapTarget` (tokens on the opposite side of the pending `gwSwapSelection`) and an instruction line above the pitch: "Tap a bench player to swap with Y".
- [ ] **Step 4: Run focused then the full e2e suite.** `npx playwright test --workers=1`. Expected PASS with the edited selectors.
- [ ] **Step 5: Commit** `git add components/terminal app/ui.css tests/e2e && git commit -m "feat: pitch view, KPI strip and player action sheet"`

### Task 8: Squad table view and switch

**Files:**
- Create: `components/terminal/squad/SquadTable.tsx`
- Modify: `components/terminal/TerminalApp.tsx` (switch in squad header; render `SquadTable` when `store.squadView === "TABLE"`), `app/ui.css`
- Test: add cases to `tests/e2e/squad-pitch.spec.ts`

**Interfaces:**
- `SquadTable` props: `{ starters: TerminalPlayer[]; bench: Array<{ player?: TerminalPlayer; label: string }>; gameweek: number; captainId?: number; viceCaptainId?: number; chip?: ChipKind | null; onOpen: (player: TerminalPlayer) => void }`. A `<table aria-label="Squad table">`; columns Pos, Player (C/V/! badges), £m, Next, GW, 3GW, 5GW, Start, Form, Run. GW for the captain is the raw xP (not doubled) with the C badge, matching the mock. Bench rows follow a `Bench` divider row and are dimmed. Each row is a `<button>`-in-cell that calls `onOpen`.

- [ ] **Step 1: Failing test:** the Pitch/Table switch (`role="group" aria-label="Squad view"` with buttons "Pitch" and "Table") flips views, the table has 15 body rows plus the divider, the choice survives reload, and clicking a row opens the same action dialog.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** as above; 3GW/5GW use `projectedPointsForGameweeks(player.projection.fixtures, gameweek, n)`; Start uses `weeklyPlayerMetrics`' start probability if exposed, else `player.selection?.startProbability`; start under 80% gets class `warn`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `git add components/terminal/squad components/terminal/TerminalApp.tsx app/ui.css tests/e2e && git commit -m "feat: squad table view"`

### Task 9: Decision rail and three/two-column layout

**Files:**
- Create: `components/terminal/rail/DecisionRail.tsx`, `CaptainSection.tsx`, `AlertsSection.tsx`
- Modify: `components/terminal/TerminalApp.tsx` (grid, rail, move `ChipSelector` and `TransferSuggestionsPanel` and `ChipStrategyPanel` into the rail, remove the planning toolbar), `components/terminal/ChipPanels.tsx` (used chips show "Used GW n" text; remove tooltip-only explanation; a chip both pressed and disabled renders disabled only), `app/ui.css`, `store/terminalStore.ts` (none)
- Test: `tests/e2e/decision-rail.spec.ts`; update `tests/e2e/chips.spec.ts` if the chip selector's container changes (aria group name stays)

**Interfaces:**
- `CaptainSection` props: `{ starters: TerminalPlayer[]; gameweek: number; captainId?: number; viceCaptainId?: number; onChange: () => void }` shows the top four by `weeklyPlayerMetrics(...).points` as bars.
- `AlertsSection` props: `{ alerts: SquadAlert[]; onOpen: (playerId: number) => void }` with the empty copy "Nothing needs a look this week."
- `DecisionRail` props: `{ captain: ReactNode; alerts: ReactNode; transfers: ReactNode; chips: ReactNode }`, a `<aside aria-label="Decision rail">`.
- Layout: `.terminal-grid` columns `var(--market-column) var(--squad-column) 296px` at ≥ 1400px; at 901–1399px the rail renders inside the squad column under the bench (same component, CSS `order`/grid placement; do not render it twice). `panelRatios`, collapse and resize stay on market/squad only.

- [ ] **Step 1: Failing test:** at 1440×900 `getByRole("complementary", {name:"Decision rail"})` is visible beside the squad (its box right of the squad box, no overlap), shows Captain, "Needs a look", "Transfers" region (`/^transfer suggestions$/i`) and Chips; at 1280×720 the rail box is below the bench box and no two of players/squad/rail overlap; the doubtful-bench alert appears for the fixture's doubtful player and clicking it opens that player's action dialog; used chips show "Used GW" text visibly.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** In `TerminalApp.tsx` compute `const alerts = useMemo(() => currentGWPlan ? squadAlerts({ squad: selected, starterIds: currentGWPlan.starterIds, benchOrder: [...currentGWPlan.benchOrder], benchGoalkeeperId: currentGWPlan.benchGoalkeeperId, gameweek: planningGameweek }) : [], [...])`. The GW stepper already lives in `TopBar` (Task 5), so delete `.planning-toolbar` JSX but keep `store.planNotice` rendering. Update the e2e test that asserts the planning toolbar (`planning-gameweek.spec.ts` "select planning gameweek" group lookups still resolve via the top bar group of the same name).
- [ ] **Step 4: Run the full e2e suite.** `npx playwright test --workers=1`. Expected PASS.
- [ ] **Step 5: Commit** `git add components/terminal app/ui.css tests/e2e && git commit -m "feat: decision rail and desktop layout"`

### Stage 2 gate

- [ ] Run all five gates. Screenshot `/` at 390×844, 1280×720, 1440×900 to `/tmp/fplshots/stage2-*.png` and compare by eye to `/tmp/fplshots/desk.html` and the option-B phone mock. Fix visible mismatches before moving on.

---

## Stage 3: Players

### Task 10: Desktop players table and Columns menu

**Files:**
- Create: `components/terminal/players/PlayersTable.tsx`, `components/terminal/players/ColumnsMenu.tsx`
- Modify: `components/terminal/TerminalApp.tsx` (replace the `<table className="player-table">` block and `PlayerRow`), `app/ui.css`
- Test: `tests/e2e/players-table.spec.ts`; update `tests/e2e/fpl-terminal.spec.ts` "keeps the player universe dense…" and "keeps the squad header on two lines and the market table inside its pane" (`.table-wrap`) to the new markup with the same assertions.

**Interfaces:**
- `PlayersTable` props: `{ rows: TerminalPlayer[]; weeks: Map<number, UniverseWeekMetrics>; gameweek: number; columns: PlayerColumnKey[]; sortKey: SortKey; sortDirection: "asc" | "desc"; onSort(key: SortKey): void; inSquadIds: ReadonlySet<number>; onOpen(id: number): void; onAdd(player: TerminalPlayer): void }`. Fixed columns: Player (name button, "CLUB · POS"), £m, GW xP, Next 5 (five `FixtureChip`s), Add. Optional via `columns`: Own, Form, 3GW, 5GW, Start, and the hidden-by-default 5GW/£ (`value5`), 10GW (`next10`), 10GW/£ (`value10`), xGI/90 (`xgi`). Each header is a `SortableHead`; the active one amber. Squad members dimmed with "In" in place of the add button (button keeps `aria-label="Add Haaland"` and `disabled`, text "In"). Sticky header; body scrolls inside `.table-wrap` (keep that class for the existing tests).
- `ColumnsMenu` props `{ columns: PlayerColumnKey[]; onChange(keys: PlayerColumnKey[]): void }`: a `Sheet` popover with a checkbox per optional column, label text e.g. "5GW xP / £".

- [ ] **Step 1: Failing test:** at 1440×900 default headers include Own, Form, GW, 3GW, 5GW, Start, Next 5 and not xGI/90; ticking xGI/90 in Columns adds it and survives reload; clicking the `3GW` header sorts descending by that column (first row's 3GW ≥ second's); squad members show "In"; start under 80% has class `warn`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `PlayerRow` is replaced; `universeWeekFor` already returns `next3` (Task 3).
- [ ] **Step 4: Run the full e2e suite.** Expected PASS.
- [ ] **Step 5: Commit** `git add components/terminal app/ui.css tests/e2e && git commit -m "feat: dense players table with a Columns menu"`

### Task 11: Filter sheet and phone player list

**Files:**
- Create: `components/terminal/players/FilterSheet.tsx`, `components/terminal/players/PlayerList.tsx`, `components/terminal/players/ActiveFilters.tsx`
- Modify: `components/terminal/TerminalApp.tsx` (replace `FilterBar` and the market header controls), `app/ui.css`
- Test: `tests/e2e/players-filters.spec.ts`; extend `tests/e2e/ui-foundations.spec.ts` with the Players-tab 12px check and "first player row above the fold on 390×844"

**Interfaces:**
- `FilterSheet` props `{ open; onClose; filters: TerminalFilters; setFilters(f: Partial<TerminalFilters>): void; clubs: string[]; onReset(): void }`: holds price min/max, ownership min/max, club, availability, confidence, risk, the six quick filters, "Affordable only", "Hide selected", and a "Reset filters" button. Every control keeps its current `aria-label` (e.g. "Minimum price", "Filter by club").
- Always visible above the list (both layouts): search (`aria-label="Search players"`, ref kept for `/`), position segmented control (`role="group" aria-label="Filter by position"`, buttons All/GK/DEF/MID/FWD), "Filters · n" button (n = count of non-default filters), and on desktop an "Available" toggle plus price and club drop-downs. `ActiveFilters` renders removable chips under the row.
- `PlayerList` props `{ rows; weeks; gameweek; inSquadIds; onOpen(id); onAdd(player) }`: row = name, "MID · ARS · £9.6 · 14% owned", four fixture chips, GW xP at 17px, a 40px Add button with `aria-label="Add X"`.
- `TerminalApp` renders `PlayerList` below 901px and `PlayersTable` above (use the existing `useMatchMedia`).

- [ ] **Step 1: Failing tests:** phone first player row top < 844 − 56; "Filters" opens a dialog; setting max price there filters rows and shows an active chip; removing the chip clears it; `/` still focuses search on desktop; the hidden selects no longer sit on the first screen.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `choosePlayer(position)` (from an empty token) still sets `position` and `maxPrice` filters, then `setMobileTab("MARKET")`.
- [ ] **Step 4: Run the full e2e suite, adjusting tests that found `select[aria-label=…]` on the main page to open the sheet first (same assertions).**
- [ ] **Step 5: Commit** `git add components/terminal app/ui.css tests/e2e && git commit -m "feat: filter sheet and phone player list"`

### Stage 3 gate

- [ ] All five gates; screenshots at three sizes; compare with the mocks.

---

## Stage 4: Leagues

### Task 12: Leagues phone changes and tokens

**Files:**
- Modify: `components/leagues/LeagueScreen.tsx`, `components/leagues/MyLeaguesPanel.tsx`, `components/leagues/LiveFeed.tsx`, `app/ui.css`
- Test: `tests/e2e/leagues.spec.ts` (edit only markup-following lines), `tests/e2e/ui-foundations.spec.ts` (add `/leagues` 12px check)

**Interfaces:**
- Phone only (≤ 900px): header shows a league drop-down button ("Chelsea ▾") that opens `Sheet` containing `MyLeaguesPanel` (the region name `My leagues` is preserved inside it); standings render first under a stats row; the existing four tabs render as a segmented control with the same `leagues-mobile-tabs` class and button names (LEAGUE, TEAM, MATCHES, FEED). `BottomTabBar active="LEAGUES"` (Task 5). Desktop layout unchanged apart from tokens.
- `LiveFeed`: omit the "GW" label per row and omit the league-impact line when its value is `0` / `0.0` (both only in the rendered output; data and `feedEvents` untouched).

- [ ] **Step 1: Failing tests:** at 390×844 the standings table's first row is above the fold; the league drop-down opens a dialog containing the "My leagues" region; a feed row with zero impact has no "League impact" text; the page passes the 12px check; the tab bar's Leagues item is current (`aria-current="page"`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Check `LeagueScreen.tsx` lines 361–440 for the tab and column structure; keep all `data-testid` and `aria-label` values.
- [ ] **Step 4: Run the full e2e suite.** Expected PASS, including every existing Leagues test.
- [ ] **Step 5: Commit** `git add components/leagues app/ui.css tests/e2e && git commit -m "feat: leagues phone layout, tab bar and quieter feed"`

### Task 13: Docs and final verification

**Files:**
- Modify: `AGENTS.md` (Responsive Terminal Design bullet; Code Map additions), `agent_docs/project_structure.md`, `agent_docs/project_progress.md`, `agent_docs/latest_session_work.md`
- Test: none new

- [ ] **Step 1:** In `AGENTS.md`, change the Responsive Terminal Design bullet to: "Test both desktop (1280×720) and mobile (390×844) viewports. Maintain the dark, dense terminal look: design tokens in `app/globals.css`, Geist for labels, mono for numbers, a 12px text floor on phones, the squad drawn as a pitch with a table alternative, thin scrollbars, clear status tones." Add the new component folders and `lib/analysis/squadAlerts.ts`, `lib/availability/status.ts`, `lib/display/` to the Code Map. Update the three `agent_docs` files with verified facts only.
- [ ] **Step 2:** Run `npm test && npm run typecheck && npm run lint && npm run test:e2e -- --workers=1 && npm run build`. Expected: all pass (the build keeps its five existing tracing warnings).
- [ ] **Step 3:** Screenshot `/` and `/leagues` at 390×844, 1280×720, 1440×900. Read each image and check against the mocks.
- [ ] **Step 4:** Write the PR description listing every edited test file and why. Commit docs.

```bash
git add AGENTS.md agent_docs
git commit -m "docs: record the pitch UI structure"
```

- [ ] **Step 5:** Ask the user before pushing or opening a PR.
