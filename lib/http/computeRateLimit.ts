import { NextResponse } from "next/server";

const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 30;
export const COMPUTE_RATE_LIMIT_MAX_BUCKETS = 1_000;

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export interface ComputeRateLimitOptions {
  limit?: number;
  windowMs?: number;
}

function pruneExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function evictOldest(): void {
  while (buckets.size >= COMPUTE_RATE_LIMIT_MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) return;
    buckets.delete(oldest);
  }
}

export function clearComputeRateLimit(): void {
  buckets.clear();
}

export function getComputeRateLimitBucketCount(): number {
  pruneExpired(Date.now());
  return buckets.size;
}

export function enforceComputeRateLimit(
  request: Request,
  scope: string,
  options: ComputeRateLimitOptions | number = {},
): Response | null {
  const now = Date.now();
  pruneExpired(now);
  const limit = typeof options === "number" ? options : options.limit ?? REQUEST_LIMIT;
  const windowMs = typeof options === "number" ? WINDOW_MS : options.windowMs ?? WINDOW_MS;
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  const client = request.headers.get("x-real-ip") ?? forwardedFor ?? "local";
  const key = `${scope}:${client}`;
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    evictOldest();
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }

  if (current.count >= limit) {
    return NextResponse.json(
      { error: "Too many compute requests" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil((current.resetAt - now) / 1_000))),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  current.count += 1;
  return null;
}
