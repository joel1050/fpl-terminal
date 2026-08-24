"use client";

import { useMemo, useState } from "react";
import { relativeLeagueImpact } from "@/lib/leagues/leagueImpact";
import type { LiveEntryPlayer, LiveFeedEvent } from "@/types/leagues";

const FILTERS = ["ALL", "MY TEAM", "MY LEAGUE", "BONUS", "NEGATIVE"] as const;
type FeedFilter = (typeof FILTERS)[number];

function isBonusKind(kind: LiveFeedEvent["kind"]): boolean {
  return kind === "BONUS CHANGE" || kind === "CLEAN SHEET" || kind === "SAVE POINT";
}

export default function LiveFeed({
  events,
  userPlayerById,
  leagueAverageMultiplier,
  leagueOwnerCount,
  playerName,
}: {
  events: readonly LiveFeedEvent[];
  userPlayerById: ReadonlyMap<number, LiveEntryPlayer>;
  leagueAverageMultiplier: (playerId: number) => number;
  leagueOwnerCount: (playerId: number) => number;
  playerName: (playerId: number) => string;
}) {
  const [filter, setFilter] = useState<FeedFilter>("ALL");

  const visible = useMemo(() => events.filter((event) => {
    const mine = userPlayerById.get(event.playerId);
    switch (filter) {
      case "MY TEAM": return Boolean(mine);
      case "MY LEAGUE": return leagueOwnerCount(event.playerId) > 0;
      case "BONUS": return isBonusKind(event.kind);
      case "NEGATIVE": return event.rawPointsDelta < 0;
      default: return true;
    }
  }), [events, filter, leagueOwnerCount, userPlayerById]);

  return (
    <section className="leagues-panel live-feed-panel" aria-label="Live feed">
      <div className="panel-header">
        <span className="section-kicker">LIVE FEED</span>
        <div className="segmented feed-filters" role="group" aria-label="Feed filter">
          {FILTERS.map((value) => (
            <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
              {value}
            </button>
          ))}
        </div>
      </div>
      <div className="feed-scroll" data-testid="live-feed-scroll">
        {!visible.length && <div className="empty-state">NO POINT CHANGES SINCE YOU OPENED THIS PAGE</div>}
        <ul className="feed-list">
          {visible.map((event) => {
            const mine = userPlayerById.get(event.playerId);
            const userMultiplier = mine?.multiplier ?? 0;
            const impact = relativeLeagueImpact(event.rawPointsDelta, userMultiplier, leagueAverageMultiplier(event.playerId));
            const delta = event.rawPointsDelta * userMultiplier;
            const ownership = mine
              ? `YOU OWN${mine.isCaptain ? " · CAPTAIN" : mine.isViceCaptain ? " · VICE" : ""}`
              : (() => {
                const owners = leagueOwnerCount(event.playerId);
                return owners > 0 ? `MY LEAGUE ×${owners}` : "LEAGUE WATCH";
              })();
            const toneClass = delta > 0 ? "gain" : delta < 0 ? "loss" : "flat";
            return (
              <li key={event.id} className={`feed-event ${toneClass}`} data-testid="feed-event">
                <div className="feed-head">
                  <span className="feed-minute">{event.minute ?? "--'"}</span>
                  <strong className="feed-title">{playerName(event.playerId)} {event.kind}</strong>
                  <span className="feed-delta">{delta > 0 ? `+${delta}` : `${delta}`}</span>
                </div>
                <div className="feed-sub">{ownership}</div>
                <div className="feed-sub">LEAGUE IMPACT {impact > 0 ? `+${impact.toFixed(1)}` : impact.toFixed(1)}</div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
