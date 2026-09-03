import { NextResponse } from "next/server";

const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 30;

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function enforceComputeRateLimit(request: Request, scope: string): Response | null {
  const now = Date.now();
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  const client = request.headers.get("x-real-ip") ?? forwardedFor ?? "local";
  const key = `${scope}:${client}`;
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return null;
  }

  if (current.count >= REQUEST_LIMIT) {
    return NextResponse.json(
      { error: "Too many compute requests" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil((current.resetAt - now) / 1_000)) },
      },
    );
  }

  current.count += 1;
  return null;
}
