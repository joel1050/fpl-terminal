/** Upper case for a home fixture, lower case for an away one. */
export function fixtureLabel(fixture: { opponentShortName: string; isHome: boolean }): string {
  return fixture.isHome ? fixture.opponentShortName.toUpperCase() : fixture.opponentShortName.toLowerCase();
}
