import { describe, expect, it } from "vitest";
import { effectiveBudgetTenths, explainIllegalSelection } from "@/lib/squad/budget";
import type { Player, Position } from "@/types/player";

function player(id: number, position: Position, priceTenths: number, teamId: number): Player {
  return {
    id, position, priceTenths, teamId,
    firstName: "P", lastName: String(id), displayName: `P${id}`,
    teamName: `T${teamId}`, teamShortName: `T${teamId}`, ownership: 0, status: "a",
    current: { totalPoints: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 90 },
    fixtures: [],
  } as unknown as Player;
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
    const budgetTenths = effectiveBudgetTenths(BANK_TENTHS, squad);
    expect(budgetTenths).toBe(1003);
    expect(explainIllegalSelection(target, squad, pool, { constraints: { budgetTenths } }).legal).toBe(true);
  });

  it("hands the guards back exactly the bank they were given", () => {
    // The guards derive bank as budget − Σ market price. That round trip is
    // the whole contract, so pin it.
    for (const bank of [0, 5, 9, 250]) {
      expect(effectiveBudgetTenths(bank, squad) - spent).toBe(bank);
    }
  });

  it("refuses a player the bank cannot cover", () => {
    const budgetTenths = effectiveBudgetTenths(8, squad); // one tenth short of 9
    expect(explainIllegalSelection(target, squad, pool, { constraints: { budgetTenths } }).legal).toBe(false);
  });
});
