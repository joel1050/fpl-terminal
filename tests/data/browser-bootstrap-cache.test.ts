import { describe, expect, it } from "vitest";
import { isUsableBootstrapData } from "@/lib/fpl/browserBootstrapCache";

describe("browser bootstrap cache", () => {
  it("only accepts bootstrap payloads with players", () => {
    expect(isUsableBootstrapData({ players: [{ id: 1 }] })).toBe(true);
    expect(isUsableBootstrapData({ players: [] })).toBe(false);
    expect(isUsableBootstrapData(null)).toBe(false);
  });
});
