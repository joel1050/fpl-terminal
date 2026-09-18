import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBootstrap: vi.fn(),
  getFixtures: vi.fn(),
  loadHistoricalBundle: vi.fn(),
  normalizeBootstrap: vi.fn(),
  enrichBootstrapWithProjections: vi.fn(),
  projectionCacheKey: vi.fn(),
}));

vi.mock("@/lib/fpl/client", () => ({
  getBootstrap: mocks.getBootstrap,
  getFixtures: mocks.getFixtures,
}));
vi.mock("@/lib/historical/load", () => ({ loadHistoricalBundle: mocks.loadHistoricalBundle }));
vi.mock("@/lib/fpl/normalize", () => ({
  normalizeBootstrap: mocks.normalizeBootstrap,
  enrichBootstrapWithProjections: mocks.enrichBootstrapWithProjections,
  projectionCacheKey: mocks.projectionCacheKey,
}));

import { GET } from "@/app/api/fpl/bootstrap/route";
import {
  clearFplCache,
  FPL_MEMORY_CACHE_MAX_ENTRIES,
  getFplMemoryCacheSize,
  getMemoryCache,
  setMemoryCache,
} from "@/lib/fpl/cache";
import { clearComputeRateLimit } from "@/lib/http/computeRateLimit";

const freshness = {
  source: "live",
  fetchedAt: new Date(0).toISOString(),
  ageSeconds: 0,
  stale: false,
  ttlSeconds: 300,
} as const;

function bootstrapRequest(refresh: boolean, client = "bootstrap-refresh-test"): Request {
  const suffix = refresh ? "?refresh=1" : "";
  return new Request(`http://localhost/api/fpl/bootstrap${suffix}`, {
    headers: { "x-real-ip": client },
  });
}

describe("FPL memory cache bounds", () => {
  beforeEach(() => {
    clearFplCache();
  });

  it("caps entries, keeps updates, and evicts the least recently used entry", () => {
    for (let index = 0; index < FPL_MEMORY_CACHE_MAX_ENTRIES; index += 1) {
      setMemoryCache(`entry-${index}`, index, index);
    }
    setMemoryCache("entry-0", "updated", 10_000);
    setMemoryCache(`entry-${FPL_MEMORY_CACHE_MAX_ENTRIES}`, "new", 10_001);

    expect(getFplMemoryCacheSize()).toBe(FPL_MEMORY_CACHE_MAX_ENTRIES);
    expect(getMemoryCache("entry-0")?.data).toBe("updated");
    expect(getMemoryCache("entry-1")).toBeUndefined();
  });
});

describe("bootstrap refresh rate limit", () => {
  beforeEach(() => {
    clearComputeRateLimit();
    mocks.getBootstrap.mockReset().mockResolvedValue({ data: { events: [] }, freshness });
    mocks.getFixtures.mockReset().mockResolvedValue({ data: [], freshness });
    mocks.loadHistoricalBundle.mockReset().mockResolvedValue(null);
    mocks.normalizeBootstrap.mockReset().mockReturnValue({ players: [], teams: [], fixtures: [], events: [] });
    mocks.enrichBootstrapWithProjections.mockReset().mockResolvedValue({
      bootstrap: { players: [] },
      metadata: {},
    });
    mocks.projectionCacheKey.mockReset().mockReturnValue("test-bootstrap-generation");
  });

  it("rejects an over-limit refresh before any FPL or projection work", async () => {
    for (let index = 0; index < 3; index += 1) {
      expect((await GET(bootstrapRequest(true))).status).toBe(200);
    }

    const bootstrapCalls = mocks.getBootstrap.mock.calls.length;
    const fixtureCalls = mocks.getFixtures.mock.calls.length;
    const historicalCalls = mocks.loadHistoricalBundle.mock.calls.length;
    const projectionCalls = mocks.enrichBootstrapWithProjections.mock.calls.length;
    const response = await GET(bootstrapRequest(true));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.getBootstrap).toHaveBeenCalledTimes(bootstrapCalls);
    expect(mocks.getFixtures).toHaveBeenCalledTimes(fixtureCalls);
    expect(mocks.loadHistoricalBundle).toHaveBeenCalledTimes(historicalCalls);
    expect(mocks.enrichBootstrapWithProjections).toHaveBeenCalledTimes(projectionCalls);
  });

  it("does not rate-limit normal bootstrap requests", async () => {
    const responses = await Promise.all(Array.from({ length: 4 }, () => GET(bootstrapRequest(false))));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(mocks.getBootstrap).toHaveBeenCalledTimes(4);
  });
});
