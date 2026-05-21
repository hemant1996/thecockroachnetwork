// Cockroach Relay — reference web client (L3 conformance, multi-relay).
// All crypto is in-browser. The keypair never leaves this device.
// Spec: ../SPEC.md

import * as ed from "https://esm.sh/@noble/ed25519@2.3.0";
import { sha256, sha512 } from "https://esm.sh/@noble/hashes@1.8.0/sha2";
import { PeerPool } from "./peers.js";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// ─── canonical JSON + ids ────────────────────────────────────────────────

const CTRL = { 0x08: "\\b", 0x09: "\\t", 0x0a: "\\n", 0x0c: "\\f", 0x0d: "\\r" };
function esc(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c < 0x20) out += CTRL[c] ?? "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out;
}
function canonScalar(v) { return typeof v === "number" ? v.toString() : `"${esc(v)}"`; }
function canonTags(tags) {
  return "[" + tags.map(t => "[" + t.map(canonScalar).join(",") + "]").join(",") + "]";
}
function canonicalForm(e) {
  return `[0,"${e.pubkey}",${e.created_at},${e.kind},${canonTags(e.tags)},"${esc(e.content)}"]`;
}

function bytesToHex(b) {
  let s = ""; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0"); return s;
}
function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
function eventId(e) { return bytesToHex(sha256(new TextEncoder().encode(canonicalForm(e)))); }
function signEvent(partial, sk) {
  const id = eventId(partial);
  return { ...partial, id, sig: bytesToHex(ed.sign(hexToBytes(id), sk)) };
}

// ─── geohash ─────────────────────────────────────────────────────────────

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
function geohashEncode(lat, lon, precision = 7) {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let bit = 0, ch = 0, even = true, out = "";
  while (out.length < precision) {
    if (even) {
      const m = (lonMin + lonMax) / 2;
      if (lon >= m) { ch = (ch << 1) | 1; lonMin = m; } else { ch = ch << 1; lonMax = m; }
    } else {
      const m = (latMin + latMax) / 2;
      if (lat >= m) { ch = (ch << 1) | 1; latMin = m; } else { ch = ch << 1; latMax = m; }
    }
    even = !even;
    if (++bit === 5) { out += BASE32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

function geohashDecode(hash) {
  if (!hash || typeof hash !== "string") return null;
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let even = true;
  for (const c of hash.toLowerCase()) {
    const idx = BASE32.indexOf(c);
    if (idx < 0) return null;
    for (let mask = 16; mask > 0; mask >>= 1) {
      const bit = (idx & mask) ? 1 : 0;
      if (even) {
        const mid = (lonMin + lonMax) / 2;
        if (bit) lonMin = mid; else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid; else latMax = mid;
      }
      even = !even;
    }
  }
  return {
    lat: (latMin + latMax) / 2,
    lon: (lonMin + lonMax) / 2,
    latErr: (latMax - latMin) / 2,
    lonErr: (lonMax - lonMin) / 2,
  };
}

function formatLatLon(d) {
  const lat = d.lat.toFixed(2);
  const lon = d.lon.toFixed(2);
  return `${Math.abs(lat)}°${d.lat >= 0 ? "N" : "S"}, ${Math.abs(lon)}°${d.lon >= 0 ? "E" : "W"}`;
}

// ─── place-name resolver (OpenStreetMap Nominatim) ───────────────────────
//
// Decoded lat/lon is always available client-side.  Place names ("Mumbai",
// "Bandra West") are a nice-to-have — fetched lazily from Nominatim,
// cached forever in memory + localStorage, and rate-limited to OSM's
// stated 1-request-per-second policy.  The feed re-renders when a name
// arrives so it slots in without page reloads.

const PLACE_CACHE_KEY = "cockroach.places";
const placeCache = (() => {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(PLACE_CACHE_KEY) || "{}"))); }
  catch { return new Map(); }
})();
function persistPlaceCache() {
  try { localStorage.setItem(PLACE_CACHE_KEY, JSON.stringify(Object.fromEntries(placeCache))); } catch {}
}

const placeQueue = [];
const placeInFlight = new Set();
let placeQueueRunning = false;

async function processPlaceQueue() {
  if (placeQueueRunning) return;
  placeQueueRunning = true;
  while (placeQueue.length) {
    const key = placeQueue.shift();
    if (placeCache.has(key)) continue;
    const d = geohashDecode(key);
    if (!d) { placeCache.set(key, null); continue; }
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${d.lat}&lon=${d.lon}&zoom=10&accept-language=${encodeURIComponent(navigator.language || "en")}`;
      const r = await fetch(url, { headers: { "Accept": "application/json" } });
      if (r.ok) {
        const j = await r.json();
        const a = j.address || {};
        const name = a.city || a.town || a.village || a.suburb || a.county || a.state || a.country || (j.display_name?.split(",")[0]) || null;
        const region = a.country_code ? ` · ${a.country_code.toUpperCase()}` : "";
        placeCache.set(key, name ? `${name}${region}` : null);
      } else {
        placeCache.set(key, null);
      }
    } catch { placeCache.set(key, null); }
    placeInFlight.delete(key);
    persistPlaceCache();
    renderFeedDebounced();
    await new Promise(r => setTimeout(r, 1100)); // honor OSM's 1 req/sec policy
  }
  placeQueueRunning = false;
}

function requestPlaceName(geohash) {
  if (!geohash || placeCache.has(geohash) || placeInFlight.has(geohash)) return;
  placeInFlight.add(geohash);
  placeQueue.push(geohash);
  processPlaceQueue();
}

// ─── identity ────────────────────────────────────────────────────────────

const KEY_STORAGE = "cockroach.sk";
function loadOrCreateKey() {
  let skHex = localStorage.getItem(KEY_STORAGE);
  if (!skHex) {
    skHex = bytesToHex(ed.utils.randomPrivateKey());
    localStorage.setItem(KEY_STORAGE, skHex);
  }
  const sk = hexToBytes(skHex);
  return { sk, pkHex: bytesToHex(ed.getPublicKey(sk)) };
}
let { sk, pkHex } = loadOrCreateKey();

// ─── relay pool ──────────────────────────────────────────────────────────
// A client speaks to N relays at once. Publishes fan out. Subscriptions are
// installed on every relay. The event store dedupes by id, so a report
// arriving from three relays is one entry, three confirmations of reach.

const RELAYS_STORAGE = "cockroach.relays";
const RELAY_META_STORAGE = "cockroach.relays.meta";  // url -> { source, addedAt, sourceDetail }
const LEGACY_RELAY_STORAGE = "cockroach.relay"; // pre-multi-relay key

// ─── relay provenance ────────────────────────────────────────────────────
//
// Each known relay carries metadata about how it arrived in the user's
// pool: "seed" (shipped with the client), "user" (manually added), or
// "share" (auto-added when the user opened a share-URL with #relays=...).
// Shown in the Identity tab so the user always knows why a relay is in
// their list and can revoke any source individually.

function loadRelayMeta() {
  try {
    const v = JSON.parse(localStorage.getItem(RELAY_META_STORAGE) || "{}");
    return typeof v === "object" && v ? v : {};
  } catch { return {}; }
}
function saveRelayMeta(meta) {
  localStorage.setItem(RELAY_META_STORAGE, JSON.stringify(meta));
}
function setRelayProvenance(url, source, sourceDetail) {
  const meta = loadRelayMeta();
  if (!meta[url]) {
    meta[url] = { source, addedAt: Date.now(), sourceDetail };
    saveRelayMeta(meta);
  }
}
function getRelayProvenance(url) { return loadRelayMeta()[url] || null; }
function forgetRelayProvenance(url) {
  const meta = loadRelayMeta();
  if (meta[url]) { delete meta[url]; saveRelayMeta(meta); }
}
function formatAgoShort(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

async function loadSeedList() {
  try {
    const r = await fetch("relays.json", { cache: "no-cache" });
    if (r.ok) {
      const data = await r.json();
      const list = Array.isArray(data) ? data : Array.isArray(data?.relays) ? data.relays : [];
      return list.filter(u => typeof u === "string" && u.startsWith("ws"));
    }
  } catch { /* no seed file shipped with this host */ }
  return [];
}

async function loadRelayList() {
  // 1. Migrate legacy single-relay key if present.
  const legacy = localStorage.getItem(LEGACY_RELAY_STORAGE);
  if (legacy && !localStorage.getItem(RELAYS_STORAGE)) {
    localStorage.setItem(RELAYS_STORAGE, JSON.stringify([legacy]));
    localStorage.removeItem(LEGACY_RELAY_STORAGE);
  }
  // 2. User's stored list, if any.
  const stored = localStorage.getItem(RELAYS_STORAGE);
  if (stored) {
    try {
      const arr = JSON.parse(stored);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch { /* fall through */ }
  }
  // 3. Seed list shipped with this mirror.
  const seeds = await loadSeedList();
  if (seeds.length) {
    localStorage.setItem(RELAYS_STORAGE, JSON.stringify(seeds));
    const meta = loadRelayMeta();
    for (const url of seeds) if (!meta[url]) meta[url] = { source: "seed", addedAt: Date.now() };
    saveRelayMeta(meta);
    return seeds;
  }
  // 4. Local dev fallback.
  const fallback = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname || "localhost"}:7447`;
  return [fallback];
}

function saveRelayList(urls) {
  localStorage.setItem(RELAYS_STORAGE, JSON.stringify(urls));
}

class RelayPool {
  constructor() {
    this.relays = new Map();   // url -> { ws, state, reconnectTimer, reconnectDelay }
    this.subs = new Map();     // subId -> { filters }
    this.listeners = new Set();
    this.onEvent = null;       // (event, fromUrl) => void
    this.onOk = null;          // (id, accepted, reason, fromUrl) => void
  }

  list() { return [...this.relays.keys()]; }

  status() {
    return [...this.relays.entries()].map(([url, r]) => ({ url, state: r.state }));
  }

  connectedCount() {
    let n = 0;
    for (const r of this.relays.values()) if (r.state === "connected") n++;
    return n;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const f of this.listeners) try { f(this.status()); } catch {} }

  add(url) {
    if (!url || this.relays.has(url)) return;
    this.relays.set(url, { ws: null, state: "connecting", reconnectTimer: null, reconnectDelay: 1000 });
    this._connect(url);
    this.emit();
    saveRelayList([...this.relays.keys()]);
  }

  remove(url) {
    const r = this.relays.get(url);
    if (!r) return;
    clearTimeout(r.reconnectTimer);
    try { r.ws?.close(); } catch {}
    this.relays.delete(url);
    this.emit();
    saveRelayList([...this.relays.keys()]);
  }

  _connect(url) {
    const r = this.relays.get(url);
    if (!r) return;
    r.state = "connecting";
    this.emit();
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { r.state = "error"; this._scheduleReconnect(url); this.emit(); return; }
    r.ws = ws;
    ws.addEventListener("open", () => {
      r.state = "connected";
      r.reconnectDelay = 1000;
      this.emit();
      for (const [subId, sub] of this.subs) {
        try { ws.send(JSON.stringify(["REQ", subId, ...sub.filters])); } catch {}
      }
      // SPEC §4.9: opportunistically tell the relay about every other relay we
      // know.  The relay records these as candidate peers and (if configured
      // to auto-discover) opens its own subscription to them — this is what
      // prevents siloed feeds.  We don't include ourselves.
      try {
        const known = [...this.relays.keys()].filter(u => u !== url);
        if (known.length) ws.send(JSON.stringify(["PEERS", ...known]));
      } catch {}
    });
    ws.addEventListener("close", () => {
      r.state = "disconnected";
      this.emit();
      this._scheduleReconnect(url);
    });
    ws.addEventListener("error", () => {
      r.state = "error";
      this.emit();
    });
    ws.addEventListener("message", (ev) => this._onMessage(url, ev));
  }

  _scheduleReconnect(url) {
    const r = this.relays.get(url);
    if (!r) return;
    clearTimeout(r.reconnectTimer);
    r.reconnectTimer = setTimeout(() => this._connect(url), r.reconnectDelay);
    r.reconnectDelay = Math.min(r.reconnectDelay * 2, 30000);
  }

  _onMessage(url, ev) {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (!Array.isArray(msg)) return;
    const verb = msg[0];
    if (verb === "EVENT") {
      const [, , e] = msg;
      if (this.onEvent) this.onEvent(e, url);
    } else if (verb === "OK") {
      const [, id, accepted, reason] = msg;
      if (this.onOk) this.onOk(id, accepted, reason, url);
    } else if (verb === "NOTICE") {
      console.log(`[${url}] notice:`, msg[1]);
    }
    // EOSE is per-relay; we don't surface it (UI doesn't need it with N relays).
  }

  publish(event) {
    let sent = 0;
    for (const r of this.relays.values()) {
      if (r.state === "connected" && r.ws) {
        try { r.ws.send(JSON.stringify(["EVENT", event])); sent++; } catch {}
      }
    }
    return sent;
  }

  subscribe(subId, filters) {
    this.subs.set(subId, { filters });
    for (const r of this.relays.values()) {
      if (r.state === "connected" && r.ws) {
        try { r.ws.send(JSON.stringify(["REQ", subId, ...filters])); } catch {}
      }
    }
  }

  unsubscribe(subId) {
    this.subs.delete(subId);
    for (const r of this.relays.values()) {
      if (r.state === "connected" && r.ws) {
        try { r.ws.send(JSON.stringify(["CLOSE", subId])); } catch {}
      }
    }
  }
}

const pool = new RelayPool();

// ─── event store ─────────────────────────────────────────────────────────

const events = new Map();         // id -> event
const verifications = new Map();  // reportId -> [verification]
const SUB_FEED = "feed";

function ingest(e) {
  if (events.has(e.id)) return false;
  events.set(e.id, e);
  if (e.kind === 2) {
    const targetTag = e.tags.find(t => t[0] === "e");
    if (targetTag) {
      const tid = targetTag[1];
      if (!verifications.has(tid)) verifications.set(tid, []);
      verifications.get(tid).push(e);
    }
  }
  return true;
}

// Verify an event's id + signature.  Relays validate on receipt, but events
// gossiped over WebRTC peer channels haven't been through a relay, so the
// peer mesh must verify locally before ingesting.  Otherwise a malicious peer
// could inject arbitrary events into our store.
function verifyEvent(e) {
  if (!e || typeof e !== "object") return false;
  if (typeof e.id !== "string" || e.id.length !== 64 || !/^[0-9a-f]+$/.test(e.id)) return false;
  if (typeof e.pubkey !== "string" || e.pubkey.length !== 64 || !/^[0-9a-f]+$/.test(e.pubkey)) return false;
  if (typeof e.sig !== "string" || e.sig.length !== 128 || !/^[0-9a-f]+$/.test(e.sig)) return false;
  if (typeof e.created_at !== "number" || !Number.isInteger(e.created_at) || e.created_at < 0) return false;
  if (typeof e.kind !== "number" || !Number.isInteger(e.kind) || e.kind < 0) return false;
  if (typeof e.content !== "string") return false;
  if (!Array.isArray(e.tags)) return false;
  for (const t of e.tags) {
    if (!Array.isArray(t) || !t.every(x => typeof x === "string")) return false;
  }
  if (eventId(e) !== e.id) return false;
  try {
    return ed.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch { return false; }
}

// Sign an event and return it (synchronous wrapper used by PeerPool for
// signaling events — kinds 10001/10002/10003).
function signEventReturn(kind, tags, content) {
  return signEvent({
    pubkey: pkHex,
    created_at: Math.floor(Date.now() / 1000),
    kind,
    tags,
    content,
  }, sk);
}

// WebRTC peer-relay mesh.  Off by default (IP exposure risk).  Users opt in
// via the Identity tab with explicit consent.  Peers find each other via
// signaling events broadcast through the relay layer (kinds 10001 offer,
// 10002 answer, 10003 ice — see SPEC §4.3 and docs/v0.2-webrtc-peer-relay.md).
const peers = new PeerPool({
  pubkeyHex: pkHex,
  signAndReturn: async (kind, tags, content) => signEventReturn(kind, tags, content),
  publishToRelays: (event) => pool.publish(event),
  onEventFromPeer: (event) => {
    if (!verifyEvent(event)) return;       // never trust an unverified peer event
    if (event.kind === 10001 || event.kind === 10002 || event.kind === 10003) return; // peer-layer events stay peer-layer
    if (ingest(event)) {
      renderFeedDebounced();
      pool.publish(event);                 // gossip to relays too — closes the mesh-to-relay bridge
    }
  },
});

pool.onEvent = (e) => {
  // Route signaling kinds to the peer pool; everything else into the local store.
  if (e.kind === 10001 || e.kind === 10002 || e.kind === 10003) {
    peers.handleSignaling(e);
    return;
  }
  if (ingest(e)) renderFeedDebounced();
};
pool.onOk = (id, accepted, reason, url) => {
  if (!accepted) toast(t("toast.relay_rejected", { host: shortUrl(url), reason }));
};

// ─── publishing ──────────────────────────────────────────────────────────

function publishReport({ content, tags, lat, lon, precision }) {
  const allTags = [
    ["g", geohashEncode(lat, lon, precision)],
    ...tags.map(t => ["t", t]),
    ["lang", navigator.language?.split("-")[0] || "en"],
  ];
  const partial = {
    pubkey: pkHex,
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: allTags,
    content,
  };
  const event = signEvent(partial, sk);
  ingest(event);
  const sent = pool.publish(event);
  const peerSent = peers.broadcast(event);
  showPublishConfirmation(sent, peerSent);
  return event;
}

// "What just happened?" — the visible signal that this network is different.
// First time: a modal explainer (signed → relays → peers → permanent).
// After that: a small slide-in card showing the same fan-out, briefly.
function showPublishConfirmation(relayCount, peerCount) {
  const FIRST_KEY = "cockroach.first_publish_seen";
  const isFirst = !localStorage.getItem(FIRST_KEY);

  if (isFirst) {
    localStorage.setItem(FIRST_KEY, "1");
    const modal = $("#publish-explainer");
    if (modal) {
      $("#explainer-relays").textContent = relayCount;
      $("#explainer-peers").textContent = peerCount;
      $("#explainer-peers-block").style.display = peerCount > 0 ? "" : "none";
      modal.hidden = false;
    }
    return;
  }

  const ptoast = $("#publish-toast");
  if (!ptoast) return;
  const peerLine = peerCount > 0
    ? `<div class="pt-step pt-peers">⤳ Fanned out to <b>${peerCount}</b> peer${peerCount === 1 ? "" : "s"}</div>`
    : "";
  const relayLine = relayCount === 0
    ? `<div class="pt-step pt-fail">⚠ No relay reachable — held locally, will retry</div>`
    : `<div class="pt-step">↗ Sent to <b>${relayCount}</b> relay${relayCount === 1 ? "" : "s"}</div>`;
  ptoast.innerHTML = `
    <div class="pt-step pt-signed">✓ <b>Signed</b> with your key</div>
    ${relayLine}
    ${peerLine}
    <div class="pt-step pt-permanent">✓ Permanent record</div>
  `;
  ptoast.classList.add("show");
  clearTimeout(window.__pubToastTimer);
  window.__pubToastTimer = setTimeout(() => ptoast.classList.remove("show"), 3500);
}

function publishVerification(reportId, verdict, note = "") {
  const partial = {
    pubkey: pkHex,
    created_at: Math.floor(Date.now() / 1000),
    kind: 2,
    tags: [["e", reportId], ["v", verdict]],
    content: note,
  };
  const event = signEvent(partial, sk);
  ingest(event);
  pool.publish(event);
  peers.broadcast(event);
  return event;
}

// ─── reputation ──────────────────────────────────────────────────────────

// Per SPEC §4.2: at most one verification per (verifier_pubkey, report_id).
// When multiple events exist, the one with the greatest created_at wins;
// ties broken by lower id.  This MUST run before counting verifiers,
// otherwise the same pubkey clicking "fake" three times satisfies a
// "≥3 distinct verifiers" check, which is what was happening before.
function dedupeVerifiers(vs) {
  const latest = new Map();
  for (const v of vs) {
    const cur = latest.get(v.pubkey);
    if (!cur
        || v.created_at > cur.created_at
        || (v.created_at === cur.created_at && v.id < cur.id)) {
      latest.set(v.pubkey, v);
    }
  }
  return latest;
}

function consensusVerdict(reportId) {
  const vs = verifications.get(reportId) || [];
  const latest = dedupeVerifiers(vs);
  // Per SPEC §8: ≥3 DISTINCT verifiers required for consensus.
  if (latest.size < 3) return null;
  const counts = {};
  for (const v of latest.values()) {
    const verdict = v.tags.find(t => t[0] === "v")?.[1];
    if (verdict) counts[verdict] = (counts[verdict] || 0) + 1;
  }
  if (Object.keys(counts).length === 0) return null;
  // Modal verdict; deterministic tiebreaking by alphabetical verdict name.
  const sorted = Object.entries(counts).sort(([a, an], [b, bn]) => bn - an || a.localeCompare(b));
  return sorted[0][0];
}

function verdictCounts(reportId) {
  const vs = verifications.get(reportId) || [];
  const latest = dedupeVerifiers(vs);
  const counts = {};
  for (const v of latest.values()) {
    const verdict = v.tags.find(t => t[0] === "v")?.[1];
    if (verdict) counts[verdict] = (counts[verdict] || 0) + 1;
  }
  return counts;
}

// Semantic mapping for the consensus display.  "true" and "resolved" are
// positive outcomes (green); "fake" is a negative outcome (red);
// "needs-more-proof" is uncertain (yellow); "duplicate" is neutral.
const VERDICT_KIND = {
  "true": "good", "resolved": "good",
  "fake": "bad",
  "duplicate": "neutral", "needs-more-proof": "warn",
};
const VERDICT_ICON = {
  "true": "✓", "resolved": "✓",
  "fake": "✗",
  "duplicate": "⇿", "needs-more-proof": "⚠",
};

// ─── UI helpers ──────────────────────────────────────────────────────────

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
function shortUrl(u) { try { return new URL(u).host; } catch { return u; } }
function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Short readable ID — first 4 hex chars of the pubkey, "#abcd".
function shortId(pubkey) { return "#" + pubkey.slice(0, 4); }

// Deterministic cockroach avatar — color derived from the pubkey hash,
// inline SVG so there's no avatar server and no network round-trip.  The
// avatar IS the identity; same key always renders the same circle.
function avatarSvg(pubkey, size = 30) {
  const hue   = (parseInt(pubkey.slice(0, 2), 16) / 255) * 360;
  const sat   = 60 + (parseInt(pubkey.slice(2, 4), 16) / 255) * 30;
  const light = 45 + (parseInt(pubkey.slice(4, 6), 16) / 255) * 18;
  const bg = `hsl(${hue.toFixed(0)} ${sat.toFixed(0)}% ${light.toFixed(0)}%)`;
  const fg = light > 56 ? "#0a0a0a" : "#ffffff";
  return `<svg class="feed-avatar" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="16" cy="16" r="16" fill="${bg}"/>
    <ellipse cx="16" cy="20" rx="6.5" ry="8.5" fill="${fg}"/>
    <ellipse cx="16" cy="11.5" rx="3.5" ry="3" fill="${fg}"/>
    <path d="M 13.6 9.5 Q 11.2 6.5 8.8 6" fill="none" stroke="${fg}" stroke-width="1" stroke-linecap="round"/>
    <path d="M 18.4 9.5 Q 20.8 6.5 23.2 6" fill="none" stroke="${fg}" stroke-width="1" stroke-linecap="round"/>
  </svg>`;
}

// Convert a relay's WS(S) URL to its HTTP(S) origin for permalink rendering.
function relayHttpOrigin(wsUrl) {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    return u.origin;
  } catch { return null; }
}

// Pick the best relay URL to use as the share-permalink host: prefer a
// connected wss:// relay (so the link works from any social platform), fall
// back to any connected relay, fall back to any known relay.
function shareableRelay() {
  const status = pool.status();
  const tls = status.find(s => s.state === "connected" && s.url.startsWith("wss://"));
  if (tls) return tls.url;
  const any = status.find(s => s.state === "connected");
  if (any) return any.url;
  return status[0]?.url || null;
}

function shareUrlFor(eventId) {
  const r = shareableRelay();
  if (!r) return null;
  const origin = relayHttpOrigin(r);
  if (!origin) return null;
  // SPEC §4.9: append #relays=<primary> so a recipient opening the link
  // auto-discovers our primary relay.  Hash fragment is not sent in HTTP
  // requests, so this stays out of server logs and Referer headers.
  return `${origin}/r/${eventId}#relays=${encodeURIComponent(r)}`;
}

// SPEC §4.9 — parse the share-URL #relays=<comma-separated wss:// urls>
// fragment on app load.  For each URL: health-check the relay's /info,
// verify it returns the canonical cockroach-relay JSON, then add to the
// pool tagged with provenance.  Clears the hash after processing so a
// reload doesn't re-trigger the same add.
async function processShareHashDiscovery() {
  const hash = location.hash || "";
  const m = hash.match(/relays=([^&]+)/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  let raw;
  try { raw = decodeURIComponent(m[1]); } catch { return; }
  const urls = raw.split(",").map(s => s.trim()).filter(u => /^wss?:\/\//.test(u));

  // Try to pull a short event-id from /r/<id> in the path so the provenance
  // line ("via share from #abcd") points at the actual content the user
  // followed in.
  const evMatch = location.pathname.match(/\/r\/([a-f0-9]{16,64})/);
  const sourceDetail = evMatch ? "#" + evMatch[1].slice(0, 4) : "share";

  for (const url of urls) {
    if (pool.list().includes(url)) continue;
    const ok = await verifyRelayUrl(url);
    if (!ok) continue;
    setRelayProvenance(url, "share", sourceDetail);
    pool.add(url);
  }
}

async function verifyRelayUrl(wsUrl) {
  try {
    const httpUrl = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(httpUrl, { signal: ctl.signal, cache: "no-cache" });
    clearTimeout(t);
    if (!r.ok) return false;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) return false;
    const j = await r.json();
    return j && typeof j === "object" && j.name === "cockroach-relay";
  } catch { return false; }
}

// ─── i18n ────────────────────────────────────────────────────────────────

const LANG_STORAGE = "cockroach.lang";
const SUPPORTED_LANGS = ["en", "hi"];
let strings = {};

async function loadLang(code) {
  try {
    const r = await fetch(`lang/${code}.json`, { cache: "no-cache" });
    if (r.ok) return await r.json();
  } catch { /* fall through */ }
  return null;
}

async function initLang() {
  let code = localStorage.getItem(LANG_STORAGE);
  if (!code) {
    const nav = (navigator.language || "en").toLowerCase();
    code = SUPPORTED_LANGS.find(l => nav.startsWith(l)) || "en";
  }
  let loaded = await loadLang(code);
  if (!loaded && code !== "en") { loaded = await loadLang("en"); code = "en"; }
  strings = loaded || {};
  document.documentElement.lang = code;
  return code;
}

function t(key, params = {}) {
  let s = strings[key] != null ? strings[key] : key;
  for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
  return s;
}

function applyTranslations() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}

const screens = ["compose", "feed", "about"];
function showScreen(name) {
  for (const s of screens) {
    $(`#screen-${s}`).classList.toggle("active", s === name);
    $(`#tab-${s}`).classList.toggle("active", s === name);
  }
  if (name === "feed") renderFeed();
  if (name === "about") renderRelayList();
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

function fmtTimeAgo(unix) {
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ─── status indicator (header) ───────────────────────────────────────────

function updateStatus() {
  const all = pool.status();
  const connected = pool.connectedCount();
  $("#status").textContent = all.length === 0
    ? t("status.no_relays")
    : t("status.connected_count", { n: connected, m: all.length });
  const dot = $("#live-dot");
  dot.classList.toggle("live", connected > 0);
  dot.classList.toggle("warn", connected === 0 && all.length > 0);
}

pool.on(() => {
  updateStatus();
  if ($("#screen-about").classList.contains("active")) renderRelayList();
});

// ─── feed render ─────────────────────────────────────────────────────────

let renderTimer;
function renderFeedDebounced() { clearTimeout(renderTimer); renderTimer = setTimeout(renderFeed, 80); }

function renderFeed() {
  const container = $("#feed-list");
  const reports = [...events.values()]
    .filter(e => e.kind === 1)
    .sort((a, b) => b.created_at - a.created_at);

  if (reports.length === 0) {
    container.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="6" x2="12" y2="12"/></svg>
      <div>${escapeHTML(t("feed.empty"))}</div>
    </div>`;
    return;
  }

  container.innerHTML = reports.map(r => {
    const tags = r.tags.filter(t => t[0] === "t").map(t => t[1]);
    const geo = r.tags.find(t => t[0] === "g")?.[1] || "";
    const decoded = geo ? geohashDecode(geo) : null;
    const cachedPlace = geo ? placeCache.get(geo) : null;
    if (geo && decoded && cachedPlace === undefined) requestPlaceName(geo);

    let locHTML = "";
    if (decoded) {
      const label = cachedPlace || formatLatLon(decoded);
      const mapUrl = `https://www.openstreetmap.org/?mlat=${decoded.lat.toFixed(5)}&mlon=${decoded.lon.toFixed(5)}#map=14/${decoded.lat.toFixed(5)}/${decoded.lon.toFixed(5)}`;
      const titleAttr = `${formatLatLon(decoded)} · geohash ${geo} · OpenStreetMap`;
      locHTML = `<a class="loc" data-geo="${escapeHTML(geo)}" href="${escapeHTML(mapUrl)}" target="_blank" rel="noopener" title="${escapeHTML(titleAttr)}"><span class="loc-pin">📍</span><span class="loc-name">${escapeHTML(label)}</span></a>`;
    } else if (geo) {
      locHTML = `<span class="loc" title="geohash">📍 ${escapeHTML(geo)}</span>`;
    }

    const counts = verdictCounts(r.id);
    const cv = consensusVerdict(r.id);
    const totalVerifs = Object.values(counts).reduce((a, b) => a + b, 0);

    // Verdict label respecting the current language; fall back to the raw verdict.
    const verdictLabel = (v) => {
      const tr = t("verdict." + v);
      return tr === "verdict." + v ? v : tr;
    };
    // Compact counts line — shows all non-zero verdicts in their semantic color.
    const countsHTML = Object.entries(counts).map(([k, n]) => {
      const kind = VERDICT_KIND[k] || "neutral";
      return `<span class="score-count score-${kind}">${VERDICT_ICON[k] || ""} ${escapeHTML(verdictLabel(k))} <b>${n}</b></span>`;
    }).join("");

    // Hide the score line completely when nothing has been verified yet.
    let scoreHTML = "";
    if (cv) {
      // Consensus reached — show the verdict with its semantic icon + color.
      const kind = VERDICT_KIND[cv] || "neutral";
      const icon = VERDICT_ICON[cv] || "·";
      scoreHTML = `<div class="score">
        <b class="score-consensus score-${kind}">${icon} ${escapeHTML(verdictLabel(cv))}</b>
        ${countsHTML}
      </div>`;
    } else if (totalVerifs > 0) {
      // Pre-consensus — show progress in muted accent.
      scoreHTML = `<div class="score">
        <span class="score-progress">${totalVerifs}/3 ${escapeHTML(t("feed.awaiting_verifications") || "verified")}</span>
        ${countsHTML}
      </div>`;
    }

    return `
      <div class="report-card" data-id="${r.id}">
        <div class="card-head">
          <span class="avatar-wrap" title="${r.pubkey}">${avatarSvg(r.pubkey, 30)}</span>
          <div class="meta">
            <span class="id mono" title="${r.pubkey}">${shortId(r.pubkey)}</span>
            ${locHTML ? `<span class="dot">·</span>${locHTML}` : ""}
            <span class="dot">·</span>
            <span class="time">${fmtTimeAgo(r.created_at)}</span>
            ${r.pubkey === pkHex ? `<span class="you-tag">${escapeHTML(t("feed.you"))}</span>` : ""}
          </div>
        </div>
        <div class="content">${escapeHTML(r.content)}</div>
        ${tags.length ? `<div class="tags">${tags.map(t => `<span>#${escapeHTML(t)}</span>`).join("")}</div>` : ""}
        ${scoreHTML}
        <div class="verify-row">
          ${["true", "duplicate", "resolved", "fake", "needs-more-proof"]
            .map(v => `<button data-verdict="${v}">${escapeHTML(t("verdict." + v))}</button>`).join("")}
          <button class="share-btn" data-action="share" title="${escapeHTML(t("feed.share_title"))}">${escapeHTML(t("feed.share"))}</button>
        </div>
      </div>`;
  }).join("");
}

// ─── relay list (Identity tab) ───────────────────────────────────────────

function renderRelayList() {
  const list = $("#relay-list");
  const status = pool.status();
  if (status.length === 0) {
    list.innerHTML = `<div style="color:var(--muted);font-size:14px">${escapeHTML(t("identity.no_relays_hint"))}</div>`;
    return;
  }
  list.innerHTML = status.map(({ url, state }) => {
    const prov = getRelayProvenance(url);
    let provHtml = "";
    if (prov) {
      const ago = formatAgoShort(Date.now() - (prov.addedAt || Date.now()));
      const label =
        prov.source === "share" ? `via share ${prov.sourceDetail || ""} · ${ago} ago` :
        prov.source === "seed"  ? "seed list" :
        prov.source === "user"  ? `added manually · ${ago} ago` :
        "";
      if (label) provHtml = `<div class="relay-prov mono">${escapeHTML(label)}</div>`;
    }
    return `<div class="relay-row" data-url="${escapeHTML(url)}">
      <span class="dot ${state}" title="${state}"></span>
      <div class="relay-info">
        <div class="relay-url mono">${escapeHTML(url)}</div>
        ${provHtml}
      </div>
      <button class="remove-relay ghost small" aria-label="remove">×</button>
    </div>`;
  }).join("");
}

// ─── geo ─────────────────────────────────────────────────────────────────

let lastFix = null;
function fetchLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("geolocation unavailable"));
    navigator.geolocation.getCurrentPosition(
      pos => { lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy }; resolve(lastFix); },
      err => reject(err),
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 8000 }
    );
  });
}

// ─── wiring ──────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", async () => {
  // Language first — every other UI string depends on this resolving.
  const currentLang = await initLang();
  applyTranslations();
  // Reflect current selection in the language picker (added in Identity tab).
  const langSel = $("#lang-select");
  if (langSel) langSel.value = currentLang;

  // Tabs
  for (const s of screens) $(`#tab-${s}`).addEventListener("click", () => showScreen(s));

  // Compose
  const composeBtn = $("#btn-publish");
  const composeText = $("#compose-content");
  const composeTagInput = $("#compose-tag-input");
  const tagPills = $("#tag-pills");
  const geoLine = $("#geo-line");
  const precSel = $("#geo-precision");

  const DEFAULT_TAGS = ["mainbhicockroach", "paperleak", "unemployment", "road", "harassment", "election", "corruption", "scam", "outage", "protest"];

  // A "main bhi cockroach" / "I am cockroach" phrase in the content auto-adds
  // the canonical #mainbhicockroach tag — so users who just write the
  // declaration without picking the hashtag still show up on the live wall.
  const COCKROACH_PHRASE_RE = /\b(?:main\s+bhi|i\s+am(?:\s+(?:a|the))?|we\s+are(?:\s+all)?|hum(?:\s+sab)?)\s+cockroach(?:es)?\b/i;
  const selectedTags = new Set();
  function renderTagPills() {
    tagPills.innerHTML = "";
    const all = new Set([...DEFAULT_TAGS, ...selectedTags]);
    for (const t of all) {
      const el = document.createElement("span");
      el.className = "pill" + (selectedTags.has(t) ? " selected" : "");
      el.textContent = `#${t}`;
      el.addEventListener("click", () => {
        if (selectedTags.has(t)) selectedTags.delete(t); else selectedTags.add(t);
        renderTagPills();
      });
      tagPills.appendChild(el);
    }
  }
  renderTagPills();

  composeTagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const t = composeTagInput.value.trim().replace(/^#/, "").replace(/\s+/g, "-").toLowerCase();
      if (t) { selectedTags.add(t); renderTagPills(); composeTagInput.value = ""; }
    }
  });

  async function refreshGeo() {
    geoLine.textContent = t("compose.locating");
    try {
      const fix = await fetchLocation();
      const gh = geohashEncode(fix.lat, fix.lon, Number(precSel.value));
      geoLine.innerHTML = `${fix.lat.toFixed(4)}, ${fix.lon.toFixed(4)} → <code>${gh}</code> <span style="opacity:0.5">±${Math.round(fix.acc)}m</span>`;
    } catch (e) {
      geoLine.textContent = t("compose.location_error", { msg: e.message });
    }
  }
  $("#btn-locate").addEventListener("click", refreshGeo);
  precSel.addEventListener("change", refreshGeo);

  composeBtn.addEventListener("click", async () => {
    if (!lastFix) {
      try { await fetchLocation(); } catch { toast(t("compose.error.no_fix")); return; }
    }
    const content = composeText.value.trim();
    if (!content) { toast(t("compose.error.empty")); return; }
    // If the user wrote a "main bhi cockroach" declaration in the content,
    // make sure the canonical tag is attached even if they didn't pick it.
    if (COCKROACH_PHRASE_RE.test(content)) selectedTags.add("mainbhicockroach");
    if (selectedTags.size === 0) { toast(t("compose.error.no_tag")); return; }
    composeBtn.disabled = true;
    try {
      publishReport({
        content,
        tags: [...selectedTags],
        lat: lastFix.lat, lon: lastFix.lon,
        precision: Number(precSel.value),
      });
      composeText.value = "";
      showScreen("feed");
    } finally { composeBtn.disabled = false; }
  });

  // Feed buttons (verify + share, delegated)
  $("#feed-list").addEventListener("click", async (e) => {
    const card = e.target.closest(".report-card");
    if (!card) return;
    const reportId = card.dataset.id;
    if (!reportId) return;

    const shareBtn = e.target.closest('button[data-action="share"]');
    if (shareBtn) {
      const url = shareUrlFor(reportId);
      if (!url) { toast(t("share.no_relay")); return; }
      const data = { title: t("share.title"), text: t("share.text"), url };
      if (navigator.share) {
        try { await navigator.share(data); return; } catch { /* user cancelled */ }
      }
      try {
        await navigator.clipboard.writeText(url);
        toast(t("share.copied"));
      } catch {
        prompt(t("share.copy_manual"), url);
      }
      return;
    }

    const vBtn = e.target.closest("button[data-verdict]");
    if (!vBtn) return;
    vBtn.disabled = true;
    try {
      publishVerification(reportId, vBtn.dataset.verdict);
      toast(t("toast.signed_verdict", { verdict: vBtn.dataset.verdict }));
    } finally { vBtn.disabled = false; }
  });

  // Identity tab
  $("#about-pubkey").textContent = pkHex;
  $("#about-regenerate").addEventListener("click", () => {
    if (!confirm(t("identity.regen_confirm"))) return;
    localStorage.removeItem(KEY_STORAGE);
    location.reload();
  });
  $("#about-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ secret_key_hex: bytesToHex(sk), public_key_hex: pkHex }, null, 2)],
      { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cockroach-key-${pkHex.slice(0, 8)}.json`;
    a.click();
  });

  // Relay management
  $("#add-relay-btn").addEventListener("click", () => {
    const input = $("#add-relay-input");
    const url = input.value.trim();
    if (!url) return;
    if (!/^wss?:\/\//.test(url)) { toast(t("compose.error.invalid_relay_url")); return; }
    setRelayProvenance(url, "user");
    pool.add(url);
    input.value = "";
    renderRelayList();
  });
  $("#add-relay-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#add-relay-btn").click();
  });
  $("#relay-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".remove-relay");
    if (!btn) return;
    const row = btn.closest(".relay-row");
    const url = row?.dataset.url;
    if (!url) return;
    if (!confirm(t("identity.remove_confirm", { url }))) return;
    pool.remove(url);
    forgetRelayProvenance(url);
    renderRelayList();
  });
  $("#reset-relays").addEventListener("click", async () => {
    if (!confirm(t("identity.reset_confirm"))) return;
    for (const url of pool.list()) pool.remove(url);
    localStorage.removeItem(RELAYS_STORAGE);
    const list = await loadRelayList();
    for (const url of list) pool.add(url);
    renderRelayList();
  });

  // Language picker (Identity tab)
  if (langSel) {
    langSel.addEventListener("change", () => {
      localStorage.setItem(LANG_STORAGE, langSel.value);
      location.reload();
    });
  }

  // Service worker (PWA install + offline shell)
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => { /* offline support is best-effort */ });
  }

  // First-publish explainer dismiss
  const explainerOk = $("#explainer-ok");
  if (explainerOk) explainerOk.addEventListener("click", () => {
    $("#publish-explainer").hidden = true;
  });
  const explainerOverlay = $("#publish-explainer");
  if (explainerOverlay) explainerOverlay.addEventListener("click", (e) => {
    if (e.target === explainerOverlay) explainerOverlay.hidden = true;
  });

  // ─── Peer mode toggle (v0.2 WebRTC mesh) ──────────────────────────────
  const PEER_PREF_KEY = "cockroach.peer_enabled";
  const peerToggle = $("#peer-toggle");
  const peerStatusEl = $("#peer-status");
  const peerIndicator = $("#peer-indicator");
  const peerDot = $("#peer-dot");
  const peerCount = $("#peer-count");

  function updatePeerStatus() {
    const s = peers.status();
    if (peerStatusEl) {
      peerStatusEl.textContent = !s.enabled ? "off"
        : s.connected > 0 ? `connected to ${s.connected} of ${s.total} peers`
        : s.total > 0 ? `connecting to ${s.total} peers…`
        : "searching for peers…";
    }
    if (peerIndicator) peerIndicator.style.display = s.enabled ? "" : "none";
    if (peerCount) peerCount.textContent = `${s.connected} peer${s.connected === 1 ? "" : "s"}`;
    if (peerDot) {
      peerDot.classList.toggle("live", s.connected > 0);
      peerDot.classList.toggle("warn", s.enabled && s.connected === 0);
    }
  }
  peers.on(updatePeerStatus);

  // Peer mode is ON by default — every PWA install joins the mesh on first
  // load.  Users can explicitly disable in the Identity tab; the explicit
  // disable persists across reloads.  The localStorage value semantics:
  //   "0"  → explicitly disabled (do not auto-enable)
  //   "1"  → explicitly enabled
  //   null → default (auto-enable)
  const PEER_DISCLOSED_KEY = "cockroach.peer_disclosed";

  if (peerToggle) {
    peerToggle.addEventListener("change", async () => {
      if (peerToggle.checked) {
        localStorage.setItem(PEER_PREF_KEY, "1");
        try { await peers.enable(); } catch (e) { toast("peer mode failed: " + (e?.message || e)); peerToggle.checked = false; }
      } else {
        peers.disable();
        localStorage.setItem(PEER_PREF_KEY, "0"); // explicit off, won't auto-enable
      }
      updatePeerStatus();
    });

    const peerPref = localStorage.getItem(PEER_PREF_KEY);
    const shouldAutoEnable = peerPref !== "0"; // null or "1" → on

    if (shouldAutoEnable) {
      peerToggle.checked = true;
      // First-time disclosure as a non-blocking toast.
      if (!localStorage.getItem(PEER_DISCLOSED_KEY)) {
        setTimeout(() => {
          toast("Peer mode on — your device is now part of the mesh. IP exposed to peers. Disable in Identity tab anytime.");
          localStorage.setItem(PEER_DISCLOSED_KEY, "1");
        }, 1800);
      }
      // Defer enable until at least one relay is connected; signaling rides
      // on the relay layer.
      const tryEnable = () => {
        if (pool.connectedCount() > 0) peers.enable().catch(() => {});
        else setTimeout(tryEnable, 1000);
      };
      tryEnable();
    }
    updatePeerStatus();
  }

  // Boot
  showScreen("compose");
  refreshGeo().catch(() => {});
  const relays = await loadRelayList();
  for (const url of relays) pool.add(url);

  // SPEC §4.9 — pick up any relays handed over via a share-URL #relays=
  // fragment.  Runs after the seed pool is up so health-checks see the
  // user's already-known relays.
  processShareHashDiscovery().catch(() => {});

  // Subscribe to the last 7 days once connections come online; the pool
  // re-issues subscriptions on each newly connected relay automatically.
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  pool.subscribe(SUB_FEED, [
    { kinds: [1], since, limit: 200 },
    { kinds: [2], since, limit: 500 },
    // WebRTC signaling — see SPEC §4.3 and peers.js.  Limit window to the
    // last hour since offers expire fast; 10002/10003 only when addressed to us.
    { kinds: [10001], since: Math.floor(Date.now() / 1000) - 3600 },
    { kinds: [10002, 10003], "#p": [pkHex] },
  ]);
});
