#!/usr/bin/env python3
"""Solve the best five-Gameweek balanced FPL squad as a binary program."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from urllib.request import urlopen

try:
    import numpy as np
    from scipy.optimize import Bounds, LinearConstraint, milp
    from scipy.sparse import coo_array
except ImportError:
    raise SystemExit("This script needs SciPy: python3 -m pip install scipy")


ROLES = {name: index for index, name in enumerate(("squad", "starter", "goalkeeper_bench", "bench_1", "bench_2", "bench_3"))}
POSITION_COUNTS = {"GK": 2, "DEF": 5, "MID": 5, "FWD": 3}
STARTER_MINIMUMS = {"GK": 1, "DEF": 3, "MID": 2, "FWD": 1}
BENCH_WEIGHTS = {"bench_1": 0.25, "bench_2": 0.15, "bench_3": 0.10}


def load_bootstrap(source: str) -> dict:
    with urlopen(source, timeout=60) as response:
        payload = json.load(response)
    data = payload.get("data", payload)
    if not isinstance(data, dict) or not isinstance(data.get("players"), list):
        raise ValueError("Source did not contain bootstrap player data.")
    return data


def risk_multiplier(player: dict) -> float:
    projection = player.get("projection") or {}
    minutes = min(90.0, max(0.0, float(projection.get("expectedMinutes") or 0))) / 100
    confidence = {"HIGH": 1.0, "LOW": 0.7}.get(projection.get("confidence"), 0.85)
    status = str(player.get("status") or "").lower()
    availability_risk = 0.75 if status in {"i", "s"} else 0.35 if status in {"d", "u"} else 0.0
    chance = player.get("chanceOfPlaying")
    if isinstance(chance, (int, float)):
        availability_risk += max(0.0, 1 - chance / 100) * 0.65
    availability = 1 - min(1.0, availability_risk)
    return (0.62 + 0.16 * minutes + 0.12 * confidence + 0.10 * availability) * 0.90


def solve(data: dict) -> dict:
    players = sorted(data["players"], key=lambda player: int(player["id"]))
    gameweeks = sorted({
        int(fixture["gameweek"])
        for player in players
        for fixture in (player.get("projection") or {}).get("fixtures", [])
        if fixture.get("gameweek") is not None
    })[:5]
    if len(gameweeks) != 5:
        raise ValueError(f"Expected five projected Gameweeks, found {gameweeks}.")

    count = len(players)
    role_variables = len(ROLES) * count
    variable_count = role_variables + len(gameweeks) * count
    index = lambda role, player_index: ROLES[role] * count + player_index
    captain_index = lambda gameweek_index, player_index: role_variables + gameweek_index * count + player_index
    utilities = []
    gameweek_utilities = []
    for player in players:
        multiplier = risk_multiplier(player)
        projection = player.get("projection") or {}
        utilities.append(float(projection.get("next5") or 0) * multiplier)
        by_gameweek = Counter()
        for fixture in projection.get("fixtures", []):
            by_gameweek[int(fixture["gameweek"])] += float(fixture.get("expectedPoints") or 0)
        gameweek_utilities.append([by_gameweek[gameweek] * multiplier for gameweek in gameweeks])

    objective = np.zeros(variable_count)
    lower_bounds = np.zeros(variable_count)
    upper_bounds = np.ones(variable_count)
    for player_index, player in enumerate(players):
        utility = utilities[player_index]
        confidence_bonus = 0.01 if (player.get("projection") or {}).get("confidence") == "HIGH" else 0
        objective[index("starter", player_index)] = -(utility + confidence_bonus)
        objective[index("goalkeeper_bench", player_index)] = -(utility * 0.05 - int(player["priceTenths"]) / 20)
        for role, weight in BENCH_WEIGHTS.items():
            objective[index(role, player_index)] = -utility * weight
        if player["position"] == "GK":
            for role in BENCH_WEIGHTS:
                upper_bounds[index(role, player_index)] = 0
        else:
            upper_bounds[index("goalkeeper_bench", player_index)] = 0
        for gameweek_index in range(len(gameweeks)):
            objective[captain_index(gameweek_index, player_index)] = -gameweek_utilities[player_index][gameweek_index]

    rows: list[dict[int, float]] = []
    row_lower: list[float] = []
    row_upper: list[float] = []

    def constrain(coefficients: dict[int, float], lower: float, upper: float) -> None:
        rows.append(coefficients)
        row_lower.append(lower)
        row_upper.append(upper)

    for player_index in range(count):
        constrain({
            index("squad", player_index): -1,
            index("starter", player_index): 1,
            index("goalkeeper_bench", player_index): 1,
            index("bench_1", player_index): 1,
            index("bench_2", player_index): 1,
            index("bench_3", player_index): 1,
        }, 0, 0)
    constrain({index("squad", i): 1 for i in range(count)}, 15, 15)
    constrain({index("starter", i): 1 for i in range(count)}, 11, 11)
    constrain({index("goalkeeper_bench", i): 1 for i in range(count)}, 1, 1)
    for role in BENCH_WEIGHTS:
        constrain({index(role, i): 1 for i in range(count)}, 1, 1)
    constrain({index("squad", i): int(player["priceTenths"]) for i, player in enumerate(players)}, 0, 1000)

    for position, required in POSITION_COUNTS.items():
        members = [i for i, player in enumerate(players) if player["position"] == position]
        constrain({index("squad", i): 1 for i in members}, required, required)
        minimum = STARTER_MINIMUMS[position]
        maximum = 1 if position == "GK" else required
        constrain({index("starter", i): 1 for i in members}, minimum, maximum)
    for team_id in {int(player["teamId"]) for player in players}:
        members = [i for i, player in enumerate(players) if int(player["teamId"]) == team_id]
        constrain({index("squad", i): 1 for i in members}, 0, 3)
    for gameweek_index in range(len(gameweeks)):
        constrain({captain_index(gameweek_index, i): 1 for i in range(count)}, 1, 1)
        for player_index in range(count):
            constrain({captain_index(gameweek_index, player_index): 1, index("starter", player_index): -1}, -np.inf, 0)

    row_indices = []
    column_indices = []
    values = []
    for row_index, coefficients in enumerate(rows):
        for column_index, value in coefficients.items():
            row_indices.append(row_index)
            column_indices.append(column_index)
            values.append(value)
    matrix = coo_array((values, (row_indices, column_indices)), shape=(len(rows), variable_count)).tocsc()
    result = milp(
        objective,
        integrality=np.ones(variable_count),
        bounds=Bounds(lower_bounds, upper_bounds),
        constraints=LinearConstraint(matrix, row_lower, row_upper),
        options={"mip_rel_gap": 0.0, "presolve": True},
    )
    if not result.success or result.x is None:
        raise RuntimeError(f"Optimizer failed: {result.message}")

    selected = lambda role: [players[i] for i in range(count) if result.x[index(role, i)] > 0.5]
    starters = selected("starter")
    bench = selected("goalkeeper_bench") + selected("bench_1") + selected("bench_2") + selected("bench_3")
    squad = starters + bench
    captains = []
    for gameweek_index, gameweek in enumerate(gameweeks):
        captain = next(players[i] for i in range(count) if result.x[captain_index(gameweek_index, i)] > 0.5)
        captains.append({"gameweek": gameweek, "player": captain["displayName"], "bonus": gameweek_utilities[players.index(captain)][gameweek_index]})

    position_counts = Counter(player["position"] for player in squad)
    club_counts = Counter(player["teamId"] for player in squad)
    assert len({player["id"] for player in squad}) == 15
    assert position_counts == Counter(POSITION_COUNTS)
    assert sum(int(player["priceTenths"]) for player in squad) <= 1000
    assert max(club_counts.values()) <= 3
    assert len(starters) == 11 and Counter(player["position"] for player in starters)["GK"] == 1

    return {
        "status": result.message,
        "mipGap": float(getattr(result, "mip_gap", 0.0)),
        "gameweeks": gameweeks,
        "objective": -float(result.fun),
        "cost": sum(int(player["priceTenths"]) for player in squad) / 10,
        "starters": starters,
        "bench": bench,
        "captains": captains,
        "utilities": {int(player["id"]): utilities[i] for i, player in enumerate(players)},
    }


def print_result(result: dict) -> None:
    utility = result.pop("utilities")
    print(f"{result['status']} | MIP gap {result['mipGap']:.6f} | £{result['cost']:.1f}m | objective {result['objective']:.3f}")
    print(f"Gameweeks: {', '.join(map(str, result['gameweeks']))}")
    for position in POSITION_COUNTS:
        players = [player for player in result["starters"] if player["position"] == position]
        print(f"{position}: " + ", ".join(f"{player['displayName']} £{player['priceTenths'] / 10:.1f} ({utility[player['id']]:.2f})" for player in players))
    print("Bench: " + " | ".join(f"{player['displayName']} £{player['priceTenths'] / 10:.1f} ({utility[player['id']]:.2f})" for player in result["bench"]))
    print("Captains: " + " | ".join(f"GW{captain['gameweek']} {captain['player']} (+{captain['bonus']:.2f})" for captain in result["captains"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", nargs="?", default="http://localhost:3000/api/fpl/bootstrap")
    args = parser.parse_args()
    try:
        print_result(solve(load_bootstrap(args.source)))
    except Exception as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
