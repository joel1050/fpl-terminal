/**
 * Deterministic, clearly labelled FPL payloads for browser tests only.
 * Production never imports this file: tests intercept the server data boundary.
 */

type FixturePosition = 1 | 2 | 3 | 4;

export interface FixturePlayer {
  id: number;
  web_name: string;
  first_name: string;
  second_name: string;
  team: number;
  element_type: FixturePosition;
  now_cost: number;
  selected_by_percent: string;
  status: "a" | "d" | "i";
  news: string;
  chance_of_playing_next_round: number | null;
  total_points: number;
  minutes: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  saves: number;
  bonus: number;
  bps: number;
  influence: string;
  creativity: string;
  threat: string;
  expected_goals: string;
  expected_assists: string;
  starts: number;
}

const teams = [
  { id: 1, name: "Test City", short_name: "TST", strength: 4, strength_attack_home: 1300, strength_attack_away: 1250, strength_defence_home: 1280, strength_defence_away: 1230 },
  { id: 2, name: "Test United", short_name: "TUN", strength: 4, strength_attack_home: 1260, strength_attack_away: 1210, strength_defence_home: 1240, strength_defence_away: 1200 },
  { id: 3, name: "Test Rovers", short_name: "TRV", strength: 3, strength_attack_home: 1080, strength_attack_away: 1050, strength_defence_home: 1090, strength_defence_away: 1060 },
  { id: 4, name: "Test Athletic", short_name: "TAT", strength: 2, strength_attack_home: 920, strength_attack_away: 900, strength_defence_home: 930, strength_defence_away: 910 },
  { id: 5, name: "Test Wanderers", short_name: "TWA", strength: 2, strength_attack_home: 860, strength_attack_away: 840, strength_defence_home: 870, strength_defence_away: 850 },
];

const player = (
  id: number,
  web_name: string,
  element_type: FixturePosition,
  now_cost: number,
  team = 1,
  points = 80,
): FixturePlayer => ({
  id,
  web_name,
  first_name: web_name,
  second_name: web_name,
  team,
  element_type,
  now_cost,
  selected_by_percent: "12.0",
  status: "a",
  news: "",
  chance_of_playing_next_round: null,
  total_points: points,
  minutes: 2400,
  goals_scored: element_type === 3 || element_type === 4 ? 10 : 1,
  assists: element_type === 3 ? 8 : 2,
  clean_sheets: element_type === 1 || element_type === 2 ? 10 : 2,
  saves: element_type === 1 ? 80 : 0,
  bonus: 12,
  bps: 500,
  influence: "700",
  creativity: "650",
  threat: "700",
  expected_goals: element_type === 3 || element_type === 4 ? "8.00" : "1.50",
  expected_assists: element_type === 3 ? "5.00" : "1.00",
  starts: 28,
});

// The three premium names are used by the brief's acceptance path. The other
// players make a legal completion possible without relying on live data.
export const fixturePlayers: FixturePlayer[] = [
  player(1, "Haaland", 4, 140, 1, 220),
  player(2, "Saka", 3, 100, 1, 190),
  player(3, "Palmer", 3, 105, 2, 205),
  player(4, "Raya", 1, 50, 1, 110),
  player(5, "Turner", 1, 40, 3, 70),
  player(6, "Gabriel", 2, 55, 1, 130),
  player(7, "Gvardiol", 2, 50, 2, 120),
  player(8, "White", 2, 48, 1, 115),
  player(9, "Pau", 2, 45, 3, 95),
  player(10, "Andersen", 2, 44, 4, 90),
  player(11, "Mbeumo", 3, 70, 3, 150),
  player(12, "Gordon", 3, 70, 4, 145),
  player(13, "Rogers", 3, 55, 5, 120),
  player(14, "Watkins", 4, 90, 2, 165),
  player(15, "Solanke", 4, 65, 3, 125),
  player(16, "Areola", 1, 40, 4, 65),
  player(17, "Faes", 2, 40, 5, 75),
  player(18, "Konsa", 2, 42, 5, 82),
  player(19, "Dunk", 2, 43, 4, 84),
  player(20, "Smith", 2, 40, 5, 68),
  player(21, "Rice", 3, 50, 1, 95),
  player(22, "Onana", 3, 50, 2, 88),
  player(23, "Wissa", 4, 60, 3, 102),
];

const fixtures = fixturePlayers.flatMap((current, index) => [
  { id: index * 2 + 1, event: 1, team_h: current.team, team_a: (current.team % teams.length) + 1, team_h_difficulty: 2, team_a_difficulty: 3 },
  { id: index * 2 + 2, event: 2, team_h: ((current.team + 1) % teams.length) + 1, team_a: current.team, team_h_difficulty: 3, team_a_difficulty: 2 },
]);

// `/api/fpl/bootstrap` returns normalized players in the running app. Keep a
// small team object on each record because the UI also accepts raw-like rows.
// This prevents the browser fixture from depending on a live server response.
const browserPlayers = fixturePlayers.map((current) => {
  const team = teams.find((candidate) => candidate.id === current.team);
  return {
    ...current,
    team: { id: current.team, name: team?.name ?? "Test Club", shortName: team?.short_name ?? "TST" },
    teamId: current.team,
    teamName: team?.name ?? "Test Club",
    teamShortName: team?.short_name ?? "TST",
    position: (["", "GK", "DEF", "MID", "FWD"] as const)[current.element_type],
    priceTenths: current.now_cost,
    ownership: Number(current.selected_by_percent),
    current: {
      totalPoints: current.total_points,
      minutes: current.minutes,
      goals: current.goals_scored,
      assists: current.assists,
      cleanSheets: current.clean_sheets,
      saves: current.saves,
      bonus: current.bonus,
    },
    projection: {
      nextGW: 3.5 + current.total_points / 100,
      next3: 10.5 + current.total_points / 30,
      next5: 17.5 + current.total_points / 20,
      expectedMinutes: 80,
      valueNext5: (17.5 + current.total_points / 20) / (current.now_cost / 10),
      riskScore: 20,
      confidence: "MEDIUM",
    },
    selection: {
      startProbability: 0.88,
      cameoProbability: 0.06,
      noAppearanceProbability: 0.06,
      expectedMinutes: 71.6,
      nailedRating: 5,
      confidence: "HIGH",
      updatedAt: "2026-08-20T18:00:00.000Z",
      evidence: [
        { source: "ROTOWIRE_XI", detail: "RotoWire predicted starter" },
        { source: "HISTORICAL_STARTS", detail: "28 starts across 38 historical matches" },
        { source: "FPL_STATUS", detail: "FPL status: available" },
      ],
    },
  };
});

export const bootstrapStaticFixture = {
  players: browserPlayers,
  gameweek: 1,
  deadline: "2026-08-22T10:00:00Z",
  source: "deterministic browser fixture",
  teams,
  events: [
    { id: 1, name: "Gameweek 1", is_next: true, finished: false, deadline_time: "2026-08-22T10:00:00Z" },
    { id: 2, name: "Gameweek 2", is_next: false, finished: false, deadline_time: "2026-08-29T10:00:00Z" },
  ],
};

export const fixturesFixture = fixtures;
