const CACHE_NAME = "fpl-terminal-bootstrap-v1";
const CACHE_KEY = "/api/fpl/bootstrap";

let memoryCache: unknown = null;

export function isUsableBootstrapData(value: unknown): boolean {
  return Boolean(
    value
      && typeof value === "object"
      && Array.isArray((value as { players?: unknown }).players)
      && (value as { players: unknown[] }).players.length,
  );
}

export function peekBootstrapData(): unknown {
  return memoryCache;
}

export async function readBootstrapData(): Promise<unknown> {
  if (memoryCache || typeof caches === "undefined") return memoryCache;
  try {
    const response = await (await caches.open(CACHE_NAME)).match(CACHE_KEY);
    const data: unknown = response ? await response.json() : null;
    if (isUsableBootstrapData(data)) memoryCache = data;
  } catch {
    // Browser storage is optional; the live request still fills the page.
  }
  return memoryCache;
}

export function cacheBootstrapData(data: unknown): void {
  if (!isUsableBootstrapData(data)) return;
  memoryCache = data;
  if (typeof caches === "undefined") return;
  void caches.open(CACHE_NAME)
    .then((cache) => cache.put(CACHE_KEY, new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    })))
    .catch(() => undefined);
}
