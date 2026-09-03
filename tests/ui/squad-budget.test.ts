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

  it("says when a refusal is about money, so the UI can offer a way out", () => {
    expect(explainIllegalSelection(target, squad, pool).reason).toBe("BUDGET");
    const budgetTenths = effectiveBudgetTenths(8, squad);
    expect(explainIllegalSelection(target, squad, pool, { constraints: { budgetTenths } }).reason).toBe("BUDGET");
  });

  it("does not blame money for a full position or a fourth club pick", () => {
    // Three from club 1 already; a fourth breaks the club limit, not the bank.
    const clubHeavy = [player(201, "FWD", 5, 1), player(202, "FWD", 5, 1), player(203, "FWD", 5, 1)];
    const fourth = player(204, "MID", 5, 1);
    const explanation = explainIllegalSelection(fourth, clubHeavy, [...clubHeavy, fourth]);
    expect(explanation.legal).toBe(false);
    expect(explanation.reason).not.toBe("BUDGET");
  });

  it("does not blame money when the club limit is broken too", () => {
    // Over budget AND a fourth pick from club 1. Money is not the only
    // problem, so offering to raise the bank would be useless advice.
    const heavy = [...squad, player(205, "FWD", 71, 1)];
    const fourthFromClub1 = player(206, "FWD", 71, 1);
    const explanation = explainIllegalSelection(fourthFromClub1, heavy, [...heavy, fourthFromClub1]);
    expect(explanation.legal).toBe(false);
    expect(explanation.reason).toBe("SHAPE");
  });

  it("reports OK on a legal add", () => {
    const budgetTenths = effectiveBudgetTenths(BANK_TENTHS, squad);
    expect(explainIllegalSelection(target, squad, pool, { constraints: { budgetTenths } }).reason).toBe("OK");
  });
});
