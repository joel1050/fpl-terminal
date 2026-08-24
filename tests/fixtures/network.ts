import type { Page, Route } from "@playwright/test";
import { bootstrapStaticFixture, fixturePlayers, fixturesFixture } from "./fpl";

/**
 * Keep browser tests deterministic at the same boundary production uses.
 * This is intentionally a test-only interceptor; no fixture is imported by app code.
 */
export async function interceptFplData(page: Page) {
  await page.route("**/*", async (route: Route) => {
    const url = route.request().url();
    const pathname = new URL(url).pathname.toLowerCase();

    if (pathname.includes("bootstrap-static") || pathname.includes("/api/fpl/bootstrap")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bootstrapStaticFixture) });
      return;
    }

    if (pathname.includes("fixtures")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixturesFixture) });
      return;
    }

    if (pathname.includes("/api/fpl/entry/4827193")) {
      const squad = {
        playerIds: [4, 7, 9, 10, 21, 22, 11, 12, 13, 1, 14, 16, 17, 18, 15],
        byPosition: { GK: [4, 16], DEF: [7, 9, 10, 17, 18], MID: [21, 22, 11, 12, 13], FWD: [1, 14, 15] },
      };
      const lineup = { gameweek: 1, benchGoalkeeperId: 16, benchOrder: [17, 18, 15], captainId: 1, viceCaptainId: 14 };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { entryId: 4827193, teamName: "Test XI", managerName: "Test Manager", squad, lineup } }) });
      return;
    }

    if (pathname.includes("/api/optimizer") && route.request().method() === "POST") {
      const squad = {
        playerIds: [5, 16, 6, 9, 10, 17, 18, 2, 3, 12, 13, 22, 1, 14, 15],
        byPosition: { GK: [5, 16], DEF: [6, 9, 10, 17, 18], MID: [2, 3, 12, 13, 22], FWD: [1, 14, 15] },
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ legal: true, squad, playerIds: squad.playerIds, errors: [], warnings: [] }) });
      return;
    }

    if (pathname.includes("/api/transfer-suggestions") && route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          gameweek: 1,
          horizon: 5,
          suggestions: [{
            outgoingPlayerId: 21,
            incomingPlayerId: 2,
            horizon: 5,
            beforeXp: 250,
            afterXp: 255,
            projectedDelta: 5,
            projectedDeltaPerGW: 1,
            cashReleasedTenths: -50,
            score: -0.25,
            kind: "XP_UPGRADE",
            incomingRisk: 0.05,
            confidence: "HIGH",
            reason: "xP upgrade: +5.0 xP over 5GW, costs £5.0m",
          }],
        }),
      });
      return;
    }

    if (/(?:ai|analyst|chat)/.test(pathname) && route.request().method() !== "GET") {
      // The acceptance test models a missing key without making a production API call.
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "DEEPSEEK_API_KEY is not configured" }) });
      return;
    }

    await route.continue();
  });
}

/**
 * Self-contained interceptor for the Leagues workspace. Serves normalized
 * application payloads (the exact shapes the app routes produce) with a
 * version-controlled live snapshot: the first Gameweek poll returns the
 * pre-match baseline and every later poll adds a Saka goal, so feed diffing,
 * live scoring, and standings movement are all deterministic.
 */
export interface LeaguesInterceptOptions {
  /** Makes every live poll after the first fail, as a flaky FPL would. */
  failLiveAfterFirstPoll?: boolean;
}

export async function interceptLeaguesData(page: Page, options: LeaguesInterceptOptions = {}) {
  const USER_ENTRY_ID = 4827193;

  const doneBaseline: Record<number, number> = { 5: 6, 9: 4, 11: 7, 15: 5, 16: 6, 23: 4, 10: 4, 12: 5, 19: 3, 20: 2 };

  const leaguesFixtures = [
    { id: 101, gameweek: 1, kickoffTime: "2026-08-22T14:00:00Z", teamHomeId: 1, teamAwayId: 2, homeScore: 1, awayScore: 0, finished: false, started: true, minutes: 74 },
    { id: 102, gameweek: 1, kickoffTime: "2026-08-22T15:00:00Z", teamHomeId: 3, teamAwayId: 4, homeScore: 2, awayScore: 1, finished: true, started: true, minutes: 90 },
    { id: 103, gameweek: 1, kickoffTime: "2026-08-22T17:30:00Z", teamHomeId: 5, teamAwayId: 1, homeScore: null, awayScore: null, finished: false, started: false, minutes: 0 },
  ];

  const buildElements = (withGoal: boolean) => fixturePlayers.map((player) => {
    const done = player.team === 3 || player.team === 4;
    const upcoming = player.team === 5;
    const stats: Record<string, number | null> = {
      minutes: done ? 90 : upcoming ? 0 : 74,
      total_points: done ? doneBaseline[player.id] ?? 0 : 0,
      goals_scored: 0,
      assists: 0,
      yellow_cards: 0,
      red_cards: 0,
      own_goals: 0,
      bonus: 0,
      bps: done ? 20 : upcoming ? 0 : 9,
      saves: 0,
      clean_sheets: 0,
      penalties_saved: 0,
      penalties_missed: 0,
      defensive_contribution: 0,
    };
    if (withGoal && player.id === 2) {
      stats.total_points = 5;
      stats.goals_scored = 1;
      stats.bps = 29;
    }
    return { playerId: player.id, stats, explain: [] };
  });

  const pickRow = (element: number, position: number, elementType: number, multiplier: number, flags: { captain?: boolean; vice?: boolean } = {}) => ({
    element,
    position,
    elementType,
    multiplier,
    isCaptain: flags.captain ?? false,
    isViceCaptain: flags.vice ?? false,
  });

  const userPicks = {
    entryId: USER_ENTRY_ID,
    gameweek: 1,
    points: 0,
    activeChip: null,
    automaticSubs: [],
    picks: [
      pickRow(4, 1, 1, 1),
      pickRow(6, 2, 2, 1),
      pickRow(7, 3, 2, 1),
      pickRow(19, 4, 2, 1),
      pickRow(17, 5, 2, 1),
      pickRow(2, 6, 3, 2, { captain: true }),
      pickRow(3, 7, 3, 1),
      pickRow(11, 8, 3, 1),
      pickRow(12, 9, 3, 1),
      pickRow(14, 10, 4, 1, { vice: true }),
      pickRow(15, 11, 4, 1),
      pickRow(16, 12, 1, 0),
      pickRow(18, 13, 2, 0),
      pickRow(23, 14, 4, 0),
      pickRow(13, 15, 3, 0),
    ],
    entryHistory: { event: 1, points: 0, totalPoints: 1890, rank: 128542, overallRank: 45231, bank: 32, value: 10103, eventTransfersCost: 0, pointsOnBench: 0 },
  };

  const memberPicks: Record<number, unknown> = {
    111: {
      entryId: 111, gameweek: 1, points: 50, activeChip: null, automaticSubs: [],
      picks: [pickRow(2, 1, 3, 1), pickRow(5, 2, 1, 1), pickRow(9, 3, 2, 1)],
      entryHistory: { event: 1, points: 50, totalPoints: 1900, eventTransfersCost: 0 },
    },
    222: {
      entryId: 222, gameweek: 1, points: 48, activeChip: null, automaticSubs: [],
      picks: [pickRow(14, 1, 4, 1), pickRow(10, 2, 2, 1)],
      entryHistory: { event: 1, points: 48, totalPoints: 1885, eventTransfersCost: 0 },
    },
    333: {
      entryId: 333, gameweek: 1, points: 40, activeChip: null, automaticSubs: [],
      picks: [pickRow(15, 1, 4, 1), pickRow(20, 2, 2, 1)],
      entryHistory: { event: 1, points: 40, totalPoints: 1800, eventTransfersCost: 0 },
    },
  };

  const leagueNames: Record<number, string> = { 9001: "UBC FPL", 9003: "Office League" };
  const standingsRows = [
    { entryId: 111, entryName: "Guardians United", playerName: "Alice Chen", rank: 1, lastRank: 1, total: 1900 },
    { entryId: USER_ENTRY_ID, entryName: "Expected Toulouse", playerName: "Joel Tester", rank: 2, lastRank: 5, total: 1890 },
    { entryId: 222, entryName: "Green Azure FC", playerName: "Mike Li", rank: 3, lastRank: 2, total: 1885 },
    { entryId: 333, entryName: "Ctrl Alt De Laet", playerName: "Sarah Kim", rank: 4, lastRank: 4, total: 1800 },
  ];

  const profilePayload = {
    data: {
      entryId: USER_ENTRY_ID,
      teamName: "Expected Toulouse",
      managerName: "Joel Tester",
      profile: {
        entryId: USER_ENTRY_ID,
        name: "Expected Toulouse",
        playerFirstName: "Joel",
        playerLastName: "Tester",
        playerRegionName: "Canada",
        playerRegionIsoCodeShort: "CA",
        joinedTime: "2020-07-01T00:00:00Z",
        startedEvent: 1,
        yearsActive: 6,
        favouriteTeamId: 43,
        currentEvent: 1,
        summaryOverallPoints: 2310,
        summaryOverallRank: 45231,
        summaryEventPoints: 64,
        summaryEventRank: 128542,
        lastDeadlineBank: 32,
        lastDeadlineValue: 10103,
        lastDeadlineTotalTransfers: 1,
        leagues: {
          classic: [
            { id: 9001, name: "UBC FPL", leagueType: 1, entryRank: 2, entryLastRank: 4, size: 12, closed: false },
            { id: 9002, name: "Canada", leagueType: 1, entryRank: 215, entryLastRank: 220, size: 1024, closed: false },
            { id: 9003, name: "Office League", leagueType: 1, entryRank: 5, entryLastRank: 5, size: 20, closed: false },
            // Enough leagues that the list has to scroll inside its own panel.
            ...Array.from({ length: 9 }, (_, index) => ({
              id: 9100 + index,
              name: `Filler League ${index + 1}`,
              leagueType: 1,
              entryRank: 30 + index,
              entryLastRank: 30 + index,
              size: 40,
              closed: false,
            })),
          ],
          h2h: [],
          cup: [],
        },
      },
      squad: {
        playerIds: [4, 6, 7, 19, 17, 2, 3, 11, 12, 14, 15, 16, 18, 23, 13],
        byPosition: { GK: [4, 16], DEF: [6, 7, 19, 17, 18], MID: [2, 3, 11, 12, 13], FWD: [14, 15, 23] },
      },
      lineup: { gameweek: 1, benchGoalkeeperId: 16, benchOrder: [18, 23, 13], captainId: 2, viceCaptainId: 14 },
    },
    freshness: null,
  };

  const historyPayload = {
    data: {
      entryId: USER_ENTRY_ID,
      chips: [],
      current: [
        { event: 1, points: 64, totalPoints: 1890, rank: 128542, overallRank: 45231, bank: 32, value: 10103, eventTransfers: 1, eventTransfersCost: 4, pointsOnBench: 0, percentileRank: "top 5%" },
      ],
      past: [{ seasonName: "2025/26", totalPoints: 2210, rank: 98123 }],
    },
    freshness: null,
  };

  let liveCalls = 0;

  await page.route("**/*", async (route: Route) => {
    const url = route.request().url();
    const pathname = new URL(url).pathname;
    const fulfill = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (pathname === "/api/fpl/bootstrap") {
      await fulfill({ data: bootstrapStaticFixture, freshness: null });
      return;
    }

    if (pathname === "/api/fpl/fixtures") {
      await fulfill({ data: leaguesFixtures, freshness: null });
      return;
    }

    if (/^\/api\/fpl\/live\/\d+$/.test(pathname)) {
      liveCalls += 1;
      if (options.failLiveAfterFirstPoll && liveCalls > 1) {
        await fulfill({ data: null, errors: ["FPL returned HTTP 503"] }, 503);
        return;
      }
      await fulfill({ data: { gameweek: 1, elements: buildElements(liveCalls > 1) }, freshness: null });
      return;
    }

    const picksMatch = /^\/api\/fpl\/entry\/(\d+)\/event\/\d+\/picks$/.exec(pathname);
    if (picksMatch) {
      const entryId = Number(picksMatch[1]);
      const payload = entryId === USER_ENTRY_ID ? userPicks : memberPicks[entryId];
      if (!payload) {
        await fulfill({ data: null, errors: ["Picks unavailable for this manager"] }, 404);
        return;
      }
      await fulfill({ data: payload, freshness: null });
      return;
    }

    if (pathname === `/api/fpl/entry/${USER_ENTRY_ID}/history`) {
      await fulfill(historyPayload);
      return;
    }

    const standingsMatch = /^\/api\/fpl\/leagues\/classic\/(\d+)$/.exec(pathname);
    if (standingsMatch) {
      const leagueId = Number(standingsMatch[1]);
      if (!leagueNames[leagueId]) {
        await fulfill({ data: null, errors: ["League not found"] }, 404);
        return;
      }
      await fulfill({
        data: {
          league: { id: leagueId, name: leagueNames[leagueId], short_name: leagueNames[leagueId], closed: false },
          page: 1,
          hasNext: false,
          results: standingsRows,
        },
        freshness: null,
      });
      return;
    }

    if (pathname === `/api/fpl/entry/${USER_ENTRY_ID}`) {
      await fulfill(profilePayload);
      return;
    }

    if (pathname === "/api/ai") {
      await fulfill({ enabled: false });
      return;
    }

    if (pathname === "/api/optimizer" && route.request().method() === "POST") {
      await fulfill({ legal: true, squad: profilePayload.data.squad, playerIds: profilePayload.data.squad.playerIds, errors: [], warnings: [] });
      return;
    }

    if (pathname === "/api/transfer-suggestions" && route.request().method() === "POST") {
      await fulfill({ gameweek: 1, horizon: 5, suggestions: [] });
      return;
    }

    await route.continue();
  });
}

