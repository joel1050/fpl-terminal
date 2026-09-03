import { describe, expect, it } from "vitest";

import { enforceComputeRateLimit } from "@/lib/http/computeRateLimit";

describe("compute rate limit", () => {
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
    await expect(response?.json()).resolves.toEqual({ error: "Too many compute requests" });
  });
});
