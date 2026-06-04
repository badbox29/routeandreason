/**
 * Route & Reason — Cloudflare Worker
 *
 * Environment variables (set in Cloudflare dashboard or wrangler.toml):
 *   GOOGLE_API_KEY     — Google Maps Platform key (Elevation API only)
 *   ALLOWED_ORIGINS    — Comma-separated list of allowed origins, e.g.:
 *                        https://yourusername.github.io,http://localhost:3000
 *
 * KV Namespace binding (set in Cloudflare dashboard or wrangler.toml):
 *   WALK_JOURNAL_KV    — KV namespace for user data storage
 *
 * Routes:
 *   POST   /elevation               — Proxy to Google Elevation API
 *   POST   /osrm                    — Proxy to OSRM match API (snap-to-road, no key needed)
 *   GET    /storage/:token/:key     — Read a value from KV for a user token
 *   PUT    /storage/:token/:key     — Write a value to KV for a user token
 *   DELETE /storage/:token/:key     — Delete a value from KV for a user token
 *   GET    /storage/:token          — List all keys for a user token
 *   GET    /ping                    — Health check (no auth required)
 *   PUT    /username/:username     — Register a username → token mapping
 *   GET    /username/:username     — Look up a token by username
 *   DELETE /username/:username     — Remove a username mapping (own token only)
 *   POST   /notify/:targetToken    — Write a mention notification to another user's KV space
 *   GET    /public/entries         — List recent public entries (optional ?bbox=minLat,minLng,maxLat,maxLng)
 *   PUT    /public/entries/:id     — Index a public entry (called by owner on save)
 *   DELETE /public/entries/:id     — Remove entry from public index (on delete or visibility change)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CORS_HEADERS_BASE = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token",
  "Access-Control-Max-Age": "86400",
};

// KV key TTL — storage entries expire after 1 year of inactivity (seconds)
const KV_TTL = 60 * 60 * 24 * 365;

// Maximum request body size we'll read (bytes)
const MAX_BODY_SIZE = 64 * 1024; // 64 KB

// Rate limiting: max requests per token per minute (stored in KV)
const RATE_LIMIT = 60;
const RATE_LIMIT_WINDOW = 60; // seconds

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return handleOptions(request, env);
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, ""); // strip trailing slash

    // Health check — no auth
    if (pathname === "/ping") {
      return jsonResponse({ ok: true, ts: Date.now() });
    }

    // All other routes require a valid origin
    const originError = checkOrigin(request, env);
    if (originError) return originError;

    // Route
    try {
      if (pathname === "/elevation" && request.method === "POST") {
        return await handleElevation(request, env);
      }

      if (pathname === "/osrm" && request.method === "POST") {
        return await handleOsrm(request, env);
      }

      if (pathname.startsWith("/storage/")) {
        return await handleStorage(request, env, pathname);
      }

      if (pathname.startsWith("/username/")) {
        return await handleUsername(request, env, pathname);
      }

      if (pathname.startsWith("/notify/") && request.method === "POST") {
        return await handleNotify(request, env, pathname);
      }

      if (pathname.startsWith("/public/entries")) {
        return await handlePublicEntries(request, env, pathname, url);
      }

      return errorResponse(404, "Not found");
    } catch (err) {
      console.error("Unhandled error:", err);
      return errorResponse(500, "Internal server error");
    }
  },
};

// ---------------------------------------------------------------------------
// Origin whitelist
// ---------------------------------------------------------------------------

function checkOrigin(request, env) {
  const origin = request.headers.get("Origin") || request.headers.get("Referer") || "";

  if (!env.ALLOWED_ORIGINS) {
    // If no whitelist is configured, block everything (fail safe)
    return errorResponse(403, "ALLOWED_ORIGINS not configured");
  }

  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim().toLowerCase());

  // Check if origin starts with any allowed entry
  const originLower = origin.toLowerCase();
  const isAllowed = allowed.some((a) => originLower.startsWith(a));

  if (!isAllowed) {
    return errorResponse(403, `Origin not allowed: ${origin}`);
  }

  return null; // origin is fine
}

// ---------------------------------------------------------------------------
// CORS preflight
// ---------------------------------------------------------------------------

function handleOptions(request, env) {
  const origin = request.headers.get("Origin") || "";
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS_BASE,
      "Access-Control-Allow-Origin": origin,
    },
  });
}

// ---------------------------------------------------------------------------
// Google Elevation API proxy
// ---------------------------------------------------------------------------

async function handleElevation(request, env) {
  if (!env.GOOGLE_API_KEY) return errorResponse(500, "API key not configured");

  const body = await readBody(request);
  if (!body) return errorResponse(400, "Invalid or oversized request body");

  // Expect { locations: [{lat, lng}, ...] }
  const { locations } = body;
  if (!Array.isArray(locations) || locations.length === 0) {
    return errorResponse(400, "locations array is required");
  }
  if (locations.length > 512) {
    return errorResponse(400, "Maximum 512 locations per request");
  }

  // Validate each location
  for (const loc of locations) {
    if (typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      return errorResponse(400, "Each location must have numeric lat and lng");
    }
  }

  const locString = locations.map((l) => `${l.lat},${l.lng}`).join("|");
  const googleUrl = `https://maps.googleapis.com/maps/api/elevation/json?locations=${encodeURIComponent(locString)}&key=${env.GOOGLE_API_KEY}`;

  const upstream = await fetch(googleUrl);
  const data = await upstream.json();

  if (data.status !== "OK") {
    console.error("Elevation API error:", data.status, data.error_message);
    return errorResponse(502, `Elevation API error: ${data.status}`);
  }

  return jsonResponse(
    data.results.map((r) => ({
      lat: r.location.lat,
      lng: r.location.lng,
      elevation: r.elevation,
      resolution: r.resolution,
    })),
    request
  );
}

// ---------------------------------------------------------------------------
// OSRM match API proxy (snap-to-road, server-side to avoid CORS)
// ---------------------------------------------------------------------------

const OSRM_BASE = "https://router.project-osrm.org";
const OSRM_MAX_COORDS = 100;
const OSRM_RADIUS = 10; // metres — OSRM's max allowed per point

async function handleOsrm(request, env) {
  const body = await readBody(request);
  if (!body) return errorResponse(400, "Invalid or oversized request body");

  // Expect { waypoints: [{lat, lng}, ...] }
  const { waypoints } = body;
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    return errorResponse(400, "waypoints array with at least 2 points is required");
  }
  if (waypoints.length > OSRM_MAX_COORDS) {
    return errorResponse(400, `Maximum ${OSRM_MAX_COORDS} waypoints per request`);
  }
  for (const wp of waypoints) {
    if (typeof wp.lat !== "number" || typeof wp.lng !== "number") {
      return errorResponse(400, "Each waypoint must have numeric lat and lng");
    }
  }

  const coords   = waypoints.map((w) => `${w.lng},${w.lat}`).join(";");
  const radiuses = waypoints.map(() => OSRM_RADIUS).join(";");
  const osrmUrl  = `${OSRM_BASE}/match/v1/foot/${coords}`
    + `?overview=full&geometries=geojson&radiuses=${radiuses}&steps=false`;

  let upstream;
  try {
    upstream = await fetch(osrmUrl, {
      headers: { "User-Agent": "WalkJournal/1.0" },
    });
  } catch (e) {
    return errorResponse(502, `OSRM request failed: ${e.message}`);
  }

  const data = await upstream.json();

  if (data.code !== "Ok") {
    console.warn("OSRM error:", data.code, data.message);
    // Return the error so the client can fall back gracefully
    return jsonResponse({ ok: false, code: data.code, message: data.message }, request);
  }

  // Merge all matching segments into a flat coordinate array
  const points = [];
  for (const matching of data.matchings) {
    for (const [lng, lat] of matching.geometry.coordinates) {
      points.push({ lat, lng });
    }
  }

  return jsonResponse({ ok: true, points }, request);
}

// ---------------------------------------------------------------------------
// Username registry
// ---------------------------------------------------------------------------

async function handleUsername(request, env, pathname) {
  if (!env.WALK_JOURNAL_KV) return errorResponse(500, "KV namespace not configured");

  const parts    = pathname.split("/").filter(Boolean);
  if (parts.length < 2) return errorResponse(400, "Username required");

  const username = parts[1].toLowerCase().trim();

  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    return errorResponse(400, "Username must be 3-32 characters (letters, numbers, - or _)");
  }

  const kvKey = "username:" + username;

  if (request.method === "GET") {
    const value = await env.WALK_JOURNAL_KV.get(kvKey, { type: "text" });
    if (!value) return errorResponse(404, "Username not found", request);
    return jsonResponse(JSON.parse(value), request);
  }

  if (request.method === "PUT") {
    const body = await readBody(request);
    if (!body || !body.token) return errorResponse(400, "token required in body");

    const token = body.token;
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(token)) {
      return errorResponse(400, "Invalid token format");
    }

    const existing = await env.WALK_JOURNAL_KV.get(kvKey, { type: "text" });
    if (existing) {
      const parsed = JSON.parse(existing);
      if (parsed.token !== token) {
        return errorResponse(409, "Username already taken");
      }
    }

    const reverseKey = "token_username:" + token;
    const oldUsername = await env.WALK_JOURNAL_KV.get(reverseKey, { type: "text" });
    if (oldUsername && oldUsername !== username) {
      await env.WALK_JOURNAL_KV.delete("username:" + oldUsername);
    }

    await env.WALK_JOURNAL_KV.put(kvKey, JSON.stringify({ token, username }), { expirationTtl: KV_TTL });
    await env.WALK_JOURNAL_KV.put(reverseKey, username, { expirationTtl: KV_TTL });

    return jsonResponse({ ok: true }, request);
  }

  if (request.method === "DELETE") {
    const body = await readBody(request);
    if (!body || !body.token) return errorResponse(400, "token required in body");

    const existing = await env.WALK_JOURNAL_KV.get(kvKey, { type: "text" });
    if (!existing) return errorResponse(404, "Username not found", request);

    const parsed = JSON.parse(existing);
    if (parsed.token !== body.token) return errorResponse(403, "Not your username");

    await env.WALK_JOURNAL_KV.delete(kvKey);
    await env.WALK_JOURNAL_KV.delete("token_username:" + body.token);
    return jsonResponse({ ok: true }, request);
  }

  return errorResponse(405, "Method not allowed");
}

// ---------------------------------------------------------------------------

async function handleStorage(request, env, pathname) {
  if (!env.WALK_JOURNAL_KV) return errorResponse(500, "KV namespace not configured");

  // Parse path: /storage/:token  or  /storage/:token/:key
  const parts = pathname.split("/").filter(Boolean); // ["storage", token, ...key parts]
  if (parts.length < 2) return errorResponse(400, "Token required");

  const token = parts[1];

  // Basic token validation — must be a non-empty alphanumeric/hyphen/underscore string
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(token)) {
    return errorResponse(400, "Invalid token format");
  }

  // Rate limiting per token
  const rateLimitError = await checkRateLimit(token, env);
  if (rateLimitError) return rateLimitError;

  // List keys for token
  if (parts.length === 2 && request.method === "GET") {
    return await listKeys(token, env, request);
  }

  if (parts.length < 3) return errorResponse(400, "Key required");

  // Rejoin remaining parts as the key (allows slashes in key names)
  const userKey = parts.slice(2).join("/");

  // Sanitise key — allow alphanumeric, hyphens, underscores, forward slashes, dots
  if (!/^[a-zA-Z0-9_\-./]{1,256}$/.test(userKey)) {
    return errorResponse(400, "Invalid key format");
  }

  // Namespace the KV key so different users never collide
  const kvKey = `user:${token}:${userKey}`;

  switch (request.method) {
    case "GET":
      return await kvGet(kvKey, env, request);
    case "PUT":
      return await kvPut(kvKey, request, env);
    case "DELETE":
      return await kvDelete(kvKey, env, request);
    default:
      return errorResponse(405, "Method not allowed");
  }
}

async function listKeys(token, env, request) {
  const prefix = `user:${token}:`;
  const list = await env.WALK_JOURNAL_KV.list({ prefix });

  const keys = list.keys.map((k) => ({
    key: k.name.slice(prefix.length), // return the user-facing key, not the namespaced one
    expiration: k.expiration,
    metadata: k.metadata,
  }));

  return jsonResponse({ keys, list_complete: list.list_complete }, request);
}

async function kvGet(kvKey, env, request) {
  const value = await env.WALK_JOURNAL_KV.get(kvKey, { type: "text" });
  if (value === null) return errorResponse(404, "Key not found", request);
  return jsonResponse({ value: JSON.parse(value) }, request);
}

async function kvPut(kvKey, request, env) {
  const body = await readBody(request);
  if (body === null) return errorResponse(400, "Invalid or oversized request body");

  await env.WALK_JOURNAL_KV.put(kvKey, JSON.stringify(body), {
    expirationTtl: KV_TTL,
  });

  return jsonResponse({ ok: true }, request);
}

async function kvDelete(kvKey, env, request) {
  await env.WALK_JOURNAL_KV.delete(kvKey);
  return jsonResponse({ ok: true }, request);
}

// ---------------------------------------------------------------------------
// Mention notifications
// ---------------------------------------------------------------------------

async function handleNotify(request, env, pathname) {
  if (!env.WALK_JOURNAL_KV) return errorResponse(500, "KV namespace not configured");

  const parts = pathname.split("/").filter(Boolean); // ["notify", targetToken]
  if (parts.length < 2) return errorResponse(400, "Target token required");

  const targetToken = parts[1];
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(targetToken)) {
    return errorResponse(400, "Invalid token format");
  }

  const body = await readBody(request);
  if (!body) return errorResponse(400, "Invalid or oversized request body");

  const { entryId, fromUsername, fromToken, preview, type, waypoints, entryName } = body;
  if (!entryId || !fromUsername || !fromToken) {
    return errorResponse(400, "entryId, fromUsername, and fromToken are required");
  }

  // Validate fromToken maps to fromUsername (prevent spoofing)
  const reverseKey = "token_username:" + fromToken;
  const storedUsername = await env.WALK_JOURNAL_KV.get(reverseKey, { type: "text" });
  if (!storedUsername || storedUsername.toLowerCase() !== fromUsername.toLowerCase()) {
    return errorResponse(403, "fromToken does not match fromUsername");
  }

  const isMutualWalk = type === 'mutualwalk';

  // Mutual walk: 7-day TTL, stored under mutualwalk/ prefix with waypoints
  // Mention: full-year TTL, stored under mention/ prefix
  const kvKey = isMutualWalk
    ? `user:${targetToken}:mutualwalk/${entryId}`
    : `user:${targetToken}:mention/${entryId}`;

  const notification = {
    entryId,
    fromUsername,
    fromToken,
    preview:   (preview || "").slice(0, 200),
    createdAt: new Date().toISOString(),
    ...(isMutualWalk && {
      type:      'mutualwalk',
      entryName: (entryName || "").slice(0, 100),
      waypoints: (waypoints || []).slice(0, 500),
    }),
  };

  const ttl = isMutualWalk ? 60 * 60 * 24 * 7 : KV_TTL; // 7 days vs 1 year

  await env.WALK_JOURNAL_KV.put(kvKey, JSON.stringify(notification), {
    expirationTtl: ttl,
  });

  return jsonResponse({ ok: true }, request);
}

// ---------------------------------------------------------------------------
// Public route discovery
// ---------------------------------------------------------------------------

async function handlePublicEntries(request, env, pathname, url) {
  if (!env.WALK_JOURNAL_KV) return errorResponse(500, "KV namespace not configured");

  const parts = pathname.split("/").filter(Boolean); // ["public", "entries"] or ["public", "entries", id]
  const entryId = parts[2] || null;

  // GET /public/entries — list public entries, optional bbox filter
  if (request.method === "GET" && !entryId) {
    const bbox = url.searchParams.get("bbox"); // "minLat,minLng,maxLat,maxLng"
    let bboxFilter = null;
    if (bbox) {
      const [minLat, minLng, maxLat, maxLng] = bbox.split(",").map(Number);
      if ([minLat, minLng, maxLat, maxLng].every(n => !isNaN(n))) {
        bboxFilter = { minLat, minLng, maxLat, maxLng };
      }
    }

    const list = await env.WALK_JOURNAL_KV.list({ prefix: "public:entry/" });
    const entries = [];

    for (const k of list.keys) {
      try {
        const raw = await env.WALK_JOURNAL_KV.get(k.name, { type: "text" });
        if (!raw) continue;
        const entry = JSON.parse(raw);

        // Bbox filter — check if any waypoint falls within bounds
        if (bboxFilter && entry.waypoints && entry.waypoints.length > 0) {
          const inBounds = entry.waypoints.some(wp =>
            wp.lat >= bboxFilter.minLat && wp.lat <= bboxFilter.maxLat &&
            wp.lng >= bboxFilter.minLng && wp.lng <= bboxFilter.maxLng
          );
          if (!inBounds) continue;
        }

        entries.push(entry);
      } catch { /* skip malformed entries */ }
    }

    // Sort by most recent
    entries.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));

    return jsonResponse({ entries: entries.slice(0, 100) }, request);
  }

  // PUT /public/entries/:id — index a public entry (owner only)
  if (request.method === "PUT" && entryId) {
    const body = await readBody(request);
    if (!body) return errorResponse(400, "Invalid or oversized request body");

    const { token, username, name, distMeters, datetime, waypoints } = body;
    if (!token || !username || !entryId) {
      return errorResponse(400, "token, username, and entry data are required");
    }

    // Verify token owns this entry key
    const entryKey = `user:${token}:entry/${entryId}`;
    const existing = await env.WALK_JOURNAL_KV.get(entryKey, { type: "text" });
    if (!existing) return errorResponse(403, "Entry not found or token mismatch");

    const publicEntry = {
      id: entryId,
      token,
      username,
      name:       name || null,
      distMeters: distMeters || 0,
      datetime:   datetime || new Date().toISOString(),
      waypoints:  (waypoints || []).slice(0, 500), // cap waypoints
    };

    await env.WALK_JOURNAL_KV.put(
      `public:entry/${entryId}`,
      JSON.stringify(publicEntry),
      { expirationTtl: KV_TTL }
    );

    return jsonResponse({ ok: true }, request);
  }

  // DELETE /public/entries/:id — remove from public index (owner only)
  if (request.method === "DELETE" && entryId) {
    const body = await readBody(request);
    if (!body?.token) return errorResponse(400, "token is required");

    // Verify ownership
    const entryKey = `user:${body.token}:entry/${entryId}`;
    const existing = await env.WALK_JOURNAL_KV.get(entryKey, { type: "text" });
    if (!existing) return errorResponse(403, "Entry not found or token mismatch");

    await env.WALK_JOURNAL_KV.delete(`public:entry/${entryId}`);
    return jsonResponse({ ok: true }, request);
  }

  return errorResponse(405, "Method not allowed");
}

// ---------------------------------------------------------------------------
// Rate limiting (simple sliding window using KV)
// ---------------------------------------------------------------------------

async function checkRateLimit(token, env) {
  const rlKey = `ratelimit:${token}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - RATE_LIMIT_WINDOW;

  let timestamps = [];
  const stored = await env.WALK_JOURNAL_KV.get(rlKey, { type: "text" });
  if (stored) {
    try {
      timestamps = JSON.parse(stored).filter((t) => t > windowStart);
    } catch {
      timestamps = [];
    }
  }

  if (timestamps.length >= RATE_LIMIT) {
    return errorResponse(429, "Rate limit exceeded — please wait a moment");
  }

  timestamps.push(now);
  await env.WALK_JOURNAL_KV.put(rlKey, JSON.stringify(timestamps), {
    expirationTtl: RATE_LIMIT_WINDOW * 2,
  });

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isLatLng(obj) {
  return obj && typeof obj.lat === "number" && typeof obj.lng === "number";
}

async function readBody(request) {
  const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (contentLength > MAX_BODY_SIZE) return null;

  try {
    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function jsonResponse(data, request) {
  const origin = request?.headers?.get("Origin") || "*";
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      ...CORS_HEADERS_BASE,
      // Prevent the browser from caching API responses
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(status, message, request) {
  const origin = request?.headers?.get("Origin") || "*";
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      ...CORS_HEADERS_BASE,
      "Cache-Control": "no-store",
    },
  });
}
