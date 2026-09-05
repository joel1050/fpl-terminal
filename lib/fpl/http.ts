import type { FreshnessMetadata } from "./cache";

export const FPL_HTTP_CACHE = {
  bootstrap: "public, max-age=300, s-maxage=300",
  fixtures: "public, max-age=300, s-maxage=300",
  live: "public, max-age=30, s-maxage=60",
  player: "public, max-age=300, s-maxage=300",
  entry: "private, max-age=300",
  picks: "private, max-age=600",
  history: "private, max-age=900",
  league: "private, max-age=300",
} as const;

export interface FplJsonOptions {
  cacheControl?: string;
  noStore?: boolean;
}

function hasStaleFreshness(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasStaleFreshness);
  const record = value as Record<string, unknown>;
  if (record.source === "snapshot" || record.stale === true) return true;
  return Object.values(record).some(hasStaleFreshness);
}

export function fplJson<T>(
  data: T | null,
  freshness: unknown,
  errors: string[] = [],
  status = data === null ? 503 : 200,
  metadata?: unknown,
  options: FplJsonOptions = {},
): Response {
  const cacheable = Boolean(
    options.cacheControl
      && !options.noStore
      && data !== null
      && status >= 200
      && status < 300
      && errors.length === 0
      && !hasStaleFreshness(freshness),
  );
  return Response.json(
    {
      data,
      freshness,
      metadata,
      errors: errors.length ? errors : undefined,
    },
    {
      status,
      headers: {
        "Cache-Control": cacheable ? options.cacheControl! : "no-store",
      },
    },
  );
}

export function refreshRequested(request: Request): boolean {
  return new URL(request.url).searchParams.get("refresh") === "1";
}

export function errorList(...errors: Array<string | undefined>): string[] {
  return errors.filter((error): error is string => Boolean(error));
}

export function latestFreshness(
  ...freshness: Array<FreshnessMetadata | null | undefined>
): FreshnessMetadata | null {
  const values = freshness.filter((item): item is FreshnessMetadata => Boolean(item));
  if (!values.length) return null;
  return values.reduce((latest, item) =>
    Date.parse(item.fetchedAt) > Date.parse(latest.fetchedAt) ? item : latest,
  );
}
