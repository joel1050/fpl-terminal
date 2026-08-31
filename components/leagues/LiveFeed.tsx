"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { feedAgeLabel } from "@/lib/leagues/display";
import { FEED_FILTERS, feedTone, matchesFeedFilter, type FeedFilter } from "@/lib/leagues/feedEvents";
import {
  ownersOf,
  readLeagueImpact,
  type ImpactReadout,
  type LeagueOwnership,
  type OwnershipStatus,
} from "@/lib/leagues/leagueImpact";
import type { LiveEntryPlayer, LiveFeedEvent } from "@/types/leagues";

const AGE_TICK_MS = 30_000;
/** Below this the list is close enough to the top that new rows are visible. */
const SCROLLED_AWAY_PX = 48;

function signed(points: number): string {
  return points > 0 ? `+${points}` : `${points}`;
}

/** Says what the number compares against, or why there is no number. */
function impactLabel(readout: ImpactReadout): string {
  if (readout.kind === "LOADING") return "LEAGUE IMPACT LOADING…";
  if (readout.kind === "UNAVAILABLE") return "LEAGUE IMPACT UNAVAILABLE";
  const value = readout.impact > 0 ? `+${readout.impact.toFixed(1)}` : readout.impact.toFixed(1);
  const basis = readout.basis === "LEAGUE" ? "" : ` VS TOP ${readout.sampleSize}`;
  return `LEAGUE IMPACT ${value}${basis}`;
}

/** Kinds whose stat change says something the row title does not. */
function showsDetail(event: LiveFeedEvent): boolean {
  return event.kind === "BONUS CHANGE" || event.kind === "POINTS CHANGE";
}

export default function LiveFeed({
  events,
  userPlayerById,
  ownership,
  ownershipStatus,
  playerName,
}: {
  events: readonly LiveFeedEvent[];
  userPlayerById: ReadonlyMap<number, LiveEntryPlayer>;
  ownership: LeagueOwnership;
  ownershipStatus: OwnershipStatus;
  playerName: (playerId: number) => string;
}) {
  const [filter, setFilter] = useState<FeedFilter>("FOCUS");
  const [now, setNow] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolledAway, setScrolledAway] = useState(false);
  const [seenId, setSeenId] = useState<string | undefined>(undefined);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const visible = useMemo(() => events.filter((event) => {
    const mine = userPlayerById.get(event.playerId);
    return matchesFeedFilter(event, filter, {
      owned: Boolean(mine),
      ownerCount: ownersOf(ownership, event.playerId),
      userMultiplier: mine?.multiplier ?? 0,
    });
  }), [events, filter, ownership, userPlayerById]);

  const hidden = events.length - visible.length;
  const newestId = visible[0]?.id;

  // The read mark is set when the reader scrolls away from the top and cleared
  // when they come back, both in the handler: at the top there is nothing
  // unread, because whatever arrives lands in view.
  const onScroll = (element: HTMLDivElement) => {
    const away = element.scrollTop > SCROLLED_AWAY_PX;
    setScrolledAway(away);
    if (!away) setSeenId(undefined);
    else if (seenId === undefined) setSeenId(newestId);
  };

  const unreadCount = useMemo(() => {
    if (!scrolledAway || !seenId || seenId === newestId) return 0;
    const index = visible.findIndex((event) => event.id === seenId);
    return index < 0 ? visible.length : index;
  }, [newestId, scrolledAway, seenId, visible]);

  const backToTop = () => {
    scrollRef.current?.scrollTo({ top: 0 });
    setSeenId(undefined);
    setScrolledAway(false);
  };

  const announcement = visible.length
    ? `${visible.length} events. Newest: ${playerName(visible[0]!.playerId)} ${visible[0]!.kind}.`
    : "No events.";

  return (
    <section className="leagues-panel live-feed-panel" aria-label="Live feed">
      <div className="panel-header">
        <span className="section-kicker">LIVE FEED</span>
        <span className="panel-count">{visible.length}</span>
      </div>
      <div className="segmented feed-filters" role="group" aria-label="Feed filter">
        {FEED_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            className={filter === value ? "active" : ""}
            onClick={() => setFilter(value)}
          >
            {value}
          </button>
        ))}
      </div>
      {/* A short spoken summary rather than the whole list, which would read out
          every goal in the league each time a poll lands. */}
      <p className="feed-announce" role="status" aria-live="polite">{announcement}</p>
      <div
        className="feed-scroll"
        data-testid="live-feed-scroll"
        ref={scrollRef}
        onScroll={(scroll) => onScroll(scroll.currentTarget)}
      >
        {unreadCount > 0 && (
          <button type="button" className="feed-new" onClick={backToTop} data-testid="feed-new-pill">
            {unreadCount} NEW ↑
          </button>
        )}
        {!visible.length && (
          <div className="empty-state">
            {events.length
              ? `NO EVENTS MATCH THIS FILTER · ${hidden} HIDDEN`
              : "NOTHING HAS SCORED IN THIS GAMEWEEK YET"}
          </div>
        )}
        <ul className="feed-list">
          {visible.map((event) => {
            const mine = userPlayerById.get(event.playerId);
            const userMultiplier = mine?.multiplier ?? 0;
            const yourPoints = event.pointsDelta * userMultiplier;
            const owners = ownersOf(ownership, event.playerId);
            const impact = readLeagueImpact({
              ownership,
              status: ownershipStatus,
              playerId: event.playerId,
              pointsDelta: event.pointsDelta,
              userMultiplier,
            });
            const role = mine?.isCaptain ? " · CAPTAIN" : mine?.isViceCaptain ? " · VICE" : "";
            const age = feedAgeLabel(event, now);
            const toneClass = feedTone(yourPoints);
            return (
              <li key={event.id} className={`feed-event ${toneClass}`} data-testid="feed-event" title={event.detail}>
                <div className="feed-head">
                  <span className="feed-minute">{event.minute ?? (event.seeded ? "GW" : "--'")}</span>
                  <strong className="feed-title">{playerName(event.playerId)} {event.kind}</strong>
                  <span className="feed-delta">{signed(event.pointsDelta)}</span>
                </div>
                <div className="feed-sub">
                  {mine
                    ? <>YOU {userMultiplier > 0 ? signed(yourPoints) : "— · BENCH"}{role}</>
                    : owners > 0 ? `MY LEAGUE ×${owners}` : "LEAGUE WATCH"}
                </div>
                <div className="feed-sub">
                  {impactLabel(impact)}{age ? ` · ${age}` : ""}
                </div>
                {showsDetail(event) && event.detail && (
                  <div className="feed-sub feed-detail">{event.detail.toUpperCase()}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
