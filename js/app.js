/* ─────────────────────────────────────────────────────────────────
   Route & Reason — app.js
   ───────────────────────────────────────────────────────────────── */

'use strict';

// ─── Constants ────────────────────────────────────────────────────
const AVG_WALK_SPEED_MPH = 3.0; // used for estimated duration
const METERS_PER_MILE    = 1609.344;
const SLOPE_COLORS = [
  { max:  5, color: '#4caf50' },
  { max: 10, color: '#cddc39' },
  { max: 15, color: '#ff9800' },
  { max: 20, color: '#f44336' },
  { max: Infinity, color: '#b71c1c' },
];

// ─── Day/Night Toggle ─────────────────────────────────────────────
function tdnn() {
  const moon   = document.getElementsByClassName('moon')[0];
  const toggle = document.getElementsByClassName('tdnn')[0];
  if (!moon || !toggle) return;
  moon.classList.toggle('sun');
  toggle.classList.toggle('day');
  document.body.classList.toggle('dark');
  state.darkMode = document.body.classList.contains('dark');
  saveSettings();
  saveProfileToKV();
}

function applyDarkMode() {
  const moon   = document.getElementsByClassName('moon')[0];
  const toggle = document.getElementsByClassName('tdnn')[0];
  if (state.darkMode) {
    document.body.classList.add('dark');
    moon?.classList.add('sun');
    toggle?.classList.add('day');
  } else {
    document.body.classList.remove('dark');
    moon?.classList.remove('sun');
    toggle?.classList.remove('day');
  }
}

// ─── State ────────────────────────────────────────────────────────
const state = {
  token:       null,
  workerUrl:   null,
  pageSize:    20,
  weightLbs:   null,   // user weight for calorie calculation
  heightIn:    null,   // user height in inches
  ageyears:    null,   // user age
  sex:         null,   // 'male' or 'female'
  currentPage: 1,
  filterType:  'all',
  entries:     [],       // all loaded entries (journeys + journal)
  savedRoutes: [],
  weatherLocs: [],       // manually saved weather locations
  map:         null,     // Leaflet map instance
  waypoints:   [],       // array of L.LatLng
  markers:     [],       // array of L.Marker
  polylines:   [],       // array of L.Polyline (slope-colored segments)
  snapPolyline: null,    // single snapped route polyline
  elevationData: [],     // [{lat,lng,elevation}]
  editingId:   null,     // entry id being edited
  suppressRouteUpdate: false, // true while bulk-loading waypoints for edit
  viewMap:     null,     // read-only view modal map
  discoverMap: null,     // discover modal map
  activeRouteTab: 'my-routes', // 'my-routes' | 'bookmarked'
  prefillSourceRef: null,      // { entryId, friendToken, username } when using a friend's route
  mentionEntries:  [],          // mention notifications fetched from KV
  mentionCache:    {},          // { username: { token, found } } to avoid re-lookups
  mutualWalkEntries: [],        // mutual walk prompts fetched from KV
  goals:           {},          // { miles, walks } weekly targets
  syncQueue:       [],          // pending KV write operations
  // Social
  username:    null,     // this user's chosen username
  friends:     [],       // [{username, token}] confirmed friends
  incomingReqs:[],       // [{username, token, sentAt}] pending incoming
  outgoingReqs:[],       // [{username, token, sentAt}] pending outgoing
  friendEntries:[],      // entries fetched from friends
  lastSeenFriends: {},   // {token: ISO timestamp} for "New" dot logic
  darkMode:    false,    // day/night toggle preference
  // Auth
  authMethod:   null,    // 'guest' | 'token' | 'google'
  linkedGoogle: null,    // { sub, email, name, picture } for Google accounts
  createdAt:    null,    // account creation timestamp (ms)
};

// ─── Utility ──────────────────────────────────────────────────────

// Token generation delegated to Auth module (128-bit base64url, HMAC-compatible).
// Auth.init() must be called before this is used.
function generateToken() {
  return Auth.generateToken();
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatDistance(meters) {
  if (!meters) return '—';
  const miles = meters / METERS_PER_MILE;
  return miles.toFixed(2) + ' mi';
}

function formatDuration(minutes) {
  if (!minutes) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

function formatPace(minutes, meters) {
  if (!minutes || !meters) return '—';
  const miles = meters / METERS_PER_MILE;
  const paceMin = minutes / miles;
  const pm = Math.floor(paceMin);
  const ps = Math.round((paceMin - pm) * 60);
  return `${pm}:${String(ps).padStart(2,'0')}/mi`;
}

function formatSpeed(minutes, meters) {
  if (!minutes || !meters) return '—';
  const miles = meters / METERS_PER_MILE;
  const hours = minutes / 60;
  return (miles / hours).toFixed(1) + ' mph';
}

// ─── Calorie Calculation ─────────────────────────────────────────
// Primary method: Mifflin-St Jeor BMR × activity factor
// Requires sex, age, height, and weight for full accuracy.
// Falls back gracefully — any missing fields reduce to MET-only.
//
// Mifflin-St Jeor BMR:
//   Male:   (10 × kg) + (6.25 × cm) - (5 × age) + 5
//   Female: (10 × kg) + (6.25 × cm) - (5 × age) - 161
//
// Active calories for a walk = BMR × MET / 24 × duration_hours
// (BMR/24 converts daily rate to per-hour; MET scales by activity intensity)

function metForSpeed(mph) {
  if (mph <= 0)   return 0;
  if (mph < 2.0)  return 2.5;
  if (mph < 3.5)  return 3.5;
  if (mph < 4.5)  return 4.3;
  return 5.0;
}

function calcCalories(distMeters, durationMin, weightLbs, heightIn, ageyears, sex) {
  if (!distMeters || !durationMin || !weightLbs) return null;

  const miles    = distMeters / METERS_PER_MILE;
  const hours    = durationMin / 60;
  const mph      = hours > 0 ? miles / hours : 0;
  const met      = metForSpeed(mph);
  const weightKg = weightLbs * 0.453592;

  // If we have full profile data, use Mifflin-St Jeor
  if (heightIn && ageyears && sex) {
    const heightCm = heightIn * 2.54;
    const bmr = sex === 'male'
      ? (10 * weightKg) + (6.25 * heightCm) - (5 * ageyears) + 5
      : (10 * weightKg) + (6.25 * heightCm) - (5 * ageyears) - 161;
    // Active calories = BMR/24 gives hourly rate, MET scales intensity
    return Math.round((bmr / 24) * met * hours);
  }

  // Fallback: simpler MET-only formula (no sex/age/height)
  return Math.round(met * weightKg * hours);
}

function formatCalories(cal) {
  if (cal === null || cal === undefined) return '—';
  return cal.toLocaleString() + ' kcal';
}

// Parse HH:MM time string on a given date string (YYYY-MM-DD)
// Returns a Date object or null.
function parseTimeOnDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  return new Date(`${dateStr}T${timeStr}`);
}

// Given a date string and two time strings, return duration in minutes.
// Handles overnight walks (end < start → add 24h).
function calcDurationFromTimes(dateStr, startTime, endTime) {
  const start = parseTimeOnDate(dateStr, startTime);
  const end   = parseTimeOnDate(dateStr, endTime);
  if (!start || !end) return null;
  let diffMs = end - start;
  if (diffMs < 0) diffMs += 24 * 60 * 60 * 1000; // overnight
  return diffMs / 60000; // convert to minutes
}

function nowLocalISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function showToast(msg, duration = 2800) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

function haversineMeters(a, b) {
  const R = 6371000;
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
  const Δφ = (b.lat - a.lat) * Math.PI / 180;
  const Δλ = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

function totalDistance(latlngs) {
  let d = 0;
  for (let i = 1; i < latlngs.length; i++) {
    d += haversineMeters(latlngs[i-1], latlngs[i]);
  }
  return d;
}

function slopeColor(pct) {
  const abs = Math.abs(pct);
  for (const band of SLOPE_COLORS) {
    if (abs <= band.max) return band.color;
  }
  return SLOPE_COLORS[SLOPE_COLORS.length - 1].color;
}

// ─── Settings / Persistence (localStorage) ────────────────────────

function loadSettings() {
  const raw_token  = localStorage.getItem('wj_token');
  const raw_worker = localStorage.getItem('wj_worker');
  state.token      = (raw_token  && raw_token  !== 'null') ? raw_token  : null;
  state.workerUrl  = (raw_worker && raw_worker !== 'null') ? raw_worker : '';
  state.pageSize   = parseInt(localStorage.getItem('wj_page_size') || '20', 10);
  state.weatherLocs = JSON.parse(localStorage.getItem('wj_weather_locs') || '[]');
  state.weightLbs  = parseFloat(localStorage.getItem('wj_weight')  || '0') || null;
  state.heightIn   = parseFloat(localStorage.getItem('wj_height')  || '0') || null;
  state.ageyears   = parseFloat(localStorage.getItem('wj_age')     || '0') || null;
  state.sex        = localStorage.getItem('wj_sex') || null;
  const raw_user   = localStorage.getItem('wj_username');
  state.username   = (raw_user && raw_user !== 'null') ? raw_user : null;
  state.lastSeenFriends = JSON.parse(localStorage.getItem('wj_last_seen') || '{}');
  state.darkMode   = localStorage.getItem('wj_dark') === 'true';
  // Auth fields
  state.authMethod   = localStorage.getItem('wj_auth_method') || null;
  const rawGoogle    = localStorage.getItem('wj_linked_google');
  state.linkedGoogle = rawGoogle ? JSON.parse(rawGoogle) : null;
  state.createdAt    = parseInt(localStorage.getItem('wj_created_at') || '0', 10) || null;
  // Legacy migration: existing users have a token but no authMethod stored yet.
  // Infer 'token' so they don't land in guest mode.
  if (!state.authMethod && state.token) {
    state.authMethod = 'token';
    localStorage.setItem('wj_auth_method', 'token');
  }
  // Clean up any string "null" values that may have been written previously
  if (raw_token  === 'null') localStorage.removeItem('wj_token');
  if (raw_worker === 'null') localStorage.removeItem('wj_worker');
  if (raw_user   === 'null') localStorage.removeItem('wj_username');
  if (state.token) localStorage.setItem('wj_token', state.token);
}

function saveSettings() {
  if (state.token)     localStorage.setItem('wj_token',      state.token);
  if (state.workerUrl) localStorage.setItem('wj_worker',     state.workerUrl);
  else                 localStorage.removeItem('wj_worker');
  localStorage.setItem('wj_page_size',  state.pageSize);
  localStorage.setItem('wj_weather_locs', JSON.stringify(state.weatherLocs));
  if (state.weightLbs) localStorage.setItem('wj_weight', state.weightLbs);
  else localStorage.removeItem('wj_weight');
  if (state.heightIn)  localStorage.setItem('wj_height', state.heightIn);
  else localStorage.removeItem('wj_height');
  if (state.ageyears)  localStorage.setItem('wj_age', state.ageyears);
  else localStorage.removeItem('wj_age');
  if (state.sex)       localStorage.setItem('wj_sex', state.sex);
  else localStorage.removeItem('wj_sex');
  if (state.username)  localStorage.setItem('wj_username', state.username);
  else localStorage.removeItem('wj_username');
  localStorage.setItem('wj_last_seen', JSON.stringify(state.lastSeenFriends));
  localStorage.setItem('wj_dark', state.darkMode ? 'true' : 'false');
  // Auth fields
  if (state.authMethod)   localStorage.setItem('wj_auth_method',   state.authMethod);
  else                    localStorage.removeItem('wj_auth_method');
  if (state.linkedGoogle) localStorage.setItem('wj_linked_google', JSON.stringify(state.linkedGoogle));
  else                    localStorage.removeItem('wj_linked_google');
  if (state.createdAt)    localStorage.setItem('wj_created_at',    String(state.createdAt));
  else                    localStorage.removeItem('wj_created_at');
}

// ─── Worker API ───────────────────────────────────────────────────

async function workerFetch(path, method = 'GET', body = null) {
  if (!state.workerUrl) throw new Error('Worker URL not configured');
  if (Auth.isGuest()) throw new Error('Guest accounts cannot sync');
  const url     = state.workerUrl.replace(/\/$/, '') + path;
  const bodyStr = body !== null ? JSON.stringify(body) : null;

  // Build auth headers — HMAC for token accounts, Bearer for Google
  let authHeaders = {};
  try {
    authHeaders = await Auth._authHeaders(method, state.token, bodyStr);
  } catch(e) { /* fall through — worker will reject with 401 if required */ }

  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders },
  };
  if (bodyStr !== null) opts.body = bodyStr;
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function kvGet(key) {
  const data = await workerFetch(`/storage/${state.token}/${key}`);
  return data.value;
}

async function kvPut(key, value) {
  await workerFetch(`/storage/${state.token}/${key}`, 'PUT', value);
}

async function kvList() {
  const data = await workerFetch(`/storage/${state.token}`);
  return data.keys || [];
}

// ─── Profile KV Sync ─────────────────────────────────────────────
// Roaming profile: synced to KV so all browsers get the same settings.

async function saveProfileToKV() {
  if (!state.workerUrl || !state.token || Auth.isGuest()) return;
  try {
    // Read existing KV profile first so we don't overwrite fields
    // that exist in KV but are null locally (e.g. on a new browser
    // that hasn't had all fields entered yet).
    let existing = {};
    try { existing = (await kvGet('profile')) || {}; } catch(e) { /* first save */ }

    // Never overwrite a non-empty friends/requests list with an empty one.
    // This guards against a KV read failure during deployment causing data loss.
    const friends      = state.friends.length      ? state.friends      : (existing.friends      || []);
    const incomingReqs = state.incomingReqs.length  ? state.incomingReqs  : (existing.incomingReqs  || []);
    const outgoingReqs = state.outgoingReqs.length  ? state.outgoingReqs  : (existing.outgoingReqs  || []);

    const merged = {
      username:     state.username    ?? existing.username    ?? null,
      sex:          state.sex         ?? existing.sex         ?? null,
      ageyears:     state.ageyears    ?? existing.ageyears    ?? null,
      heightIn:     state.heightIn    ?? existing.heightIn    ?? null,
      weightLbs:    state.weightLbs   ?? existing.weightLbs   ?? null,
      pageSize:     state.pageSize    ?? existing.pageSize    ?? 20,
      weatherLocs:  state.weatherLocs?.length ? state.weatherLocs : (existing.weatherLocs ?? []),
      goals:        (state.goals?.miles || state.goals?.walks) ? state.goals : (existing.goals ?? {}),
      friends,
      incomingReqs,
      outgoingReqs,
      darkMode:     state.darkMode     ?? existing.darkMode     ?? false,
      authMethod:   state.authMethod   ?? existing.authMethod   ?? null,
      linkedGoogle: state.linkedGoogle ?? existing.linkedGoogle ?? null,
      createdAt:    state.createdAt    ?? existing.createdAt    ?? null,
    };

    await kvPut('profile', merged);

    // Also back up friends to localStorage so a KV blip can't wipe them
    if (friends.length) localStorage.setItem('wj_friends', JSON.stringify(friends));
  } catch(e) {
    console.warn('Profile KV save failed:', e.message);
  }
}

async function loadProfileFromKV() {
  if (!state.workerUrl || !state.token || Auth.isGuest()) return;
  try {
    // Fetch raw so we can inspect headers (migration)
    const bodyStr     = null;
    const authHeaders = await Auth._authHeaders('GET', state.token, bodyStr).catch(() => ({}));
    const res = await fetch(
      `${state.workerUrl.replace(/\/$/, '')}/storage/${state.token}/profile`,
      { headers: { 'Content-Type': 'application/json', ...authHeaders } }
    );

    // Handle token migration (legacy token upgraded on another device)
    const migratedTo = res.headers.get('X-Token-Migrated');
    if (migratedTo) {
      const data = await res.json().catch(() => ({}));
      const migrated = Auth.handlePullMigration(migratedTo, { ...data.value, userToken: migratedTo });
      state.token    = migrated.userToken;
      state.authMethod = migrated.authMethod || state.authMethod;
      saveSettings();
      return;
    }

    // Handle account migrated to Google (tombstone)
    if (res.status === 410) {
      Auth.showAccountSetup();
      return;
    }

    if (!res.ok) return;

    const json    = await res.json();
    const profile = json.value;
    if (!profile) return;

    // Only overwrite local state if KV has a non-null value.
    if (profile.username   != null) state.username   = profile.username;
    if (profile.sex        != null) state.sex        = profile.sex;
    if (profile.ageyears   != null) state.ageyears   = profile.ageyears;
    if (profile.heightIn   != null) state.heightIn   = profile.heightIn;
    if (profile.weightLbs  != null) state.weightLbs  = profile.weightLbs;
    if (profile.pageSize   != null) state.pageSize   = profile.pageSize;
    if (profile.authMethod != null) state.authMethod = profile.authMethod;
    if (profile.linkedGoogle != null) state.linkedGoogle = profile.linkedGoogle;
    if (Array.isArray(profile.weatherLocs) && profile.weatherLocs.length > 0) state.weatherLocs = profile.weatherLocs;

    // For friends/requests: use KV value if non-empty, else fall back to localStorage backup
    if (Array.isArray(profile.friends) && profile.friends.length > 0) {
      state.friends = profile.friends;
    } else {
      const localFriends = JSON.parse(localStorage.getItem('wj_friends') || '[]');
      if (localFriends.length > 0) {
        state.friends = localFriends;
        saveProfileToKV().catch(() => {});
      }
    }

    if (Array.isArray(profile.incomingReqs)) state.incomingReqs = profile.incomingReqs;
    if (Array.isArray(profile.outgoingReqs)) state.outgoingReqs = profile.outgoingReqs;
    if (profile.darkMode != null) state.darkMode = profile.darkMode;
    if (profile.goals?.miles || profile.goals?.walks) {
      state.goals = profile.goals;
      saveGoals();
    }
    saveSettings();
  } catch(e) {
    console.warn('[Profile KV] load failed:', e.message);
    const localFriends = JSON.parse(localStorage.getItem('wj_friends') || '[]');
    if (localFriends.length > 0) state.friends = localFriends;
  }
}

// ─── Social / Friends ────────────────────────────────────────────

// Fetch entries for all confirmed friends and merge into feed
async function loadFriendEntries() {
  state.friendEntries = [];
  if (!state.workerUrl || state.friends.length === 0) return;

  const now = new Date().toISOString();

  for (const friend of state.friends) {
    try {
      // List this friend's entry keys using their token
      const data = await workerFetch(`/storage/${friend.token}`);
      const keys = (data.keys || []).filter(k => k.key.startsWith('entry/'));

      const entries = await Promise.all(
        keys.map(k =>
          workerFetch(`/storage/${friend.token}/${k.key}`)
            .then(d => d.value)
            .catch(() => null)
        )
      );

      const visible = entries
        .filter(Boolean)
        .filter(e => e.visibility === 'friends' || e.visibility === 'public')
        .map(e => ({
          ...e,
          _isFriend: true,
          _friendUsername: friend.username,
          _friendToken: friend.token,
          _isNew: !state.lastSeenFriends[friend.token] ||
                  new Date(e.datetime) > new Date(state.lastSeenFriends[friend.token]),
        }));

      state.friendEntries.push(...visible);
    } catch(e) {
      console.warn('Could not load entries for friend:', friend.username, e.message);
    }

    // Update lastSeen for this friend
    state.lastSeenFriends[friend.token] = now;
  }

  saveSettings(); // persist lastSeen
}

// Username worker helpers
async function registerUsername(username) {
  const url = state.workerUrl.replace(/\/$/, '') + `/username/${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: state.token }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to register username');
  return data;
}

async function lookupUsername(username) {
  const url = state.workerUrl.replace(/\/$/, '') + `/username/${encodeURIComponent(username)}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Lookup failed');
  return res.json(); // { token, username }
}

// ─── Mentions ─────────────────────────────────────────────────────

// Load mention notifications from this user's own KV
async function loadMentionEntries() {
  state.mentionEntries = [];
  if (!state.workerUrl || !state.token) return;
  try {
    const data = await workerFetch(`/storage/${state.token}`);
    const keys = (data.keys || []).filter(k => k.key.startsWith('mention/'));
    const mentions = await Promise.all(
      keys.map(k =>
        workerFetch(`/storage/${state.token}/${k.key}`)
          .then(d => d.value)
          .catch(() => null)
      )
    );
    state.mentionEntries = mentions.filter(Boolean).map(m => ({
      ...m,
      _isMention: true,
    }));
  } catch(e) {
    console.warn('Could not load mention entries:', e.message);
  }
}

// Send a mention notification to a tagged user's KV space
async function sendMentionNotification(targetToken, entryId, preview) {
  if (!state.workerUrl || !state.username) return;
  try {
    const url = state.workerUrl.replace(/\/$/, '') + `/notify/${encodeURIComponent(targetToken)}`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entryId,
        fromUsername: state.username,
        fromToken:    state.token,
        preview,
      }),
    });
  } catch(e) {
    console.warn('Mention notification failed:', e.message);
  }
}

// Parse @mentions from text — returns array of lowercase usernames
function parseMentions(text) {
  const matches = text.match(/@([a-zA-Z0-9_-]{3,32})/g) || [];
  return [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
}

// Load mutual walk prompts from this user's own KV
async function loadMutualWalkEntries() {
  state.mutualWalkEntries = [];
  if (!state.workerUrl || !state.token) return;
  try {
    const data = await workerFetch(`/storage/${state.token}`);
    const keys = (data.keys || []).filter(k => k.key.startsWith('mutualwalk/'));
    const entries = await Promise.all(
      keys.map(k =>
        workerFetch(`/storage/${state.token}/${k.key}`)
          .then(d => d.value)
          .catch(() => null)
      )
    );
    state.mutualWalkEntries = entries.filter(Boolean);
  } catch(e) {
    console.warn('Could not load mutual walk entries:', e.message);
  }
}

// Send a mutual walk notification to a tagged user's KV space
async function sendMutualWalkNotification(targetToken, entry) {
  if (!state.workerUrl || !state.username) return;
  try {
    const url = state.workerUrl.replace(/\/$/, '') + `/notify/${encodeURIComponent(targetToken)}`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type:         'mutualwalk',
        entryId:      entry.id,
        entryName:    entry.name || '',
        fromUsername: state.username,
        fromToken:    state.token,
        preview:      (entry.notes || '').slice(0, 120),
        waypoints:    entry.waypoints || [],
      }),
    });
  } catch(e) {
    console.warn('Mutual walk notification failed:', e.message);
  }
}

// ─── Surface overlay ──────────────────────────────────────────────

const SURFACE_COLORS = {
  paved:   '#4a7c59',
  gravel:  '#c8a84b',
  dirt:    '#8b6340',
  unpaved: '#888888',
  stairs:  '#e8820c',
};

const SURFACE_LABELS = {
  paved:   'Paved',
  gravel:  'Gravel',
  dirt:    'Dirt',
  unpaved: 'Unpaved',
  stairs:  'Stairs',
};

const SURFACE_ORDER = ['paved', 'gravel', 'dirt', 'unpaved', 'stairs'];

// Cache last surface fetch — avoids re-hitting Overpass when toggling back to surface
const surfaceCache = { bbox: null, ways: null };

function closestWaySurface(pt, ways) {
  let best = null, bestDist = Infinity;
  for (const way of ways) {
    for (const node of way.geometry) {
      const d = Math.hypot(pt.lat - node.lat, pt.lng - node.lng);
      if (d < bestDist) { bestDist = d; best = way.surface; }
    }
  }
  return best || 'unpaved';
}

async function fetchAndDrawSurface(routePoints) {
  if (!state.workerUrl || routePoints.length < 2) return;
  const lats   = routePoints.map(p => p.lat || p[0]);
  const lngs   = routePoints.map(p => p.lng || p[1]);
  const minLat = (Math.min(...lats) - 0.001).toFixed(5);
  const minLng = (Math.min(...lngs) - 0.001).toFixed(5);
  const maxLat = (Math.max(...lats) + 0.001).toFixed(5);
  const maxLng = (Math.max(...lngs) + 0.001).toFixed(5);
  const bbox   = `${minLat},${minLng},${maxLat},${maxLng}`;

  // Use cached result if bbox matches — instant on toggle back
  if (surfaceCache.bbox === bbox && surfaceCache.ways !== null) {
    drawSurfaceRoute(routePoints, surfaceCache.ways);
    return;
  }

  try {
    const url  = state.workerUrl.replace(/\/$/, '') + `/surface?bbox=${encodeURIComponent(bbox)}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    surfaceCache.bbox = bbox;
    surfaceCache.ways = data.ways || [];
    drawSurfaceRoute(routePoints, surfaceCache.ways);
  } catch(e) {
    console.warn('Surface fetch failed, drawing plain route:', e.message);
    const poly = L.polyline(routePoints, { color: '#4a7c59', weight: 4, opacity: 0.85 }).addTo(state.map);
    state.polylines.push(poly);
  }
}

function drawSurfaceRoute(routePoints, ways) {
  if (ways.length === 0) {
    const poly = L.polyline(routePoints, { color: '#4a7c59', weight: 4, opacity: 0.85 }).addTo(state.map);
    state.polylines.push(poly);
    renderSurfaceLegend(new Set(['paved']));
    return;
  }

  const surfacesFound  = new Set();
  let currentSurface   = null;
  let currentSegment   = [];

  const flushSegment = () => {
    if (currentSegment.length >= 2) {
      const color = SURFACE_COLORS[currentSurface] || SURFACE_COLORS.unpaved;
      state.polylines.push(L.polyline(currentSegment, { color, weight: 5, opacity: 0.9 }).addTo(state.map));
    }
    currentSegment = [];
  };

  for (let i = 0; i < routePoints.length - 1; i++) {
    const pt      = routePoints[i];
    const surface = closestWaySurface({ lat: pt.lat || pt[0], lng: pt.lng || pt[1] }, ways);
    surfacesFound.add(surface);
    if (surface !== currentSurface) {
      flushSegment();
      currentSurface  = surface;
      currentSegment  = [routePoints[i]];
    }
    currentSegment.push(routePoints[i + 1]);
  }
  flushSegment();

  renderSurfaceLegend(surfacesFound);
}

function renderSurfaceLegend(surfacesFound) {
  const el = document.getElementById('surface-legend');
  el.innerHTML = SURFACE_ORDER
    .filter(s => surfacesFound.has(s))
    .map(s => `<span class="legend-item"><span class="legend-dot" style="background:${SURFACE_COLORS[s]}"></span>${SURFACE_LABELS[s]}</span>`)
    .join('');
}

// ─── Mention autocomplete ─────────────────────────────────────────

(function initMentionAutocomplete() {
  const textarea = document.getElementById('journey-notes');
  const dropdown = document.getElementById('mention-dropdown');
  let mentionStart = -1;
  let currentQuery = '';
  let lookupTimer  = null;
  let options      = [];
  let activeIdx    = -1;

  function hideDrop() {
    dropdown.style.display = 'none';
    options = [];
    activeIdx = -1;
    mentionStart = -1;
    currentQuery = '';
  }

  function showDrop(items) {
    if (!items.length) { hideDrop(); return; }
    options = items;
    activeIdx = 0;
    dropdown.innerHTML = items.map((item, i) => `
      <div class="mention-option${i === 0 ? ' active' : ''}" data-idx="${i}">
        <span class="mention-at">@${escapeHtml(item.username)}</span>
        ${item.isFriend ? '<span class="mention-status">friend</span>' : ''}
      </div>
    `).join('');
    dropdown.querySelectorAll('.mention-option').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        selectOption(parseInt(el.dataset.idx));
      });
    });

    // Position below the textarea cursor (approximate)
    const rect = textarea.getBoundingClientRect();
    const parentRect = textarea.parentElement.getBoundingClientRect();
    dropdown.style.display = 'block';
    dropdown.style.top  = (rect.bottom - parentRect.top + 4) + 'px';
    dropdown.style.left = '0';
  }

  function selectOption(idx) {
    const item = options[idx];
    if (!item) return;
    const val    = textarea.value;
    const before = val.slice(0, mentionStart);
    const after  = val.slice(textarea.selectionStart);
    textarea.value = before + '@' + item.username + ' ' + after;
    // Move cursor after inserted mention
    const pos = (before + '@' + item.username + ' ').length;
    textarea.setSelectionRange(pos, pos);
    hideDrop();
    textarea.focus();
    // Cache the resolved user
    state.mentionCache[item.username.toLowerCase()] = { token: item.token, found: true };
  }

  textarea.addEventListener('input', () => {
    const val   = textarea.value;
    const caret = textarea.selectionStart;

    // Find the @ that precedes the caret
    let atPos = -1;
    for (let i = caret - 1; i >= 0; i--) {
      if (val[i] === '@') { atPos = i; break; }
      if (val[i] === ' ' || val[i] === '\n') break;
    }

    if (atPos === -1) { hideDrop(); return; }

    const query = val.slice(atPos + 1, caret);
    if (!/^[a-zA-Z0-9_-]{0,32}$/.test(query)) { hideDrop(); return; }

    mentionStart  = atPos;
    currentQuery  = query;

    if (query.length < 1) { hideDrop(); return; }

    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(async () => {
      if (!state.workerUrl) return;

      // Check friends first (instant)
      const friendMatches = state.friends
        .filter(f => f.username.toLowerCase().startsWith(query.toLowerCase()))
        .map(f => ({ username: f.username, token: f.token, isFriend: true }));

      // If we have a friend match, show immediately; also do a remote lookup
      if (friendMatches.length) showDrop(friendMatches);

      // Remote lookup for exact match
      try {
        const cached = state.mentionCache[query.toLowerCase()];
        if (cached) {
          if (cached.found) {
            const exists = friendMatches.find(f => f.username.toLowerCase() === query.toLowerCase());
            if (!exists) showDrop([...friendMatches, { username: query, token: cached.token, isFriend: false }]);
          }
          return;
        }
        const result = await lookupUsername(query);
        if (result && query === currentQuery) {
          state.mentionCache[query.toLowerCase()] = { token: result.token, found: true };
          const exists = friendMatches.find(f => f.username.toLowerCase() === result.username.toLowerCase());
          if (!exists) showDrop([...friendMatches, { username: result.username, token: result.token, isFriend: false }]);
          else showDrop(friendMatches);
        } else if (!result) {
          state.mentionCache[query.toLowerCase()] = { token: null, found: false };
          if (friendMatches.length) showDrop(friendMatches);
          else hideDrop();
        }
      } catch(e) {
        if (friendMatches.length) showDrop(friendMatches);
      }
    }, 300);
  });

  textarea.addEventListener('keydown', e => {
    if (dropdown.style.display === 'none') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, options.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      selectOption(activeIdx);
      return;
    } else if (e.key === 'Escape') {
      hideDrop();
      return;
    }
    dropdown.querySelectorAll('.mention-option').forEach((el, i) => {
      el.classList.toggle('active', i === activeIdx);
    });
  });

  textarea.addEventListener('blur', () => {
    setTimeout(hideDrop, 150);
  });
})();

// Send a friend request to another user
async function sendFriendRequest(friendUsername, friendToken) {
  const now = new Date().toISOString();
  const req = { username: friendUsername, token: friendToken, sentAt: now };

  // Check for mutual simultaneous request — auto-confirm if they already sent to us
  const mutual = state.incomingReqs.find(r => r.token === friendToken);
  if (mutual) {
    await confirmFriendship(mutual);
    return { autoConfirmed: true };
  }

  // Add to outgoing
  state.outgoingReqs = state.outgoingReqs.filter(r => r.token !== friendToken);
  state.outgoingReqs.push(req);
  await saveProfileToKV();

  // Write to their incoming requests
  try {
    const theirProfile = await workerFetch(`/storage/${friendToken}/profile`)
      .then(d => d.value).catch(() => null);
    const theirIncoming = theirProfile?.incomingReqs || [];
    // Avoid duplicate
    const already = theirIncoming.find(r => r.token === state.token);
    if (!already) {
      theirIncoming.push({ username: state.username, token: state.token, sentAt: now });
      const updated = { ...(theirProfile || {}), incomingReqs: theirIncoming };
      await workerFetch(`/storage/${friendToken}/profile`, 'PUT', updated);
    }
  } catch(e) {
    console.warn('Could not write to friend incoming:', e.message);
  }

  return { autoConfirmed: false };
}

// Confirm a friend request (approve incoming)
async function confirmFriendship(req) {
  const now = new Date().toISOString();

  // Add to our friends list
  if (!state.friends.find(f => f.token === req.token)) {
    state.friends.push({ username: req.username, token: req.token, since: now });
  }
  // Remove from our incoming
  state.incomingReqs = state.incomingReqs.filter(r => r.token !== req.token);
  // Remove from our outgoing (in case of mutual)
  state.outgoingReqs = state.outgoingReqs.filter(r => r.token !== req.token);
  await saveProfileToKV();

  // Write us to their friends list and clean up their outgoing
  try {
    const theirProfile = await workerFetch(`/storage/${req.token}/profile`)
      .then(d => d.value).catch(() => null);
    if (theirProfile) {
      const theirFriends = theirProfile.friends || [];
      if (!theirFriends.find(f => f.token === state.token)) {
        theirFriends.push({ username: state.username, token: state.token, since: now });
      }
      const theirOutgoing = (theirProfile.outgoingReqs || []).filter(r => r.token !== state.token);
      const updated = { ...theirProfile, friends: theirFriends, outgoingReqs: theirOutgoing };
      await workerFetch(`/storage/${req.token}/profile`, 'PUT', updated);
    }
  } catch(e) {
    console.warn('Could not update friend profile:', e.message);
  }
}

// Decline an incoming request
async function declineRequest(req) {
  state.incomingReqs = state.incomingReqs.filter(r => r.token !== req.token);
  await saveProfileToKV();
}

// Cancel an outgoing request
async function cancelRequest(req) {
  state.outgoingReqs = state.outgoingReqs.filter(r => r.token !== req.token);
  await saveProfileToKV();
  // Remove from their incoming
  try {
    const theirProfile = await workerFetch(`/storage/${req.token}/profile`)
      .then(d => d.value).catch(() => null);
    if (theirProfile) {
      const theirIncoming = (theirProfile.incomingReqs || []).filter(r => r.token !== state.token);
      await workerFetch(`/storage/${req.token}/profile`, 'PUT', { ...theirProfile, incomingReqs: theirIncoming });
    }
  } catch(e) {
    console.warn('Could not update friend profile:', e.message);
  }
}

// Remove a confirmed friend (one-sided, silent)
async function removeFriend(friend) {
  state.friends = state.friends.filter(f => f.token !== friend.token);
  await saveProfileToKV();
}

// Poll incoming requests count and update badge
async function refreshFriendsBadge() {
  if (!state.workerUrl) return;
  try {
    const profile = await kvGet('profile');
    if (profile?.incomingReqs) {
      state.incomingReqs = profile.incomingReqs;
    }
    updateFriendsBadge();
  } catch(e) { /* silent */ }
}

function updateFriendsBadge() {
  const reqCount  = state.incomingReqs.length;
  const notifCount = state.mentionEntries.length + state.mutualWalkEntries.length;
  const totalCount = reqCount + notifCount;

  // Header badge — total of requests + notifications
  const badge = document.getElementById('friends-badge');
  if (totalCount > 0) {
    badge.textContent = totalCount > 9 ? '9+' : totalCount;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }

  // Requests tab badge
  const tabBadgeReq = document.getElementById('tab-badge-requests');
  if (reqCount > 0) {
    tabBadgeReq.textContent = reqCount > 9 ? '9+' : reqCount;
    tabBadgeReq.style.display = 'inline-flex';
  } else {
    tabBadgeReq.style.display = 'none';
  }

  // Notifications tab badge
  const tabBadgeNotif = document.getElementById('tab-badge-notifications');
  if (notifCount > 0) {
    tabBadgeNotif.textContent = notifCount > 9 ? '9+' : notifCount;
    tabBadgeNotif.style.display = 'inline-flex';
  } else {
    tabBadgeNotif.style.display = 'none';
  }
}

// ─── Sync Queue ───────────────────────────────────────────────────
// Queues failed KV writes for retry. One operation per entry ID —
// edits replace prior saves, deletes cancel pending saves.

function loadSyncQueue() {
  try {
    state.syncQueue = JSON.parse(localStorage.getItem('wj_sync_queue') || '[]');
  } catch(e) {
    state.syncQueue = [];
  }
}

function saveSyncQueue() {
  localStorage.setItem('wj_sync_queue', JSON.stringify(state.syncQueue));
}

function queueEntryOp(entry) {
  // Remove any existing op for this ID, then push save op
  state.syncQueue = state.syncQueue.filter(op => op.id !== entry.id);
  state.syncQueue.push({ type: 'save', id: entry.id, entry, queuedAt: Date.now() });
  saveSyncQueue();
}

function queueDeleteOp(id) {
  // If there's a pending save for this ID, remove it — no point syncing a deleted entry
  const hadPendingSave = state.syncQueue.some(op => op.id === id && op.type === 'save');
  state.syncQueue = state.syncQueue.filter(op => op.id !== id);
  // Only queue the delete if the entry was already synced (i.e. no pending save)
  if (!hadPendingSave) {
    state.syncQueue.push({ type: 'delete', id, queuedAt: Date.now() });
  }
  saveSyncQueue();
}

function isQueued(entryId) {
  return state.syncQueue.some(op => op.id === entryId);
}

async function drainSyncQueue() {
  if (!state.workerUrl || state.syncQueue.length === 0) return;

  const queue = [...state.syncQueue]; // snapshot
  let changed  = false;

  for (const op of queue) {
    try {
      if (op.type === 'save') {
        await kvPut(`entry/${op.id}`, op.entry);
      } else if (op.type === 'delete') {
        await workerFetch(`/storage/${state.token}/entry/${op.id}`, 'DELETE');
      }
      // Success — remove from queue
      state.syncQueue = state.syncQueue.filter(q => q.id !== op.id);
      changed = true;
    } catch(e) {
      // Still offline or error — leave in queue
    }
  }

  if (changed) {
    saveSyncQueue();
    renderFeed(); // refresh badges
  }
}

// ─── Entry Storage ────────────────────────────────────────────────
// KV is always the source of truth when a worker URL is set.
// localStorage is a write-through cache used as a fallback when
// the worker is unreachable. It never overrides KV data.

async function loadEntries() {
  if (!state.workerUrl) {
    state.entries     = JSON.parse(localStorage.getItem('wj_entries') || '[]');
    state.savedRoutes = JSON.parse(localStorage.getItem('wj_routes')  || '[]');
    return;
  }
  try {
    const keys      = await kvList();
    const entryKeys = keys.filter(k => k.key.startsWith('entry/'));
    const routeKeys = keys.filter(k => k.key.startsWith('route/'));

    const entries = await Promise.all(
      entryKeys.map(k => kvGet(k.key).catch(() => null))
    );
    state.entries = entries
      .filter(Boolean)
      .sort((a, b) => new Date(b.datetime) - new Date(a.datetime));

    const routes = await Promise.all(
      routeKeys.map(k => kvGet(k.key).catch(() => null))
    );
    state.savedRoutes = routes.filter(Boolean);

    // Keep localStorage in sync as a cache
    localStorage.setItem('wj_entries', JSON.stringify(state.entries));
    localStorage.setItem('wj_routes',  JSON.stringify(state.savedRoutes));
  } catch (e) {
    console.warn('Could not load from worker, falling back to local cache:', e.message);
    state.entries     = JSON.parse(localStorage.getItem('wj_entries') || '[]');
    state.savedRoutes = JSON.parse(localStorage.getItem('wj_routes')  || '[]');
  }
}

async function saveEntry(entry) {
  // Merge into state
  const idx = state.entries.findIndex(e => e.id === entry.id);
  if (idx >= 0) state.entries[idx] = entry;
  else state.entries.unshift(entry);
  state.entries.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));

  // Always write to KV first if available, then update local cache
  if (state.workerUrl) {
    try {
      await kvPut(`entry/${entry.id}`, entry);
      // Success — remove from sync queue if it was queued
      if (isQueued(entry.id)) {
        state.syncQueue = state.syncQueue.filter(op => op.id !== entry.id);
        saveSyncQueue();
      }
    } catch(e) {
      console.warn('Worker save failed — queuing for sync:', e.message);
      queueEntryOp(entry);
    }

    // Sync public discovery index
    try {
      if (entry.visibility === 'public' && entry.type === 'journey' && state.username) {
        const url = state.workerUrl.replace(/\/$/, '') + `/public/entries/${entry.id}`;
        await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token:      state.token,
            username:   state.username,
            name:       entry.name,
            distMeters: entry.distMeters,
            datetime:   entry.datetime,
            waypoints:  entry.waypoints,
          }),
        });
      } else {
        // Remove from public index if visibility changed away from public
        const url = state.workerUrl.replace(/\/$/, '') + `/public/entries/${entry.id}`;
        await fetch(url, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: state.token }),
        }).catch(() => {}); // silent fail — may not exist in index
      }
    } catch(e) {
      console.warn('Public index sync failed:', e.message);
    }
  }
  localStorage.setItem('wj_entries', JSON.stringify(state.entries));
}

async function deleteEntry(id) {
  // Remove from state
  state.entries = state.entries.filter(e => e.id !== id);
  localStorage.setItem('wj_entries', JSON.stringify(state.entries));

  // Remove from KV
  if (state.workerUrl) {
    try {
      await workerFetch(`/storage/${state.token}/entry/${id}`, 'DELETE');
      // Success — remove from sync queue
      state.syncQueue = state.syncQueue.filter(op => op.id !== id);
      saveSyncQueue();
    } catch(e) {
      console.warn('Worker delete failed — queuing for sync:', e.message);
      queueDeleteOp(id);
    }
    // Remove from public index (silent — may not exist)
    try {
      const url = state.workerUrl.replace(/\/$/, '') + `/public/entries/${id}`;
      await fetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: state.token }),
      });
    } catch(e) {}
  }
}

async function saveRoute(route) {
  const idx = state.savedRoutes.findIndex(r => r.id === route.id);
  if (idx >= 0) state.savedRoutes[idx] = route;
  else state.savedRoutes.push(route);

  if (state.workerUrl) {
    try { await kvPut(`route/${route.id}`, route); }
    catch(e) { console.warn('Worker save failed:', e.message); }
  }
  localStorage.setItem('wj_routes', JSON.stringify(state.savedRoutes));
}

// ─── Local → KV Migration ─────────────────────────────────────────
// Returns the number of local entries not yet present in KV.
async function countUnsyncedLocalEntries() {
  const local = JSON.parse(localStorage.getItem('wj_entries') || '[]');
  if (!local.length) return { count: 0, entries: [] };
  try {
    const keys     = await kvList();
    const kvIds    = new Set(keys.filter(k => k.key.startsWith('entry/')).map(k => k.key.replace('entry/', '')));
    const unsynced = local.filter(e => !kvIds.has(e.id));
    return { count: unsynced.length, entries: unsynced };
  } catch(e) {
    return { count: 0, entries: [] };
  }
}

async function pushLocalEntriesToKV(entries, progressEl) {
  let done = 0;
  for (const entry of entries) {
    try {
      await kvPut(`entry/${entry.id}`, entry);
      done++;
      if (progressEl) progressEl.textContent = `Synced ${done} of ${entries.length}…`;
    } catch(e) {
      console.warn('Failed to sync entry:', entry.id, e.message);
    }
  }
  return done;
}

// ─── Modal Manager ────────────────────────────────────────────────

function openModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('open');
    // Only restore scroll if no other modals open
    if (!document.querySelector('.modal-overlay.open')) {
      document.body.style.overflow = '';
    }
  }
}

// Close buttons
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

// Click outside to close
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// ─── Map Setup ────────────────────────────────────────────────────

function initMap() {
  if (state.map) return;

  state.map = L.map('journey-map', {
    center: [39.5, -98.35],
    zoom: 4,
    zoomControl: true,
  });

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(state.map);

  state.map.on('click', onMapClick);

  // Try to geolocate
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(pos => {
      state.map.setView([pos.coords.latitude, pos.coords.longitude], 15);
    }, () => {});
  }
}

function onMapClick(e) {
  addWaypoint(e.latlng);
}

function addWaypoint(latlng) {
  state.waypoints.push(latlng);

  const isFirst = state.waypoints.length === 1;
  const iconHtml = `<div></div>`;
  const icon = L.divIcon({
    className: isFirst ? 'waypoint-start-icon' : 'waypoint-icon',
    html: iconHtml,
    iconSize: isFirst ? [14,14] : [10,10],
    iconAnchor: isFirst ? [7,7] : [5,5],
  });

  const marker = L.marker(latlng, { icon, draggable: true }).addTo(state.map);
  marker.on('dragend', () => {
    const idx = state.markers.indexOf(marker);
    if (idx >= 0) state.waypoints[idx] = marker.getLatLng();
    updateRoute();
  });
  state.markers.push(marker);

  if (!state.suppressRouteUpdate) updateRoute();
}

// One-time backfill: compute elevation stats for existing entries that lack them
async function backfillElevationStats() {
  if (!state.workerUrl) {
    console.log('[Elevation backfill] Skipped — no worker URL');
    return;
  }

  const needsBackfill = state.entries.filter(e =>
    e.type === 'journey' &&
    e.waypoints && e.waypoints.length >= 2 &&
    e.elevGainM == null
  );

  console.log(`[Elevation backfill] Found ${needsBackfill.length} entries needing backfill (of ${state.entries.length} total)`);

  if (needsBackfill.length === 0) return;

  for (const entry of needsBackfill) {
    try {
      const sample = samplePoints(entry.waypoints, 100);
      console.log(`[Elevation backfill] Fetching elevation for "${entry.name}" (${sample.length} points)`);
      const elevations = await workerFetch('/elevation', 'POST', { locations: sample });
      console.log(`[Elevation backfill] Got ${elevations?.length} elevation points`);
      const stats = computeElevStats(elevations);
      if (stats) {
        entry.elevGainM = stats.elevGainM;
        entry.elevLossM = stats.elevLossM;
        entry.elevHighM = stats.elevHighM;
        entry.elevLowM  = stats.elevLowM;
        await saveEntry(entry);
        console.log(`[Elevation backfill] Saved stats for "${entry.name}": gain=${stats.elevGainM}m high=${stats.elevHighM}m`);
      } else {
        console.warn(`[Elevation backfill] computeElevStats returned null for "${entry.name}"`);
      }
      // Small delay between calls to avoid hammering the API
      await new Promise(r => setTimeout(r, 300));
    } catch(e) {
      console.warn(`[Elevation backfill] Failed for entry "${entry.name}":`, e.message);
    }
  }

  console.log('[Elevation backfill] Complete.');
  renderElevationRecords();
}
function checkLoopDetection() {
  const btn = document.getElementById('btn-close-loop');
  if (state.waypoints.length < 3) { btn.style.display = 'none'; return; }

  const start = state.waypoints[0];
  const end   = state.waypoints[state.waypoints.length - 1];
  const dist  = start.distanceTo(end); // metres

  // Already a loop (snapped) — hide button
  if (dist < 1) { btn.style.display = 'none'; return; }

  // Close enough to suggest closing (within 50m)
  btn.style.display = dist < 50 ? '' : 'none';
}

function clearMapDrawings() {
  state.polylines.forEach(p => state.map.removeLayer(p));
  state.polylines = [];
  if (state.snapPolyline) { state.map.removeLayer(state.snapPolyline); state.snapPolyline = null; }
}

async function updateRoute() {
  clearMapDrawings();
  if (state.waypoints.length < 2) {
    updateStats(0);
    return;
  }

  const snap    = document.getElementById('toggle-snap').checked;
  const slope   = document.getElementById('toggle-slope').checked;
  const surface = document.getElementById('toggle-surface').checked;

  let routePoints = state.waypoints;

  if (snap && state.workerUrl) {
    try {
      routePoints = await fetchSnappedRoute(state.waypoints);
    } catch(e) {
      console.warn('Snap failed, using straight lines:', e.message);
    }
  }

  if (surface && state.workerUrl) {
    await fetchAndDrawSurface(routePoints);
  } else if (slope && state.workerUrl) {
    await drawSlopedRoute(routePoints);
  } else {
    const poly = L.polyline(routePoints, { color: '#4a7c59', weight: 4, opacity: 0.85 }).addTo(state.map);
    state.polylines.push(poly);
  }

  // Store the final route points so they can be saved with the entry
  state.lastRoutePoints = routePoints;

  const distMeters = totalDistance(routePoints.map(p => ({ lat: p.lat || p[0], lng: p.lng || p[1] })));
  updateStats(distMeters);

  checkLoopDetection();

  if (document.getElementById('toggle-elevation').checked && state.workerUrl) {
    fetchAndDrawElevation(routePoints);
  }
}

// Snap-to-road via OSRM, proxied through the worker to avoid CORS issues.
const OSRM_MAX_COORDS = 100;

async function fetchSnappedRoute(waypoints) {
  if (waypoints.length < 2) return waypoints;

  // Downsample if needed — worker enforces the same limit
  const pts = waypoints.length > OSRM_MAX_COORDS
    ? samplePoints(waypoints.map(p => ({ lat: p.lat, lng: p.lng })), OSRM_MAX_COORDS)
        .map(p => L.latLng(p.lat, p.lng))
    : waypoints;

  const data = await workerFetch('/osrm', 'POST', {
    waypoints: pts.map(p => ({ lat: p.lat, lng: p.lng })),
  });

  if (!data.ok || !data.points || data.points.length < 2) {
    console.warn('OSRM match failed:', data.code, data.message);
    return waypoints; // fall back to straight lines
  }

  return data.points.map(p => L.latLng(p.lat, p.lng));
}

async function drawSlopedRoute(routePoints) {
  // Sample every Nth point to avoid too many elevation API calls
  const sample = samplePoints(routePoints, 100);
  let elevations = [];

  try {
    const result = await workerFetch('/elevation', 'POST', {
      locations: sample.map(p => ({ lat: p.lat, lng: p.lng })),
    });
    elevations = result;
    state.elevationData = elevations;
  } catch(e) {
    console.warn('Elevation fetch failed:', e.message);
  }

  if (elevations.length < 2) {
    // Draw plain line
    const poly = L.polyline(routePoints, { color: '#4a7c59', weight: 4, opacity: 0.85 }).addTo(state.map);
    state.polylines.push(poly);
    return;
  }

  // Draw colored segments
  for (let i = 1; i < elevations.length; i++) {
    const a = elevations[i-1], b = elevations[i];
    const dist = haversineMeters(a, b);
    const rise  = b.elevation - a.elevation;
    const pct   = dist > 0 ? (rise / dist) * 100 : 0;
    const color = slopeColor(pct);

    const poly = L.polyline(
      [L.latLng(a.lat, a.lng), L.latLng(b.lat, b.lng)],
      { color, weight: 5, opacity: 0.9 }
    ).addTo(state.map);
    state.polylines.push(poly);
  }

  drawElevationProfile(elevations);
}

function samplePoints(points, maxCount) {
  if (points.length <= maxCount) return points.map(p => ({ lat: p.lat, lng: p.lng }));
  const step = Math.ceil(points.length / maxCount);
  const sampled = [];
  for (let i = 0; i < points.length; i += step) sampled.push({ lat: points[i].lat, lng: points[i].lng });
  if (sampled[sampled.length-1] !== points[points.length-1]) {
    sampled.push({ lat: points[points.length-1].lat, lng: points[points.length-1].lng });
  }
  return sampled;
}

async function fetchAndDrawElevation(routePoints) {
  const sample = samplePoints(routePoints, 100);
  try {
    const result = await workerFetch('/elevation', 'POST', {
      locations: sample,
    });
    state.elevationData = result;
    drawElevationProfile(result);
  } catch(e) {
    console.warn('Elevation fetch failed:', e.message);
  }
}

function computeElevStats(elevations) {
  if (!elevations || elevations.length < 2) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i < elevations.length; i++) {
    const diff = elevations[i].elevation - elevations[i-1].elevation;
    if (diff > 0) gain += diff;
    else          loss += Math.abs(diff);
  }
  const elev   = elevations.map(e => e.elevation);
  const high   = Math.max(...elev);
  const low    = Math.min(...elev);
  return {
    elevGainM:  Math.round(gain),
    elevLossM:  Math.round(loss),
    elevHighM:  Math.round(high),
    elevLowM:   Math.round(low),
  };
}

function drawElevationProfile(elevations) {
  const container = document.getElementById('elevation-profile');
  const canvas    = document.getElementById('elevation-canvas');
  if (!elevations || elevations.length < 2) { container.style.display = 'none'; return; }

  container.style.display = 'block';
  const ctx    = canvas.getContext('2d');
  const W      = canvas.offsetWidth || 400;
  const H      = 100;
  canvas.width  = W;
  canvas.height = H;

  const elev = elevations.map(e => e.elevation);
  const minE = Math.min(...elev), maxE = Math.max(...elev);
  const range = maxE - minE || 1;

  ctx.clearRect(0, 0, W, H);

  // Fill
  ctx.beginPath();
  ctx.moveTo(0, H);
  elevations.forEach((e, i) => {
    const x = (i / (elevations.length - 1)) * W;
    const y = H - ((e.elevation - minE) / range) * (H - 10) - 5;
    i === 0 ? ctx.lineTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(W, H);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(74,124,89,0.4)');
  grad.addColorStop(1, 'rgba(74,124,89,0.05)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  elevations.forEach((e, i) => {
    const x = (i / (elevations.length - 1)) * W;
    const y = H - ((e.elevation - minE) / range) * (H - 10) - 5;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#4a7c59';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Update elevation stat slots in stats bar
  const stats = computeElevStats(elevations);
  if (stats) {
    const ftGain = Math.round(stats.elevGainM * 3.28084);
    const ftHigh = Math.round(stats.elevHighM * 3.28084);
    document.getElementById('stat-elev-gain').textContent = `${ftGain} ft`;
    document.getElementById('stat-elev-high').textContent = `${ftHigh} ft`;
    document.getElementById('stat-elev-gain-item').style.display = '';
    document.getElementById('stat-elev-high-item').style.display = '';
  }
}

function updateStats(distMeters) {
  // Use actual times if available, otherwise estimate from average walking speed
  const dateStr   = document.getElementById('journey-date')?.value || '';
  const startTime = document.getElementById('journey-start-time')?.value || '';
  const endTime   = document.getElementById('journey-end-time')?.value || '';

  const actualDuration = calcDurationFromTimes(dateStr, startTime, endTime);
  const estimatedDuration = distMeters > 0
    ? (distMeters / METERS_PER_MILE) / AVG_WALK_SPEED_MPH * 60
    : null;
  const durationMin = actualDuration ?? estimatedDuration;

  // Weight: per-journey override first, then settings default
  const overrideWeight = parseFloat(document.getElementById('journey-weight')?.value || '0') || null;
  const weightLbs = overrideWeight || state.weightLbs;

  const calories = calcCalories(distMeters, durationMin, weightLbs, state.heightIn, state.ageyears, state.sex);

  document.getElementById('stat-distance').textContent  = formatDistance(distMeters);
  document.getElementById('stat-duration').textContent  = durationMin ? formatDuration(durationMin) : '—';
  document.getElementById('stat-pace').textContent      = (durationMin && distMeters > 0) ? formatPace(durationMin, distMeters) : '—';
  document.getElementById('stat-speed').textContent     = (durationMin && distMeters > 0) ? formatSpeed(durationMin, distMeters) : '—';
  document.getElementById('stat-calories').textContent  = formatCalories(calories);
}

// ─── Journey Modal ────────────────────────────────────────────────

function openJourneyModal(prefillRoute = null, isEditing = false) {
  openModal('modal-journey');

  // Clear any prior source ref
  state.prefillSourceRef = null;

  // Init map after modal is visible
  setTimeout(() => {
    initMap();
    state.map.invalidateSize();

    if (prefillRoute) {
      clearRoute();
      prefillRoute.waypoints.forEach(wp => addWaypoint(L.latLng(wp.lat, wp.lng)));
      if (state.waypoints.length > 1) {
        const bounds = L.latLngBounds(state.waypoints);
        state.map.fitBounds(bounds, { padding: [30, 30] });
      }
      // Store attribution ref if this route came from a friend's entry
      if (prefillRoute._sourceEntryId) {
        state.prefillSourceRef = {
          entryId:     prefillRoute._sourceEntryId,
          friendToken: prefillRoute._friendToken,
          username:    prefillRoute._fromUsername,
        };
      }
    }
  }, 50);

  // Set default date and times
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local  = new Date(now.getTime() - offset * 60000);
  document.getElementById('journey-date').value       = local.toISOString().slice(0, 10);
  document.getElementById('journey-start-time').value = local.toISOString().slice(11, 16);
  document.getElementById('journey-end-time').value   = '';
  if (!isEditing) state.editingId = null;
}

function clearRoute() {
  state.markers.forEach(m => state.map.removeLayer(m));
  state.markers   = [];
  state.waypoints = [];
  clearMapDrawings();
  updateStats(0);
  document.getElementById('elevation-profile').style.display      = 'none';
  document.getElementById('btn-close-loop').style.display         = 'none';
  document.getElementById('stat-elev-gain-item').style.display    = 'none';
  document.getElementById('stat-elev-high-item').style.display    = 'none';
  document.getElementById('surface-legend').style.display         = 'none';
  state.elevationData   = [];
  state.lastRoutePoints = null;
}

document.getElementById('btn-undo-waypoint').addEventListener('click', () => {
  if (state.waypoints.length === 0) return;
  state.map.removeLayer(state.markers.pop());
  state.waypoints.pop();
  updateRoute();
  checkLoopDetection();
});

document.getElementById('btn-reverse-route').addEventListener('click', () => {
  if (state.waypoints.length < 2) return;

  // Reverse both arrays
  state.waypoints.reverse();
  state.markers.reverse();

  // Re-apply icons so the start icon follows the new first waypoint
  state.markers.forEach((marker, i) => {
    const isFirst = i === 0;
    marker.setIcon(L.divIcon({
      className: isFirst ? 'waypoint-start-icon' : 'waypoint-icon',
      html: `<div></div>`,
      iconSize:   isFirst ? [14, 14] : [10, 10],
      iconAnchor: isFirst ? [7, 7]   : [5, 5],
    }));
  });

  updateRoute();
  checkLoopDetection();
});

document.getElementById('btn-close-loop').addEventListener('click', () => {
  if (state.waypoints.length < 2) return;

  // Snap last waypoint to exactly match first
  const start = state.waypoints[0];
  const lastIdx = state.waypoints.length - 1;
  state.waypoints[lastIdx] = L.latLng(start.lat, start.lng);
  state.markers[lastIdx].setLatLng(state.waypoints[lastIdx]);

  document.getElementById('btn-close-loop').style.display = 'none';
  updateRoute();
});

document.getElementById('btn-clear-route').addEventListener('click', () => {
  clearRoute();
});

// Show/hide route name input when save-route checkbox is toggled
document.getElementById('journey-save-route').addEventListener('change', function () {
  document.getElementById('route-name-group').style.display = this.checked ? 'block' : 'none';
  if (!this.checked) document.getElementById('journey-route-name').value = '';
});

// Toggle listeners
['toggle-snap','toggle-elevation','toggle-slope','toggle-surface'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    // Toggle exclusivity: slope ↔ surface (must run before updateRoute)
    if (id === 'toggle-slope' && document.getElementById('toggle-slope').checked) {
      document.getElementById('toggle-surface').checked = false;
    }
    if (id === 'toggle-surface' && document.getElementById('toggle-surface').checked) {
      document.getElementById('toggle-slope').checked = false;
    }

    if (state.waypoints.length >= 2) updateRoute();

    if (id === 'toggle-elevation' && !document.getElementById(id).checked) {
      document.getElementById('elevation-profile').style.display = 'none';
    }

    // Legend switching
    const slopeOn   = document.getElementById('toggle-slope').checked;
    const surfaceOn = document.getElementById('toggle-surface').checked;
    const legendEl  = document.getElementById('slope-legend');
    const surfLegEl = document.getElementById('surface-legend');
    legendEl.style.opacity  = slopeOn   ? '1' : '0.3';
    legendEl.style.display  = surfaceOn ? 'none' : '';
    surfLegEl.style.display = surfaceOn ? '' : 'none';
  });
});

// Disable/enable toggles that require the worker based on whether a URL is set.
// Called on page load and whenever settings are saved.
function updateWorkerDependentToggles() {
  const hasWorker = !!state.workerUrl && !Auth.isGuest();
  const workerToggles = ['toggle-snap', 'toggle-elevation', 'toggle-slope', 'toggle-surface'];

  workerToggles.forEach(id => {
    const checkbox = document.getElementById(id);
    const pill     = checkbox.closest('.toggle-pill');

    if (!hasWorker) {
      checkbox.disabled = true;
      checkbox.checked  = false;
      pill.classList.add('toggle-disabled');
      pill.title = 'Enter a Worker URL in Settings to enable this feature';
    } else {
      checkbox.disabled = false;
      pill.classList.remove('toggle-disabled');
      pill.title = '';
      // Restore snap and slope to checked by default when worker becomes available
      if (id === 'toggle-snap' || id === 'toggle-slope') checkbox.checked = true;
    }
  });

  // Also update slope legend opacity to match slope toggle state
  const slopeChecked = document.getElementById('toggle-slope').checked;
  document.getElementById('slope-legend').style.opacity = slopeChecked ? '1' : '0.3';
}

// Recalculate stats when time fields or weight override change
['journey-start-time', 'journey-end-time', 'journey-weight'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', () => {
    const pts = state.lastRoutePoints || state.waypoints;
    const distMeters = pts.length >= 2
      ? totalDistance(pts.map(p => ({ lat: p.lat, lng: p.lng })))
      : 0;
    updateStats(distMeters);
  });
});

// Map search
document.getElementById('btn-map-search').addEventListener('click', () => doMapSearch());
document.getElementById('map-search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doMapSearch();
});

async function doMapSearch() {
  const q = document.getElementById('map-search-input').value.trim();
  if (!q) return;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`);
    const data = await res.json();
    if (data[0]) {
      state.map.setView([parseFloat(data[0].lat), parseFloat(data[0].lon)], 15);
    } else {
      showToast('Location not found');
    }
  } catch(e) {
    showToast('Search failed');
  }
}

// Export GPX
document.getElementById('btn-export-gpx').addEventListener('click', () => {
  if (state.waypoints.length < 2) { showToast('Add at least 2 waypoints first'); return; }
  const gpx = buildGPX(state.waypoints, document.getElementById('journey-name').value || 'Walk');
  downloadFile(gpx, 'walk.gpx', 'application/gpx+xml');
});

function buildGPX(waypoints, name) {
  const pts = waypoints.map(p =>
    `  <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"></trkpt>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Route &amp; Reason">
  <trk><name>${escapeXml(name)}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
}

function downloadFile(content, filename, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  a.click();
}

// Save Journey
document.getElementById('btn-save-journey').addEventListener('click', async () => {
  const name      = document.getElementById('journey-name').value.trim() || 'Untitled Walk';
  const dateStr   = document.getElementById('journey-date').value;
  const startTime = document.getElementById('journey-start-time').value;
  const endTime   = document.getElementById('journey-end-time').value;

  // Build ISO datetime from date + start time
  const datetime = (dateStr && startTime)
    ? new Date(`${dateStr}T${startTime}`).toISOString()
    : new Date().toISOString();

  // Use snapped route points for distance if available — they follow actual roads
  // and are far more accurate than straight lines between raw click waypoints.
  const routePts   = state.lastRoutePoints || state.waypoints;
  const distMeters = totalDistance(routePts.map(p => ({ lat: p.lat, lng: p.lng })));

  // Duration: from actual times if available, else estimate
  const actualDuration    = calcDurationFromTimes(dateStr, startTime, endTime);
  const estimatedDuration = distMeters > 0
    ? (distMeters / METERS_PER_MILE) / AVG_WALK_SPEED_MPH * 60
    : 0;
  const durationMin = actualDuration ?? estimatedDuration;

  // Calories
  const overrideWeight = parseFloat(document.getElementById('journey-weight').value || '0') || null;
  const weightLbs      = overrideWeight || state.weightLbs;
  const calories       = calcCalories(distMeters, durationMin, weightLbs, state.heightIn, state.ageyears, state.sex);

  const entry = {
    id:           state.editingId || crypto.randomUUID(),
    type:         'journey',
    name,
    datetime,
    date:         dateStr,
    startTime,
    endTime,
    waypoints:    state.waypoints.map(p => ({ lat: p.lat, lng: p.lng })),
    routePoints:  state.lastRoutePoints ? state.lastRoutePoints.map(p => ({ lat: p.lat, lng: p.lng })) : null,
    distMeters,
    durationMin,
    calories,
    weightLbs:    weightLbs || null,
    mood:         document.getElementById('journey-mood').value,
    energyStart:  document.getElementById('journey-energy-start').value,
    energyEnd:    document.getElementById('journey-energy-end').value,
    weather:      document.getElementById('journey-weather').value,
    temp:         document.getElementById('journey-temp').value,
    companions:   document.getElementById('journey-companions').value.trim(),
    notes:        document.getElementById('journey-notes').value.trim(),
    visibility:   document.getElementById('journey-visibility').value,
    // Social stub
    userId:       state.token,
    connections:  [],
    // Route attribution
    _sourceRouteRef: state.prefillSourceRef || null,
    // Elevation stats (populated below if elevation data is available)
    elevGainM: null,
    elevLossM: null,
    elevHighM: null,
    elevLowM:  null,
    // Mentions — resolved below
    mentions: [],
  };

  // Compute and attach elevation stats if available
  if (state.elevationData && state.elevationData.length >= 2) {
    const es = computeElevStats(state.elevationData);
    if (es) {
      entry.elevGainM = es.elevGainM;
      entry.elevLossM = es.elevLossM;
      entry.elevHighM = es.elevHighM;
      entry.elevLowM  = es.elevLowM;
    }
  }

  // Resolve @mentions and store them on the entry
  const mentionedNames = parseMentions(entry.notes);
  if (mentionedNames.length && state.workerUrl) {
    const resolved = await Promise.all(
      mentionedNames.map(async uname => {
        const cached = state.mentionCache[uname];
        if (cached) return cached.found ? { username: uname, token: cached.token } : null;
        try {
          const result = await lookupUsername(uname);
          if (result) {
            state.mentionCache[uname] = { token: result.token, found: true };
            return { username: result.username, token: result.token };
          }
        } catch(e) {}
        return null;
      })
    );
    entry.mentions = resolved.filter(Boolean);
  }

  // Save route if requested
  if (document.getElementById('journey-save-route').checked && state.waypoints.length >= 2) {
    const routeNameRaw = document.getElementById('journey-route-name').value.trim();
    const routeName    = routeNameRaw || `Route ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    const route = {
      id:        crypto.randomUUID(),
      name:      routeName,
      waypoints: entry.waypoints,
      distMeters,
      createdAt: new Date().toISOString(),
    };
    await saveRoute(route);
    renderSavedRoutes();
  renderElevationRecords();
  renderGoalsWidget();
  }

  await saveEntry(entry);

  // Send mention notifications (fire and forget — don't block UI)
  if (entry.mentions && entry.mentions.length) {
    const preview = (entry.name ? entry.name + ': ' : '') + (entry.notes || '').slice(0, 120);
    for (const m of entry.mentions) {
      if (m.token !== state.token) {
        sendMentionNotification(m.token, entry.id, preview);
        // If this is a journey with a route, also send a mutual walk prompt
        if (entry.type === 'journey' && entry.waypoints && entry.waypoints.length >= 2) {
          sendMutualWalkNotification(m.token, entry);
        }
      }
    }
  }

  renderFeed();
  renderSpotlight();
  closeModal('modal-journey');
  showToast('Journey saved ✓');
  resetJourneyForm();
});

function resetJourneyForm() {
  document.getElementById('journey-name').value         = '';
  document.getElementById('journey-date').value         = '';
  document.getElementById('journey-start-time').value   = '';
  document.getElementById('journey-end-time').value     = '';
  document.getElementById('journey-mood').value         = '';
  document.getElementById('journey-energy-start').value = '';
  document.getElementById('journey-energy-end').value   = '';
  document.getElementById('journey-weather').value      = '';
  document.getElementById('journey-temp').value         = '';
  document.getElementById('journey-companions').value   = '';
  document.getElementById('journey-notes').value        = '';
  document.getElementById('journey-weight').value       = '';
  document.getElementById('journey-save-route').checked = false;
  document.getElementById('journey-route-name').value   = '';
  document.getElementById('route-name-group').style.display = 'none';
  state.prefillSourceRef = null;
  clearRoute();
}

// ─── Journal Entry Modal ──────────────────────────────────────────

document.getElementById('btn-new-entry').addEventListener('click', () => {
  openModal('modal-entry');
  document.getElementById('entry-datetime').value = nowLocalISO();
  state.editingId = null;
});

document.getElementById('btn-switch-to-journey').addEventListener('click', () => {
  closeModal('modal-entry');
  openJourneyModal();
});

document.getElementById('btn-save-entry').addEventListener('click', async () => {
  const notes = document.getElementById('entry-notes').value.trim();
  if (!notes) { showToast('Please write something first'); return; }

  const entry = {
    id:         state.editingId || crypto.randomUUID(),
    type:       'journal',
    name:       'Journal Entry',
    datetime:   document.getElementById('entry-datetime').value || new Date().toISOString(),
    mood:       document.getElementById('entry-mood').value,
    energy:     document.getElementById('entry-energy').value,
    weather:    document.getElementById('entry-weather').value,
    notes,
    visibility: document.getElementById('entry-visibility').value,
    userId:     state.token,
    connections: [],
  };

  await saveEntry(entry);
  renderFeed();
  renderSpotlight();
  closeModal('modal-entry');
  showToast('Entry saved ✓');
  resetEntryForm();
});

function resetEntryForm() {
  document.getElementById('entry-datetime').value = '';
  document.getElementById('entry-mood').value     = '';
  document.getElementById('entry-energy').value   = '';
  document.getElementById('entry-weather').value  = '';
  document.getElementById('entry-notes').value    = '';
}

// ─── Header Buttons ───────────────────────────────────────────────

document.getElementById('btn-new-journey').addEventListener('click', () => openJourneyModal());
document.getElementById('btn-settings').addEventListener('click', () => {
  // Always re-populate from current state so username and profile
  // fields reflect any data pulled from KV since page load
  populateSettingsModal();
  openModal('modal-settings');
});

// ─── Discover Modal ───────────────────────────────────────────────

document.getElementById('btn-discover').addEventListener('click', () => {
  openModal('modal-discover');
});

document.querySelector('#modal-discover [data-close]').addEventListener('click', () => {
  closeModal('modal-discover');
  if (state.discoverMap) { state.discoverMap.remove(); state.discoverMap = null; }
});

document.getElementById('btn-discover-search').addEventListener('click', () => {
  const q = document.getElementById('discover-location').value.trim();
  if (!q) return;
  searchDiscoverByLocation(q);
});

document.getElementById('discover-location').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-discover-search').click();
});

document.getElementById('btn-discover-near-me').addEventListener('click', () => {
  if (!navigator.geolocation) { showToast('Geolocation not supported'); return; }
  navigator.geolocation.getCurrentPosition(
    pos => fetchPublicRoutes(pos.coords.latitude, pos.coords.longitude, 0.5),
    ()  => showToast('Could not get your location')
  );
});

async function searchDiscoverByLocation(query) {
  const btn = document.getElementById('btn-discover-search');
  btn.disabled = true;
  btn.textContent = 'Searching…';
  try {
    const res  = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`);
    const data = await res.json();
    if (!data[0]) { showToast('Location not found'); return; }
    await fetchPublicRoutes(parseFloat(data[0].lat), parseFloat(data[0].lon), 0.5);
  } catch(e) {
    showToast('Search failed');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search';
  }
}

async function fetchPublicRoutes(lat, lng, radiusDeg = 0.5) {
  if (!state.workerUrl) { showToast('Worker URL required for route discovery'); return; }

  const resultsEl = document.getElementById('discover-results');
  resultsEl.innerHTML = '<div class="widget-empty">Loading…</div>';

  const bbox = `${lat - radiusDeg},${lng - radiusDeg},${lat + radiusDeg},${lng + radiusDeg}`;
  try {
    const url  = state.workerUrl.replace(/\/$/, '') + `/public/entries?bbox=${encodeURIComponent(bbox)}`;
    const res  = await fetch(url);
    const data = await res.json();
    renderDiscoverResults(data.entries || [], lat, lng);
  } catch(e) {
    resultsEl.innerHTML = '<div class="widget-empty">Failed to load routes. Check your Worker URL in settings.</div>';
  }
}

function renderDiscoverResults(entries, centerLat, centerLng) {
  const resultsEl = document.getElementById('discover-results');
  const mapEl     = document.getElementById('discover-map');

  if (entries.length === 0) {
    mapEl.style.display = 'none';
    resultsEl.innerHTML = '<div class="widget-empty">No public routes found in this area.</div>';
    return;
  }

  // Init or reuse discover map
  mapEl.style.display = 'block';
  setTimeout(() => {
    if (state.discoverMap) { state.discoverMap.remove(); state.discoverMap = null; }
    const dmap = L.map('discover-map', { zoomControl: true, scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 19,
    }).addTo(dmap);

    const allPoints = [];
    entries.forEach((entry, i) => {
      if (entry.waypoints && entry.waypoints.length >= 2) {
        const latlngs = entry.waypoints.map(w => L.latLng(w.lat, w.lng));
        L.polyline(latlngs, { color: '#4a7c59', weight: 3, opacity: 0.7 }).addTo(dmap);
        allPoints.push(...latlngs);
      }
    });

    if (allPoints.length > 0) {
      dmap.fitBounds(L.latLngBounds(allPoints), { padding: [20, 20] });
    } else {
      dmap.setView([centerLat, centerLng], 13);
    }
    state.discoverMap = dmap;
  }, 50);

  // Results list
  resultsEl.innerHTML = entries.map(entry => `
    <div class="discover-result-item">
      <div class="discover-result-info">
        <div class="discover-result-name">${escapeHtml(entry.name || 'Untitled Route')}</div>
        <div class="discover-result-meta">
          by @${escapeHtml(entry.username)} · ${formatDistance(entry.distMeters)} · ${formatDate(entry.datetime)}
        </div>
      </div>
      <div class="discover-result-actions">
        ${entry.waypoints && entry.waypoints.length >= 2
          ? `<button class="btn-load-route btn-use-public-route" data-id="${escapeHtml(entry.id)}" data-username="${escapeHtml(entry.username)}">Use Route</button>`
          : ''}
      </div>
    </div>
  `).join('');

  // Wire up Use Route buttons
  resultsEl.querySelectorAll('.btn-use-public-route').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = entries.find(e => e.id === btn.dataset.id);
      if (!entry || !entry.waypoints) return;
      closeModal('modal-discover');
      if (state.discoverMap) { state.discoverMap.remove(); state.discoverMap = null; }
      openJourneyModal({
        waypoints:      entry.waypoints,
        distMeters:     entry.distMeters,
        _sourceEntryId: entry.id,
        _fromUsername:  entry.username,
        _friendToken:   entry.token,
      });
    });
  });
}

// ─── Feed Rendering ───────────────────────────────────────────────

function filteredEntries() {
  const f = state.filterType;
  // Merge own entries with friend entries
  const own = f === 'all' ? state.entries : state.entries.filter(e => e.type === f);
  const friend = f === 'journal' ? [] : state.friendEntries; // journals not shown from friends unless all
  const merged = [...own, ...friend]
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
  return merged;
}

function renderFeed() {
  const feed   = document.getElementById('entry-feed');
  const empty  = document.getElementById('feed-empty');
  const pager  = document.getElementById('pagination');
  const all    = filteredEntries();

  if (all.length === 0) {
    feed.innerHTML = '';
    if (empty) {
      empty.style.display = 'block';
      feed.appendChild(empty);
    }
    pager.innerHTML = '';
    return;
  }

  // Re-fetch empty element since it may have been moved into feed by a prior call
  const emptyEl = document.getElementById('feed-empty');
  if (emptyEl) emptyEl.style.display = 'none';

  const totalPages = Math.ceil(all.length / state.pageSize);
  if (state.currentPage > totalPages) state.currentPage = Math.max(1, totalPages);

  const start   = (state.currentPage - 1) * state.pageSize;
  const pageItems = all.slice(start, start + state.pageSize);

  feed.innerHTML = '';
  pageItems.forEach((entry, i) => {
    const card = buildEntryCard(entry, i);
    feed.appendChild(card);
  });

  renderPagination(totalPages);
}

function buildEntryCard(entry, animIdx) {
  const isFriend = !!entry._isFriend;
  const card = document.createElement('div');
  card.className = `entry-card type-${isFriend ? 'friend' : entry.type}`;
  card.style.animationDelay = `${animIdx * 0.04}s`;

  const title = entry.type === 'journey'
    ? (entry.name || 'Untitled Walk')
    : 'Journal Entry';

  const tags = [];
  if (isFriend) {
    tags.push(`<span class="tag tag-friend">👤 ${escapeHtml(entry._friendUsername)}</span>`);
  }
  tags.push(`<span class="tag tag-${entry.type}">${entry.type === 'journey' ? '🥾 Journey' : '✍️ Journal'}</span>`);
  if (entry.mood)        tags.push(`<span class="tag tag-mood">${moodLabel(entry.mood)}</span>`);
  if (entry.energyStart) tags.push(`<span class="tag tag-mood">${energyLabel(entry.energyStart)}</span>`);
  if (!entry.energyStart && entry.energy) tags.push(`<span class="tag tag-mood">${energyLabel(entry.energy)}</span>`);
  if (entry.weather)     tags.push(`<span class="tag tag-weather">${weatherLabel(entry.weather)}</span>`);
  if (entry.distMeters > 0) tags.push(`<span class="tag tag-distance">${formatDistance(entry.distMeters)}</span>`);
  if (entry.visibility === 'public') tags.push(`<span class="tag tag-public">🌍 Public</span>`);

  const newDot = (entry._isNew && isFriend) ? '<span class="entry-new-dot" title="New"></span>' : '';
  const pendingBadge = (!entry._isFriend && isQueued(entry.id))
    ? '<div class="sync-pending-badge">⏳ Pending sync</div>'
    : '';

  card.innerHTML = `
    <div class="entry-card-header">
      <div class="entry-card-title">${escapeHtml(title)}${newDot}</div>
      <div class="entry-card-date">${formatDate(entry.datetime)}</div>
    </div>
    <div class="entry-card-meta">${tags.join('')}</div>
    ${entry.notes ? `<div class="entry-card-excerpt">${escapeHtml(entry.notes)}</div>` : ''}
    ${pendingBadge}
  `;

  card.addEventListener('click', () => openViewModal(entry));
  return card;
}

function buildMentionCard(mention, animIdx) {
  const card = document.createElement('div');
  card.className = 'entry-card type-mention';
  card.style.animationDelay = `${animIdx * 0.04}s`;
  card.innerHTML = `
    <div class="entry-card-header">
      <div class="entry-card-title">Mentioned by @${escapeHtml(mention.fromUsername)}</div>
      <div class="entry-card-date">${formatDate(mention.createdAt)}</div>
    </div>
    <div class="entry-card-meta">
      <span class="tag tag-mention-feed">💬 Mention</span>
    </div>
    ${mention.preview ? `<div class="entry-card-excerpt">${escapeHtml(mention.preview)}</div>` : ''}
  `;
  return card;
}

function buildMutualWalkCard(entry, animIdx) {
  const card = document.createElement('div');
  card.className = 'entry-card type-mutualwalk';
  card.style.animationDelay = `${animIdx * 0.04}s`;

  const hasRoute = entry.waypoints && entry.waypoints.length >= 2;
  const name     = entry.entryName || 'a walk';

  card.innerHTML = `
    <div class="entry-card-header">
      <div class="entry-card-title">🚶 Walk with @${escapeHtml(entry.fromUsername)}</div>
      <div class="entry-card-date">${formatDate(entry.createdAt)}</div>
    </div>
    <div class="entry-card-meta">
      <span class="tag tag-mutualwalk">👣 Mutual Walk</span>
    </div>
    <div class="entry-card-excerpt">@${escapeHtml(entry.fromUsername)} logged "${escapeHtml(name)}" — a walk you were part of.</div>
    ${hasRoute ? `<div class="mutualwalk-actions"><button class="btn btn-sm btn-primary mutualwalk-log-btn">Log my version</button></div>` : ''}
  `;

  if (hasRoute) {
    card.querySelector('.mutualwalk-log-btn').addEventListener('click', e => {
      e.stopPropagation();
      openJourneyModal({
        waypoints:      entry.waypoints,
        _sourceEntryId: entry.entryId,
        _fromUsername:  entry.fromUsername,
        _friendToken:   entry.fromToken,
      });
    });
  }

  return card;
}

function moodLabel(v) {
  return { excellent:'😄 Excellent', good:'🙂 Good', neutral:'😐 Neutral', low:'😔 Low', rough:'😞 Rough' }[v] || v;
}

function weatherLabel(v) {
  const m = {
    'sunny':'☀️ Sunny','partly-cloudy':'⛅ Partly cloudy','cloudy':'☁️ Cloudy',
    'overcast':'🌥️ Overcast','light-rain':'🌦️ Light rain','rain':'🌧️ Rain',
    'thunderstorm':'⛈️ Storm','snow':'❄️ Snow','foggy':'🌫️ Foggy',
    'windy':'💨 Windy','hot':'🌡️ Hot','cold':'🥶 Cold',
  };
  return m[v] || v;
}

function energyLabel(v) {
  return { strong:'⚡ Strong', good:'✅ Good', moderate:'〰️ Moderate', tired:'🥱 Tired', exhausted:'😮‍💨 Exhausted' }[v] || v;
}

function escapeHtml(s) {
  return String(s || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
}

function renderPagination(totalPages) {
  const pager = document.getElementById('pagination');
  pager.innerHTML = '';
  if (totalPages <= 1) return;

  const prev = document.createElement('button');
  prev.className = 'page-btn';
  prev.textContent = '←';
  prev.disabled = state.currentPage === 1;
  prev.addEventListener('click', () => { state.currentPage--; renderFeed(); window.scrollTo(0,0); });
  pager.appendChild(prev);

  const maxButtons = 7;
  let start = Math.max(1, state.currentPage - 3);
  let end   = Math.min(totalPages, start + maxButtons - 1);
  if (end - start < maxButtons - 1) start = Math.max(1, end - maxButtons + 1);

  for (let p = start; p <= end; p++) {
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (p === state.currentPage ? ' active' : '');
    btn.textContent = p;
    const pg = p;
    btn.addEventListener('click', () => { state.currentPage = pg; renderFeed(); window.scrollTo(0,0); });
    pager.appendChild(btn);
  }

  const next = document.createElement('button');
  next.className = 'page-btn';
  next.textContent = '→';
  next.disabled = state.currentPage === totalPages;
  next.addEventListener('click', () => { state.currentPage++; renderFeed(); window.scrollTo(0,0); });
  pager.appendChild(next);
}

// Filter
document.getElementById('filter-type').addEventListener('change', e => {
  state.filterType  = e.target.value;
  state.currentPage = 1;
  renderFeed();
});

// ─── Spotlight ────────────────────────────────────────────────────

function renderSpotlight() {
  const el = document.getElementById('spotlight-content');
  if (state.entries.length === 0) {
    el.innerHTML = '<div class="spotlight-empty">Your past journeys will appear here as a daily highlight.</div>';
    return;
  }

  // Pick a deterministic-random entry based on today's date
  const today = new Date().toDateString();
  let seed = 0;
  for (const c of today) seed = (seed * 31 + c.charCodeAt(0)) & 0xffffffff;
  const idx = Math.abs(seed) % state.entries.length;
  const entry = state.entries[idx];

  const title = entry.type === 'journey' ? (entry.name || 'Untitled Walk') : 'Journal Entry';
  const meta  = [
    formatDate(entry.datetime),
    entry.distMeters > 0 ? formatDistance(entry.distMeters) : null,
    entry.mood ? moodLabel(entry.mood) : null,
  ].filter(Boolean).join(' · ');

  el.innerHTML = `
    <div class="spotlight-entry-name">${escapeHtml(title)}</div>
    <div class="spotlight-entry-meta">${escapeHtml(meta)}</div>
    ${entry.notes ? `<div class="spotlight-entry-excerpt">${escapeHtml(entry.notes)}</div>` : ''}
  `;

  el.style.cursor = 'pointer';
  el.onclick = () => openViewModal(entry);
}

// ─── View Entry Modal ─────────────────────────────────────────────

function openViewModal(entry) {
  document.getElementById('view-title').textContent =
    entry.type === 'journey' ? (entry.name || 'Untitled Walk') : 'Journal Entry';

  const body = document.getElementById('view-body');

  const tags = [];
  if (entry.mood)        tags.push(`<span class="tag tag-mood">${moodLabel(entry.mood)}</span>`);
  if (entry.energyStart) tags.push(`<span class="tag tag-mood">Start: ${energyLabel(entry.energyStart)}</span>`);
  if (entry.energyEnd)   tags.push(`<span class="tag tag-mood">End: ${energyLabel(entry.energyEnd)}</span>`);
  // backwards-compat: old entries may have entry.energy
  if (!entry.energyStart && entry.energy) tags.push(`<span class="tag tag-mood">${energyLabel(entry.energy)}</span>`);
  if (entry.weather)     tags.push(`<span class="tag tag-weather">${weatherLabel(entry.weather)}</span>`);
  if (entry.temp)        tags.push(`<span class="tag tag-weather">${entry.temp}°F</span>`);
  if (entry.companions)  tags.push(`<span class="tag tag-journey">With ${escapeHtml(entry.companions)}</span>`);
  if (entry._sourceRouteRef?.username) tags.push(`<span class="tag tag-route-ref">Route by @${escapeHtml(entry._sourceRouteRef.username)}</span>`);

  let statsHtml = '';
  if (entry.type === 'journey' && entry.distMeters > 0) {
    statsHtml = `
      <div class="view-stats-grid">
        <div><div class="view-stat-value">${formatDistance(entry.distMeters)}</div><div class="view-stat-label">Distance</div></div>
        <div><div class="view-stat-value">${formatDuration(entry.durationMin)}</div><div class="view-stat-label">Duration</div></div>
        <div><div class="view-stat-value">${formatPace(entry.durationMin, entry.distMeters)}</div><div class="view-stat-label">Pace</div></div>
        <div><div class="view-stat-value">${formatSpeed(entry.durationMin, entry.distMeters)}</div><div class="view-stat-label">Speed</div></div>
        <div><div class="view-stat-value">${formatCalories(entry.calories ?? null)}</div><div class="view-stat-label">Calories</div></div>
      </div>
    `;
  }

  let mapHtml = '';
  const mapPoints = entry.routePoints || entry.waypoints;
  if (entry.type === 'journey' && mapPoints && mapPoints.length >= 2) {
    mapHtml = `<div id="view-map"></div>`;
  }

  // Route attribution count
  let attributionHtml = '';
  if (entry.type === 'journey' && mapPoints && mapPoints.length >= 2) {
    const allEntries = [...state.entries, ...state.friendEntries];
    const walkerCount = allEntries.filter(
      e => e._sourceRouteRef && e._sourceRouteRef.entryId === entry.id && e.id !== entry.id
    ).length;
    if (walkerCount > 0) {
      attributionHtml = `
        <div class="route-walked-by">
          🥾 ${walkerCount} ${walkerCount === 1 ? 'person has' : 'people have'} walked this route
        </div>
      `;
    }
  }

  body.innerHTML = `
    <div class="view-entry-meta">
      <span class="tag tag-${entry.type}">${formatDateTime(entry.datetime)}</span>
      ${tags.join('')}
    </div>
    ${statsHtml}
    ${attributionHtml}
    ${mapHtml}
    ${entry.notes ? `<div class="view-notes">${escapeHtml(entry.notes)}</div>` : ''}
  `;

  // Render view map
  if (mapHtml) {
    setTimeout(() => {
      if (state.viewMap) { state.viewMap.remove(); state.viewMap = null; }
      const vmap = L.map('view-map', { zoomControl: true, scrollWheelZoom: false });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        maxZoom: 19,
      }).addTo(vmap);
      const latlngs = (entry.routePoints || entry.waypoints).map(w => L.latLng(w.lat, w.lng));
      L.polyline(latlngs, { color: '#4a7c59', weight: 4, opacity: 0.85 }).addTo(vmap);
      const bounds = L.latLngBounds(latlngs);
      vmap.fitBounds(bounds, { padding: [20,20] });
      state.viewMap = vmap;
    }, 50);
  }

  document.getElementById('btn-edit-entry').onclick = () => {
    closeModal('modal-view');
    editEntry(entry);
  };

  // Use Route button — shown for any journey with waypoints (own or friend's)
  const useRouteBtn = document.getElementById('btn-use-route');
  const bookmarkBtn = document.getElementById('btn-bookmark-route');
  const hasRoute    = entry.type === 'journey' && entry.waypoints && entry.waypoints.length >= 2;

  if (hasRoute) {
    useRouteBtn.style.display = '';
    useRouteBtn.onclick = () => {
      closeModal('modal-view');
      if (state.viewMap) { state.viewMap.remove(); state.viewMap = null; }
      openJourneyModal({
        waypoints:      entry.waypoints,
        distMeters:     entry.distMeters,
        _sourceEntryId: entry._isFriend ? entry.id : null,
        _friendToken:   entry._isFriend ? entry._friendToken : null,
        _fromUsername:  entry._isFriend ? entry._friendUsername : null,
      });
    };
  } else {
    useRouteBtn.style.display = 'none';
  }

  // Bookmark button — only for friend entries with a route
  if (hasRoute && entry._isFriend) {
    const alreadyBookmarked = state.savedRoutes.some(
      r => r._sourceEntryId === entry.id
    );
    bookmarkBtn.style.display = '';
    bookmarkBtn.textContent   = alreadyBookmarked ? 'Bookmarked ✓' : 'Bookmark';
    bookmarkBtn.disabled      = alreadyBookmarked;
    bookmarkBtn.onclick = async () => {
      const routeName = entry.name
        ? `${entry.name} (@${entry._friendUsername})`
        : `Route by @${entry._friendUsername}`;
      const route = {
        id:             crypto.randomUUID(),
        name:           routeName,
        waypoints:      entry.waypoints,
        distMeters:     entry.distMeters,
        createdAt:      new Date().toISOString(),
        _bookmarked:    true,
        _fromUsername:  entry._friendUsername,
        _sourceEntryId: entry.id,
      };
      await saveRoute(route);
      renderSavedRoutes();
  renderElevationRecords();
  renderGoalsWidget();
      bookmarkBtn.textContent = 'Bookmarked ✓';
      bookmarkBtn.disabled    = true;
      showToast(`Route bookmarked ✓`);
    };
  } else {
    bookmarkBtn.style.display = 'none';
  }

  // Add delete button to modal header
  const headerActions = document.querySelector('#modal-view .modal-header-actions');
  let deleteBtn = document.getElementById('btn-delete-entry');
  if (!deleteBtn) {
    deleteBtn = document.createElement('button');
    deleteBtn.id = 'btn-delete-entry';
    deleteBtn.className = 'btn-delete';
    deleteBtn.textContent = 'Delete';
    headerActions.insertBefore(deleteBtn, document.getElementById('btn-edit-entry'));
  }
  deleteBtn.onclick = () => promptDeleteModal(entry);

  openModal('modal-view');
}

document.getElementById('modal-view').querySelector('[data-close]').addEventListener('click', () => {
  if (state.viewMap) { state.viewMap.remove(); state.viewMap = null; }
});

// ─── Delete Modal ─────────────────────────────────────────────────

function promptDeleteModal(entry) {
  const title = entry.type === 'journey' ? (entry.name || 'Untitled Walk') : 'this journal entry';
  document.getElementById('delete-message').textContent =
    `Are you sure you want to delete "${title}"?`;

  const btn    = document.getElementById('btn-confirm-delete');
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);

  newBtn.addEventListener('click', async () => {
    newBtn.disabled = true;
    newBtn.textContent = 'Deleting…';
    await deleteEntry(entry.id);
    closeModal('modal-delete');
    closeModal('modal-view');
    if (state.viewMap) { state.viewMap.remove(); state.viewMap = null; }
    renderFeed();
    renderSpotlight();
    showToast('Entry deleted');
  });

  openModal('modal-delete');
}

function editEntry(entry) {
  state.editingId = entry.id;
  if (entry.type === 'journey') {
    openJourneyModal(null, true);
    setTimeout(() => {
      document.getElementById('journey-name').value         = entry.name || '';
      document.getElementById('journey-date').value         = entry.date || entry.datetime?.slice(0,10) || '';
      document.getElementById('journey-start-time').value   = entry.startTime || entry.datetime?.slice(11,16) || '';
      document.getElementById('journey-end-time').value     = entry.endTime || '';
      document.getElementById('journey-mood').value         = entry.mood || '';
      document.getElementById('journey-energy-start').value = entry.energyStart || entry.energy || '';
      document.getElementById('journey-energy-end').value   = entry.energyEnd || '';
      document.getElementById('journey-weather').value      = entry.weather || '';
      document.getElementById('journey-temp').value         = entry.temp || '';
      document.getElementById('journey-companions').value   = entry.companions || '';
      document.getElementById('journey-notes').value        = entry.notes || '';
      document.getElementById('journey-weight').value       = entry.weightLbs || '';
      document.getElementById('journey-visibility').value   = entry.visibility || 'private';
      if (entry.waypoints && entry.waypoints.length > 0) {
        // Suppress snap/draw while loading waypoints one by one
        state.suppressRouteUpdate = true;
        entry.waypoints.forEach(wp => addWaypoint(L.latLng(wp.lat, wp.lng)));
        state.suppressRouteUpdate = false;

        // Restore the saved snapped route if available, otherwise redraw from waypoints
        if (entry.routePoints && entry.routePoints.length >= 2) {
          clearMapDrawings();
          const pts = entry.routePoints.map(p => L.latLng(p.lat, p.lng));
          state.lastRoutePoints = pts;
          const slope   = document.getElementById('toggle-slope').checked;
          const surface = document.getElementById('toggle-surface').checked;
          if (surface && state.workerUrl) {
            fetchAndDrawSurface(pts);
          } else if (slope && state.workerUrl && state.elevationData?.length >= 2) {
            drawSlopedRoute(pts);
          } else {
            const poly = L.polyline(pts, { color: '#4a7c59', weight: 4, opacity: 0.85 }).addTo(state.map);
            state.polylines.push(poly);
          }
          const distMeters = totalDistance(entry.routePoints);
          updateStats(distMeters);
        } else {
          // No saved route points — redraw fresh (will re-snap)
          updateRoute();
        }

        const bounds = L.latLngBounds(state.waypoints);
        state.map.fitBounds(bounds, { padding: [30,30] });
      }
    }, 100);
  } else {
    openModal('modal-entry');
    document.getElementById('entry-datetime').value = entry.datetime?.slice(0,16) || '';
    document.getElementById('entry-mood').value     = entry.mood || '';
    document.getElementById('entry-energy').value   = entry.energy || '';
    document.getElementById('entry-weather').value  = entry.weather || '';
    document.getElementById('entry-notes').value    = entry.notes || '';
    document.getElementById('entry-visibility').value = entry.visibility || 'private';
  }
}

// ─── Walk Goals ───────────────────────────────────────────────────

function loadGoals() {
  const raw = localStorage.getItem('wj_goals');
  if (raw) {
    try { state.goals = JSON.parse(raw); } catch(e) { state.goals = {}; }
  }
}

function saveGoals() {
  localStorage.setItem('wj_goals', JSON.stringify(state.goals));
}

function getThisWeekJourneys() {
  const now   = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay()); // Sunday
  start.setHours(0, 0, 0, 0);
  return state.entries.filter(e =>
    e.type === 'journey' && new Date(e.datetime) >= start
  );
}

function renderGoalsWidget() {
  const el        = document.getElementById('goals-display');
  const goalMiles = parseFloat(state.goals?.miles) || 0;
  const goalWalks = parseInt(state.goals?.walks)   || 0;

  if (!goalMiles && !goalWalks) {
    el.innerHTML = '<div class="widget-empty">Tap Edit to set a weekly goal.</div>';
    return;
  }

  const week       = getThisWeekJourneys();
  const doneMiles  = week.reduce((s, e) => s + (e.distMeters || 0), 0) / METERS_PER_MILE;
  const doneWalks  = week.length;

  let html = '';

  if (goalMiles) {
    const pct      = Math.min(doneMiles / goalMiles * 100, 100);
    const complete = doneMiles >= goalMiles;
    html += `
      <div class="goal-item">
        <div class="goal-item-header">
          <span class="goal-item-label">Miles this week</span>
          <span class="goal-item-value">${doneMiles.toFixed(1)} / ${goalMiles} mi</span>
        </div>
        <div class="goal-bar-track">
          <div class="goal-bar-fill${complete ? ' complete' : ''}" style="width:${pct}%"></div>
        </div>
        ${complete ? '<div class="goal-complete-badge">✓ Goal reached!</div>' : ''}
      </div>`;
  }

  if (goalWalks) {
    const pct      = Math.min(doneWalks / goalWalks * 100, 100);
    const complete = doneWalks >= goalWalks;
    html += `
      <div class="goal-item">
        <div class="goal-item-header">
          <span class="goal-item-label">Walks this week</span>
          <span class="goal-item-value">${doneWalks} / ${goalWalks}</span>
        </div>
        <div class="goal-bar-track">
          <div class="goal-bar-fill${complete ? ' complete' : ''}" style="width:${pct}%"></div>
        </div>
        ${complete ? '<div class="goal-complete-badge">✓ Goal reached!</div>' : ''}
      </div>`;
  }

  el.innerHTML = html;
}

// Goals widget interactions
document.getElementById('btn-edit-goals').addEventListener('click', () => {
  const editEl = document.getElementById('goals-edit');
  const isOpen = editEl.style.display !== 'none';
  editEl.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    document.getElementById('goal-miles').value = state.goals?.miles || '';
    document.getElementById('goal-walks').value = state.goals?.walks || '';
  }
});

document.getElementById('btn-save-goals').addEventListener('click', () => {
  const miles = parseFloat(document.getElementById('goal-miles').value) || 0;
  const walks = parseInt(document.getElementById('goal-walks').value)   || 0;
  state.goals = { miles: miles || null, walks: walks || null };
  saveGoals();
  saveProfileToKV().catch(() => {}); // sync to KV so goals persist cross-browser
  document.getElementById('goals-edit').style.display = 'none';
  document.getElementById('btn-edit-goals').textContent = 'Edit';
  renderGoalsWidget();
});

document.getElementById('btn-cancel-goals').addEventListener('click', () => {
  document.getElementById('goals-edit').style.display = 'none';
});

// ─── Saved Routes Sidebar ─────────────────────────────────────────

function renderSavedRoutes() {
  const el   = document.getElementById('saved-routes-list');
  const tab  = state.activeRouteTab;

  // Update tab button states
  document.querySelectorAll('.route-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  const myRoutes    = state.savedRoutes.filter(r => !r._bookmarked);
  const bookmarked  = state.savedRoutes.filter(r =>  r._bookmarked);
  const routes      = tab === 'my-routes' ? myRoutes : bookmarked;

  if (routes.length === 0) {
    el.innerHTML = tab === 'my-routes'
      ? '<div class="widget-empty">Save a route while logging a journey to see it here.</div>'
      : '<div class="widget-empty">Bookmark routes from friends\' journeys to see them here.</div>';
    return;
  }

  el.innerHTML = routes.map(r => `
    <div class="route-item">
      <div class="route-item-info">
        <div class="route-item-name">${escapeHtml(r.name)}</div>
        <div class="route-item-dist">
          ${formatDistance(r.distMeters)}
          ${r._fromUsername ? `<span class="route-item-attribution">via @${escapeHtml(r._fromUsername)}</span>` : ''}
        </div>
      </div>
      <div class="route-item-actions">
        <button class="btn-load-route" data-id="${r.id}">Load</button>
        <button class="btn-delete-route" data-id="${r.id}" title="${r._bookmarked ? 'Remove bookmark' : 'Delete route'}">✕</button>
      </div>
    </div>
  `).join('');

  el.querySelectorAll('.btn-load-route').forEach(btn => {
    btn.addEventListener('click', () => {
      const route = state.savedRoutes.find(r => r.id === btn.dataset.id);
      if (route) openJourneyModal(route);
    });
  });

  el.querySelectorAll('.btn-delete-route').forEach(btn => {
    btn.addEventListener('click', () => {
      const route = state.savedRoutes.find(r => r.id === btn.dataset.id);
      if (route) promptDeleteRouteModal(route);
    });
  });
}

// Route library tab switching
document.querySelectorAll('.route-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    state.activeRouteTab = btn.dataset.tab;
    renderSavedRoutes();
  renderElevationRecords();
  renderGoalsWidget();
  });
});

// ─── Elevation Records Widget ──────────────────────────────────────

function renderElevationRecords() {
  const el = document.getElementById('elev-records-list');
  const entries = state.entries.filter(e => e.type === 'journey' && e.elevGainM != null);

  if (entries.length === 0) {
    el.innerHTML = '<div class="widget-empty">Log a journey with elevation enabled to see records here.</div>';
    return;
  }

  const metersToFt = m => Math.round(m * 3.28084);

  // Find records
  const mostGain  = entries.reduce((a, b) => (b.elevGainM > a.elevGainM ? b : a));
  const highestPt = entries.reduce((a, b) => (b.elevHighM > a.elevHighM ? b : a));
  const mostLoss  = entries.reduce((a, b) => (b.elevLossM > a.elevLossM ? b : a));

  const records = [
    { label: '↑ Most Climb',    value: `${metersToFt(mostGain.elevGainM)} ft`,  entry: mostGain },
    { label: '⬆ Highest Point', value: `${metersToFt(highestPt.elevHighM)} ft`, entry: highestPt },
    { label: '↓ Most Descent',  value: `${metersToFt(mostLoss.elevLossM)} ft`,  entry: mostLoss },
  ];

  el.innerHTML = records.map((r, i) => `
    <div class="elev-record-item" data-idx="${i}">
      <div class="elev-record-label">${r.label}</div>
      <div class="elev-record-value">${r.value}</div>
      <div class="elev-record-name">${escapeHtml(r.entry.name || 'Untitled Walk')}</div>
      <div class="elev-record-date">${formatDate(r.entry.datetime)}</div>
    </div>
  `).join('');

  el.querySelectorAll('.elev-record-item').forEach((item, i) => {
    item.addEventListener('click', () => openViewModal(records[i].entry));
  });
}

async function deleteRoute(id) {
  state.savedRoutes = state.savedRoutes.filter(r => r.id !== id);
  localStorage.setItem('wj_routes', JSON.stringify(state.savedRoutes));

  if (state.workerUrl) {
    try {
      await workerFetch(`/storage/${state.token}/route/${id}`, 'DELETE');
    } catch(e) {
      console.warn('Worker delete failed:', e.message);
    }
  }
}

function promptDeleteRouteModal(route) {
  document.getElementById('delete-route-message').textContent =
    `Are you sure you want to delete the saved route "${route.name}"?`;

  const btn    = document.getElementById('btn-confirm-delete-route');
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);

  newBtn.addEventListener('click', async () => {
    newBtn.disabled = true;
    newBtn.textContent = 'Deleting…';
    await deleteRoute(route.id);
    closeModal('modal-delete-route');
    renderSavedRoutes();
  renderElevationRecords();
  renderGoalsWidget();
    showToast('Route deleted');
  });

  openModal('modal-delete-route');
}

// ─── Export / Import Modal ────────────────────────────────────────

document.getElementById('btn-export-import').addEventListener('click', () => {
  openModal('modal-export');
});

document.querySelector('#modal-export [data-close]').addEventListener('click', () => {
  closeModal('modal-export');
});

// ── JSON Export ───────────────────────────────────────────────────
document.getElementById('btn-export-json').addEventListener('click', () => {
  const backup = {
    version:    '2.0',
    exportedAt: new Date().toISOString(),
    entries:    state.entries,
    routes:     state.savedRoutes,
    settings: {
      username:    state.username,
      sex:         state.sex,
      ageyears:    state.ageyears,
      heightIn:    state.heightIn,
      weightLbs:   state.weightLbs,
      pageSize:    state.pageSize,
      weatherLocs: state.weatherLocs,
      darkMode:    state.darkMode,
      goals:       state.goals,
    },
  };
  const date = new Date().toISOString().slice(0, 10);
  downloadFile(JSON.stringify(backup, null, 2), `routeandreason-backup-${date}.json`, 'application/json');
  showToast('JSON backup downloaded ✓');
});

// ── CSV Export ────────────────────────────────────────────────────
document.getElementById('btn-export-csv').addEventListener('click', () => {
  const journeys = state.entries.filter(e => e.type === 'journey');
  if (journeys.length === 0) { showToast('No journey entries to export'); return; }

  const headers = [
    'Date', 'Name', 'Distance (mi)', 'Duration (min)', 'Pace (min/mi)',
    'Calories', 'Companions', 'Mood', 'Energy Start', 'Energy End',
    'Elev Gain (ft)', 'Elev High (ft)', 'Visibility', 'Notes'
  ];

  const rows = journeys.map(e => {
    const miles = e.distMeters ? (e.distMeters / METERS_PER_MILE).toFixed(2) : '';
    const pace  = (e.durationMin && e.distMeters)
      ? (e.durationMin / (e.distMeters / METERS_PER_MILE)).toFixed(1) : '';
    const gainFt = e.elevGainM != null ? Math.round(e.elevGainM * 3.28084) : '';
    const highFt = e.elevHighM != null ? Math.round(e.elevHighM * 3.28084) : '';
    return [
      e.datetime ? new Date(e.datetime).toLocaleString() : '',
      e.name || '',
      miles,
      e.durationMin || '',
      pace,
      e.calories ? Math.round(e.calories) : '',
      e.companions || '',
      e.mood || '',
      e.energyStart || '',
      e.energyEnd   || '',
      gainFt,
      highFt,
      e.visibility || '',
      (e.notes || '').replace(/\n/g, ' '),
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });

  const csv  = [headers.join(','), ...rows].join('\n');
  const date = new Date().toISOString().slice(0, 10);
  downloadFile(csv, `routeandreason-journeys-${date}.csv`, 'text/csv');
  showToast(`Exported ${journeys.length} journeys ✓`);
});

// ── GPX Export ────────────────────────────────────────────────────
document.getElementById('btn-export-gpx-all').addEventListener('click', () => {
  const journeys = state.entries.filter(e =>
    e.type === 'journey' && e.waypoints && e.waypoints.length >= 2
  );
  if (journeys.length === 0) { showToast('No journeys with route data to export'); return; }

  const tracks = journeys.map(e => {
    const startTime  = e.datetime ? new Date(e.datetime) : null;
    const durationMs = e.durationMin ? e.durationMin * 60 * 1000 : null;
    const pts        = e.waypoints || [];
    const elevData   = e.elevGainM != null; // rough proxy — we don't store per-point elevation

    const trkpts = pts.map((wp, i) => {
      // Interpolate timestamps if we have start + duration
      let timeTag = '';
      if (startTime) {
        let t;
        if (durationMs && pts.length > 1) {
          t = new Date(startTime.getTime() + (i / (pts.length - 1)) * durationMs);
        } else {
          t = startTime;
        }
        timeTag = `\n        <time>${t.toISOString()}</time>`;
      }
      // Include elevation if stored (use high as approximation — real per-point not stored)
      // We omit <ele> since we don't have per-point elevation stored
      return `      <trkpt lat="${wp.lat.toFixed(6)}" lon="${wp.lng.toFixed(6)}">${timeTag}\n      </trkpt>`;
    }).join('\n');

    const desc = [
      e.distMeters ? `Distance: ${(e.distMeters / METERS_PER_MILE).toFixed(2)} mi` : '',
      e.durationMin ? `Duration: ${formatDuration(e.durationMin)}` : '',
      e.companions ? `With: ${e.companions}` : '',
      e.notes ? e.notes.slice(0, 200) : '',
    ].filter(Boolean).join('. ');

    const timeEl = startTime ? `\n    <time>${startTime.toISOString()}</time>` : '';

    return `  <trk>
    <name>${escapeXml(e.name || 'Untitled Walk')}</name>
    <desc>${escapeXml(desc)}</desc>${timeEl}
    <trkseg>
${trkpts}
    </trkseg>
  </trk>`;
  }).join('\n');

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Route &amp; Reason"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>Route &amp; Reason Export</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
${tracks}
</gpx>`;

  const date = new Date().toISOString().slice(0, 10);
  downloadFile(gpx, `routeandreason-routes-${date}.gpx`, 'application/gpx+xml');
  showToast(`Exported ${journeys.length} routes ✓`);
});

// ── JSON Import ───────────────────────────────────────────────────
document.getElementById('import-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('import-status');
  statusEl.style.display = 'block';
  statusEl.className = '';
  statusEl.textContent = 'Reading file…';

  try {
    const text    = await file.text();
    const backup  = JSON.parse(text);

    if (!backup.entries && !backup.routes && !backup.settings) {
      throw new Error('File does not appear to be a Route & Reason backup.');
    }

    let importedEntries = 0;
    let importedRoutes  = 0;

    // Merge entries (skip duplicates by id)
    if (Array.isArray(backup.entries)) {
      const existingIds = new Set(state.entries.map(e => e.id));
      const newEntries  = backup.entries.filter(e => e.id && !existingIds.has(e.id));
      state.entries = [...state.entries, ...newEntries]
        .sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
      importedEntries = newEntries.length;
      localStorage.setItem('wj_entries', JSON.stringify(state.entries));
      // Sync to KV
      if (state.workerUrl) {
        for (const entry of newEntries) {
          kvPut(`entry/${entry.id}`, entry).catch(() => {});
        }
      }
    }

    // Merge routes (skip duplicates by id)
    if (Array.isArray(backup.routes)) {
      const existingIds = new Set(state.savedRoutes.map(r => r.id));
      const newRoutes   = backup.routes.filter(r => r.id && !existingIds.has(r.id));
      state.savedRoutes = [...state.savedRoutes, ...newRoutes];
      importedRoutes = newRoutes.length;
      localStorage.setItem('wj_routes', JSON.stringify(state.savedRoutes));
      if (state.workerUrl) {
        for (const route of newRoutes) {
          kvPut(`route/${route.id}`, route).catch(() => {});
        }
      }
    }

    // Restore settings — only fill in nulls, don't overwrite existing
    if (backup.settings) {
      const s = backup.settings;
      if (!state.username   && s.username)   state.username   = s.username;
      if (!state.sex        && s.sex)        state.sex        = s.sex;
      if (!state.ageyears   && s.ageyears)   state.ageyears   = s.ageyears;
      if (!state.heightIn   && s.heightIn)   state.heightIn   = s.heightIn;
      if (!state.weightLbs  && s.weightLbs)  state.weightLbs  = s.weightLbs;
      if (!state.weatherLocs?.length && s.weatherLocs?.length) state.weatherLocs = s.weatherLocs;
      if (!state.goals?.miles && !state.goals?.walks && s.goals) state.goals = s.goals;
      saveSettings();
      saveGoals();
    }

    renderFeed();
    renderSpotlight();
    renderSavedRoutes();
    renderElevationRecords();
    renderGoalsWidget();

    statusEl.className   = 'success';
    statusEl.textContent = `✓ Imported ${importedEntries} entries and ${importedRoutes} routes.`;

    // Reset file input so same file can be re-selected
    e.target.value = '';

  } catch(err) {
    statusEl.className   = 'error';
    statusEl.textContent = `✗ Import failed: ${err.message}`;
    e.target.value = '';
  }
});

// ─── Stats Dashboard ──────────────────────────────────────────────

let statsWindow = 'week'; // 'week' | 'month' | 'year' | 'all'

document.getElementById('btn-stats').addEventListener('click', () => {
  openModal('modal-stats');
  renderStatsDashboard();
});

document.querySelector('#modal-stats [data-close]').addEventListener('click', () => {
  closeModal('modal-stats');
});

document.querySelectorAll('.stats-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    statsWindow = btn.dataset.window;
    document.querySelectorAll('.stats-tab').forEach(b => b.classList.toggle('active', b === btn));
    renderStatsDashboard();
  });
});

function getWindowEntries() {
  const journeys = state.entries.filter(e => e.type === 'journey');
  if (statsWindow === 'all') return journeys;
  const now  = new Date();
  const cutoff = new Date();
  if (statsWindow === 'week') {
    const day = now.getDay();
    cutoff.setDate(now.getDate() - day);
    cutoff.setHours(0, 0, 0, 0);
  } else if (statsWindow === 'month') {
    cutoff.setDate(1);
    cutoff.setHours(0, 0, 0, 0);
  } else if (statsWindow === 'year') {
    cutoff.setMonth(0, 1);
    cutoff.setHours(0, 0, 0, 0);
  }
  return journeys.filter(e => new Date(e.datetime) >= cutoff);
}

function renderStatsDashboard() {
  const entries  = getWindowEntries();
  const allJourneys = state.entries.filter(e => e.type === 'journey');

  // ── Summary row ──────────────────────────────────────────────────
  const totalWalks = entries.length;
  const totalMiles = entries.reduce((s, e) => s + (e.distMeters || 0), 0) / METERS_PER_MILE;
  const totalMins  = entries.reduce((s, e) => s + (e.durationMin || 0), 0);
  const totalCals  = entries.reduce((s, e) => s + (e.calories || 0), 0);

  document.getElementById('stats-summary-row').innerHTML = `
    <div class="stats-summary-card">
      <div class="stats-summary-value">${totalWalks}</div>
      <div class="stats-summary-label">Walks</div>
    </div>
    <div class="stats-summary-card">
      <div class="stats-summary-value">${totalMiles.toFixed(1)}</div>
      <div class="stats-summary-label">Miles</div>
    </div>
    <div class="stats-summary-card">
      <div class="stats-summary-value">${formatDuration(totalMins)}</div>
      <div class="stats-summary-label">Time</div>
    </div>
    <div class="stats-summary-card">
      <div class="stats-summary-value">${totalCals > 0 ? Math.round(totalCals).toLocaleString() : '—'}</div>
      <div class="stats-summary-label">Calories</div>
    </div>
  `;

  // ── Weekly miles chart ────────────────────────────────────────────
  drawWeeklyChart(allJourneys);

  // ── Day of week chart ─────────────────────────────────────────────
  drawDowChart(entries);

  // ── Personal bests ────────────────────────────────────────────────
  const bests = document.getElementById('stats-personal-bests');
  if (allJourneys.length === 0) {
    bests.innerHTML = '<div class="widget-empty" style="font-size:0.8rem">No journeys logged yet.</div>';
  } else {
    const longest  = allJourneys.reduce((a, b) => (b.distMeters||0) > (a.distMeters||0) ? b : a);
    const longest2 = allJourneys.reduce((a, b) => (b.durationMin||0) > (a.durationMin||0) ? b : a);
    const fastest  = allJourneys.filter(e => e.distMeters > 0 && e.durationMin > 0)
      .reduce((a, b) => {
        const paceA = a ? a.durationMin / (a.distMeters / METERS_PER_MILE) : Infinity;
        const paceB = b.durationMin / (b.distMeters / METERS_PER_MILE);
        return paceB < paceA ? b : a;
      }, null);
    const mostCals = allJourneys.filter(e => e.calories).reduce((a, b) => (b.calories > a.calories ? b : a), allJourneys[0]);

    const rows = [
      { label: 'Longest walk',    value: longest.distMeters ? formatDistance(longest.distMeters) : '—',
        sub: escapeHtml(longest.name || '') },
      { label: 'Longest duration', value: longest2.durationMin ? formatDuration(longest2.durationMin) : '—',
        sub: escapeHtml(longest2.name || '') },
      { label: 'Best pace',       value: fastest ? formatPace(fastest.durationMin, fastest.distMeters) + '/mi' : '—',
        sub: fastest ? escapeHtml(fastest.name || '') : '' },
      { label: 'Most calories',   value: mostCals?.calories ? Math.round(mostCals.calories) + ' cal' : '—',
        sub: mostCals ? escapeHtml(mostCals.name || '') : '' },
    ];

    bests.innerHTML = rows.map(r => `
      <div class="stats-row">
        <span class="stats-row-label">${r.label}<br><small style="font-size:0.72rem;color:var(--ink-muted)">${r.sub}</small></span>
        <span class="stats-row-value">${r.value}</span>
      </div>
    `).join('');
  }

  // ── Patterns ──────────────────────────────────────────────────────
  const patternsEl = document.getElementById('stats-patterns');
  if (entries.length === 0) {
    patternsEl.innerHTML = '<div class="widget-empty" style="font-size:0.8rem">No data for this period.</div>';
  } else {
    const avgMiles = totalMiles / totalWalks;
    const avgMins  = totalMins  / totalWalks;

    // Most walked month (all time)
    const byMonth = {};
    allJourneys.forEach(e => {
      const key = new Date(e.datetime).toLocaleString('default', { month: 'long', year: 'numeric' });
      byMonth[key] = (byMonth[key] || 0) + 1;
    });
    const topMonth = Object.entries(byMonth).sort((a, b) => b[1] - a[1])[0];

    // Favorite companion
    const compCounts = {};
    allJourneys.forEach(e => {
      if (!e.companions) return;
      e.companions.split(',').map(s => s.trim()).filter(Boolean).forEach(c => {
        compCounts[c.toLowerCase()] = (compCounts[c.toLowerCase()] || 0) + 1;
      });
    });
    const topComp = Object.entries(compCounts)
      .filter(([k]) => !['solo','alone',''].includes(k))
      .sort((a, b) => b[1] - a[1])[0];

    const rows = [
      { label: 'Avg walk distance', value: `${avgMiles.toFixed(1)} mi` },
      { label: 'Avg walk duration', value: formatDuration(avgMins) },
      { label: 'Most active month', value: topMonth ? topMonth[0] : '—' },
      { label: 'Top companion',     value: topComp ? topComp[0] : '—' },
    ];

    patternsEl.innerHTML = rows.map(r => `
      <div class="stats-row">
        <span class="stats-row-label">${r.label}</span>
        <span class="stats-row-value">${r.value}</span>
      </div>
    `).join('');
  }
}

function drawWeeklyChart(journeys) {
  const canvas = document.getElementById('stats-canvas-weekly');
  const W = canvas.offsetWidth || 500;
  const H = 120;
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // Build last 12 week buckets
  const weeks = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay() - i * 7);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    const miles = journeys
      .filter(e => { const d = new Date(e.datetime); return d >= start && d < end; })
      .reduce((s, e) => s + (e.distMeters || 0), 0) / METERS_PER_MILE;
    weeks.push({ label: `${start.getMonth()+1}/${start.getDate()}`, miles });
  }

  const maxMiles = Math.max(...weeks.map(w => w.miles), 0.1);
  const barW  = Math.floor((W - 20) / weeks.length) - 2;
  const isDark = document.body.classList.contains('dark');
  const barColor   = '#4a7c59';
  const labelColor = isDark ? 'rgba(240,236,228,0.5)' : 'rgba(60,50,30,0.4)';

  weeks.forEach((w, i) => {
    const x   = 10 + i * (barW + 2);
    const barH = w.miles > 0 ? Math.max(4, ((w.miles / maxMiles) * (H - 28))) : 0;
    const y   = H - 18 - barH;

    ctx.fillStyle = barColor;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, barW, barH, 2) : ctx.rect(x, y, barW, barH);
    ctx.fill();

    // Week label every 3rd
    if (i % 3 === 0) {
      ctx.fillStyle = labelColor;
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(w.label, x + barW / 2, H - 4);
    }
  });
}

function drawDowChart(entries) {
  const canvas = document.getElementById('stats-canvas-dow');
  const W = canvas.offsetWidth || 200;
  const H = 120;
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const days  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const counts = new Array(7).fill(0);
  entries.forEach(e => counts[new Date(e.datetime).getDay()]++);

  const maxCount = Math.max(...counts, 1);
  const barW     = Math.floor((W - 10) / 7) - 2;
  const isDark   = document.body.classList.contains('dark');
  const barColor   = '#4a7c59';
  const labelColor = isDark ? 'rgba(240,236,228,0.5)' : 'rgba(60,50,30,0.4)';

  counts.forEach((c, i) => {
    const x    = 5 + i * (barW + 2);
    const barH = c > 0 ? Math.max(4, (c / maxCount) * (H - 28)) : 0;
    const y    = H - 18 - barH;

    ctx.fillStyle = barColor;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, barW, barH, 2) : ctx.rect(x, y, barW, barH);
    ctx.fill();

    ctx.fillStyle = labelColor;
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(days[i], x + barW / 2, H - 4);
  });
}

// ─── Settings Modal ───────────────────────────────────────────────

function populateSettingsModal() {
  // Populate the token and worker URL into the new auth module field IDs
  const tokenEl  = document.getElementById('p-token');
  const workerEl = document.getElementById('p-worker-url');
  if (tokenEl)  tokenEl.value  = state.token    || '';
  if (workerEl) workerEl.value = state.workerUrl || '';

  document.getElementById('settings-page-size').value  = String(state.pageSize);
  document.getElementById('settings-weight').value     = state.weightLbs || '';
  document.getElementById('settings-height').value     = state.heightIn  || '';
  document.getElementById('settings-age').value        = state.ageyears  || '';
  document.getElementById('settings-sex').value        = state.sex       || '';
  document.getElementById('settings-username').value   = state.username  || '';
  document.getElementById('username-status').textContent = '';
  renderSettingsWeatherLocs();

  // Update sync indicator
  const syncIndicator = document.getElementById('sync-indicator');
  if (syncIndicator) {
    if (Auth.isGuest()) {
      syncIndicator.textContent = '';
    } else if (state.workerUrl) {
      syncIndicator.textContent = 'Synced ✓';
      syncIndicator.style.color = 'var(--green-mid)';
    } else {
      syncIndicator.textContent = 'No worker URL set';
      syncIndicator.style.color = 'var(--ink-muted)';
    }
  }

  // Let the auth module update the badge and show/hide sections
  Auth.renderSettingsSection();
}

function renderSettingsWeatherLocs() {
  const el = document.getElementById('settings-weather-locations');
  if (state.weatherLocs.length === 0) {
    el.innerHTML = '<div style="font-size:0.85rem;color:var(--ink-muted);font-style:italic;">No saved locations.</div>';
    return;
  }
  el.innerHTML = state.weatherLocs.map((loc, i) => `
    <div class="weather-location-setting">
      <span>${escapeHtml(loc.name)}</span>
      <button class="btn-remove-loc" data-idx="${i}" title="Remove">✕</button>
    </div>
  `).join('');
  el.querySelectorAll('.btn-remove-loc').forEach(btn => {
    btn.addEventListener('click', () => {
      state.weatherLocs.splice(parseInt(btn.dataset.idx), 1);
      saveSettings();
      renderSettingsWeatherLocs();
      renderWeatherSidebar();
    });
  });
}

// ── Settings modal — auth button event delegation ─────────────────
// Auth buttons are shown/hidden dynamically, so we use delegation.
document.getElementById('modal-settings').addEventListener('click', e => {
  if (e.target.closest('#btn-guest-create-account')) {
    setTimeout(() => { closeModal('modal-settings'); Auth.showSetupFresh(); }, 0);
  }
  if (e.target.closest('#btn-upgrade-to-google')) {
    setTimeout(() => { closeModal('modal-settings'); Auth.showGoogleUpgradeFlow(); }, 0);
  }
  if (e.target.closest('#btn-switch-account')) {
    setTimeout(() => { closeModal('modal-settings'); Auth.showGuestSwitchConfirm(); }, 0);
  }
  if (e.target.closest('#btn-manual-sync')) {
    const indicator = document.getElementById('sync-indicator');
    if (indicator) { indicator.textContent = 'Syncing…'; indicator.style.color = 'var(--ink-muted)'; }
    saveProfileToKV()
      .then(() => {
        if (indicator) { indicator.textContent = 'Synced ✓'; indicator.style.color = 'var(--green-mid)'; }
        showToast('Synced ✓');
      })
      .catch(() => {
        if (indicator) { indicator.textContent = 'Sync failed'; indicator.style.color = 'var(--red-soft)'; }
        showToast('Sync failed');
      });
  }
});

document.getElementById('btn-save-location').addEventListener('click', async () => {
  const input = document.getElementById('settings-new-location').value.trim();
  if (!input) return;
  // Geocode the location
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(input)}&limit=1`);
    const data = await res.json();
    if (!data[0]) { showToast('Location not found'); return; }
    const loc = {
      name: data[0].display_name.split(',').slice(0,2).join(',').trim(),
      lat:  parseFloat(data[0].lat),
      lng:  parseFloat(data[0].lon),
      manual: true,
    };
    state.weatherLocs.push(loc);
    saveSettings();
    renderSettingsWeatherLocs();
    document.getElementById('settings-new-location').value = '';
    showToast(`Added ${loc.name}`);
  } catch(e) {
    showToast('Geocoding failed');
  }
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const prevWorkerUrl = state.workerUrl;
  // Read from auth module field IDs (p-token, p-worker-url)
  const newToken      = (document.getElementById('p-token')?.value || '').trim();
  const newWorkerUrl  = (document.getElementById('p-worker-url')?.value || '').trim();

  // Only apply token change for token accounts (Google accounts use google:<sub>)
  if (newToken && Auth.isTokenAccount() && newToken !== state.token) {
    state.token = newToken;
  }
  state.workerUrl  = newWorkerUrl;
  state.pageSize   = parseInt(document.getElementById('settings-page-size').value, 10);
  state.weightLbs  = parseFloat(document.getElementById('settings-weight').value || '0') || null;
  state.heightIn   = parseFloat(document.getElementById('settings-height').value || '0') || null;
  state.ageyears   = parseFloat(document.getElementById('settings-age').value    || '0') || null;
  state.sex        = document.getElementById('settings-sex').value || null;
  // Note: username is saved separately via btn-save-username
  saveSettings();
  if (!Auth.isGuest()) saveProfileToKV();
  closeModal('modal-settings');
  showToast('Settings saved ✓');
  renderWeatherSidebar();
  updateWorkerDependentToggles();

  // If worker URL changed, pull fresh data
  const workerChanged = newWorkerUrl && newWorkerUrl !== prevWorkerUrl;
  if (workerChanged && !Auth.isGuest()) {
    try {
      const res  = await fetch(newWorkerUrl.replace(/\/$/, '') + '/');
      const data = await res.json();
      if (!data.ok) throw new Error('ping failed');

      await loadProfileFromKV();
      saveSettings();
      await loadEntries();
      await loadFriendEntries();
      await loadMentionEntries();
      await loadMutualWalkEntries();
      updateFriendsBadge();
      renderFeed();
      renderSpotlight();
      renderSavedRoutes();
      renderElevationRecords();
      renderGoalsWidget();
      renderWeatherSidebar();
      updateWorkerDependentToggles();
      updateFriendsBadge();

      const { count, entries: unsynced } = await countUnsyncedLocalEntries();
      if (count > 0) promptSyncModal(count, unsynced);
    } catch(e) {
      showToast('⚠️ Worker saved but could not be reached — check the URL');
    }
  }
});

// ─── Sync Modal ───────────────────────────────────────────────────

function promptSyncModal(count, unsynced) {
  const noun = count === 1 ? 'entry' : 'entries';
  document.getElementById('sync-message').textContent =
    `We found ${count} local ${noun} that haven't been synced to your worker yet.`;

  // Wire up confirm button fresh each time
  const btn = document.getElementById('btn-confirm-sync');
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);

  // Add progress element if not present
  let progressEl = document.getElementById('sync-progress');
  if (!progressEl) {
    progressEl = document.createElement('p');
    progressEl.id = 'sync-progress';
    progressEl.className = 'sync-progress';
    newBtn.parentNode.appendChild(progressEl);
  }
  progressEl.textContent = '';

  newBtn.addEventListener('click', async () => {
    newBtn.disabled = true;
    newBtn.textContent = 'Syncing…';
    const done = await pushLocalEntriesToKV(unsynced, progressEl);
    // Reload from KV so state reflects the merged data
    await loadEntries();
    renderFeed();
    renderSpotlight();
    closeModal('modal-sync');
    showToast(`Synced ${done} ${done === 1 ? 'entry' : 'entries'} ✓`);
  });

  openModal('modal-sync');
}

// ─── Weather Sidebar ──────────────────────────────────────────────

async function renderWeatherSidebar() {
  const el = document.getElementById('weather-locations');

  const allLocs = state.weatherLocs.filter(l => l.manual);

  if (allLocs.length === 0) {
    el.innerHTML = '<div class="widget-empty">Add a location to see current conditions.</div>';
    return;
  }

  el.innerHTML = '<div class="widget-empty">Loading conditions…</div>';

  const results = await Promise.all(allLocs.map(loc => fetchWeather(loc)));
  el.innerHTML = results.map(renderWeatherLocation).join('');
}

async function fetchWeather(loc) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lng}`
      + `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,uv_index,weather_code`
      + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;

    const wxPromise = fetch(url).then(r => r.json());

    // Pollen via worker (daily cached) — only if worker URL is configured
    let pollenPromise = Promise.resolve(null);
    if (state.workerUrl) {
      const pollenUrl = state.workerUrl.replace(/\/$/, '')
        + `/pollen?lat=${loc.lat}&lng=${loc.lng}`;
      pollenPromise = fetch(pollenUrl).then(r => r.ok ? r.json() : null).catch(() => null);
    }

    const [wx, pollen] = await Promise.all([wxPromise, pollenPromise]);
    return { ...loc, wx: wx.current, pollen };
  } catch(e) {
    return { ...loc, wx: null, pollen: null };
  }
}

function renderWeatherLocation(data) {
  if (!data.wx) return `<div class="weather-location"><div class="weather-loc-name">${escapeHtml(data.name)} <span>Unavailable</span></div></div>`;

  const wx = data.wx;
  const wmoDesc = wmoDescription(wx.weather_code);

  let pollenHtml = '';
  if (data.pollen) {
    const pollens = [
      { label: 'Tree',  data: data.pollen.tree  },
      { label: 'Grass', data: data.pollen.grass },
      { label: 'Weed',  data: data.pollen.weed  },
    ].filter(p => p.data && p.data.index !== null);

    if (pollens.length > 0) {
      pollenHtml = `<div class="pollen-row">${pollens.map(p =>
        `<span class="pollen-badge ${pollenClassFromCategory(p.data.category)}">${p.label}: ${p.data.category || '—'}</span>`
      ).join('')}</div>`;
    }
  }

  return `
    <div class="weather-location">
      <div class="weather-loc-name">${escapeHtml(data.name)} <span>${wmoDesc}</span></div>
      <div class="weather-grid">
        <div class="weather-item"><strong>${Math.round(wx.temperature_2m)}°F</strong></div>
        <div class="weather-item">💧 <strong>${wx.relative_humidity_2m}%</strong></div>
        <div class="weather-item">💨 <strong>${Math.round(wx.wind_speed_10m)} mph</strong></div>
        <div class="weather-item">☀️ UV <strong>${wx.uv_index ?? '—'}</strong></div>
      </div>
      ${pollenHtml}
    </div>
  `;
}

function pollenClassFromCategory(category) {
  if (!category) return 'pollen-vlow';
  // Google returns "Very Low", "Low", "Moderate", "High", "Very High"
  // Normalise to uppercase-underscore for comparison
  const c = category.toUpperCase().replace(/\s+/g, '_');
  if (c === 'NONE' || c === 'VERY_LOW') return 'pollen-vlow';
  if (c === 'LOW')      return 'pollen-low';
  if (c === 'MODERATE') return 'pollen-moderate';
  if (c === 'HIGH')     return 'pollen-high';
  return 'pollen-vhigh'; // VERY_HIGH
}

function wmoDescription(code) {
  const m = {
    0:'Clear',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',
    45:'Foggy',48:'Foggy',51:'Light drizzle',53:'Drizzle',55:'Heavy drizzle',
    61:'Light rain',63:'Rain',65:'Heavy rain',71:'Light snow',73:'Snow',75:'Heavy snow',
    80:'Rain showers',81:'Rain showers',82:'Heavy showers',
    95:'Thunderstorm',96:'Thunderstorm',99:'Thunderstorm',
  };
  return m[code] || '—';
}

// Add location button on sidebar
document.getElementById('btn-add-location').addEventListener('click', () => {
  populateSettingsModal();
  openModal('modal-settings');
  setTimeout(() => document.getElementById('settings-new-location').focus(), 100);
});

// ─── Username Save ────────────────────────────────────────────────

document.getElementById('btn-save-username').addEventListener('click', async () => {
  const val = document.getElementById('settings-username').value.trim().toLowerCase();
  const statusEl = document.getElementById('username-status');
  if (!val) return;
  if (!state.workerUrl) { showToast('Worker URL required to set a username'); return; }
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(val)) {
    statusEl.textContent = 'Invalid username format';
    statusEl.style.color = 'var(--red-soft)';
    return;
  }
  statusEl.textContent = 'Saving…';
  statusEl.style.color = 'var(--ink-muted)';
  try {
    await registerUsername(val);
    state.username = val;
    saveSettings();
    await saveProfileToKV();
    statusEl.textContent = '✓ Username saved';
    statusEl.style.color = 'var(--green-mid)';
    document.getElementById('settings-username').value = val;
  } catch(e) {
    statusEl.textContent = e.message.includes('taken') ? '✗ Username already taken' : '✗ ' + e.message;
    statusEl.style.color = 'var(--red-soft)';
  }
});

// ─── Friends Modal ────────────────────────────────────────────────

document.getElementById('btn-friends').addEventListener('click', () => {
  renderFriendsModal();
  openModal('modal-friends');
});

// Tab switching
document.querySelectorAll('.friends-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.friends-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.friends-tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

function renderFriendsModal() {
  const usernameEl = document.getElementById('friends-modal-username');
  if (usernameEl) {
    usernameEl.textContent = state.username ? `@${state.username}` : 'No username set — add one in Settings';
    usernameEl.style.color = state.username ? 'var(--green-mid)' : 'var(--ink-muted)';
  }
  renderFriendsList();
  renderRequestsPanels();
  renderNotificationsPanel();
  updateFriendsBadge();
}

function renderNotificationsPanel() {
  const el = document.getElementById('notifications-content');
  const mentions    = state.mentionEntries   || [];
  const mutualWalks = state.mutualWalkEntries || [];

  if (mentions.length === 0 && mutualWalks.length === 0) {
    el.innerHTML = '<div class="widget-empty">No notifications yet.</div>';
    return;
  }

  el.innerHTML = '';

  // Mention notifications
  if (mentions.length > 0) {
    const header = document.createElement('div');
    header.className = 'friends-section-heading';
    header.textContent = `Mentions (${mentions.length})`;
    el.appendChild(header);

    mentions.forEach(m => {
      const item = document.createElement('div');
      item.className = 'notification-item';
      item.innerHTML = `
        <div class="notification-icon">💬</div>
        <div class="notification-body">
          <div class="notification-title">Mentioned by @${escapeHtml(m.fromUsername)}</div>
          <div class="notification-preview">${escapeHtml(m.preview || '')}</div>
          <div class="notification-date">${formatDate(m.createdAt)}</div>
        </div>
      `;
      el.appendChild(item);
    });
  }

  // Mutual walk notifications
  if (mutualWalks.length > 0) {
    const header = document.createElement('div');
    header.className = 'friends-section-heading';
    header.style.marginTop = mentions.length ? '1rem' : '0';
    header.textContent = `Walks you were on (${mutualWalks.length})`;
    el.appendChild(header);

    mutualWalks.forEach(m => {
      const hasRoute = m.waypoints && m.waypoints.length >= 2;
      const item = document.createElement('div');
      item.className = 'notification-item';
      item.innerHTML = `
        <div class="notification-icon">🚶</div>
        <div class="notification-body">
          <div class="notification-title">@${escapeHtml(m.fromUsername)} logged "${escapeHtml(m.entryName || 'a walk')}"</div>
          <div class="notification-preview">A walk you were part of.</div>
          <div class="notification-date">${formatDate(m.createdAt)}</div>
          ${hasRoute ? `<button class="btn btn-sm btn-primary notification-log-btn" style="margin-top:0.5rem">Log my version</button>` : ''}
        </div>
      `;
      if (hasRoute) {
        item.querySelector('.notification-log-btn').addEventListener('click', () => {
          closeModal('modal-friends');
          openJourneyModal({
            waypoints:      m.waypoints,
            _sourceEntryId: m.entryId,
            _fromUsername:  m.fromUsername,
            _friendToken:   m.fromToken,
          });
        });
      }
      el.appendChild(item);
    });
  }
}

function renderFriendsList() {
  const el = document.getElementById('friends-list-content');
  if (state.friends.length === 0) {
    el.innerHTML = '<div class="widget-empty">No friends yet. Search for someone to add.</div>';
    return;
  }
  el.innerHTML = state.friends.map(f => `
    <div class="friend-item">
      <div>
        <div class="friend-item-name">@${escapeHtml(f.username)}</div>
      </div>
      <div class="friend-item-actions">
        <button class="btn-remove-friend" data-token="${f.token}">Remove</button>
      </div>
    </div>
  `).join('');
  el.querySelectorAll('.btn-remove-friend').forEach(btn => {
    btn.addEventListener('click', async () => {
      const friend = state.friends.find(f => f.token === btn.dataset.token);
      if (!friend) return;
      if (!confirm(`Remove @${friend.username} from your friends?`)) return;
      btn.disabled = true;
      await removeFriend(friend);
      renderFriendsList();
      renderFeed();
      showToast(`@${friend.username} removed`);
    });
  });

  // Update friends tab badge with count
  const badge = document.getElementById('tab-badge-friends');
  badge.style.display = 'none';
}

function renderRequestsPanels() {
  // Incoming
  const inEl = document.getElementById('requests-incoming-content');
  if (state.incomingReqs.length === 0) {
    inEl.innerHTML = '<div class="widget-empty">No pending requests.</div>';
  } else {
    inEl.innerHTML = state.incomingReqs.map(r => `
      <div class="request-item">
        <div class="request-item-name">@${escapeHtml(r.username)}</div>
        <div class="request-item-actions">
          <button class="btn-approve" data-token="${r.token}">Approve</button>
          <button class="btn-decline" data-token="${r.token}">Decline</button>
        </div>
      </div>
    `).join('');
    inEl.querySelectorAll('.btn-approve').forEach(btn => {
      btn.addEventListener('click', async () => {
        const req = state.incomingReqs.find(r => r.token === btn.dataset.token);
        if (!req) return;
        btn.disabled = true;
        btn.textContent = 'Adding…';
        await confirmFriendship(req);
        await loadFriendEntries();
        await loadMentionEntries();
  await loadMutualWalkEntries();
  updateFriendsBadge();
        renderFriendsModal();
        renderFeed();
        showToast(`@${req.username} added as a friend ✓`);
      });
    });
    inEl.querySelectorAll('.btn-decline').forEach(btn => {
      btn.addEventListener('click', async () => {
        const req = state.incomingReqs.find(r => r.token === btn.dataset.token);
        if (!req) return;
        await declineRequest(req);
        renderRequestsPanels();
        updateFriendsBadge();
        showToast('Request declined');
      });
    });
  }

  // Outgoing
  const outEl = document.getElementById('requests-outgoing-content');
  if (state.outgoingReqs.length === 0) {
    outEl.innerHTML = '<div class="widget-empty">No outgoing requests.</div>';
  } else {
    outEl.innerHTML = state.outgoingReqs.map(r => `
      <div class="request-item">
        <div class="request-item-name">@${escapeHtml(r.username)}</div>
        <div class="request-item-actions">
          <button class="btn-cancel-req" data-token="${r.token}">Cancel</button>
        </div>
      </div>
    `).join('');
    outEl.querySelectorAll('.btn-cancel-req').forEach(btn => {
      btn.addEventListener('click', async () => {
        const req = state.outgoingReqs.find(r => r.token === btn.dataset.token);
        if (!req) return;
        btn.disabled = true;
        await cancelRequest(req);
        renderRequestsPanels();
        showToast('Request cancelled');
      });
    });
  }
}

// Friend search
document.getElementById('btn-friend-search').addEventListener('click', () => doFriendSearch());
document.getElementById('friend-search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doFriendSearch();
});

async function doFriendSearch() {
  const raw = document.getElementById('friend-search-input').value.trim();
  const q   = raw.startsWith('@') ? raw.slice(1).toLowerCase() : raw.toLowerCase();
  const el  = document.getElementById('friend-search-results');
  if (!q) return;
  if (!state.workerUrl) { showToast('Worker URL required'); return; }
  if (!state.username) { showToast('Set your username in Settings first'); return; }

  el.innerHTML = '<div class="widget-empty">Searching…</div>';

  try {
    const result = await lookupUsername(q);

    if (!result) {
      el.innerHTML = '<div class="widget-empty">No user found with that username.</div>';
      return;
    }

    // Can't add yourself
    if (result.token === state.token) {
      el.innerHTML = '<div class="widget-empty">That\'s you!</div>';
      return;
    }

    const isAlreadyFriend = state.friends.some(f => f.token === result.token);
    const isPending = state.outgoingReqs.some(r => r.token === result.token);
    const isIncoming = state.incomingReqs.some(r => r.token === result.token);

    let actionHtml = '';
    if (isAlreadyFriend) {
      actionHtml = '<span style="font-size:0.8rem;color:var(--green-mid)">✓ Already friends</span>';
    } else if (isPending) {
      actionHtml = '<span style="font-size:0.8rem;color:var(--ink-muted)">Request sent</span>';
    } else if (isIncoming) {
      actionHtml = `<button class="btn-approve" data-token="${result.token}">Approve their request</button>`;
    } else {
      actionHtml = `<button class="btn-add-friend btn btn-sm btn-primary" data-token="${result.token}" data-username="${escapeHtml(result.username)}">Add friend</button>`;
    }

    el.innerHTML = `
      <div class="friend-result">
        <div>
          <div class="friend-result-name">@${escapeHtml(result.username)}</div>
        </div>
        <div>${actionHtml}</div>
      </div>
    `;

    el.querySelector('.btn-add-friend')?.addEventListener('click', async btn => {
      const b = el.querySelector('.btn-add-friend');
      b.disabled = true;
      b.textContent = 'Sending…';
      try {
        const res = await sendFriendRequest(result.username, result.token);
        if (res.autoConfirmed) {
          await loadFriendEntries();
          await loadMentionEntries();
  await loadMutualWalkEntries();
  updateFriendsBadge();
          renderFriendsModal();
          renderFeed();
          showToast(`@${result.username} added — mutual request detected ✓`);
        } else {
          b.textContent = 'Request sent';
          renderRequestsPanels();
          showToast(`Friend request sent to @${result.username}`);
        }
      } catch(e) {
        b.disabled = false;
        b.textContent = 'Add friend';
        showToast('Failed to send request');
      }
    });

    el.querySelector('.btn-approve')?.addEventListener('click', async () => {
      const req = state.incomingReqs.find(r => r.token === result.token);
      if (!req) return;
      await confirmFriendship(req);
      await loadFriendEntries();
      renderFriendsModal();
      renderFeed();
      showToast(`@${result.username} added as a friend ✓`);
    });

  } catch(e) {
    el.innerHTML = '<div class="widget-empty">Search failed. Try again.</div>';
    console.error('Friend search error:', e);
  }
}

// ─── Init ─────────────────────────────────────────────────────────

async function init() {
  loadSettings();
  loadGoals();
  loadSyncQueue();
  applyDarkMode();  // apply before any KV fetch to avoid flash

  // ── Auth module initialisation ────────────────────────────────────
  // Must happen before any worker calls so callbacks and state are ready.
  Auth.init({
    googleClientId:    '816310286560-8q21cppmirq6n5r3c3cmsolaaakga4s1.apps.googleusercontent.com',
    storageKey:        'wj_appdata',
    storageAuthKey:    'wj_google_id_token',
    storageDismissKey: 'wj_token_upgrade_dismissed',
    workerBase:        () => state.workerUrl || '',
    getData:           () => ({
      userToken:    state.token,
      workerUrl:    state.workerUrl,
      authMethod:   state.authMethod,
      linkedGoogle: state.linkedGoogle,
      createdAt:    state.createdAt,
    }),
    setData: (d) => {
      if (d.userToken    !== undefined) state.token        = d.userToken;
      if (d.workerUrl    !== undefined) state.workerUrl    = d.workerUrl;
      if (d.authMethod   !== undefined) state.authMethod   = d.authMethod;
      if (d.linkedGoogle !== undefined) state.linkedGoogle = d.linkedGoogle;
      if (d.createdAt    !== undefined) state.createdAt    = d.createdAt;
      saveSettings();
    },
    mergeData: (raw) => ({
      userToken:    raw.userToken    ?? state.token,
      workerUrl:    raw.workerUrl    ?? state.workerUrl ?? '',
      authMethod:   raw.authMethod   ?? 'token',
      linkedGoogle: raw.linkedGoogle ?? null,
      createdAt:    raw.createdAt    ?? Date.now(),
    }),
    onSignedIn: async (data, isNewAccount) => {
      if (data.userToken    !== undefined) state.token        = data.userToken;
      if (data.workerUrl    !== undefined) state.workerUrl    = data.workerUrl;
      if (data.authMethod   !== undefined) state.authMethod   = data.authMethod;
      if (data.linkedGoogle !== undefined) state.linkedGoogle = data.linkedGoogle;
      if (data.createdAt    !== undefined) state.createdAt    = data.createdAt;
      saveSettings();
      if (!isNewAccount) {
        await loadProfileFromKV();
        applyDarkMode();
      }
      await loadEntries();
      await loadFriendEntries();
      await loadMentionEntries();
      await loadMutualWalkEntries();
      updateFriendsBadge();
      renderFeed();
      renderSpotlight();
      renderSavedRoutes();
      renderElevationRecords();
      renderGoalsWidget();
      renderWeatherSidebar();
      updateWorkerDependentToggles();
      showToast(`Welcome to Route & Reason 🌿`);
    },
    onGuestReady: async (data) => {
      if (data.authMethod !== undefined) state.authMethod = data.authMethod;
      saveSettings();
      renderFeed();
      renderSpotlight();
      renderGoalsWidget();
      updateWorkerDependentToggles();
    },
    onSessionExpired: () => {
      showToast('Your session has expired — please sign in again.');
      Auth.showAccountSetup();
    },
    pushToWorker:  () => saveProfileToKV(),
    startSyncPing: () => {},  // sync ping is handled by the setInterval below
    openModal,
    closeModal,
    toast:    (msg) => showToast(msg),
    appName:  'Route & Reason',
    appEmoji: '🌿',
  });

  // ── First run: no token means brand new device / new user ─────────
  const isFirstRun = !state.token && !state.authMethod;
  if (isFirstRun) {
    // Load local-only entries first so guest users see any cached data
    state.entries     = JSON.parse(localStorage.getItem('wj_entries') || '[]');
    state.savedRoutes = JSON.parse(localStorage.getItem('wj_routes')  || '[]');
    renderFeed();
    renderGoalsWidget();
    updateWorkerDependentToggles();
    Auth.showAccountSetup();
    return;
  }

  // ── Existing session ──────────────────────────────────────────────
  if (state.workerUrl && !Auth.isGuest()) {
    await loadProfileFromKV();
    applyDarkMode();

    // bootCheck handles Google session verify + legacy token upgrade prompt
    const shouldContinue = await Auth.bootCheck(state.token);
    if (!shouldContinue) return;
  }

  await loadEntries();
  await loadFriendEntries();
  await loadMentionEntries();
  await loadMutualWalkEntries();
  updateFriendsBadge();

  // Backfill elevation stats for entries that predate the feature
  backfillElevationStats().catch(() => {});

  renderFeed();
  renderSpotlight();
  renderSavedRoutes();
  renderElevationRecords();
  renderGoalsWidget();
  renderWeatherSidebar();
  updateWorkerDependentToggles();
  updateFriendsBadge();

  // Poll for new friend requests every 60 seconds
  setInterval(refreshFriendsBadge, 60000);

  // Drain sync queue on reconnect and every 30 seconds
  window.addEventListener('online', () => drainSyncQueue());
  setInterval(drainSyncQueue, 30000);

  drainSyncQueue();
}

init();
