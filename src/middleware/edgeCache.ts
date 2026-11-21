import type { MiddlewareHandler } from "hono";

type Bindings = { DB: D1Database };

// Translations only change through approvals, proofing fixes, releases and the
// Mukhtasar sync, all of which bump content_version (see migration 0013).
// Responses are cached per Cloudflare data center under that version, so a
// change shows up within VERSION_REFRESH_MS and the TTL only bounds staleness
// if a bump is ever missed.
const VERSION_REFRESH_MS = 60_000;
const EDGE_TTL_SECONDS = 86_400;
const ORIGINAL_CACHE_CONTROL = "x-origin-cache-control";

let versionMemo: { value: number; fetchedAt: number } | null = null;

async function contentVersion(db: D1Database): Promise<number | null> {
  const now = Date.now();
  if (versionMemo && now - versionMemo.fetchedAt < VERSION_REFRESH_MS) {
    return versionMemo.value;
  }
  try {
    const row = await db
      .prepare("SELECT version FROM content_version WHERE id = 1")
      .first<{ version: number }>();
    if (row) versionMemo = { value: row.version, fetchedAt: now };
  } catch (e) {
    // A stale version keeps serving cached responses while D1 is unavailable
    console.error("content_version lookup failed:", e);
  }
  return versionMemo?.value ?? null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Caches successful public read responses in the data center's Cache API.
 * GET requests are keyed by path and query; POST requests by a hash of the
 * body, since the Cache API only stores GET keys.
 */
export const edgeCache: MiddlewareHandler<{ Bindings: Bindings }> = async (
  c,
  next,
) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "POST") return next();

  const version = await contentVersion(c.env.DB);
  if (version === null) return next();

  const url = new URL(c.req.url);
  const keyUrl = new URL(`/__edge-cache${url.pathname}`, url.origin);
  if (method === "GET") {
    keyUrl.search = url.search;
  } else {
    const body = await c.req.raw.clone().text();
    keyUrl.searchParams.set("body", await sha256Hex(body));
  }
  keyUrl.searchParams.set("v", String(version));
  const cacheKey = new Request(keyUrl.toString(), { method: "GET" });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    const res = new Response(hit.body, hit);
    const original = res.headers.get(ORIGINAL_CACHE_CONTROL);
    res.headers.delete(ORIGINAL_CACHE_CONTROL);
    if (original) res.headers.set("Cache-Control", original);
    else res.headers.delete("Cache-Control");
    res.headers.set("X-Cache", "HIT");
    return res;
  }

  await next();

  // Never cache an error: a cached 500 would outlive the outage that caused it
  if (c.res.status !== 200) return;

  const stored = new Response(c.res.clone().body, c.res);
  const original = c.res.headers.get("Cache-Control");
  if (original) stored.headers.set(ORIGINAL_CACHE_CONTROL, original);
  stored.headers.set("Cache-Control", `public, max-age=${EDGE_TTL_SECONDS}`);
  stored.headers.delete("Set-Cookie");
  c.executionCtx.waitUntil(cache.put(cacheKey, stored));

  c.res = new Response(c.res.body, c.res);
  c.res.headers.set("X-Cache", "MISS");
};
