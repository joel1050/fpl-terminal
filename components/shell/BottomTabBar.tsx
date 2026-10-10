"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTerminalStore } from "@/store/terminalStore";

/**
 * The phone tab bar, shared by Planner and Leagues. On the Planner, Squad and
 * Players switch the panel in place. On Leagues they link back to the Planner
 * and set the panel first, so the Planner opens on the tab that was chosen.
 */
export function BottomTabBar({ active, onSquad, onPlayers, onMore }: { active: "SQUAD" | "PLAYERS" | "LEAGUES"; onSquad?: () => void; onPlayers?: () => void; onMore: () => void }) {
  const onLeagues = usePathname() === "/leagues";
  return (
    <nav className="tab-bar" aria-label="Main">
      {onLeagues ? (
        <Link href="/" prefetch={false} aria-current={active === "SQUAD" ? "page" : undefined} onClick={() => useTerminalStore.getState().setMobileTab("SQUAD")}>Squad</Link>
      ) : (
        <button type="button" aria-current={active === "SQUAD" ? "page" : undefined} onClick={onSquad}>Squad</button>
      )}
      {onLeagues ? (
        <Link href="/" prefetch={false} aria-current={active === "PLAYERS" ? "page" : undefined} onClick={() => useTerminalStore.getState().setMobileTab("MARKET")}>Players</Link>
      ) : (
        <button type="button" aria-current={active === "PLAYERS" ? "page" : undefined} onClick={onPlayers}>Players</button>
      )}
      <Link href="/leagues" prefetch={false} aria-current={active === "LEAGUES" ? "page" : undefined}>Leagues</Link>
      <button type="button" aria-haspopup="dialog" onClick={onMore}>More</button>
    </nav>
  );
}
