import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearComputeRateLimit,
  COMPUTE_RATE_LIMIT_MAX_BUCKETS,
  enforceComputeRateLimit,
  getComputeRateLimitBucketCount,
} from "@/lib/http/computeRateLimit";

describe("compute rate limit", () => {
  beforeEach(() => {
    clearComputeRateLimit();
  });

  it("rejects requests above the per-route client limit", async () => {
    const request = new Request("http://localhost/api/optimizer", {
      headers: { "x-real-ip": "rate-limit-test" },
    });

    for (let count = 0; count < 30; count += 1) {
      expect(enforceComputeRateLimit(request, "test")).toBeNull();
    }

    const response = enforceComputeRateLimit(request, "test");
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBeTruthy();
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    await expect(response?.json()).resolves.toEqual({ error: "Too many compute requests" });
  });

  it("accepts a custom limit and rejects the fourth request in the window", () => {
    const request = new Request("http://localhost/api/bootstrap?refresh=1", {
      headers: { "x-real-ip": "custom-rate-limit-test" },
    });

    for (let count = 0; count < 3; count += 1) {
      expect(enforceComputeRateLimit(request, "custom", { limit: 3 })).toBeNull();
    }

    const response = enforceComputeRateLimit(request, "custom", { limit: 3 });
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBeTruthy();
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("prunes expired buckets and caps unique-client churn", () => {
    vi.useFakeTimers();
    try {
      for (let count = 0; count < COMPUTE_RATE_LIMIT_MAX_BUCKETS + 25; count += 1) {
        const request = new Request("http://localhost/api/optimizer", {
          headers: { "x-real-ip": `churn-${count}` },
        });
        expect(enforceComputeRateLimit(request, "churn")).toBeNull();
      }
      expect(getComputeRateLimitBucketCount()).toBe(COMPUTE_RATE_LIMIT_MAX_BUCKETS);

      vi.advanceTimersByTime(60_001);
      expect(getComputeRateLimitBucketCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
