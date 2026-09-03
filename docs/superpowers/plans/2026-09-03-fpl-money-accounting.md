# FPL Money Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every money figure in the planner reflect real FPL purchase prices, the official selling rule, and the real bank — and say so plainly when it cannot.

**Architecture:** Purchase prices arrive from two upstream sources: `element_in_cost` on the transfers endpoint (exact, already used) and per-gameweek `value` rows on the element-summary endpoint (recovers the opening squad). A checksum against `entry_history.value` verifies the reconstruction and downgrades `financialConfidence` when it disagrees. The corrected `TransferBaseline` then feeds the bank shown as ITB, the squad add guard, and transfer suggestions, replacing three places that currently substitute today's market price for a purchase price.

**Tech Stack:** TypeScript (strict), Next.js App Router, Zustand, Zod, Vitest, Playwright.

**Spec:** No separate spec document. The design was agreed in conversation and is restated in "Background" below; this plan is self-contained.

## Global Constraints

- Money is always integer tenths. Never floating point. `105` means £10.5m. (`AGENTS.md`, Domain Invariant 1)
- Shared calculations belong in `lib/`, never in UI components. (`AGENTS.md`, Agent Change Guidelines)
- Never hand-edit generated JSON in `data/` or mock fixtures to make a test pass. Fix the generator or normalization instead.
- No database, external authentication, or background daemon. This rules out `/api/my-team/{id}/`, which would give purchase prices directly but needs the user's FPL login.
- Node 20.9+.
- Verification before any task is called done: `npm test`, `npm run typecheck`, `npm run lint`.
- **Another Claude session edits this checkout live.** Work in a git worktree (`superpowers:using-git-worktrees`) and stage explicit paths — never `git add -A`. Line numbers in this plan drift; locate code by symbol name.

---

## Background: the three defects

**1. Import records today's price as the purchase price for the opening squad.** `app/api/fpl/entry/[id]/route.ts` builds `priceById` from `element.now_cost` and passes that same map as `initialPricesTenths` to `reconstructImportBaseline`. That function only downgrades to `ESTIMATED` when a price is *missing*; a present-but-wrong price keeps `EXACT`. Players transferred in get genuinely exact prices from `elementInCost`; players held since GW1 get a phantom.

Verified against the repo snapshots:

```
player 115: GW1 value 45 · GW2 value 46 · now_cost 47
player 112: GW1 value 50 · GW2 value 50 · now_cost 49
```

Player 115 held since GW1 has purchase price 45. Import records 47. Real selling price is `45 + floor(2/2) = 46`; the app credits 47. Player 112 is a faller, harmless — only risers produce phantom money.

**2. ITB is computed from market prices.** The metric strip shows `budgetTenths − Σ currentPrice`, which equals `bank + Σ(sellingPrice − currentPrice)`. Since `sellingPrice ≤ currentPrice` always, displayed ITB understates the real bank. Meanwhile the add guard calls `explainIllegalSelection` with no options at all, so it enforces a hardcoded £100.0m regardless of the imported budget.

**3. Transfer suggestions ignore selling prices.** `findBestSingleTransfers` computes `cashReleasedTenths = outgoing.priceTenths - incoming.priceTenths` and checks legality with `Σ currentPrice(after) ≤ budgetTenths`. The real constraint is `currentPrice(in) ≤ bank + sellingPrice(out)`.

**The checksum.** FPL publishes the answer key: `entry_history.value == bank + Σ sellingPriceTenths(purchase_i, current_i)`, for every gameweek in `history.current[]`. A GW1 snapshot satisfies it trivially (`bank 10, value 1000`, squad costing 990, purchase equals current).

**A deliberate asymmetry:** the checksum only ever *downgrades* confidence. Aggregate agreement does not prove per-player correctness — two errors can cancel — and per-player prices are what individual transfers depend on. `EXACT` is earned by per-player provenance in Tasks 1–2, never by a matching sum.

---

## File Structure

**Create:**
- `lib/chips/openingPrices.ts` — read a player's price at a given gameweek from element-summary history. Pure; no fetching.
- `lib/chips/verifyBaseline.ts` — the `value == bank + Σ sellingPrice` checksum and the confidence downgrade.
- `tests/chips/openingPrices.test.ts`
- `tests/chips/verifyBaseline.test.ts`

**Modify:**
- `lib/chips/importTeam.ts` — take per-player provenance so a current-price stand-in marks `ESTIMATED`.
- `app/api/fpl/entry/[id]/route.ts` — fetch opening prices for never-transferred players; run the checksum.
- `lib/analysis/context.ts` — add `purchasePricesTenths` and `bankTenths` to `CommonOptions`.
- `lib/analysis/singleTransfers.ts` — selling-price-aware cash released and affordability.
- `app/api/transfer-suggestions/route.ts` — accept and forward the two new fields.
- `store/terminalStore.ts` — seed the fallback baseline from the budget; add `setBankTenths`.
- `components/terminal/ChipPanels.tsx` — pass prices into the fallback.
- `components/terminal/TerminalApp.tsx` — ITB from the replay, effective budget for the add guard, editable bank, EST badge.

**Natural checkpoint:** Tasks 1–4 fix the imported data. Tasks 5–7 make the corrected numbers reach the screen. Stop and review after Task 4.

---

### Task 1: Opening prices from element-summary history

**Files:**
- Create: `lib/chips/openingPrices.ts`
- Test: `tests/chips/openingPrices.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `interface OpeningPrice { priceTenths: number; exact: boolean }`; `openingPriceFromSummary(summary: SummaryLike, gameweek: number): OpeningPrice | undefined`; `openingPricesFromSummaries(summaries: ReadonlyMap<number, SummaryLike | null>, gameweek: number): Record<number, OpeningPrice>`; `type SummaryLike = { history: ReadonlyArray<{ round?: number; value?: number }> }`.

`exact` is true only when a row exists for the requested gameweek itself. A player who blanked that week yields the earliest later row with `exact: false`, which Task 2 treats as unverified.

- [ ] **Step 1: Write the failing test**

Create `tests/chips/openingPrices.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { openingPriceFromSummary, openingPricesFromSummaries } from "@/lib/chips/openingPrices";

describe("opening prices", () => {
  it("reads the price at the requested gameweek", () => {
    const summary = { history: [{ round: 1, value: 45 }, { round: 2, value: 46 }] };
    expect(openingPriceFromSummary(summary, 1)).toEqual({ priceTenths: 45, exact: true });
    expect(openingPriceFromSummary(summary, 2)).toEqual({ priceTenths: 46, exact: true });
  });

  it("falls back to the earliest later row and marks it inexact", () => {
    // Blanked in GW1, so the first observation is GW2.
    const summary = { history: [{ round: 3, value: 48 }, { round: 2, value: 46 }] };
    expect(openingPriceFromSummary(summary, 1)).toEqual({ priceTenths: 46, exact: false });
  });

  it("returns undefined when no row is at or after the gameweek", () => {
    expect(openingPriceFromSummary({ history: [] }, 1)).toBeUndefined();
    expect(openingPriceFromSummary({ history: [{ round: 1, value: 45 }] }, 5)).toBeUndefined();
  });

  it("ignores rows missing a round or a value", () => {
    const summary = { history: [{ round: 1 }, { value: 45 }, { round: 2, value: 46 }] };
    expect(openingPriceFromSummary(summary, 1)).toEqual({ priceTenths: 46, exact: false });
  });

  it("truncates fractional values to integer tenths", () => {
    expect(openingPriceFromSummary({ history: [{ round: 1, value: 45.9 }] }, 1))
      .toEqual({ priceTenths: 45, exact: true });
  });

  it("maps many summaries and skips nulls", () => {
    const summaries = new Map([
      [115, { history: [{ round: 1, value: 45 }] }],
      [112, { history: [{ round: 1, value: 50 }] }],
      [1, null],
    ]);
    expect(openingPricesFromSummaries(summaries, 1)).toEqual({
      115: { priceTenths: 45, exact: true },
      112: { priceTenths: 50, exact: true },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/chips/openingPrices.test.ts`
Expected: FAIL — cannot resolve `@/lib/chips/openingPrices`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/chips/openingPrices.ts`:

```typescript
/** One row of FPL's element-summary history: the player's price that gameweek. */
export type SummaryLike = { history: ReadonlyArray<{ round?: number; value?: number }> };

export interface OpeningPrice {
  priceTenths: number;
  /** True when the price came from the requested gameweek itself. */
  exact: boolean;
}

/**
 * The player's price at `gameweek`, read from their own per-gameweek history.
 * Prices do not move before the season's first deadline, so a GW1 row is the
 * purchase price for anyone in the opening squad. A player who had no fixture
 * that week yields the earliest later row, flagged inexact.
 */
export function openingPriceFromSummary(
  summary: SummaryLike | null | undefined,
  gameweek: number,
): OpeningPrice | undefined {
  if (!summary || !Array.isArray(summary.history)) return undefined;
  let best: { round: number; value: number } | undefined;
  for (const row of summary.history) {
    const round = row.round;
    const value = row.value;
    if (round === undefined || value === undefined) continue;
    if (!Number.isSafeInteger(round) || !Number.isFinite(value)) continue;
    if (round < gameweek) continue;
    if (!best || round < best.round) best = { round, value: Math.trunc(value) };
  }
  if (!best) return undefined;
  return { priceTenths: best.value, exact: best.round === gameweek };
}

export function openingPricesFromSummaries(
  summaries: ReadonlyMap<number, SummaryLike | null>,
  gameweek: number,
): Record<number, OpeningPrice> {
  const result: Record<number, OpeningPrice> = {};
  for (const [id, summary] of summaries) {
    const price = openingPriceFromSummary(summary, gameweek);
    if (price) result[id] = price;
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/chips/openingPrices.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/chips/openingPrices.ts tests/chips/openingPrices.test.ts
git commit -m "Read opening purchase prices from element-summary history"
```

---

### Task 2: Stop claiming EXACT for current-price stand-ins

**Files:**
- Modify: `lib/chips/importTeam.ts` (`ImportReconstructionInput`, `reconstructImportBaseline`)
- Test: `tests/chips/financeTimeline.test.ts` (add cases to the existing `reconstructImportBaseline` describe block)

**Interfaces:**
- Consumes: `OpeningPrice` from Task 1 conceptually; no import needed here.
- Produces: `ImportReconstructionInput` gains `verifiedInitialPriceIds?: readonly number[]`. Ids listed there are real opening prices; any other entry in `initialPricesTenths` is treated as a stand-in and forces `financialConfidence: "ESTIMATED"`.

This is the honesty fix. It lands before Task 4, so the existing route immediately starts reporting `ESTIMATED` — correctly — rather than asserting `EXACT` with no evidence.

- [ ] **Step 1: Write the failing test**

Append to `tests/chips/financeTimeline.test.ts`, inside the existing top-level scope:

```typescript
describe("import price provenance", () => {
  const baseInput = {
    initialSquadIds: [...SQUAD],
    startedEvent: 1,
    currentGameweek: 3,
    currentSquadIds: [...SQUAD],
    currentPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 52])),
    bankTenths: 0,
    transfers: [],
    chips: [],
    byPosition: BY_POSITION,
  };

  it("marks ESTIMATED when initial prices are unverified stand-ins", () => {
    const result = reconstructImportBaseline({
      ...baseInput,
      initialPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 52])),
    });
    expect(result.baseline.financialConfidence).toBe("ESTIMATED");
    expect(result.baseline.warnings.join(" ")).toContain("current price");
  });

  it("keeps EXACT when every initial price is verified", () => {
    const result = reconstructImportBaseline({
      ...baseInput,
      initialPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      verifiedInitialPriceIds: [...SQUAD],
    });
    expect(result.baseline.financialConfidence).toBe("EXACT");
    expect(result.baseline.purchasePricesTenths[1]).toBe(50);
  });

  it("keeps EXACT when unverified players were all transferred in", () => {
    // Player 15 was sold; 16 was bought at 60, an exact price from the transfer row.
    const result = reconstructImportBaseline({
      ...baseInput,
      currentSquadIds: [...SQUAD.filter((id) => id !== 15), 16],
      currentPricesTenths: { ...baseInput.currentPricesTenths, 16: 62 },
      initialPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      verifiedInitialPriceIds: [...SQUAD],
      transfers: [{ elementIn: 16, elementOut: 15, elementInCost: 60, elementOutCost: 50, event: 2 }],
    });
    expect(result.baseline.financialConfidence).toBe("EXACT");
    expect(result.baseline.purchasePricesTenths[16]).toBe(60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/chips/financeTimeline.test.ts -t "import price provenance"`
Expected: FAIL — the first case reports `EXACT`, because a present price currently keeps confidence untouched.

- [ ] **Step 3: Write minimal implementation**

In `lib/chips/importTeam.ts`, add the field to `ImportReconstructionInput`, immediately after `initialPricesTenths`:

```typescript
  /**
   * Ids whose `initialPricesTenths` entry is a real opening price read from the
   * player's own history. Any other entry is a current-price stand-in and
   * forces ESTIMATED, because today's price is not what the manager paid.
   */
  verifiedInitialPriceIds?: readonly number[];
```

Then replace the `initialSquadIds` loop in `reconstructImportBaseline`:

```typescript
  const verified = new Set(input.verifiedInitialPriceIds ?? []);
  const standIns: number[] = [];
  const initialSet = new Set(input.initialSquadIds);
  for (const id of input.initialSquadIds) {
    const price = input.initialPricesTenths[id];
    if (price === undefined) {
      purchasePrices[id] = input.currentPricesTenths[id] ?? 0;
      confidence = "ESTIMATED";
      warnings.push(`Missing starting price for player ${id}; current price used.`);
    } else {
      purchasePrices[id] = Math.trunc(price);
      if (!verified.has(id)) standIns.push(id);
    }
  }
```

Then, after the loop that applies transfer costs (`purchasePrices[transfer.elementIn] = ...`), add:

```typescript
  // A stand-in only matters if that player is still owned and was never bought
  // through a recorded transfer — otherwise the transfer cost already replaced it.
  const boughtIds = new Set(sorted.map((transfer) => transfer.elementIn));
  const currentSet = new Set(input.currentSquadIds);
  const unverifiedOwned = standIns.filter((id) => currentSet.has(id) && !boughtIds.has(id));
  if (unverifiedOwned.length > 0) {
    confidence = "ESTIMATED";
    warnings.push(
      `Opening prices unavailable for ${unverifiedOwned.length} owned player(s); current price used, so selling values may be too high.`,
    );
  }
```

The `void initialSet;` statement inside the transfer loop becomes dead — `initialSet` is now genuinely read above. Delete the `void initialSet;` line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/chips/`
Expected: PASS, including the three new cases and every pre-existing chip test.

- [ ] **Step 5: Commit**

```bash
git add lib/chips/importTeam.ts tests/chips/financeTimeline.test.ts
git commit -m "Mark import finances ESTIMATED when purchase prices are stand-ins"
```

---

### Task 3: Checksum the reconstruction against FPL's reported team value

**Files:**
- Create: `lib/chips/verifyBaseline.ts`
- Test: `tests/chips/verifyBaseline.test.ts`

**Interfaces:**
- Consumes: `sellingPriceTenths` from `lib/chips/finance.ts`; `TransferBaseline` from `types/chips`.
- Produces: `interface BaselineCheck { impliedValueTenths: number; reportedValueTenths: number; deltaTenths: number; matches: boolean }`; `verifyBaselineValue(baseline, currentPricesTenths, reportedValueTenths): BaselineCheck`; `applyBaselineCheck(baseline, check): TransferBaseline`.

`applyBaselineCheck` downgrades to `ESTIMATED` on a mismatch and never upgrades on a match.

- [ ] **Step 1: Write the failing test**

Create `tests/chips/verifyBaseline.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { applyBaselineCheck, verifyBaselineValue } from "@/lib/chips/verifyBaseline";
import type { TransferBaseline } from "@/types/chips";
import type { Position } from "@/types/player";

const BY_POSITION = { GK: [1, 2], DEF: [3, 4, 5, 6, 7], MID: [8, 9, 10, 11, 12], FWD: [13, 14, 15] } as Record<Position, number[]>;
const SQUAD = Array.from({ length: 15 }, (_, index) => index + 1);

function baselineOf(purchase: Record<number, number>, bankTenths = 3): TransferBaseline {
  return {
    squadPlayerIds: [...SQUAD],
    byPosition: BY_POSITION,
    bankTenths,
    freeTransfers: 1,
    purchasePricesTenths: purchase,
    financialConfidence: "EXACT",
    startGameweek: 3,
    warnings: [],
  };
}

describe("baseline value checksum", () => {
  it("matches when purchase prices are right", () => {
    // 14 players flat at 50, one riser bought at 45 now 47 -> sells for 46.
    const purchase = Object.fromEntries(SQUAD.map((id) => [id, id === 15 ? 45 : 50]));
    const current = Object.fromEntries(SQUAD.map((id) => [id, id === 15 ? 47 : 50]));
    const check = verifyBaselineValue(baselineOf(purchase), current, 14 * 50 + 46 + 3);
    expect(check).toMatchObject({ matches: true, deltaTenths: 0 });
    expect(check.impliedValueTenths).toBe(749);
  });

  it("detects a current-price stand-in on a riser", () => {
    // Purchase recorded as 47 (today's price) instead of the real 45.
    const purchase = Object.fromEntries(SQUAD.map((id) => [id, id === 15 ? 47 : 50]));
    const current = Object.fromEntries(SQUAD.map((id) => [id, id === 15 ? 47 : 50]));
    const check = verifyBaselineValue(baselineOf(purchase), current, 14 * 50 + 46 + 3);
    expect(check.matches).toBe(false);
    expect(check.deltaTenths).toBe(1); // implied 750 vs reported 749
  });

  it("treats a missing current price as a mismatch", () => {
    const purchase = Object.fromEntries(SQUAD.map((id) => [id, 50]));
    const current = Object.fromEntries(SQUAD.filter((id) => id !== 7).map((id) => [id, 50]));
    expect(verifyBaselineValue(baselineOf(purchase), current, 753).matches).toBe(false);
  });

  it("falls back to the current price when a purchase price is absent", () => {
    const current = Object.fromEntries(SQUAD.map((id) => [id, 50]));
    const check = verifyBaselineValue(baselineOf({}), current, 753);
    expect(check).toMatchObject({ impliedValueTenths: 753, matches: true });
  });

  it("accepts a Map of current prices", () => {
    const purchase = Object.fromEntries(SQUAD.map((id) => [id, 50]));
    const current = new Map(SQUAD.map((id) => [id, 50]));
    expect(verifyBaselineValue(baselineOf(purchase), current, 753).matches).toBe(true);
  });

  it("downgrades to ESTIMATED on a mismatch and names the delta", () => {
    const baseline = baselineOf(Object.fromEntries(SQUAD.map((id) => [id, 50])));
    const applied = applyBaselineCheck(baseline, {
      impliedValueTenths: 750, reportedValueTenths: 749, deltaTenths: 1, matches: false,
    });
    expect(applied.financialConfidence).toBe("ESTIMATED");
    expect(applied.warnings.join(" ")).toContain("£0.1m");
  });

  it("never upgrades confidence on a match", () => {
    const baseline = { ...baselineOf({}), financialConfidence: "ESTIMATED" as const };
    const applied = applyBaselineCheck(baseline, {
      impliedValueTenths: 753, reportedValueTenths: 753, deltaTenths: 0, matches: true,
    });
    expect(applied.financialConfidence).toBe("ESTIMATED");
    expect(applied.warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/chips/verifyBaseline.test.ts`
Expected: FAIL — cannot resolve `@/lib/chips/verifyBaseline`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/chips/verifyBaseline.ts`:

```typescript
import type { TransferBaseline } from "@/types/chips";
import { sellingPriceTenths } from "./finance";

export interface BaselineCheck {
  /** Team value implied by the reconstructed purchase prices, in tenths. */
  impliedValueTenths: number;
  /** Team value FPL reports for the same gameweek, in tenths. */
  reportedValueTenths: number;
  /** implied − reported. Positive means the reconstruction is too generous. */
  deltaTenths: number;
  matches: boolean;
}

type PriceSource = Record<number, number> | ReadonlyMap<number, number>;

function priceOf(prices: PriceSource, id: number): number | undefined {
  return prices instanceof Map ? prices.get(id) : (prices as Record<number, number>)[id];
}

function money(tenths: number): string {
  return `£${(tenths / 10).toFixed(1)}m`;
}

/**
 * FPL publishes the answer key: entry_history.value equals the bank plus the
 * selling value of the squad. Recomputing it from reconstructed purchase
 * prices says whether the reconstruction is right.
 */
export function verifyBaselineValue(
  baseline: TransferBaseline,
  currentPricesTenths: PriceSource,
  reportedValueTenths: number,
): BaselineCheck {
  const reported = Math.trunc(reportedValueTenths);
  let implied = Math.trunc(baseline.bankTenths);
  let complete = true;
  for (const id of baseline.squadPlayerIds) {
    const current = priceOf(currentPricesTenths, id);
    if (current === undefined) {
      complete = false;
      continue;
    }
    const purchase = baseline.purchasePricesTenths[id] ?? current;
    implied += sellingPriceTenths(purchase, current);
  }
  const delta = implied - reported;
  return {
    impliedValueTenths: implied,
    reportedValueTenths: reported,
    deltaTenths: delta,
    matches: complete && delta === 0,
  };
}

/**
 * Downgrades confidence when the checksum disagrees. Never upgrades: agreeing
 * in aggregate does not prove each player's purchase price, and individual
 * transfers depend on the per-player figure.
 */
export function applyBaselineCheck(
  baseline: TransferBaseline,
  check: BaselineCheck,
): TransferBaseline {
  if (check.matches) return baseline;
  const direction = check.deltaTenths > 0 ? "too high" : "too low";
  return {
    ...baseline,
    financialConfidence: "ESTIMATED",
    warnings: [
      ...baseline.warnings,
      `Reconstructed team value is ${money(check.impliedValueTenths)} but FPL reports ${money(check.reportedValueTenths)}`
        + ` (${money(Math.abs(check.deltaTenths))} ${direction}); finances are ESTIMATED.`,
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/chips/verifyBaseline.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/chips/verifyBaseline.ts tests/chips/verifyBaseline.test.ts
git commit -m "Check reconstructed finances against FPL's reported team value"
```

---

### Task 4: Fetch opening prices and verify on import

**Files:**
- Modify: `app/api/fpl/entry/[id]/route.ts`
- Test: `tests/data/fpl-entry-route.test.ts`

**Interfaces:**
- Consumes: `openingPricesFromSummaries` (Task 1), `verifiedInitialPriceIds` (Task 2), `verifyBaselineValue` / `applyBaselineCheck` (Task 3), `getPlayerSummary` from `lib/fpl/client.ts` (signature: `(playerId: number, options?: FplRequestOptions) => Promise<{ data: FplPlayerSummaryPayload | null; freshness: ...; error?: string }>`).
- Produces: no new exports. The route's `transferBaseline` in the response now carries real purchase prices and honest confidence.

At most 15 extra requests, all cached by `lib/fpl/cache.ts`. Every fetch is best-effort: a failure falls back to the current price, which Task 2 already turns into `ESTIMATED`.

- [ ] **Step 1: Write the failing test**

Open `tests/data/fpl-entry-route.test.ts`, add `getPlayerSummary` to the existing `vi.mock("@/lib/fpl/client", ...)` factory alongside the other mocked fetchers, and append this case. Match the file's existing mock and request-construction helpers rather than inventing new ones:

```typescript
it("reads opening prices for players never transferred in", async () => {
  // Player held since GW1: opening price 45, now 47. Selling price is 46, not 47.
  mocks.getPlayerSummary.mockImplementation(async (id: number) => ({
    data: { history: [{ round: 1, value: id === 115 ? 45 : 50 }], history_past: [] },
    freshness: null,
  }));

  const response = await GET(request(), { params: Promise.resolve({ id: "4827193" }) });
  const body = await response.json();

  expect(mocks.getPlayerSummary).toHaveBeenCalled();
  expect(body.data.transferBaseline.purchasePricesTenths[115]).toBe(45);
});

it("marks finances ESTIMATED when an opening price cannot be read", async () => {
  mocks.getPlayerSummary.mockResolvedValue({ data: { history: [], history_past: [] }, freshness: null });

  const response = await GET(request(), { params: Promise.resolve({ id: "4827193" }) });
  const body = await response.json();

  expect(body.data.financialConfidence).toBe("ESTIMATED");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/data/fpl-entry-route.test.ts`
Expected: FAIL — `getPlayerSummary` is never called, and the purchase price is the current price.

- [ ] **Step 3: Write minimal implementation**

In `app/api/fpl/entry/[id]/route.ts`, add the imports:

```typescript
import { getEntryPicks, getEntryTransfers, getPlayerSummary } from "@/lib/fpl/client";
import { openingPricesFromSummaries } from "@/lib/chips/openingPrices";
import { applyBaselineCheck, verifyBaselineValue } from "@/lib/chips/verifyBaseline";
```

(Merge `getPlayerSummary` into the existing `@/lib/fpl/client` import rather than adding a second one.)

Replace the block that builds `initialPrices` — currently:

```typescript
    const initialPrices: Record<number, number> = {};
    for (const id of initialIds) {
      if (priceById[id] !== undefined) initialPrices[id] = priceById[id];
    }
```

with:

```typescript
    // Opening prices are only needed for players never bought through a
    // recorded transfer; a transfer row already gives their exact cost.
    const boughtIds = new Set(transfers.map((transfer) => transfer.elementIn));
    const needOpening = initialIds.filter((id) => !boughtIds.has(id));
    const summaries = new Map(
      await Promise.all(needOpening.map(async (id) => {
        const summary = await getPlayerSummary(id).catch(() => null);
        return [id, summary?.data ?? null] as const;
      })),
    );
    const opening = openingPricesFromSummaries(summaries, startedEvent);

    const initialPrices: Record<number, number> = {};
    const verifiedInitialPriceIds: number[] = [];
    for (const id of initialIds) {
      const found = opening[id];
      if (found?.exact) {
        initialPrices[id] = found.priceTenths;
        verifiedInitialPriceIds.push(id);
      } else if (found) {
        initialPrices[id] = found.priceTenths;
      } else if (priceById[id] !== undefined) {
        initialPrices[id] = priceById[id];
      }
    }
    if (verifiedInitialPriceIds.length < needOpening.length) {
      importWarnings.push("Some opening prices could not be read; those purchase prices use current prices.");
    }
```

Add `verifiedInitialPriceIds,` to the `reconstructImportBaseline({ ... })` call, next to `initialPricesTenths`.

Then, immediately after `transferBaseline = reconstruction.baseline;` and before the existing warnings merge, insert:

```typescript
    // FPL reports the answer: entry_history.value is bank + squad selling value.
    const check = verifyBaselineValue(transferBaseline, priceById, budgetTenths);
    transferBaseline = applyBaselineCheck(transferBaseline, check);
    financialConfidence = transferBaseline.financialConfidence;
```

Delete the now-redundant `financialConfidence = reconstruction.baseline.financialConfidence;` line that this replaces.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/data/ tests/chips/`
Expected: PASS. If a pre-existing entry-route test now reports `ESTIMATED` where it asserted `EXACT`, that assertion was encoding the bug — update it to `ESTIMATED` and add the mocked summaries needed to earn `EXACT`.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add app/api/fpl/entry/\[id\]/route.ts tests/data/fpl-entry-route.test.ts
git commit -m "Recover real opening prices on import and verify against team value"
```

**Checkpoint:** imported finances are now correct and honestly labelled. Review before continuing.

---

### Task 5: Price transfers with selling values

**Files:**
- Modify: `lib/analysis/context.ts` (`CommonOptions`)
- Modify: `lib/analysis/singleTransfers.ts` (`findBestSingleTransfers`)
- Modify: `app/api/transfer-suggestions/route.ts`
- Test: `tests/analysis/single-transfers.test.ts`, `tests/analysis/transfer-suggestions-route.test.ts`

**Interfaces:**
- Consumes: `sellingPriceTenths` from `lib/chips/finance.ts`.
- Produces: `CommonOptions` gains `purchasePricesTenths?: Record<number, number>` and `bankTenths?: number`. When `bankTenths` is undefined the behaviour is unchanged, so existing callers and tests keep working.

- [ ] **Step 1: Write the failing test**

Append to `tests/analysis/single-transfers.test.ts`. It reuses that file's existing `player()` helper and `selected` squad, whose market cost is 885 tenths. The outgoing player is 11 — a MID priced 64 with 5 xP per gameweek.

```typescript
describe("selling prices", () => {
  // Player 11 was bought at 58 and is now 64: profit 6, so it sells for 58 + 3 = 61.
  const purchasePricesTenths = { 11: 58 };
  const cheaper = player(20, "MID", 55, 6);
  const dearer = player(21, "MID", 62, 6.5);

  it("releases the selling price, not the market price", () => {
    const suggestions = findBestSingleTransfers({
      squad: selected,
      players: [...selected, cheaper],
      gameweek: 1,
      horizon: 5,
      risk: "BALANCED",
      outgoingPlayerId: 11,
      bankTenths: 0,
      purchasePricesTenths,
    });
    expect(suggestions[0]).toMatchObject({ incomingPlayerId: 20, cashReleasedTenths: 6 }); // 61 − 55
  });

  it("refuses a transfer the bank cannot fund", () => {
    // Selling releases 61 with nothing in the bank, so a 62 target is out of
    // reach even though the squad's market total leaves plenty of headroom.
    const suggestions = findBestSingleTransfers({
      squad: selected,
      players: [...selected, dearer],
      gameweek: 1,
      horizon: 5,
      risk: "BALANCED",
      outgoingPlayerId: 11,
      bankTenths: 0,
      purchasePricesTenths,
    });
    expect(suggestions.some((item) => item.incomingPlayerId === 21)).toBe(false);
  });

  it("keeps market-price behaviour when no bank is supplied", () => {
    const suggestions = findBestSingleTransfers({
      squad: selected, players: [...selected, cheaper], gameweek: 1, horizon: 5, risk: "BALANCED", outgoingPlayerId: 11,
    });
    expect(suggestions[0]).toMatchObject({ incomingPlayerId: 20, cashReleasedTenths: 9 }); // 64 − 55
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/analysis/single-transfers.test.ts -t "selling prices"`
Expected: FAIL — `cashReleasedTenths` is 6 in the first case, and the unaffordable move is suggested.

- [ ] **Step 3: Write minimal implementation**

In `lib/analysis/context.ts`, add to `CommonOptions`:

```typescript
  /** Purchase price per owned player in integer tenths, for official selling values. */
  purchasePricesTenths?: Record<number, number>;
  /** Cash in bank in integer tenths. When set, affordability uses bank + selling value. */
  bankTenths?: number;
```

In `lib/analysis/singleTransfers.ts`, add the import:

```typescript
import { sellingPriceTenths } from "@/lib/chips/finance";
```

Inside `findBestSingleTransfers`, after `const squad = squadIds.map(...)`, add:

```typescript
  const sellingOf = (player: Player): number =>
    sellingPriceTenths(input.purchasePricesTenths?.[player.id] ?? player.priceTenths, player.priceTenths);
  const spentBefore = squad.reduce((sum, player) => sum + player.priceTenths, 0);
```

Inside the `for (const outgoingId of squadIds)` loop, after `const outgoingWeeks = ...`, add:

```typescript
  // Affordability is bank + selling value of the outgoing player. Expressed as
  // a budget so the existing legality check needs no change.
  const affordableBudget = input.bankTenths === undefined
    ? budgetTenths
    : spentBefore - outgoing.priceTenths + input.bankTenths + sellingOf(outgoing);
```

Change the legality call inside the `viable` mapping from `budgetTenths` to `budgetTenths: affordableBudget`, and change the cash line to:

```typescript
      const cashReleasedTenths = sellingOf(outgoing) - incoming.priceTenths;
```

In `app/api/transfer-suggestions/route.ts`, add to the Zod schema:

```typescript
  purchasePricesTenths: z.record(z.string(), z.number().int()).optional(),
  bankTenths: z.number().int().optional(),
```

and forward them into the `findBestSingleTransfers` call:

```typescript
      purchasePricesTenths: parsed.data.purchasePricesTenths
        ? Object.fromEntries(Object.entries(parsed.data.purchasePricesTenths).map(([key, value]) => [Number(key), value]))
        : undefined,
      bankTenths: parsed.data.bankTenths,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/analysis/`
Expected: PASS, including every pre-existing suggestion test — none pass `bankTenths`, so their behaviour is unchanged.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add lib/analysis/context.ts lib/analysis/singleTransfers.ts app/api/transfer-suggestions/route.ts tests/analysis/
git commit -m "Price transfer suggestions with official selling values"
```

---

### Task 6: Seed the fallback baseline from the budget, and let the bank be set

**Files:**
- Modify: `store/terminalStore.ts` (`estimatedBaselineFallback`, `baselineWithMigrationFallback`, new `setBankTenths` action)
- Modify: `components/terminal/ChipPanels.tsx` (both `baselineWithMigrationFallback` call sites)
- Test: `tests/chips/storeChips.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `estimatedBaselineFallback(playerIds, byPosition, budgetTenths, gameweek, priceById?: ReadonlyMap<number, number>)`; `baselineWithMigrationFallback(baseline, playerIds, byPosition, budgetTenths, gameweek, priceById?)`; store action `setBankTenths(tenths: number): boolean`.

`estimatedBaselineFallback` currently contains `void budgetTenths;` and returns `bankTenths: 0`. I confirmed the consequence by running a five-player BUILD squad on a £100.0m budget through `replayTimeline`: it reports a bank of 0 where the answer is 750. Task 7 reads that bank, so this must land first.

- [ ] **Step 1: Write the failing test**

Append to `tests/chips/storeChips.test.ts`:

```typescript
describe("hand-built baseline", () => {
  it("seeds the bank from the budget and prices the squad at market", () => {
    const priceById = new Map([[1, 50], [2, 50], [3, 50], [4, 50], [5, 50]]);
    const baseline = estimatedBaselineFallback(
      [1, 2, 3, 4, 5],
      { GK: [1], DEF: [2, 3], MID: [4], FWD: [5] },
      1000,
      3,
      priceById,
    );
    expect(baseline.bankTenths).toBe(750);
    expect(baseline.purchasePricesTenths).toEqual({ 1: 50, 2: 50, 3: 50, 4: 50, 5: 50 });
    expect(baseline.financialConfidence).toBe("ESTIMATED");
  });

  it("never reports a negative bank", () => {
    const priceById = new Map([[1, 900], [2, 900]]);
    expect(estimatedBaselineFallback([1, 2], { GK: [1], DEF: [2], MID: [], FWD: [] }, 1000, 3, priceById).bankTenths).toBe(0);
  });

  it("keeps a zero bank when no prices are supplied", () => {
    expect(estimatedBaselineFallback([1], { GK: [1], DEF: [], MID: [], FWD: [] }, 1000, 3).bankTenths).toBe(0);
  });
});

describe("setBankTenths", () => {
  it("writes the bank onto the baseline", () => {
    useTerminalStore.setState({ transferBaseline: null, playerIds: [1], budgetTenths: 1000 });
    expect(useTerminalStore.getState().setBankTenths(7)).toBe(true);
    expect(useTerminalStore.getState().transferBaseline?.bankTenths).toBe(7);
    expect(useTerminalStore.getState().transferBaseline?.financialConfidence).toBe("ESTIMATED");
  });

  it("rejects a negative or non-integer bank and leaves state untouched", () => {
    useTerminalStore.setState({ transferBaseline: null });
    expect(useTerminalStore.getState().setBankTenths(-1)).toBe(false);
    expect(useTerminalStore.getState().setBankTenths(1.5)).toBe(false);
    expect(useTerminalStore.getState().transferBaseline).toBeNull();
  });
});
```

Add `estimatedBaselineFallback` to the file's existing import from `@/store/terminalStore`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/chips/storeChips.test.ts`
Expected: FAIL — the bank is 0 instead of 750, and `setBankTenths` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `store/terminalStore.ts`, replace `estimatedBaselineFallback`:

```typescript
/**
 * Baseline for a squad with no import behind it. Purchase price is the market
 * price, because a hand-built squad is bought at today's prices, and the bank
 * is whatever the budget leaves. Always ESTIMATED: a real team's purchase
 * prices and bank cannot be derived from a list of players.
 */
export function estimatedBaselineFallback(
  playerIds: number[],
  byPosition: SlotMap,
  budgetTenths: number,
  gameweek: number,
  priceById?: ReadonlyMap<number, number>,
): TransferBaseline {
  const purchasePricesTenths: Record<number, number> = {};
  let spent = 0;
  if (priceById) {
    for (const id of playerIds) {
      const price = priceById.get(id);
      if (price === undefined) continue;
      purchasePricesTenths[id] = Math.trunc(price);
      spent += Math.trunc(price);
    }
  }
  return {
    squadPlayerIds: [...playerIds],
    byPosition: cloneSlotMap(byPosition),
    bankTenths: priceById ? Math.max(0, Math.trunc(budgetTenths) - spent) : 0,
    freeTransfers: 1,
    purchasePricesTenths,
    financialConfidence: "ESTIMATED",
    startGameweek: validGameweek(gameweek) ? gameweek : 1,
    warnings: ["Squad was built by hand, so purchase prices use market prices and finances are ESTIMATED."],
  };
}
```

Add the parameter to `baselineWithMigrationFallback` and forward it:

```typescript
export function baselineWithMigrationFallback(
  baseline: TransferBaseline | null,
  playerIds: number[],
  byPosition: SlotMap,
  budgetTenths: number,
  gameweek: number,
  priceById?: ReadonlyMap<number, number>,
): TransferBaseline {
  if (baseline) return baseline;
  return estimatedBaselineFallback(playerIds, byPosition, budgetTenths, gameweek, priceById);
}
```

Add `setBankTenths: (tenths: number) => boolean;` to the `TerminalState` interface next to the other setters, and the action to the store body:

```typescript
  setBankTenths: (tenths) => {
    if (!Number.isSafeInteger(tenths) || tenths < 0) return false;
    const state = get();
    const baseline = state.transferBaseline
      ?? estimatedBaselineFallback(state.playerIds, state.byPosition, state.budgetTenths, state.planningGameweek);
    set({
      transferBaseline: {
        ...baseline,
        bankTenths: tenths,
        financialConfidence: "ESTIMATED",
        warnings: [...baseline.warnings.filter((text) => !text.startsWith("Bank set by hand")), "Bank set by hand; finances are ESTIMATED."],
      },
    });
    return true;
  },
```

In `components/terminal/ChipPanels.tsx`, both `baselineWithMigrationFallback` call sites already have `players` in scope. At each, build and pass the price map:

```typescript
    const priceById = new Map(players.map((player) => [player.id, player.priceTenths]));
    const baseline = baselineWithMigrationFallback(transferBaseline, playerIds, byPosition, budgetTenths, planningGameweek, priceById);
```

In `usePlanningWeekFinance` the map is already built two lines below — hoist that single declaration above the `baseline` line and reuse it rather than building it twice.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/chips/ tests/store/`
Expected: PASS. The pre-existing `storeChips.test.ts:268` case calls `baselineWithMigrationFallback` without a price map and still expects `ESTIMATED` — unchanged.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add store/terminalStore.ts components/terminal/ChipPanels.tsx tests/chips/storeChips.test.ts
git commit -m "Seed hand-built finances from the budget and allow setting the bank"
```

---

### Task 7: Show the real bank and guard adds against it

**Files:**
- Modify: `components/terminal/TerminalApp.tsx` (`bankTenths`, `slotMaxPrices`, `addPlayer`, the transfer-suggestions fetch body, `MetricStrip`)
- Test: `tests/ui/squad-budget.test.ts` (create)

**Interfaces:**
- Consumes: `usePlanningWeekFinance` (already imported at the top of `TerminalApp.tsx`, returning `{ bankTenths, confidence, hitCost, ... } | null`); `setBankTenths` (Task 6); `purchasePricesTenths` / `bankTenths` on the transfer-suggestions body (Task 5).
- Produces: no new exports.

Three corrections in one screen. The load-bearing line is the effective budget: `explainIllegalSelection` derives its own bank as `budget − Σ currentPrice`, so handing it `bank + spent` makes that come out as the real bank while `minimumRemainingSpend`'s completability check keeps working untouched. `lib/squad/budget.ts` needs no edit.

Note `usePlanningWeekFinance` returns `null` for an empty squad, which is the first screen a new user sees — hence the fallback to `store.budgetTenths`.

Expect ITB to move when the planning gameweek changes: the replay runs from `baseline.startGameweek` to the planning week. That is correct, and new.

- [ ] **Step 1: Write the failing test**

Create `tests/ui/squad-budget.test.ts`. This tests the arithmetic the component performs, not the DOM:

```typescript
import { describe, expect, it } from "vitest";
import { explainIllegalSelection } from "@/lib/squad/budget";
import type { Player } from "@/types/player";

function player(id: number, position: Player["position"], priceTenths: number, teamId: number): Player {
  return {
    id, position, priceTenths, teamId,
    displayName: `P${id}`, webName: `P${id}`, ownership: 0,
  } as Player;
}

describe("add guard budget", () => {
  // A real team: 14 players held at £7.1m each (994), one FWD slot open,
  // £0.9m in the bank. Team value 100.3m, so the last £0.9m pick costs 1003
  // at market — over the £100.0m a fresh entry would have.
  const BANK_TENTHS = 9;
  const squad = Array.from({ length: 14 }, (_, index) =>
    player(index + 1, index < 2 ? "GK" : index < 7 ? "DEF" : index < 12 ? "MID" : "FWD", 71, (index % 5) + 1));
  const target = player(99, "FWD", 9, 5);
  const pool = [...squad, target];
  const spent = squad.reduce((sum, item) => sum + item.priceTenths, 0); // 994

  it("refuses the add when the ceiling is the default £100.0m", () => {
    // 994 + 9 = 1003 > 1000.
    expect(explainIllegalSelection(target, squad, pool).legal).toBe(false);
  });

  it("permits it when the budget is bank plus what the squad costs at market", () => {
    const effectiveBudgetTenths = BANK_TENTHS + spent; // 1003
    expect(explainIllegalSelection(target, squad, pool, { constraints: { budgetTenths: effectiveBudgetTenths } }).legal).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui/squad-budget.test.ts`
Expected: FAIL on the second case — it currently reports illegal, proving the guard ignores the real bank.

- [ ] **Step 3: Write minimal implementation**

In `components/terminal/TerminalApp.tsx`, move the `weekFinance` line above `bankTenths` (it currently sits below, near the projection memo), then replace the budget derivation:

```typescript
  const weekFinance = usePlanningWeekFinance(data.players, planningGameweek);
  const bankTenths = weekFinance?.bankTenths ?? store.budgetTenths - spent;
  // explainIllegalSelection derives its bank as budget − Σ market price, so
  // handing it bank + spent makes that come out as the real bank.
  const effectiveBudgetTenths = bankTenths + spent;
```

Pass the constraints at both guard call sites:

```typescript
  const slotMaxPrices = useMemo(() => POSITIONS.reduce((result, position) => {
    result[position] = maxSafePriceForPosition(position, selected, data.players, { constraints: { budgetTenths: effectiveBudgetTenths } });
    return result;
  }, {} as Record<Position, number>), [data.players, selected, effectiveBudgetTenths]);
```

```typescript
  const addPlayer = useCallback((player: TerminalPlayer) => {
    const explanation = explainIllegalSelection(player, selected, data.players, { constraints: { budgetTenths: effectiveBudgetTenths } });
```

and add `effectiveBudgetTenths` to that callback's dependency array.

Add the finance fields to the transfer-suggestions fetch body, alongside the existing `budgetTenths`:

```typescript
        bankTenths,
        purchasePricesTenths: store.transferBaseline?.purchasePricesTenths,
```

and add `bankTenths` and `store.transferBaseline` to `transferRequestKey` and that effect's dependency array so suggestions refetch when the bank changes.

In `MetricStrip`, make ITB editable and show the confidence. Replace the `ITB` metric with:

```tsx
    <label className="metric metric-editable">
      <span className="metric-label">ITB{confidence === "ESTIMATED" ? " · EST" : ""}</span>
      <input
        className="metric-input"
        type="number"
        step="0.1"
        min="0"
        value={(bankTenths / 10).toFixed(1)}
        aria-label="Cash in the bank in millions"
        title={confidence === "ESTIMATED"
          ? "Estimated. Type the value your FPL team page shows."
          : "From your FPL entry. Editing this overrides the imported figure."}
        onChange={(event) => {
          const tenths = Math.round(Number(event.target.value) * 10);
          if (Number.isSafeInteger(tenths) && tenths >= 0) onBankChange(tenths);
        }}
      />
    </label>
```

Add `confidence` and `onBankChange` to the `MetricStrip` props, and pass `confidence={weekFinance?.confidence ?? "ESTIMATED"}` and `onBankChange={store.setBankTenths}` at its call site. Style `.metric-editable` and `.metric-input` in `app/globals.css` to match the surrounding metric tiles — monospace, transparent background, no spinner — keeping the terminal look.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ui/ && npm test`
Expected: PASS.

- [ ] **Step 5: Check both viewports**

Run: `npm run test:e2e`
Then start `npm run dev` and confirm at 1280×720 and 390×844 that the ITB tile still fits the metric strip and the EST suffix does not wrap.

- [ ] **Step 6: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add components/terminal/TerminalApp.tsx app/globals.css tests/ui/squad-budget.test.ts
git commit -m "Show the real bank and guard squad adds against it"
```

---

## Out of scope

Named here so nobody folds them in:

- **The COST metric.** It shows `Σ currentPrice` where FPL shows squad selling value. A separate question about what the strip displays.
- **Lifting the £100.0m cap in BUILD mode.** At GW3 a fresh entry genuinely cannot own a £101m squad, so the refusal is correct. What it needs is a better message pointing at Import — worth doing, but it is copy, not accounting.
- **`/api/my-team/{id}/`.** Gives `purchase_price` and `selling_price` outright, and needs the user's FPL login. Blocked by the no-authentication rule in `AGENTS.md`.
- **Per-player purchase prices for rival managers.** Not obtainable. The checksum is the ceiling for anyone else's team.
