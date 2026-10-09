/**
 * Keeps the players of one pitch line where the user last saw them.
 *
 * `previous` is the line as drawn before a change, `next` is the set of ids the
 * line holds now (in any order). Players who stay keep their relative order.
 * If one player left and one arrived, the arrival takes the leaver's place.
 * Any other arrivals go to the end, in the order given.
 */
export function stableLineOrder(previous: readonly number[], next: readonly number[]): number[] {
  if (previous.length === 0) return [...next];
  const nextSet = new Set(next);
  const previousSet = new Set(previous);
  const arrived = next.filter((id) => !previousSet.has(id));
  const leftIndexes = previous.flatMap((id, index) => (nextSet.has(id) ? [] : [index]));
  if (leftIndexes.length === 1 && arrived.length === 1) {
    return previous.map((id) => (nextSet.has(id) ? id : arrived[0]));
  }
  return [...previous.filter((id) => nextSet.has(id)), ...arrived];
}
