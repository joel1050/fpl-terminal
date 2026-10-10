# Pitch UI redesign: design spec

Date: 2026-10-06
Status: draft for review
Mock-ups: `/tmp/fplshots/review-paths.html` (audit and phone options A/B/C),
`/tmp/fplshots/desk.html` (desktop). Both are local files, not in the repo.

## Intent

The user said the UI "looks bad", with mobile the worst part. After seeing three
directions they chose **B's pitch with A's dark, dense lists**: the squad shows
as a pitch, everything else stays a dense dark table. On a phone the screens
stay lean. On desktop every number comes back.

Success means:

1. On a 390×844 phone, the Squad tab shows all 11 starters, the captain and
   the bench without an inner scroll area. The Players tab shows a player row
   on the first screen.
2. At 1440×900, one screen shows the players table (price, ownership, form,
   GW/3GW/5GW xP, start chance, next five fixtures), the squad on a pitch,
   and a rail with captain, availability, transfers and chips.
3. At 1280×720 the same parts fit side by side without overlap. The rail moves
   under the bench.
4. No text under 12px on phones. Body text is 13–15px.
5. Each colour has one meaning across both workspaces.
6. All behaviour stays as it is: squad rules, lineup edits, captaincy,
   transfers, chips, the optimizer and persistence. This is a presentation
   change. No change to `lib/` maths or the store's saved shape.

## Problems this fixes (from the audit)

- Nested scroll on the phone Squad tab: 719px of content in a 409px box hides
  the captain and the bench.
- 119 font sizes at 7–9px; mostly upper-case with wide letter spacing.
- Phone Players tab: about 830px of filters before the first player.
- Phone chrome: three rows of navigation, with Reset beside Refresh.
- Amber means everything; cyan and amber change meaning between screens.
- The squad has no shape: bordered boxes rather than a formation.
- Projected points look the same size as money in the bank.
- 261 tap targets under 32px on the phone Players tab.
- Used chips explain themselves only on hover.
- Leagues on a phone puts a 9-row league picker before the standings.

## Visual system

Tokens live in `app/globals.css` `:root`, replacing the current ad-hoc values.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0b0c0e` | page |
| `--surface` | `#131519` | cards, KPI strip, bench strip |
| `--surface-2` | `#16181c` | inputs, segmented controls |
| `--line` | `#1b1e22` | column dividers, row rules |
| `--text` | `#e9ebee` | body |
| `--muted` | `#8b929a` | labels, secondary text |
| `--accent` | `#f5b301` | captain, active sort, primary action, selected tab. Nothing else. |
| `--warn` | `#f97316` / text `#fb923c` | availability doubt ("!"), start chance under 80% |
| `--good` | `#4ade80` | team rating meter, positive deltas, live status |
| `--bad` | `#f87171` | negative deltas, errors, Reset |
| FDR 1–5 | green → grey → orange → red | fixture difficulty only |

Type: Geist (already loaded as `--font-prose`) for names, labels and
headings; IBM Plex Mono (`--font-mono`) for numbers only, with tabular
figures. Sentence case for labels; no all-caps on data. Sizes: 12px floor on
phones, 11.5px floor on desktop table headers, 13–15px body, 28px for the
headline projection.

Borders: one 1px line between columns and between table rows. No borders on
cards, badges, fixture chips or stat cells; use surface colour instead.

Tap targets: 40px minimum on phones.

Fixture notation, used everywhere: upper case is home (`LEE`), lower case is
away (`liv`), background is difficulty.

## Layout

### Breakpoints

| Width | Layout |
|---|---|
| ≥ 1400px | Three columns: players (668px) · squad (flexible) · rail (296px) |
| 901–1399px | Two columns: players (flexible, min 520px) · squad (480px). The rail stacks under the bench inside the squad column. The players table hides Own and Form below 1180px. |
| ≤ 900px | Phone layout: one screen per tab, bottom tab bar |

The existing panel collapse and drag-to-resize controls stay on the
players/squad divider at widths above 900px, with their accessible names
unchanged. The rail has a fixed width and no controls of its own.

At 720px tall the squad column scrolls as one panel. No element inside it
gets its own scroll area, except the players table body on desktop, which
scrolls under a sticky header.

### Desktop top bar (> 900px)

One 52px row: brand · Planner/Leagues switch · planning GW stepper (‹ GW 6 ›)
· deadline ("Sat 10 Oct, 11:00 · 3d 5h") · data status · spacer · Refresh ·
overflow menu (⋯).

The overflow menu holds Export, Import, optimizer settings (horizon, bench
strategy), "Reverse all changes" and Reset. Reset sits last, in red, behind
the existing confirm dialog.

"Pick team" and "Optimize" (or "Complete squad" for a draft) stay in the
squad panel header, with those names, so they sit next to what they change.
"Optimize" is the one amber button.

The GW stepper replaces the "PLAN ← GW → LIVE GW" toolbar in the squad panel.
The chip selector moves to the rail's Chips section.

### Phone layout (≤ 900px)

- A slim header per tab (title, one line of context, at most one action).
- A fixed bottom tab bar on both routes: **Squad · Players · Leagues · More**.
  On `/leagues` the Leagues tab is active; Squad and Players link back to `/`
  and open that tab.
- **More** opens a bottom sheet with Refresh, Export, Import, optimizer
  settings, Reverse all changes, a link to the mode chooser, and Reset (last,
  red, confirmed).
- The `.mobile-tabs` SQUAD/MARKET bar and the top-row action buttons are
  removed. `activeMobileTab` keeps its "SQUAD" | "MARKET" values; "MARKET"
  now means the Players tab.

## Squad panel

### KPI strip

Five cells: **Proj. GW n** (28px mono, the headline) · Value · Bank
(the existing editable `BankMetric`, unchanged behaviour) · Transfers (free
transfers, e.g. "1 FT") · Rating (percentage plus a thin meter). Risk moves
out of the strip; doubtful players appear in "Needs a look" instead.
The strip keeps `aria-label="Squad projection metrics"`.

### Pitch view (default)

- Four lines (GK, DEF, MID, FWD) on a striped green pitch, evenly spaced.
- Each token: shirt in club colour with the short name, C/V badge on the
  shirt, orange "!" when doubtful or unavailable, name pill, next fixture
  chip with GW xP, and a five-bar fixture strip (desktop only).
- The captain's token shows multiplied xP (2× or 3× with Triple Captain), as
  the current slot does. A caption above the pitch says so on desktop
  ("Captain counts double: Haaland 5.6 → 11.2").
- Bench strip below: GK, 1st, 2nd, 3rd, same token at lower opacity.
  With Bench Boost active the bench tokens show full opacity and "Counts".
- Lock state shows as a small lock on the shirt.
- Draft squads (fewer than 15) show empty tokens: "+ DEF, max £5.5" that open
  the Players tab filtered to that position and price, as `EmptySlot` does now.
- The pitch keeps `data-testid="squad-roster"` and the "Starting XI" and
  "Bench" region names.

Phone: tokens are 76px wide, xP only (no fixture strip), and the whole squad
fits in 844px with the tab bar.

### Player actions

Selecting a token opens one action sheet. It is a bottom sheet on phones and
a popover anchored to the token on desktop. It replaces both the desktop
C/VC/B buttons on each card and `MobileLineupBar`. Contents:

- Name, club, price (selling price for imported squads), GW xP.
- Starters: Captain, Vice-captain, Move to bench.
- Bench: Move into XI, ↑ / ↓ bench order.
- Always: Details (opens the existing player dialog), Lock/Unlock, Remove.

Swaps keep today's two-step flow: choose "Move to bench" on a starter, then
tap a bench token (or the reverse). Tokens that can complete the swap are
highlighted, and an instruction bar says what to tap next.

Every action keeps its current accessible name ("Make Haaland captain",
"Select Haaland to move to bench", "Lock Haaland", "Remove Haaland", …), so
existing tests and screen readers still find them.

### Table view

A Pitch/Table switch in the squad header. Table columns: Pos, Player (with
C/V/! badges), £m, Next, GW, 3GW, 5GW, Start, Form, Run (five-bar strip).
Bench rows sit under a "Bench" divider, dimmed. Rows open the same action
sheet. The choice is saved as `squadView: "PITCH" | "TABLE"` in the store's
persisted UI fields (an optional field; older saves default to "PITCH").

## Decision rail

Four sections, top to bottom. At 901–1399px they stack under the bench; on
phones they appear under the bench on the Squad tab, below the fold.

1. **Captain**: the top four starters by GW xP as bars, with C and V marked.
   "Change" opens the action sheet for the current captain.
2. **Needs a look**: up to five alerts, worst first:
   - a starter or bench player who is doubtful or unavailable (status and
     chance, expected minutes, bench position);
   - the starter with the hardest next-five run, when that run's average
     difficulty is 3.6 or worse (with the five fixtures and 5-GW xP);
   - a blank or double gameweek for any squad player in the planning GW.
   An empty list says "Nothing needs a look this week."
3. **Transfers**: the existing transfer suggestions panel, restyled. Keeps
   the 1/3/5/10 GW horizon, the banked-transfers choice, Simulate and
   Dismiss, and its region name. The simulation result opens as a dialog over
   the squad column, as now.
4. **Chips**: the existing chip selector and chip strategy panel, restyled.
   Used chips show struck through with "Used GW n" as visible text, not a
   tooltip. A chip that is both planned and unavailable shows as unavailable
   only.

The alert rules are domain logic, so they go in
`lib/analysis/squadAlerts.ts` as a pure function:

```ts
squadAlerts(input: {
  squad: Player[];
  starterIds: number[];
  benchOrder: number[];
  benchGoalkeeperId: number;
  gameweek: number;
}): SquadAlert[]
```

`SquadAlert` is added to `types/analysis.ts`. It reuses the availability
rule now in `TerminalApp.tsx` (`availabilityOf`), which moves to
`lib/availability/status.ts` so the players table and the alerts share it.

## Players panel

### Desktop table

Columns: Player (name, club · position), £m, Own, Form, GW xP, 3GW, 5GW,
Start, Next 5 (five fixture chips), Add. Sort works on every numeric column,
with the active header in amber. Squad members are dimmed and show "In"
instead of +. Start chance under 80% shows in orange.

Columns removed from the default view: XP5/£, XP10, XP10/£ and xGI/90.
They come back through a "Columns" menu (checkbox list, saved in the store
as `playerColumns`, optional, defaulting to the set above). Sort keys stay
as they are. A new `next3` sort key is added for the 3GW column.

Filters on desktop: search, a position segmented control, Price, Club, an
"Available" toggle, and "More filters". "More filters" opens the same filter
sheet the phone uses, holding ownership, confidence, risk, the quick filters,
"affordable only" and "hide selected". Active filters show as removable
chips under the filter row.

### Phone list

One row per player: name, "MID · ARS · £9.6 · 14% owned", four fixture
chips, GW xP (17px) and an Add button (40px). Above the list: search, the
position segmented control, a "Filters · n" button that opens the filter
sheet, and a sort line ("Sorted by GW xP ▾").

The table and list render up to 250 rows, as now.

## Leagues

Leagues gets the shared tokens, type scale and bottom tab bar, plus three
phone changes:

1. Standings come first. The league picker becomes a drop-down in the
   header ("Chelsea ▾"), and "My leagues" moves into it.
2. The in-page tabs (League · Team · Matches · Feed) become a segmented
   control under the header, with the same four views and the same
   `leagues-mobile-tabs` hooks.
3. The feed drops the repeated "GW" label, and hides the "League impact"
   line when the change is 0.0.

The desktop Leagues layout keeps its current structure; only tokens and type
change. A fuller Leagues redesign is a separate spec.

## Components

`TerminalApp.tsx` is 2,020 lines. The redesign splits it along the new parts.
The data hooks, handlers and normalisation stay in `TerminalApp.tsx` for
this change; only rendering moves out.

```text
components/
├── shell/
│   ├── TopBar.tsx            # desktop top bar, GW stepper, overflow menu
│   ├── BottomTabBar.tsx      # phone tab bar, shared by both routes
│   └── Sheet.tsx             # bottom sheet / popover primitive (dialog, focus trap, Esc)
├── terminal/
│   ├── squad/
│   │   ├── SquadKpis.tsx     # KPI strip (wraps existing BankMetric)
│   │   ├── SquadPitch.tsx    # pitch + bench
│   │   ├── PitchToken.tsx
│   │   ├── SquadTable.tsx
│   │   └── PlayerActions.tsx # action sheet / popover
│   ├── rail/
│   │   ├── DecisionRail.tsx
│   │   ├── CaptainSection.tsx
│   │   └── AlertsSection.tsx
│   ├── players/
│   │   ├── PlayersTable.tsx
│   │   ├── PlayerList.tsx    # phone rows
│   │   └── FilterSheet.tsx
│   └── fixtures/
│       └── FixtureChips.tsx  # chip, run strip, notation
lib/
├── analysis/squadAlerts.ts
├── availability/status.ts    # availabilityOf, moved from TerminalApp
└── display/clubColours.ts    # short name → shirt colour, grey fallback
```

`PlayerDetail`, `PointsBreakdown`, `SimulationPanel`, `TransferSuggestionsPanel`
and the chip panels keep their logic; they get the new tokens and lose their
inline styles.

## Testing

Unit (Vitest):

- `squadAlerts`: doubtful starter, doubtful bench player, unavailable
  player, hardest-run threshold (3.6 in, 3.5 out), blank and double GW,
  ordering, the five-alert cap, the empty case.
- `availabilityOf` after the move: the existing cases, unchanged.
- Store: `squadView` and `playerColumns` persist, and older saves without
  them load with the defaults.

Browser (Playwright), all at 1440×900, 1280×720 and 390×844:

- Phone Squad tab: all 15 tokens and the captain badge are inside the
  viewport with no scrollable descendant of the squad panel
  (`scrollHeight > clientHeight` on no element inside it).
- Phone Players tab: the first player row is above the fold.
- No visible text under 12px on phone screens (computed font size of every
  visible text node).
- 1280×720: players, pitch and rail have no overlapping bounding boxes.
- The action sheet sets captain, vice-captain, swaps and reorders the bench,
  and the result survives a reload.
- More sheet: Refresh, Export, Import and Reset work; Reset still asks first.
- Pitch/Table switch persists across reload.

Existing browser tests: tests that find elements by role, label or test id
must pass unchanged, apart from those that drive the removed SQUAD/MARKET
bar or the old top-row actions, which move to the bottom tab bar and More
sheet. Tests that find elements by CSS class
(`.slot-xp`, `article.squad-slot`, `.squad-fixture-badges`,
`.strategy-popover`, `summary.compact-action`, `.topbar-stats`,
`.mobile-tabs`) are updated to the new markup with the same assertions. No
assertion is removed or loosened. Where a test checks a layout that no
longer exists (for example "puts the planner header on one line without the
gameweek readout"), it is rewritten to check the new layout's equivalent,
and the change is listed in the PR.

Gates before merge: `npm test`, `npm run typecheck`, `npm run lint`,
`npm run test:e2e`, `npm run build`, plus screenshots at the three sizes
compared by eye against the mock-ups.

## Delivery

Four stages on one branch, each leaving the app working and the gates green:

1. **Foundations**: tokens, type, `Sheet`, `TopBar`, `BottomTabBar`, More
   sheet. Old panels restyled with the tokens only.
2. **Squad**: KPI strip, pitch, bench, action sheet, table view, the
   rail with `squadAlerts`, and the three-column and two-column layouts.
3. **Players**: desktop table, Columns menu, phone list, filter sheet.
4. **Leagues**: the three phone changes and the shared tab bar.

`AGENTS.md`'s design line changes from "compact typography" to "compact
typography with a 12px floor on phones" and adds "the squad renders as a
pitch". The `agent_docs` structure notes gain the new component folders.

## Out of scope

- Drag-to-swap on the pitch (the action sheet covers it; drag can follow).
- A light theme.
- Desktop Leagues layout changes.
- Any change to projections, the optimizer, squad rules or saved-state
  format beyond the two optional UI fields.
