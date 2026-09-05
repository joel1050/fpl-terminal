import { describe, expect, it } from "vitest";
import { FPL_HTTP_CACHE, fplJson } from "@/lib/fpl/http";

const fresh = { source: "live", stale: false };

describe("FPL HTTP caching", () => {
  it("uses the shortest dependency TTL for composite public responses", () => {
    expect(FPL_HTTP_CACHE.bootstrap).toBe("public, max-age=300, s-maxage=300");
    expect(FPL_HTTP_CACHE.fixtures).toBe("public, max-age=300, s-maxage=300");
    expect(FPL_HTTP_CACHE.player).toBe("public, max-age=300, s-maxage=300");
    expect(FPL_HTTP_CACHE.live).toBe("public, max-age=30, s-maxage=60");
    expect(Object.values(FPL_HTTP_CACHE).every((value) => !value.includes("stale-while-revalidate"))).toBe(true);
  });

  it("caches only clean successful responses", () => {
    const success = fplJson({ ok: true }, fresh, [], 200, undefined, {
      cacheControl: FPL_HTTP_CACHE.bootstrap,
    });
    expect(success.headers.get("Cache-Control")).toBe(FPL_HTTP_CACHE.bootstrap);

    const error = fplJson({ ok: false }, fresh, ["upstream failed"], 200, undefined, {
      cacheControl: FPL_HTTP_CACHE.bootstrap,
    });
    expect(error.headers.get("Cache-Control")).toBe("no-store");

    const refresh = fplJson({ ok: true }, fresh, [], 200, undefined, {
      cacheControl: FPL_HTTP_CACHE.bootstrap,
      noStore: true,
    });
    expect(refresh.headers.get("Cache-Control")).toBe("no-store");

    const stale = fplJson({ ok: true }, { source: "snapshot", stale: true }, [], 200, undefined, {
      cacheControl: FPL_HTTP_CACHE.bootstrap,
    });
    expect(stale.headers.get("Cache-Control")).toBe("no-store");

    const nullResponse = fplJson(null, fresh, [], undefined, undefined, {
      cacheControl: FPL_HTTP_CACHE.bootstrap,
    });
    expect(nullResponse.status).toBe(503);
    expect(nullResponse.headers.get("Cache-Control")).toBe("no-store");

    const non2xx = fplJson({ ok: false }, fresh, [], 502, undefined, {
      cacheControl: FPL_HTTP_CACHE.bootstrap,
    });
    expect(non2xx.status).toBe(502);
    expect(non2xx.headers.get("Cache-Control")).toBe("no-store");
  });
});
