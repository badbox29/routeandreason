/**
 * Route & Reason — Cloudflare Worker
 *
 * Environment variables (set in Cloudflare dashboard):
 *   GOOGLE_API_KEY     — Google Maps Platform key (Elevation + Pollen APIs)
 *   GOOGLE_CLIENT_ID   — Google OAuth Client ID (for Google sign-in)
 *   ALLOWED_ORIGINS    — Comma-separated list of allowed origins, e.g.:
 *                        https://yourusername.github.io,http://localhost:3000
 *
 * KV Namespace binding (set in Cloudflare dashboard):
 *   WALK_JOURNAL_KV    — KV namespace for user data storage
 *
 * Routes:
 *   POST   /elevation               — Proxy to Google Elevation API
 *   POST   /osrm                    — Proxy to OSRM match API
 *   GET    /pollen?lat=&lng=        — Google Pollen API proxy with daily KV cache
 *   GET    /surface?bbox=           — Overpass API proxy for OSM surface tags
 *   GET    /storage/:token/:key     — Read a value from KV for a user token
 *   PUT    /storage/:token/:key     — Write a value to KV for a user token
 *   DELETE /storage/:token/:key     — Delete a value from KV for a user token
 *   GET    /storage/:token          — List all keys for a user token
 *   GET    /                        — Health check (no auth required)
 *   GET    /ping                    — Health check (no auth required)
 *   PUT    /username/:username      — Register a username → token mapping
 *   GET    /username/:username      — Look up a token by username
 *   DELETE /username/:username      — Remove a username mapping (own token only)
 *   POST   /notify/:targetToken     — Write a mention notification to another user's KV space
 *   GET    /public/entries          — List recent public entries
 *   PUT    /public/entries/:id      — Index a public entry
 *   DELETE /public/entries/:id      — Remove entry from public index
 *   POST   /auth/google             — Verify Google ID token, return KV key
 *   POST   /auth/verify             — Re-verify a stored Google credential
 *   POST   /auth/migrate            — One-way token → Google account migration
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// GOOGLE_CLIENT_ID is read from env.GOOGLE_CLIENT_ID (set in Cloudflare dashboard).
// Do NOT hardcode it here.

const KV_BINDING = 'WALK_JOURNAL_KV';

// KV key TTL — account data persists for 5 years (resets on every write)
const KV_TTL = 60 * 60 * 24 * 1825;

// HMAC salt — must never change after deployment
const HMAC_SALT = 'reverence-hmac-v1';

// Maximum request body size (bytes)
const MAX_BODY_SIZE = 64 * 1024; // 64 KB

// Rate limiting for storage routes: max requests per token per minute
const RATE_LIMIT        = 60;
const RATE_LIMIT_WINDOW = 60; // seconds

// ---------------------------------------------------------------------------
// ── AUTH-WORKER FUNCTIONS (inlined from auth-worker.js) ──────────────────
// ---------------------------------------------------------------------------

// ── Response helpers ─────────────────────────────────────────────

function respond(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function respondText(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain', ...extraHeaders },
  });
}

// ── CORS ─────────────────────────────────────────────────────────

function buildCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Timestamp, X-Signature, X-User-Token',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

// Exact-match origin check. Returns the origin string if allowed, null if rejected.
function checkOriginAuth(request, allowedOrigins) {
  const origin = request.headers.get('Origin') || '';
  return allowedOrigins.includes(origin) ? origin : null;
}

// ── Rate limiting (per-IP, for auth routes) ──────────────────────

async function checkRateLimitIp(env, ip, maxRequests = 60, windowSeconds = 3600) {
  const kv      = env[KV_BINDING];
  const key     = `rl:${ip}`;
  const raw     = await kv.get(key, { type: 'text' });
  const count   = raw ? parseInt(raw, 10) : 0;
  const allowed = count < maxRequests;
  if (allowed) {
    await kv.put(key, String(count + 1), { expirationTtl: windowSeconds * 2 });
  }
  return { allowed, remaining: Math.max(0, maxRequests - count - 1) };
}

// ── Token validation ─────────────────────────────────────────────

// Accepts: legacy (8-16 alphanumeric), secure base64url (22 chars),
// longer hex tokens (app.js generated 48-char hex), and google:<sub>.
function isValidToken(token) {
  return /^(google:\d{10,30}|[a-zA-Z0-9_-]{8,128})$/.test(token);
}

// ── HMAC request signing ─────────────────────────────────────────

async function deriveHmacKey(token) {
  const enc    = new TextEncoder();
  const keyMat = await crypto.subtle.importKey(
    'raw', enc.encode(token), { name: 'HKDF' }, false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256',
      salt: enc.encode(HMAC_SALT),
      info: enc.encode('request-signing') },
    keyMat,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  );
}

async function verifyHmacSignature(request, token, body) {
  const timestamp = request.headers.get('X-Timestamp') || '';
  const signature = request.headers.get('X-Signature') || '';
  if (!timestamp || !signature) return { ok: false, reason: 'Missing HMAC headers' };

  const age = Math.abs(Date.now() - parseInt(timestamp, 10));
  if (age > 5 * 60 * 1000) return { ok: false, reason: 'Request timestamp expired' };

  const bodyHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body || '')))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  const message = `${request.method.toUpperCase()}:${token}:${timestamp}:${bodyHash}`;
  try {
    const key      = await deriveHmacKey(token);
    const sigBytes = Uint8Array.from(
      atob(signature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(message));
    return valid ? { ok: true } : { ok: false, reason: 'Invalid signature' };
  } catch { return { ok: false, reason: 'Signature verification error' }; }
}

// Unified KV credential check.
// Google keys → Bearer JWT; token keys → HMAC (if hmacRequired).
async function checkKvAuth(request, token, cors, hmacRequired, body, env) {
  const isGoogle = token.startsWith('google:');

  if (isGoogle) {
    const authHeader = request.headers.get('Authorization') || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) return { ok: false, response: respond(JSON.stringify({ error: 'Authorization required' }), 401, cors) };
    const payload = await verifyGoogleJWT(idToken, env?.GOOGLE_CLIENT_ID);
    if (!payload) return { ok: false, response: respond(JSON.stringify({ error: 'Invalid or expired Google token' }), 401, cors) };
    if (token !== `google:${payload.sub}`) return { ok: false, response: respond(JSON.stringify({ error: 'Token mismatch' }), 403, cors) };
    return { ok: true, isGoogle: true };
  }

  const hmac = await verifyHmacSignature(request, token, body);
  if (!hmac.ok && hmacRequired) {
    return { ok: false, response: respond(JSON.stringify({ error: `HMAC failed: ${hmac.reason}` }), 401, cors) };
  }
  return { ok: true, isGoogle: false };
}

// ── Google JWT verification ──────────────────────────────────────

async function verifyGoogleJWT(idToken, clientId) {
  if (!clientId) return null;
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;

    const header  = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now)                                                      return null;
    if (payload.aud !== clientId)                                               return null;
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) return null;
    if (!payload.sub)                                                            return null;

    const jwksRes = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (!jwksRes.ok) return null;
    const jwks = await jwksRes.json();
    const jwk  = jwks.keys?.find(k => k.kid === header.kid);
    if (!jwk) return null;

    const cryptoKey = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );

    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature    = Uint8Array.from(
      atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signingInput);
    if (!valid) return null;

    return {
      sub:     payload.sub,
      email:   payload.email   || null,
      name:    payload.name    || null,
      picture: payload.picture || null,
    };
  } catch (err) {
    console.error('[Auth] verifyGoogleJWT error:', err);
    return null;
  }
}

// ── Auth route handler ───────────────────────────────────────────

async function handleAuthRoutes(url, method, request, env, cors) {
  const kv = env[KV_BINDING];

  // POST /auth/google — verify Google ID token, return KV key
  if (url.pathname === '/auth/google') {
    if (method !== 'POST') return respondText('Method not allowed', 405, cors);
    let idToken;
    try { idToken = (await request.json()).idToken; } catch {
      return respond(JSON.stringify({ error: 'Invalid request body' }), 400, cors);
    }
    if (!idToken) return respond(JSON.stringify({ error: 'idToken required' }), 400, cors);
    const payload = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!payload) return respond(JSON.stringify({ error: 'Invalid or expired Google token' }), 401, cors);
    const kvKey = `google:${payload.sub}`;
    return respond(JSON.stringify({ ok: true, kvKey, profile: payload }), 200, cors);
  }

  // POST /auth/verify — re-verify a stored Google credential at boot
  if (url.pathname === '/auth/verify') {
    if (method !== 'POST') return respondText('Method not allowed', 405, cors);
    let idToken;
    try { idToken = (await request.json()).idToken; } catch {
      return respond(JSON.stringify({ error: 'Invalid request body' }), 400, cors);
    }
    if (!idToken) return respond(JSON.stringify({ error: 'idToken required' }), 400, cors);
    const payload = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!payload) return respond(JSON.stringify({ ok: false, error: 'Token expired or invalid' }), 401, cors);
    return respond(JSON.stringify({ ok: true, profile: payload }), 200, cors);
  }

  // POST /auth/migrate — one-way token → Google migration
  if (url.pathname === '/auth/migrate') {
    if (method !== 'POST') return respondText('Method not allowed', 405, cors);
    let body;
    try { body = await request.json(); } catch {
      return respond(JSON.stringify({ error: 'Invalid request body' }), 400, cors);
    }
    const { idToken, oldToken, migrationCode } = body || {};
    if (!idToken || !oldToken) return respond(JSON.stringify({ error: 'idToken and oldToken required' }), 400, cors);
    if (!isValidToken(oldToken)) return respond(JSON.stringify({ error: 'Invalid token format' }), 400, cors);

    const payload = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!payload) return respond(JSON.stringify({ error: 'Invalid or expired Google token' }), 401, cors);

    if (migrationCode) {
      const storedCode = await kv.get(`migcode:${oldToken}`, { type: 'text' });
      if (!storedCode || storedCode !== migrationCode) {
        return respond(JSON.stringify({ error: 'Invalid or expired migration code' }), 401, cors);
      }
    }

    const kvKey = `google:${payload.sub}`;

    // Guard — if this Google ID already has an account, block the migration.
    // One Google identity = one account. The user should sign in with Google instead.
    const existingGoogle = await kv.get(`user:${kvKey}:profile`, { type: 'text' });
    if (existingGoogle) {
      return respond(JSON.stringify({ error: 'A Route & Reason account already exists for this Google account. Sign in with Google instead of migrating.' }), 409, cors);
    }

    const existingData = await kv.get(`user:${oldToken}:profile`, { type: 'text' });
    if (!existingData) return respond(JSON.stringify({ error: 'Source account not found' }), 404, cors);

    let parsed;
    try { parsed = JSON.parse(existingData); } catch {
      return respond(JSON.stringify({ error: 'Corrupt source data' }), 500, cors);
    }
    parsed.authMethod   = 'google';
    parsed.linkedGoogle = payload;
    parsed.lastModified = Date.now();

    await kv.put(kvKey, JSON.stringify(parsed), { expirationTtl: KV_TTL });
    await kv.put(`migrated:${oldToken}`, kvKey, { expirationTtl: 60 * 60 * 24 * 90 });
    if (migrationCode) await kv.delete(`migcode:${oldToken}`);

    // Copy all entry/ and route/ keys from old token namespace to new Google key namespace
    const oldPrefix = `user:${oldToken}:`;
    const newPrefix = `user:${kvKey}:`;
    let cursor = undefined;
    do {
      const listed = await kv.list({ prefix: oldPrefix, cursor });
      for (const k of listed.keys) {
        const subKey = k.name.slice(oldPrefix.length); // e.g. "entry/abc123"
        if (subKey.startsWith('entry/') || subKey.startsWith('route/')) {
          const val = await kv.get(k.name, { type: 'text' });
          if (val !== null) {
            await kv.put(newPrefix + subKey, val, { expirationTtl: KV_TTL });
          }
        }
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);

    return respond(JSON.stringify({ ok: true, kvKey, profile: payload }), 200, cors);
  }

  return null; // no auth route matched
}

// ── GET handler helpers ──────────────────────────────────────────

async function checkMigrationTombstone(token, env, cors, remaining) {
  const kv         = env[KV_BINDING];
  const migratedTo = await kv.get(`migrated:${token}`, { type: 'text' });
  if (!migratedTo) return null;
  return respond(
    JSON.stringify({ migrated: true, authMethod: 'google' }),
    410,
    { ...cors, 'X-Account-Migrated': 'google', 'X-RateLimit-Remaining': String(remaining) }
  );
}

async function checkLegacyForwardingPointer(token, env, cors, remaining) {
  const kv        = env[KV_BINDING];
  const forwardTo = await kv.get(`legacy:${token}`, { type: 'text' });
  if (!forwardTo) return null;
  const newData = await kv.get(forwardTo, { type: 'text' });
  if (newData === null) return null;
  return respond(newData, 200, {
    ...cors,
    'X-Token-Migrated':      forwardTo,
    'X-RateLimit-Remaining': String(remaining),
  });
}

// ── PUT handler helper ───────────────────────────────────────────

async function writeLegacyPointerIfNeeded(parsed, newToken, env) {
  const kv          = env[KV_BINDING];
  const legacyToken = parsed._legacyToken;
  if (legacyToken &&
      typeof legacyToken === 'string' &&
      isValidToken(legacyToken) &&
      legacyToken !== newToken) {
    delete parsed._legacyToken;
    await kv.put(`legacy:${legacyToken}`, newToken, { expirationTtl: 60 * 60 * 24 * 90 });
  } else {
    delete parsed._legacyToken;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    // Health check — no auth required (needed by auth module's testWorkerUrl)
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/ping')) {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // Origin check
    const allowedOrigins = (env.ALLOWED_ORIGINS || '')
      .split(',').map(o => o.trim()).filter(Boolean);
    const origin = checkOriginAuth(request, allowedOrigins);
    if (!origin) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const cors = buildCorsHeaders(origin);

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // ── Auth routes (/auth/google, /auth/verify, /auth/migrate) ──
      const authRes = await handleAuthRoutes(url, method, request, env, cors);
      if (authRes) return authRes;

      const pathname = url.pathname.replace(/\/$/, '');

      // ── Elevation ────────────────────────────────────────────────
      if (pathname === '/elevation' && method === 'POST') {
        return await handleElevation(request, env, cors);
      }

      // ── Pollen ───────────────────────────────────────────────────
      if (pathname === '/pollen' && method === 'GET') {
        return await handlePollen(request, env, url, cors);
      }

      // ── Surface ──────────────────────────────────────────────────
      if (pathname === '/surface' && method === 'GET') {
        return await handleSurface(request, env, url, cors);
      }

      // ── OSRM ─────────────────────────────────────────────────────
      if (pathname === '/osrm' && method === 'POST') {
        return await handleOsrm(request, env, cors);
      }

      // ── Storage ──────────────────────────────────────────────────
      if (pathname.startsWith('/storage/')) {
        return await handleStorage(request, env, pathname, cors);
      }

      // ── Username registry ─────────────────────────────────────────
      if (pathname.startsWith('/username/')) {
        return await handleUsername(request, env, pathname, cors);
      }

      // ── Mention / mutual walk notifications ───────────────────────
      if (pathname.startsWith('/notify/') && method === 'POST') {
        return await handleNotify(request, env, pathname, cors);
      }

      // ── Public route discovery ────────────────────────────────────
      if (pathname.startsWith('/public/entries')) {
        return await handlePublicEntries(request, env, pathname, url, cors);
      }

      return respond(JSON.stringify({ error: 'Not found' }), 404, cors);

    } catch (err) {
      console.error('Unhandled error:', err);
      return respond(JSON.stringify({ error: 'Internal server error' }), 500, cors);
    }
  },
};

// ---------------------------------------------------------------------------
// Google Elevation API proxy
// ---------------------------------------------------------------------------

async function handleElevation(request, env, cors) {
  if (!env.GOOGLE_API_KEY) return respond(JSON.stringify({ error: 'API key not configured' }), 500, cors);

  const body = await readBody(request);
  if (!body) return respond(JSON.stringify({ error: 'Invalid or oversized request body' }), 400, cors);

  const { locations } = body;
  if (!Array.isArray(locations) || locations.length === 0) {
    return respond(JSON.stringify({ error: 'locations array is required' }), 400, cors);
  }
  if (locations.length > 512) {
    return respond(JSON.stringify({ error: 'Maximum 512 locations per request' }), 400, cors);
  }
  for (const loc of locations) {
    if (typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
      return respond(JSON.stringify({ error: 'Each location must have numeric lat and lng' }), 400, cors);
    }
  }

  const locString = locations.map(l => `${l.lat},${l.lng}`).join('|');
  const googleUrl = `https://maps.googleapis.com/maps/api/elevation/json?locations=${encodeURIComponent(locString)}&key=${env.GOOGLE_API_KEY}`;

  const upstream = await fetch(googleUrl);
  const data     = await upstream.json();

  if (data.status !== 'OK') {
    console.error('Elevation API error:', data.status, data.error_message);
    return respond(JSON.stringify({ error: `Elevation API error: ${data.status}` }), 502, cors);
  }

  return respond(JSON.stringify(
    data.results.map(r => ({ lat: r.location.lat, lng: r.location.lng, elevation: r.elevation, resolution: r.resolution }))
  ), 200, cors);
}

// ---------------------------------------------------------------------------
// OSRM match API proxy
// ---------------------------------------------------------------------------

const OSRM_BASE       = 'https://router.project-osrm.org';
const OSRM_MAX_COORDS = 100;
const OSRM_RADIUS     = 10;

async function handleOsrm(request, env, cors) {
  const body = await readBody(request);
  if (!body) return respond(JSON.stringify({ error: 'Invalid or oversized request body' }), 400, cors);

  const { waypoints } = body;
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    return respond(JSON.stringify({ error: 'At least 2 waypoints required' }), 400, cors);
  }
  if (waypoints.length > OSRM_MAX_COORDS) {
    return respond(JSON.stringify({ error: `Maximum ${OSRM_MAX_COORDS} waypoints per request` }), 400, cors);
  }
  for (const wp of waypoints) {
    if (typeof wp.lat !== 'number' || typeof wp.lng !== 'number') {
      return respond(JSON.stringify({ error: 'Each waypoint must have numeric lat and lng' }), 400, cors);
    }
  }

  const coords   = waypoints.map(w => `${w.lng},${w.lat}`).join(';');
  const radiuses = waypoints.map(() => OSRM_RADIUS).join(';');
  const osrmUrl  = `${OSRM_BASE}/match/v1/foot/${coords}?overview=full&geometries=geojson&radiuses=${radiuses}&steps=false`;

  let upstream;
  try {
    upstream = await fetch(osrmUrl, { headers: { 'User-Agent': 'RouteAndReason/1.0' } });
  } catch (e) {
    return respond(JSON.stringify({ error: `OSRM request failed: ${e.message}` }), 502, cors);
  }

  const data = await upstream.json();
  if (data.code !== 'Ok') {
    return respond(JSON.stringify({ ok: false, code: data.code, message: data.message }), 200, cors);
  }

  const points = [];
  for (const matching of data.matchings) {
    for (const [lng, lat] of matching.geometry.coordinates) {
      points.push({ lat, lng });
    }
  }
  return respond(JSON.stringify({ ok: true, points }), 200, cors);
}

// ---------------------------------------------------------------------------
// Pollen (Google Pollen API — daily KV cache)
// ---------------------------------------------------------------------------

async function handlePollen(request, env, url, cors) {
  if (!env.GOOGLE_API_KEY)  return respond(JSON.stringify({ error: 'API key not configured' }), 500, cors);
  if (!env[KV_BINDING])     return respond(JSON.stringify({ error: 'KV namespace not configured' }), 500, cors);

  const lat = parseFloat(url.searchParams.get('lat'));
  const lng = parseFloat(url.searchParams.get('lng'));
  if (isNaN(lat) || isNaN(lng)) return respond(JSON.stringify({ error: 'lat and lng are required' }), 400, cors);

  const today    = new Date().toISOString().slice(0, 10);
  const cacheKey = `pollen:${lat.toFixed(2)}:${lng.toFixed(2)}:${today}`;
  const cached   = await env[KV_BINDING].get(cacheKey, { type: 'text' });
  if (cached) return respond(cached, 200, cors);

  const googleUrl = `https://pollen.googleapis.com/v1/forecast:lookup`
    + `?location.longitude=${lng}&location.latitude=${lat}&days=1&key=${env.GOOGLE_API_KEY}`;

  const res = await fetch(googleUrl);
  if (!res.ok) {
    console.error('Google Pollen API error:', await res.text());
    return respond(JSON.stringify({ error: 'Pollen API request failed' }), 502, cors);
  }

  const data        = await res.json();
  const day         = data.dailyInfo?.[0];
  const pollenTypes = {};
  if (day?.pollenTypeInfo) {
    for (const pt of day.pollenTypeInfo) {
      const name = pt.code?.toLowerCase();
      if (!name) continue;
      pollenTypes[name] = { index: pt.indexInfo?.value ?? null, category: pt.indexInfo?.category ?? null };
    }
  }

  const result = {
    tree:  pollenTypes.tree  || null,
    grass: pollenTypes.grass || null,
    weed:  pollenTypes.weed  || null,
    date:  today,
  };

  await env[KV_BINDING].put(cacheKey, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 });
  return respond(JSON.stringify(result), 200, cors);
}

// ---------------------------------------------------------------------------
// Surface (Overpass API — OSM surface tags)
// ---------------------------------------------------------------------------

async function handleSurface(request, env, url, cors) {
  const bbox = url.searchParams.get('bbox');
  if (!bbox) return respond(JSON.stringify({ error: 'bbox is required' }), 400, cors);

  const [minLat, minLng, maxLat, maxLng] = bbox.split(',').map(Number);
  if ([minLat, minLng, maxLat, maxLng].some(isNaN)) {
    return respond(JSON.stringify({ error: 'Invalid bbox format' }), 400, cors);
  }

  const query = `[out:json][timeout:15];(way["surface"](${minLat},${minLng},${maxLat},${maxLng});way["highway"~"^(footway|path|track|bridleway|primary|secondary|tertiary|residential|unclassified|service|motorway|trunk|living_street|pedestrian|cycleway|steps|corridor)$"](${minLat},${minLng},${maxLat},${maxLng}););out geom;`;

  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) continue;
      const data = await res.json();
      return respond(JSON.stringify(data), 200, cors);
    } catch { /* try next endpoint */ }
  }

  return respond(JSON.stringify({ error: 'Surface data unavailable' }), 502, cors);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function handleStorage(request, env, pathname, cors) {
  if (!env[KV_BINDING]) return respond(JSON.stringify({ error: 'KV namespace not configured' }), 500, cors);

  const parts = pathname.split('/').filter(Boolean); // ["storage", token, ...key parts]
  if (parts.length < 2) return respond(JSON.stringify({ error: 'Token required' }), 400, cors);

  const token = decodeURIComponent(parts[1]);
  if (!isValidToken(token)) return respond(JSON.stringify({ error: 'Invalid token format' }), 400, cors);

  // Per-token rate limiting (sliding window) for storage routes
  const rateLimitError = await checkStorageRateLimit(token, env, cors);
  if (rateLimitError) return rateLimitError;

  // List keys for token
  if (parts.length === 2 && request.method === 'GET') {
    return await listKeys(token, env, cors);
  }

  if (parts.length < 3) return respond(JSON.stringify({ error: 'Key required' }), 400, cors);

  const userKey = parts.slice(2).join('/');
  if (!/^[a-zA-Z0-9_\-./]{1,256}$/.test(userKey)) {
    return respond(JSON.stringify({ error: 'Invalid key format' }), 400, cors);
  }

  const kvKey = `user:${token}:${userKey}`;

  if (request.method === 'GET') {
    // Auth check
    const auth = await checkKvAuth(request, token, cors, true, null, env);
    if (!auth.ok) return auth.response;

    // Migration tombstone check (token→Google migration)
    const { remaining } = await checkStorageRateLimitCount(token, env);
    const tombRes = await checkMigrationTombstone(token, env, cors, remaining);
    if (tombRes) return tombRes;

    // Legacy forwarding pointer check (token security upgrade)
    const fwdRes = await checkLegacyForwardingPointer(token, env, cors, remaining);
    if (fwdRes) return fwdRes;

    const value = await env[KV_BINDING].get(kvKey, { type: 'text' });
    if (value === null) return respond(JSON.stringify({ error: 'Key not found' }), 404, cors);
    return respond(JSON.stringify({ value: JSON.parse(value) }), 200, cors);
  }

  if (request.method === 'PUT') {
    const bodyText = await readBodyText(request);
    if (bodyText === null) return respond(JSON.stringify({ error: 'Invalid or oversized request body' }), 400, cors);

    let parsed;
    try { parsed = JSON.parse(bodyText); } catch {
      return respond(JSON.stringify({ error: 'Invalid JSON' }), 400, cors);
    }

    // Auth check (HMAC over the raw body text)
    const auth = await checkKvAuth(request, token, cors, true, bodyText, env);
    if (!auth.ok) return auth.response;

    // Write legacy forwarding pointer if _legacyToken present
    parsed = await writeLegacyPointerIfNeeded(parsed, token, env);

    await env[KV_BINDING].put(kvKey, JSON.stringify(parsed), { expirationTtl: KV_TTL });
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  if (request.method === 'DELETE') {
    await env[KV_BINDING].delete(kvKey);
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  return respond(JSON.stringify({ error: 'Method not allowed' }), 405, cors);
}

async function listKeys(token, env, cors) {
  const prefix = `user:${token}:`;
  const list   = await env[KV_BINDING].list({ prefix });
  const keys   = list.keys.map(k => ({
    key:        k.name.slice(prefix.length),
    expiration: k.expiration,
    metadata:   k.metadata,
  }));
  return respond(JSON.stringify({ keys, list_complete: list.list_complete }), 200, cors);
}

// ---------------------------------------------------------------------------
// Username registry
// ---------------------------------------------------------------------------

async function handleUsername(request, env, pathname, cors) {
  if (!env[KV_BINDING]) return respond(JSON.stringify({ error: 'KV namespace not configured' }), 500, cors);

  const parts    = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return respond(JSON.stringify({ error: 'Username required' }), 400, cors);

  const username = parts[1].toLowerCase().trim();
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    return respond(JSON.stringify({ error: 'Username must be 3-32 characters (letters, numbers, - or _)' }), 400, cors);
  }

  const kvKey = 'username:' + username;

  if (request.method === 'GET') {
    const value = await env[KV_BINDING].get(kvKey, { type: 'text' });
    if (!value) return respond(JSON.stringify({ error: 'Username not found' }), 404, cors);
    return respond(value, 200, cors);
  }

  if (request.method === 'PUT') {
    const body = await readBody(request);
    if (!body || !body.token) return respond(JSON.stringify({ error: 'token required in body' }), 400, cors);

    const token = body.token;
    if (!isValidToken(token)) return respond(JSON.stringify({ error: 'Invalid token format' }), 400, cors);

    const existing = await env[KV_BINDING].get(kvKey, { type: 'text' });
    if (existing) {
      const parsed = JSON.parse(existing);
      if (parsed.token !== token) return respond(JSON.stringify({ error: 'Username already taken' }), 409, cors);
    }

    const reverseKey   = 'token_username:' + token;
    const oldUsername  = await env[KV_BINDING].get(reverseKey, { type: 'text' });
    if (oldUsername && oldUsername !== username) {
      await env[KV_BINDING].delete('username:' + oldUsername);
    }

    await env[KV_BINDING].put(kvKey, JSON.stringify({ token, username }), { expirationTtl: KV_TTL });
    await env[KV_BINDING].put(reverseKey, username, { expirationTtl: KV_TTL });
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  if (request.method === 'DELETE') {
    const body = await readBody(request);
    if (!body || !body.token) return respond(JSON.stringify({ error: 'token required in body' }), 400, cors);

    const existing = await env[KV_BINDING].get(kvKey, { type: 'text' });
    if (!existing) return respond(JSON.stringify({ error: 'Username not found' }), 404, cors);

    const parsed = JSON.parse(existing);
    if (parsed.token !== body.token) return respond(JSON.stringify({ error: 'Not your username' }), 403, cors);

    await env[KV_BINDING].delete(kvKey);
    await env[KV_BINDING].delete('token_username:' + body.token);
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  return respond(JSON.stringify({ error: 'Method not allowed' }), 405, cors);
}

// ---------------------------------------------------------------------------
// Mention / mutual walk notifications
// ---------------------------------------------------------------------------

async function handleNotify(request, env, pathname, cors) {
  if (!env[KV_BINDING]) return respond(JSON.stringify({ error: 'KV namespace not configured' }), 500, cors);

  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return respond(JSON.stringify({ error: 'Target token required' }), 400, cors);

  const targetToken = parts[1];
  if (!isValidToken(targetToken)) return respond(JSON.stringify({ error: 'Invalid token format' }), 400, cors);

  const body = await readBody(request);
  if (!body) return respond(JSON.stringify({ error: 'Invalid or oversized request body' }), 400, cors);

  const { entryId, fromUsername, fromToken, preview, type, waypoints, entryName } = body;
  if (!entryId || !fromUsername || !fromToken) {
    return respond(JSON.stringify({ error: 'entryId, fromUsername, and fromToken are required' }), 400, cors);
  }

  // Validate fromToken maps to fromUsername (prevent spoofing)
  const reverseKey      = 'token_username:' + fromToken;
  const storedUsername  = await env[KV_BINDING].get(reverseKey, { type: 'text' });
  if (!storedUsername || storedUsername.toLowerCase() !== fromUsername.toLowerCase()) {
    return respond(JSON.stringify({ error: 'fromToken does not match fromUsername' }), 403, cors);
  }

  const isMutualWalk = type === 'mutualwalk';
  const kvKey = isMutualWalk
    ? `user:${targetToken}:mutualwalk/${entryId}`
    : `user:${targetToken}:mention/${entryId}`;

  const notification = {
    entryId,
    fromUsername,
    fromToken,
    preview:   (preview || '').slice(0, 200),
    createdAt: new Date().toISOString(),
    ...(isMutualWalk && {
      type:      'mutualwalk',
      entryName: (entryName || '').slice(0, 100),
      waypoints: (waypoints || []).slice(0, 500),
    }),
  };

  const ttl = isMutualWalk ? 60 * 60 * 24 * 7 : KV_TTL;
  await env[KV_BINDING].put(kvKey, JSON.stringify(notification), { expirationTtl: ttl });
  return respond(JSON.stringify({ ok: true }), 200, cors);
}

// ---------------------------------------------------------------------------
// Public route discovery
// ---------------------------------------------------------------------------

async function handlePublicEntries(request, env, pathname, url, cors) {
  if (!env[KV_BINDING]) return respond(JSON.stringify({ error: 'KV namespace not configured' }), 500, cors);

  const parts   = pathname.split('/').filter(Boolean);
  const entryId = parts[2] || null;
  const method  = request.method.toUpperCase();

  // GET /public/entries
  if (method === 'GET' && !entryId) {
    const bbox = url.searchParams.get('bbox');
    let bboxFilter = null;
    if (bbox) {
      const [minLat, minLng, maxLat, maxLng] = bbox.split(',').map(Number);
      if ([minLat, minLng, maxLat, maxLng].every(n => !isNaN(n))) {
        bboxFilter = { minLat, minLng, maxLat, maxLng };
      }
    }

    const list    = await env[KV_BINDING].list({ prefix: 'public:entry/' });
    const entries = [];
    for (const k of list.keys) {
      try {
        const raw = await env[KV_BINDING].get(k.name, { type: 'text' });
        if (!raw) continue;
        const entry = JSON.parse(raw);
        if (bboxFilter && entry.waypoints?.length > 0) {
          const inBounds = entry.waypoints.some(wp =>
            wp.lat >= bboxFilter.minLat && wp.lat <= bboxFilter.maxLat &&
            wp.lng >= bboxFilter.minLng && wp.lng <= bboxFilter.maxLng
          );
          if (!inBounds) continue;
        }
        entries.push(entry);
      } catch { /* skip malformed */ }
    }
    entries.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
    return respond(JSON.stringify({ entries: entries.slice(0, 100) }), 200, cors);
  }

  // PUT /public/entries/:id
  if (method === 'PUT' && entryId) {
    const body = await readBody(request);
    if (!body) return respond(JSON.stringify({ error: 'Invalid or oversized request body' }), 400, cors);

    const { token, username, name, distMeters, datetime, waypoints } = body;
    if (!token || !username || !entryId) {
      return respond(JSON.stringify({ error: 'token, username, and entry data are required' }), 400, cors);
    }

    const entryKey = `user:${token}:entry/${entryId}`;
    const existing = await env[KV_BINDING].get(entryKey, { type: 'text' });
    if (!existing) return respond(JSON.stringify({ error: 'Entry not found or token mismatch' }), 403, cors);

    const publicEntry = {
      id: entryId, token, username,
      name:       name || null,
      distMeters: distMeters || 0,
      datetime:   datetime || new Date().toISOString(),
      waypoints:  (waypoints || []).slice(0, 500),
    };
    await env[KV_BINDING].put(`public:entry/${entryId}`, JSON.stringify(publicEntry), { expirationTtl: KV_TTL });
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  // DELETE /public/entries/:id
  if (method === 'DELETE' && entryId) {
    const body = await readBody(request);
    if (!body?.token) return respond(JSON.stringify({ error: 'token is required' }), 400, cors);

    const entryKey = `user:${body.token}:entry/${entryId}`;
    const existing = await env[KV_BINDING].get(entryKey, { type: 'text' });
    if (!existing) return respond(JSON.stringify({ error: 'Entry not found or token mismatch' }), 403, cors);

    await env[KV_BINDING].delete(`public:entry/${entryId}`);
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  return respond(JSON.stringify({ error: 'Method not allowed' }), 405, cors);
}

// ---------------------------------------------------------------------------
// Rate limiting helpers
// ---------------------------------------------------------------------------

// Per-token sliding window rate limiter (used for storage routes)
async function checkStorageRateLimit(token, env, cors) {
  const rlKey      = `ratelimit:${token}`;
  const now        = Math.floor(Date.now() / 1000);
  const windowStart = now - RATE_LIMIT_WINDOW;
  let timestamps   = [];
  const stored     = await env[KV_BINDING].get(rlKey, { type: 'text' });
  if (stored) {
    try { timestamps = JSON.parse(stored).filter(t => t > windowStart); } catch { timestamps = []; }
  }
  if (timestamps.length >= RATE_LIMIT) {
    return respond(JSON.stringify({ error: 'Rate limit exceeded — please wait a moment' }), 429, cors);
  }
  timestamps.push(now);
  await env[KV_BINDING].put(rlKey, JSON.stringify(timestamps), { expirationTtl: RATE_LIMIT_WINDOW * 2 });
  return null;
}

// Returns current count without incrementing (used for remaining header)
async function checkStorageRateLimitCount(token, env) {
  const rlKey      = `ratelimit:${token}`;
  const now        = Math.floor(Date.now() / 1000);
  const windowStart = now - RATE_LIMIT_WINDOW;
  let timestamps   = [];
  const stored     = await env[KV_BINDING].get(rlKey, { type: 'text' });
  if (stored) {
    try { timestamps = JSON.parse(stored).filter(t => t > windowStart); } catch { timestamps = []; }
  }
  return { remaining: Math.max(0, RATE_LIMIT - timestamps.length) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readBody(request) {
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_BODY_SIZE) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) return null;
    return JSON.parse(text);
  } catch { return null; }
}

// Like readBody but returns the raw text (needed for HMAC verification)
async function readBodyText(request) {
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_BODY_SIZE) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) return null;
    return text;
  } catch { return null; }
}
