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
  activeRouteTab: 'my-routes', // 'my-routes' | 'bookmarked'
  prefillSourceRef: null,      // { entryId, friendToken, username } when using a friend's route
  // Social
  username:    null,     // this user's chosen username
  friends:     [],       // [{username, token}] confirmed friends
  incomingReqs:[],       // [{username, token, sentAt}] pending incoming
  outgoingReqs:[],       // [{username, token, sentAt}] pending outgoing
  friendEntries:[],      // entries fetched from friends
  lastSeenFriends: {},   // {token: ISO timestamp} for "New" dot logic
  darkMode:    false,    // day/night toggle preference
};

// ─── Utility ──────────────────────────────────────────────────────

function generateToken() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2,'0')).join('');
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
  state.token      = localStorage.getItem('wj_token') || generateToken();
  state.workerUrl  = localStorage.getItem('wj_worker') || '';
  state.pageSize   = parseInt(localStorage.getItem('wj_page_size') || '20', 10);
  state.weatherLocs = JSON.parse(localStorage.getItem('wj_weather_locs') || '[]');
  state.weightLbs  = parseFloat(localStorage.getItem('wj_weight')  || '0') || null;
  state.heightIn   = parseFloat(localStorage.getItem('wj_height')  || '0') || null;
  state.ageyears   = parseFloat(localStorage.getItem('wj_age')     || '0') || null;
  state.sex        = localStorage.getItem('wj_sex') || null;
  state.username   = localStorage.getItem('wj_username') || null;
  state.lastSeenFriends = JSON.parse(localStorage.getItem('wj_last_seen') || '{}');
  state.darkMode   = localStorage.getItem('wj_dark') === 'true';
  localStorage.setItem('wj_token', state.token);
}

function saveSettings() {
  localStorage.setItem('wj_token',      state.token);
  localStorage.setItem('wj_worker',     state.workerUrl);
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
}

// ─── Worker API ───────────────────────────────────────────────────

async function workerFetch(path, method = 'GET', body = null) {
  if (!state.workerUrl) throw new Error('Worker URL not configured');
  const url = state.workerUrl.replace(/\/$/, '') + path;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== null) opts.body = JSON.stringify(body);
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
  if (!state.workerUrl) return;
  try {
    // Read existing KV profile first so we don't overwrite fields
    // that exist in KV but are null locally (e.g. on a new browser
    // that hasn't had all fields entered yet).
    let existing = {};
    try { existing = (await kvGet('profile')) || {}; } catch(e) { /* first save */ }

    const merged = {
      username:     state.username    ?? existing.username    ?? null,
      sex:          state.sex         ?? existing.sex         ?? null,
      ageyears:     state.ageyears    ?? existing.ageyears    ?? null,
      heightIn:     state.heightIn    ?? existing.heightIn    ?? null,
      weightLbs:    state.weightLbs   ?? existing.weightLbs   ?? null,
      pageSize:     state.pageSize    ?? existing.pageSize    ?? 20,
      weatherLocs:  state.weatherLocs?.length ? state.weatherLocs : (existing.weatherLocs ?? []),
      friends:      state.friends     ?? existing.friends     ?? [],
      incomingReqs: state.incomingReqs ?? existing.incomingReqs ?? [],
      outgoingReqs: state.outgoingReqs ?? existing.outgoingReqs ?? [],
      darkMode:     state.darkMode     ?? existing.darkMode     ?? false,
    };

    await kvPut('profile', merged);
  } catch(e) {
    console.warn('Profile KV save failed:', e.message);
  }
}

async function loadProfileFromKV() {
  if (!state.workerUrl) return;
  try {
    const profile = await kvGet('profile');
    if (!profile) return;
    // Only overwrite local state if KV has a non-null value.
    // This means local data is never clobbered by nulls from KV.
    if (profile.username   != null) state.username   = profile.username;
    if (profile.sex        != null) state.sex        = profile.sex;
    if (profile.ageyears   != null) state.ageyears   = profile.ageyears;
    if (profile.heightIn   != null) state.heightIn   = profile.heightIn;
    if (profile.weightLbs  != null) state.weightLbs  = profile.weightLbs;
    if (profile.pageSize   != null) state.pageSize   = profile.pageSize;
    if (Array.isArray(profile.weatherLocs) && profile.weatherLocs.length > 0) state.weatherLocs = profile.weatherLocs;
    if (Array.isArray(profile.friends))     state.friends     = profile.friends;
    if (Array.isArray(profile.incomingReqs)) state.incomingReqs = profile.incomingReqs;
    if (Array.isArray(profile.outgoingReqs)) state.outgoingReqs = profile.outgoingReqs;
    if (profile.darkMode != null) state.darkMode = profile.darkMode;
    // Sync merged state to localStorage as cache
    saveSettings();
  } catch(e) {
    console.warn('[Profile KV] load failed:', e.message);
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
        .filter(e => e.visibility === 'friends')
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
  const count = state.incomingReqs.length;
  const badge = document.getElementById('friends-badge');
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : count;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
  // Also update requests tab badge
  const tabBadge = document.getElementById('tab-badge-requests');
  if (count > 0) {
    tabBadge.textContent = count > 9 ? '9+' : count;
    tabBadge.style.display = 'inline-flex';
  } else {
    tabBadge.style.display = 'none';
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
    } catch(e) {
      console.warn('Worker save failed, entry kept in local cache:', e.message);
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
    } catch(e) {
      console.warn('Worker delete failed:', e.message);
    }
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

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
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

  const snap = document.getElementById('toggle-snap').checked;
  const slope = document.getElementById('toggle-slope').checked;

  let routePoints = state.waypoints;

  if (snap && state.workerUrl) {
    try {
      routePoints = await fetchSnappedRoute(state.waypoints);
    } catch(e) {
      console.warn('Snap failed, using straight lines:', e.message);
    }
  }

  if (slope && state.workerUrl) {
    await drawSlopedRoute(routePoints);
  } else {
    const poly = L.polyline(routePoints, { color: '#4a7c59', weight: 4, opacity: 0.85 }).addTo(state.map);
    state.polylines.push(poly);
  }

  // Store the final route points so they can be saved with the entry
  state.lastRoutePoints = routePoints;

  const distMeters = totalDistance(routePoints.map(p => ({ lat: p.lat || p[0], lng: p.lng || p[1] })));
  updateStats(distMeters);

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
  document.getElementById('elevation-profile').style.display = 'none';
  state.elevationData = [];
  state.lastRoutePoints = null;
}

document.getElementById('btn-undo-waypoint').addEventListener('click', () => {
  if (state.waypoints.length === 0) return;
  state.map.removeLayer(state.markers.pop());
  state.waypoints.pop();
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
['toggle-snap','toggle-elevation','toggle-slope'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    if (state.waypoints.length >= 2) updateRoute();
    // Hide elevation profile if elevation toggled off
    if (id === 'toggle-elevation' && !document.getElementById(id).checked) {
      document.getElementById('elevation-profile').style.display = 'none';
    }
    // Hide slope legend if slope toggled off
    const legendEl = document.getElementById('slope-legend');
    if (id === 'toggle-slope') {
      legendEl.style.opacity = document.getElementById('toggle-slope').checked ? '1' : '0.3';
    }
  });
});

// Disable/enable toggles that require the worker based on whether a URL is set.
// Called on page load and whenever settings are saved.
function updateWorkerDependentToggles() {
  const hasWorker = !!state.workerUrl;
  const workerToggles = ['toggle-snap', 'toggle-elevation', 'toggle-slope'];

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
  };

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
  }

  await saveEntry(entry);
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
  if (state.currentPage > totalPages) state.currentPage = totalPages;

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

  const newDot = (entry._isNew && isFriend) ? '<span class="entry-new-dot" title="New"></span>' : '';
  card.innerHTML = `
    <div class="entry-card-header">
      <div class="entry-card-title">${escapeHtml(title)}${newDot}</div>
      <div class="entry-card-date">${formatDate(entry.datetime)}</div>
    </div>
    <div class="entry-card-meta">${tags.join('')}</div>
    ${entry.notes ? `<div class="entry-card-excerpt">${escapeHtml(entry.notes)}</div>` : ''}
  `;

  card.addEventListener('click', () => openViewModal(entry));
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
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        subdomains: 'abcd', maxZoom: 19,
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
          const slope = document.getElementById('toggle-slope').checked;
          if (slope && state.workerUrl && state.elevationData?.length >= 2) {
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
  });
});

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
    showToast('Route deleted');
  });

  openModal('modal-delete-route');
}

// ─── Settings Modal ───────────────────────────────────────────────

function populateSettingsModal() {
  document.getElementById('settings-token').value      = state.token;
  document.getElementById('settings-worker-url').value = state.workerUrl || '';
  document.getElementById('settings-page-size').value  = String(state.pageSize);
  document.getElementById('settings-weight').value     = state.weightLbs || '';
  document.getElementById('settings-height').value     = state.heightIn  || '';
  document.getElementById('settings-age').value        = state.ageyears  || '';
  document.getElementById('settings-sex').value        = state.sex       || '';
  document.getElementById('settings-username').value   = state.username  || '';
  document.getElementById('username-status').textContent = '';
  renderSettingsWeatherLocs();
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

document.getElementById('btn-copy-token').addEventListener('click', () => {
  navigator.clipboard.writeText(state.token).then(() => showToast('Token copied ✓'));
});

document.getElementById('btn-import-token').addEventListener('click', () => {
  const val = document.getElementById('settings-import-token').value.trim();
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(val)) {
    showToast('Invalid token format'); return;
  }
  if (!confirm('Replace your current token? Make sure you have copied it first.')) return;
  state.token = val;
  saveSettings();
  document.getElementById('settings-token').value = val;
  document.getElementById('settings-import-token').value = '';
  showToast('Token updated. Reloading data…');
  loadProfileFromKV().then(() => {
    saveSettings(); // persist downloaded profile to localStorage cache
    loadEntries().then(async () => {
      await loadFriendEntries();
      renderFeed();
      renderSpotlight();
      renderSavedRoutes();
      renderWeatherSidebar();
      updateFriendsBadge();
    });
  });
});

document.getElementById('btn-test-worker').addEventListener('click', async () => {
  const url = document.getElementById('settings-worker-url').value.trim();
  const statusEl = document.getElementById('worker-status');
  if (!url) { statusEl.textContent = 'Enter a URL first'; statusEl.className = 'worker-status err'; return; }
  statusEl.textContent = 'Testing…';
  statusEl.className = 'worker-status';
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/ping');
    const data = await res.json();
    if (data.ok) {
      statusEl.textContent = '✓ Connected';
      statusEl.className = 'worker-status ok';
    } else {
      throw new Error('Unexpected response');
    }
  } catch(e) {
    statusEl.textContent = '✗ Failed: ' + e.message;
    statusEl.className = 'worker-status err';
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
  const newWorkerUrl  = document.getElementById('settings-worker-url').value.trim();
  state.workerUrl  = newWorkerUrl;
  state.pageSize   = parseInt(document.getElementById('settings-page-size').value, 10);
  state.weightLbs  = parseFloat(document.getElementById('settings-weight').value || '0') || null;
  state.heightIn   = parseFloat(document.getElementById('settings-height').value || '0') || null;
  state.ageyears   = parseFloat(document.getElementById('settings-age').value    || '0') || null;
  state.sex        = document.getElementById('settings-sex').value || null;
  // Note: username is saved separately via btn-save-username
  saveSettings();
  saveProfileToKV();
  closeModal('modal-settings');
  showToast('Settings saved ✓');
  renderWeatherSidebar();
  updateWorkerDependentToggles();

  // If a new (or changed) worker URL was entered, silently test it and
  // prompt to migrate any unsynced local entries.
  const workerChanged = newWorkerUrl && newWorkerUrl !== prevWorkerUrl;
  if (workerChanged) {
    try {
      const res  = await fetch(newWorkerUrl.replace(/\/$/, '') + '/ping');
      const data = await res.json();
      if (!data.ok) throw new Error('ping failed');

      // Worker is reachable — pull profile then reload entries
      await loadProfileFromKV();
      // Re-save to localStorage now that profile is populated from KV
      saveSettings();
      await loadEntries();
      await loadFriendEntries();
      renderFeed();
      renderSpotlight();
      renderSavedRoutes();
      renderWeatherSidebar();
      updateWorkerDependentToggles();
      updateFriendsBadge();

      const { count, entries: unsynced } = await countUnsyncedLocalEntries();
      if (count > 0) {
        promptSyncModal(count, unsynced);
      }
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

  // Collect manual + inferred locations
  const manualLocs = state.weatherLocs.filter(l => l.manual);

  // Infer locations from recent journeys (last 3 unique areas)
  const inferredLocs = inferLocationsFromEntries();

  const allLocs = [
    ...manualLocs.map(l => ({ ...l, source: 'manual' })),
    ...inferredLocs.map(l => ({ ...l, source: 'inferred' })),
  ];

  if (allLocs.length === 0) {
    el.innerHTML = '<div class="widget-empty">Add a location to see current conditions.</div>';
    return;
  }

  el.innerHTML = '<div class="widget-empty">Loading conditions…</div>';

  const results = await Promise.all(allLocs.map(loc => fetchWeather(loc)));

  let html = '';
  const manual   = results.filter(r => r.source === 'manual');
  const inferred = results.filter(r => r.source === 'inferred');

  if (manual.length > 0) {
    html += manual.map(renderWeatherLocation).join('');
  }
  if (inferred.length > 0) {
    html += `<div class="weather-section-divider">From recent walks</div>`;
    html += inferred.map(renderWeatherLocation).join('');
  }

  el.innerHTML = html;
}

function inferLocationsFromEntries() {
  const journeys = state.entries
    .filter(e => e.type === 'journey' && e.waypoints && e.waypoints.length > 0)
    .slice(0, 5);

  const seen = new Set();
  const locs = [];
  for (const j of journeys) {
    const wp  = j.waypoints[0];
    const key = `${wp.lat.toFixed(1)},${wp.lng.toFixed(1)}`;
    if (!seen.has(key)) {
      seen.add(key);
      locs.push({ name: j.name || 'Recent walk', lat: wp.lat, lng: wp.lng, manual: false });
      if (locs.length >= 2) break;
    }
  }
  return locs;
}

async function fetchWeather(loc) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lng}`
      + `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,uv_index,weather_code`
      + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;

    const airUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${loc.lat}&longitude=${loc.lng}`
      + `&current=pm10,pm2_5,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen`
      + `&timezone=auto`;

    const [wx, air] = await Promise.all([
      fetch(url).then(r => r.json()),
      fetch(airUrl).then(r => r.json()).catch(() => null),
    ]);

    return { ...loc, wx: wx.current, air: air?.current };
  } catch(e) {
    return { ...loc, wx: null, air: null };
  }
}

function renderWeatherLocation(data) {
  if (!data.wx) return `<div class="weather-location"><div class="weather-loc-name">${escapeHtml(data.name)} <span>Unavailable</span></div></div>`;

  const wx = data.wx;
  const wmoDesc = wmoDescription(wx.weather_code);

  let pollenHtml = '';
  if (data.air) {
    const pollens = [
      { label: 'Tree', val: Math.max(data.air.alder_pollen||0, data.air.birch_pollen||0, data.air.olive_pollen||0) },
      { label: 'Grass', val: data.air.grass_pollen || 0 },
      { label: 'Weed', val: Math.max(data.air.mugwort_pollen||0, data.air.ragweed_pollen||0) },
    ].filter(p => p.val > 0);

    if (pollens.length > 0) {
      pollenHtml = `<div class="pollen-row">${pollens.map(p =>
        `<span class="pollen-badge ${pollenClass(p.val)}">${p.label}: ${pollenLabel(p.val)}</span>`
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

function pollenClass(val) {
  if (val < 10)  return 'pollen-low';
  if (val < 50)  return 'pollen-moderate';
  if (val < 200) return 'pollen-high';
  return 'pollen-vhigh';
}

function pollenLabel(val) {
  if (val < 10)  return 'Low';
  if (val < 50)  return 'Mod';
  if (val < 200) return 'High';
  return 'V.High';
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
  updateFriendsBadge();
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
  const q = document.getElementById('friend-search-input').value.trim().toLowerCase();
  const el = document.getElementById('friend-search-results');
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
  applyDarkMode();  // apply before any KV fetch to avoid flash

  if (state.workerUrl) {
    // Pull profile from KV — merges roaming settings into local state.
    // We do NOT push back on init — that would overwrite KV with whatever
    // happens to be in localStorage at load time, which may be incomplete.
    // Profile is only pushed when the user explicitly saves settings or username.
    await loadProfileFromKV();
    applyDarkMode();  // re-apply in case KV had a different preference
  }

  await loadEntries();
  await loadFriendEntries();

  renderFeed();
  renderSpotlight();
  renderSavedRoutes();
  renderWeatherSidebar();
  updateWorkerDependentToggles();
  updateFriendsBadge();

  // Poll for new friend requests every 60 seconds
  setInterval(refreshFriendsBadge, 60000);
}

init();
