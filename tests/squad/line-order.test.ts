import { describe, expect, it } from "vitest";
import { stableLineOrder } from "@/lib/squad/lineOrder";

describe("stableLineOrder", () => {
  it("returns the new order as given when there is no previous order", () => {
    expect(stableLineOrder([], [4, 2, 9])).toEqual([4, 2, 9]);
  });

  it("keeps the previous order when the set is unchanged", () => {
    expect(stableLineOrder([1, 2, 3, 4], [3, 1, 4, 2])).toEqual([1, 2, 3, 4]);
  });

  it("puts an incoming player in the place of the one who left", () => {
    expect(stableLineOrder([1, 2, 3, 4], [9, 1, 2, 3])).toEqual([1, 2, 3, 9]);
    expect(stableLineOrder([1, 2, 3, 4], [1, 9, 3, 4])).toEqual([1, 9, 3, 4]);
    expect(stableLineOrder([1, 2, 3, 4], [4, 3, 9, 2])).toEqual([9, 2, 3, 4]);
  });

  it("closes the gap in the line that loses a player and appends to the line that gains one", () => {
    expect(stableLineOrder([1, 2, 3, 4], [4, 1, 3])).toEqual([1, 3, 4]);
    expect(stableLineOrder([5, 6, 7], [7, 8, 5, 6])).toEqual([5, 6, 7, 8]);
  });

  it("keeps stayers in order and appends arrivals when several change at once", () => {
    expect(stableLineOrder([1, 2, 3, 4], [9, 8, 3, 1])).toEqual([1, 3, 9, 8]);
    expect(stableLineOrder([1, 2, 3], [7, 8, 9])).toEqual([7, 8, 9]);
  });
});
