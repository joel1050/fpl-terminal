import { describe, expect, it } from "vitest";
import { parseRotowireLineups } from "@/lib/availability/rotowire";

const players = (prefix: string, injury?: string) => Array.from({ length: injury ? 1 : 11 }, (_, index) => `
  <li class="lineup__player">
    <div class="lineup__pos ">${index === 0 ? "GK" : "M"}</div>
    <a title="${prefix} Player ${index + 1}" href="/soccer/player/${prefix.toLowerCase()}-${index + 100}">${prefix[0]}. Player ${index + 1}</a>
    ${injury ? `<span class="lineup__inj">${injury}</span>` : ""}
  </li>`).join("");

const html = `
  <div class="page-title__secondary">Starting lineups for August 21, 2026</div>
  <div class="lineup is-soccer">
    <div class="lineup__time"><b>August 21</b>&nbsp; 3:00 PM ET</div>
    <div class="lineup__abbr">HOM</div><div class="lineup__abbr">AWY</div>
    <div class="lineup__mteam is-home">Home &amp; City <span></span></div>
    <div class="lineup__mteam is-visit">Away United <span></span></div>
    <ul class="lineup__list is-home">
      <li class="lineup__status is-expected">Predicted Lineup</li>
      ${players("Home")}
      <li class="lineup__title is-middle">Injuries</li>${players("Injured", "OUT")}
    </ul>
    <ul class="lineup__list is-visit">
      <li class="lineup__status is-confirmed">Confirmed Lineup</li>${players("Away")}
    </ul>
  </div>`;

describe("RotoWire lineup ingestion", () => {
  it("extracts teams, statuses, starters, injuries, and stable RotoWire IDs", () => {
    const snapshot = parseRotowireLineups(html, "2026-08-20T12:00:00.000Z");
    expect(snapshot.dateRange).toBe("Starting lineups for August 21, 2026");
    expect(snapshot.fixtures).toHaveLength(1);
    expect(snapshot.fixtures[0].kickoff).toBe("August 21 3:00 PM ET");
    expect(snapshot.fixtures[0].home).toMatchObject({ name: "Home & City", abbreviation: "HOM", status: "PREDICTED" });
    expect(snapshot.fixtures[0].home.starters).toHaveLength(11);
    expect(snapshot.fixtures[0].home.unavailable[0]).toMatchObject({ name: "Injured Player 1", rotowireId: 100, status: "OUT" });
    expect(snapshot.fixtures[0].away.status).toBe("CONFIRMED");
  });

  it("rejects incomplete source data instead of publishing a partial snapshot", () => {
    expect(() => parseRotowireLineups(html.replace(players("Away"), players("Away").replace(/<li class="lineup__player">[\s\S]*?<\/li>/, "")))).toThrow(/Away United \(10 starters\)/);
  });
});
