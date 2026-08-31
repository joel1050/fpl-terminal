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
  points_per_game: string;
  form: string;
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
  points_per_game: (points / 30).toFixed(1),
  form: (points / 45).toFixed(1),
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
    web_name: current.web_name,
    displayName: current.web_name,
    team: { id: current.team, name: team?.name ?? "Test Club", shortName: team?.short_name ?? "TST" },
    teamId: current.team,
    teamName: team?.name ?? "Test Club",
    teamShortName: team?.short_name ?? "TST",
    position: (["", "GK", "DEF", "MID", "FWD"] as const)[current.element_type],
    priceTenths: current.now_cost,
    ownership: Number(current.selected_by_percent),
    current: {
      totalPoints: current.total_points,
      pointsPer90: current.minutes ? (current.total_points / (current.minutes / 90)) : undefined,
      form: Number(current.form),
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
      next10: 35 + current.total_points / 10,
      expectedMinutes: 80,
      valueNext5: (17.5 + current.total_points / 20) / (current.now_cost / 10),
      riskScore: 20,
      confidence: "MEDIUM",
      fixtures: [],
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

const profileStats = (totalPoints: number, minutes: number, overrides: Record<string, number> = {}) => ({
  totalPoints,
  minutes,
  starts: minutes >= 60 ? 1 : 0,
  goals: 0,
  assists: 0,
  cleanSheets: 0,
  goalsConceded: 0,
  ownGoals: 0,
  penaltiesSaved: 0,
  penaltiesMissed: 0,
  yellowCards: 0,
  redCards: 0,
  saves: 0,
  bonus: 0,
  bps: 14,
  influence: 18,
  creativity: 8,
  threat: 42,
  ictIndex: 6.8,
  defensiveContribution: 4,
  clearancesBlocksInterceptions: 1,
  recoveries: 3,
  tackles: 1,
  expectedGoals: 0.32,
  expectedAssists: 0.08,
  expectedGoalInvolvements: 0.4,
  expectedGoalsConceded: 1.1,
  ...overrides,
});

const recentProfileMatches = [
  { fixtureId: 601, gameweek: 1, opponentTeamId: 2, opponentShortName: "TUN", isHome: true, kickoffTime: "2026-08-01T14:00:00Z", teamHomeScore: 3, teamAwayScore: 0, stats: profileStats(13, 90, { goals: 2, cleanSheets: 1, bonus: 3, bps: 44, expectedGoals: 1.42, expectedGoalInvolvements: 1.5 }) },
  { fixtureId: 602, gameweek: 2, opponentTeamId: 3, opponentShortName: "TRV", isHome: false, kickoffTime: "2026-08-08T14:00:00Z", teamHomeScore: 1, teamAwayScore: 2, stats: profileStats(8, 90, { goals: 1, bonus: 2, bps: 31, expectedGoals: 0.71, expectedGoalInvolvements: 0.76 }) },
  { fixtureId: 603, gameweek: 3, opponentTeamId: 4, opponentShortName: "TAT", isHome: true, kickoffTime: "2026-08-15T14:00:00Z", teamHomeScore: 1, teamAwayScore: 1, stats: profileStats(2, 90, { expectedGoals: 0.55, expectedGoalInvolvements: 0.61 }) },
  { fixtureId: 604, gameweek: 4, opponentTeamId: 5, opponentShortName: "TWA", isHome: false, kickoffTime: "2026-08-22T14:00:00Z", teamHomeScore: 0, teamAwayScore: 2, stats: profileStats(6, 84, { assists: 1, cleanSheets: 1, bonus: 1, bps: 27, expectedAssists: 0.48, expectedGoalInvolvements: 0.82 }) },
  { fixtureId: 605, gameweek: 5, opponentTeamId: 2, opponentShortName: "TUN", isHome: true, kickoffTime: "2026-08-26T18:30:00Z", teamHomeScore: 0, teamAwayScore: 1, stats: profileStats(1, 90, { expectedGoals: 0.18, expectedGoalInvolvements: 0.22 }) },
  { fixtureId: 606, gameweek: 6, opponentTeamId: 3, opponentShortName: "TRV", isHome: false, kickoffTime: "2026-08-29T16:30:00Z", teamHomeScore: 1, teamAwayScore: 4, stats: profileStats(17, 90, { goals: 3, bonus: 3, bps: 58, expectedGoals: 2.12, expectedGoalInvolvements: 2.18 }) },
];

const profileCurrent = {
  ...browserPlayers[0].current,
  totalPoints: recentProfileMatches.reduce((sum, match) => sum + match.stats.totalPoints, 0),
  pointsPerGame: 7.8,
  form: 6.4,
  starts: 6,
  minutes: 534,
  goals: 6,
  assists: 1,
  cleanSheets: 3,
  goalsConceded: 3,
  ownGoals: 0,
  penaltiesSaved: 0,
  penaltiesMissed: 0,
  bonus: 9,
  bps: 192,
  influence: 245.4,
  creativity: 84.2,
  threat: 361,
  ictIndex: 69.1,
  expectedGoals: 5.3,
  expectedAssists: 0.74,
  expectedGoalInvolvements: 6.04,
  expectedGoalsConceded: 5.1,
  defensiveContribution: 28,
  clearancesBlocksInterceptions: 4,
  recoveries: 19,
  tackles: 5,
  yellowCards: 1,
  redCards: 0,
  pointsPer90: 47 / (534 / 90),
};

const profileFixtures = [
  { fixtureId: 701, gameweek: 7, opponentTeamId: 4, opponentShortName: "TAT", isHome: true, difficulty: 2, kickoffTime: "2026-09-05T14:00:00Z" },
  { fixtureId: 702, gameweek: 8, opponentTeamId: 5, opponentShortName: "TWA", isHome: false, difficulty: 2, kickoffTime: "2026-09-12T16:30:00Z" },
  { fixtureId: 703, gameweek: 9, opponentTeamId: 2, opponentShortName: "TUN", isHome: true, difficulty: 4, kickoffTime: "2026-09-19T14:00:00Z" },
  { fixtureId: 704, gameweek: 10, opponentTeamId: 3, opponentShortName: "TRV", isHome: false, difficulty: 3, kickoffTime: "2026-09-26T14:00:00Z" },
  { fixtureId: 705, gameweek: 11, opponentTeamId: 5, opponentShortName: "TWA", isHome: true, difficulty: 1, kickoffTime: "2026-10-03T14:00:00Z" },
];

export const playerProfileFixture = {
  data: {
    player: { ...browserPlayers[0], current: profileCurrent, fixtures: profileFixtures },
    fixtures: profileFixtures,
    history: recentProfileMatches,
    historyPast: [
      { season: "2023/24", startPriceTenths: 140, endPriceTenths: 142, stats: profileStats(217, 2552, { starts: 29, goals: 27, assists: 8, cleanSheets: 9, bonus: 29, bps: 658, expectedGoals: 29.18, expectedAssists: 4.11, expectedGoalInvolvements: 33.29, defensiveContribution: 72, ictIndex: 331.2 }) },
      { season: "2024/25", startPriceTenths: 150, endPriceTenths: 149, stats: profileStats(181, 2776, { starts: 31, goals: 22, assists: 3, cleanSheets: 8, bonus: 21, bps: 571, expectedGoals: 25.24, expectedAssists: 3.48, expectedGoalInvolvements: 28.72, defensiveContribution: 81, ictIndex: 298.4 }) },
      { season: "2025/26", startPriceTenths: 145, endPriceTenths: 146, stats: profileStats(204, 2891, { starts: 33, goals: 25, assists: 5, cleanSheets: 10, bonus: 26, bps: 622, expectedGoals: 27.16, expectedAssists: 4.22, expectedGoalInvolvements: 31.38, defensiveContribution: 88, ictIndex: 320.7 }) },
    ],
  },
  freshness: { player: { source: "live", fetchedAt: "2026-08-30T18:00:00.000Z", stale: false } },
};
