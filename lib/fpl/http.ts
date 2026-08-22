import type { FreshnessMetadata } from "./cache";

export function fplJson<T>(
  data: T | null,
  freshness: unknown,
  errors: string[] = [],
  status = data === null ? 503 : 200,
  metadata?: unknown,
): Response {
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
        "Cache-Control": "no-store",
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
