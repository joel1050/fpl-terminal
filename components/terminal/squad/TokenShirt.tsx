import type { CSSProperties, ReactNode } from "react";
import { clubColour, shirtTextColour } from "@/lib/display/clubColours";

/** The club shirt on a pitch token. Badges (role, flag, lock) go in as children. */
export function TokenShirt({ club, children }: { club: string; children?: ReactNode }) {
  const shirtColour = clubColour(club);
  return (
    <span className="token-shirt" style={{ "--shirt": shirtColour, color: shirtTextColour(shirtColour) } as CSSProperties} aria-hidden="true">
      <span className="token-club">{club}</span>
      {children}
    </span>
  );
}
