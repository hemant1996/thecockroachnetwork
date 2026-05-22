// Cockroach Relay — reference web client (L3 conformance, multi-relay).
// All crypto is in-browser. The keypair never leaves this device.
// Spec: ../SPEC.md

import * as ed from "https://esm.sh/@noble/ed25519@2.3.0";
import { sha256, sha512 } from "https://esm.sh/@noble/hashes@1.8.0/sha2";
import { PeerPool } from "./peers.js";
import { compressImage } from "./media.js";
import {
  translateLegacyVerdict,
  truthCounts,
  truthConsensus,
  latestStatus,
  evidenceRequestCount,
  duplicatesOf,
  myActiveTruth,
  voterLocalReportCount,
  cellVerifierCount,
  geohashMatchLen,
  evidenceMultiplier,
  gTagOf,
  eTagOf,
  geo5,
} from "./verdicts.js";

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

const events = new Map();              // id -> kind:1 report event (and originals of translated legacy events for dedup-by-id)
const truthEvents = [];                // kind:2 truth-verdicts (post-translation)
const statusEvents = [];               // kind:3 status events
const evidenceEvents = [];             // kind:4 evidence-request events
const relationEvents = [];             // kind:5 relation events

// ── ingest-time indexes (v0.7.1) ────────────────────────────────────────
// renderFeed used to re-filter the global event arrays for every card;
// at scale that was O(N × M) per render. These maps are populated as events
// arrive so per-card lookups are O(1) on a small slice.
const truthByReport      = new Map();  // reportId -> kind:2[] for that report
const statusByReport     = new Map();  // reportId -> kind:3[]
const evidenceByReport   = new Map();  // reportId -> kind:4[]
const relationsBySource  = new Map();  // sourceReportId -> kind:5[]
const evidenceAttachByReport = new Map();  // originalReportId -> kind:1 evidence-attachments
const myReportsByCell    = new Map();  // geohash-5 cell -> count of MY kind:1 reports
const verifierByCell     = new Map();  // geohash-5 cell -> Set<pubkey> of voters on any kind:1 in that cell
const reportCellById     = new Map();  // reportId -> geohash-5 cell of the report (cached for verifier indexing)

const SUB_FEED = "feed";

function _pushIndex(map, key, value) {
  let arr = map.get(key);
  if (!arr) { arr = []; map.set(key, arr); }
  arr.push(value);
}

// kind:1 has `["e", origId, "evidence"]` when it's an evidence-attachment reply.
function evidenceParentId(ev) {
  if (ev.kind !== 1) return null;
  const tag = ev.tags.find(t => t[0] === "e" && t[2] === "evidence");
  return tag ? tag[1] : null;
}

function ingest(e) {
  if (events.has(e.id)) return false;
  // SPEC §4.2.6 — translate legacy kind:2 verdicts (needs-more-proof → kind:4,
  // resolved → kind:3, duplicate → discarded) before routing into stores.
  const ev = translateLegacyVerdict(e);
  if (ev === null) return false;
  events.set(e.id, e);

  if (ev.kind === 1) {
    // Cache geohash-5 cell for fast lookup by report-id when indexing verifiers.
    const cell = geo5(gTagOf(ev));
    if (cell) {
      reportCellById.set(ev.id, cell);
      // Out-of-order delivery: verifiers may have arrived before this kind:1.
      const pending = _pendingVerifiers.get(ev.id);
      if (pending) {
        let set = verifierByCell.get(cell);
        if (!set) { set = new Set(); verifierByCell.set(cell, set); }
        for (const pk of pending) set.add(pk);
        _pendingVerifiers.delete(ev.id);
      }
    }
    // §8.3 voter-weight: count my own kind:1 reports per cell incrementally.
    if (cell && ev.pubkey === pkHex) {
      myReportsByCell.set(cell, (myReportsByCell.get(cell) || 0) + 1);
    }
    // Evidence-attachment reply: index under the parent report.
    const parent = evidenceParentId(ev);
    if (parent) _pushIndex(evidenceAttachByReport, parent, ev);
  } else if (ev.kind === 2) {
    truthEvents.push(ev);
    const reportId = eTagOf(ev);
    if (reportId) _pushIndex(truthByReport, reportId, ev);
    _indexVerifierByCell(reportId, ev.pubkey);
  } else if (ev.kind === 3) {
    statusEvents.push(ev);
    const reportId = eTagOf(ev);
    if (reportId) _pushIndex(statusByReport, reportId, ev);
    _indexVerifierByCell(reportId, ev.pubkey);
  } else if (ev.kind === 4) {
    evidenceEvents.push(ev);
    const reportId = eTagOf(ev);
    if (reportId) _pushIndex(evidenceByReport, reportId, ev);
    _indexVerifierByCell(reportId, ev.pubkey);
  } else if (ev.kind === 5) {
    relationEvents.push(ev);
    const eTags = ev.tags.filter(t => t[0] === "e").map(t => t[1]);
    if (eTags[0]) _pushIndex(relationsBySource, eTags[0], ev);
  }
  return true;
}

function _indexVerifierByCell(reportId, pubkey) {
  if (!reportId) return;
  // Verifier might arrive before the kind:1 it points at (out-of-order delivery
  // over multiple relays). If so, we'll fix up when the kind:1 lands — see below.
  const cell = reportCellById.get(reportId);
  if (!cell) {
    _pushIndex(_pendingVerifiers, reportId, pubkey);
    return;
  }
  let set = verifierByCell.get(cell);
  if (!set) { set = new Set(); verifierByCell.set(cell, set); }
  set.add(pubkey);
}
const _pendingVerifiers = new Map();

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

// v0.7.1 — when an evidence-reply is in flight, the parent report id sits here.
// publishReport() reads it and appends ["e", parent, "evidence"] to the new kind:1.
let evidenceReplyTo = null;

function publishReport({ content, tags, lat, lon, precision, media }) {
  const allTags = [
    ["g", geohashEncode(lat, lon, precision)],
    ...tags.map(t => ["t", t]),
    ["lang", navigator.language?.split("-")[0] || "en"],
  ];
  // SPEC §3.4: media tag carries any URL form.  For in-event thumbnails the
  // URL is a data:image/jpeg;base64,… URL; the bytes encoded in it are
  // SHA-256-bound to the second field for downstream verification.
  for (const m of (media || [])) {
    if (!m || !m.dataUrl) continue;
    allTags.push(["media", m.dataUrl, "sha256:" + m.sha256, m.mime, String(m.size)]);
  }
  // SPEC §4.2.6 evidence-attachment: a kind:1 report tagged with the original.
  if (evidenceReplyTo) {
    allTags.push(["e", evidenceReplyTo, "evidence"]);
  }
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

// SPEC §4.2 — verification, status, and relation publishers. Each kind has
// its own dedupe key (§4.2.5); the actual math lives in verdicts.js.

function _signAndFanout({ kind, tags, content }) {
  const event = signEvent({
    pubkey: pkHex,
    created_at: Math.floor(Date.now() / 1000),
    kind, tags, content,
  }, sk);
  ingest(event);
  pool.publish(event);
  peers.broadcast(event);
  return event;
}

// SPEC §4.2.1 — binary truth-verdict. Retract by republishing with the same
// (e, v) plus ["state","retracted"].
function publishTruthVerdict(reportId, verdict, { retract = false } = {}) {
  if (verdict !== "true" && verdict !== "fake") {
    throw new Error("v0.7+ truth verdicts must be 'true' or 'fake'");
  }
  const tags = [["e", reportId], ["v", verdict]];
  if (retract) tags.push(["state", "retracted"]);
  return _signAndFanout({ kind: 2, tags, content: "" });
}

// SPEC §4.2.2 — status update (resolved | reopened).
function publishStatus(reportId, status) {
  if (status !== "resolved" && status !== "reopened") {
    throw new Error("status must be 'resolved' or 'reopened'");
  }
  return _signAndFanout({
    kind: 3,
    tags: [["e", reportId], ["status", status]],
    content: "",
  });
}

// SPEC §4.2.3 — evidence-request (a question, not a verdict).
function publishEvidenceRequest(reportId, note = "") {
  return _signAndFanout({
    kind: 4,
    tags: [["e", reportId]],
    content: note,
  });
}

// SPEC §4.2.4 — relation. v0.7 uses duplicate-of for the UI; continuation-of
// is wire-compatible but not surfaced in the reference client yet.
function publishRelation(reportId, targetId, rel = "duplicate-of") {
  return _signAndFanout({
    kind: 5,
    tags: [["e", reportId], ["e", targetId], ["rel", rel]],
    content: "",
  });
}

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
  // Mirror the dot state onto the chip border (new design system).
  const chip = dot.parentElement;
  if (chip) {
    chip.classList.toggle("live", connected > 0);
    chip.classList.toggle("warn", connected === 0 && all.length > 0);
  }
  // Sign-row + rail need the same numbers — refresh both when relay state moves.
  const sr = document.getElementById("signrow-relays");
  if (sr) sr.textContent = connected + (connected === 1 ? " relay" : " relays");
  renderRail();
}

pool.on(() => {
  updateStatus();
  if ($("#screen-about").classList.contains("active")) renderRelayList();
});

// ─── feed render ─────────────────────────────────────────────────────────

let renderTimer;
function renderFeedDebounced() { clearTimeout(renderTimer); renderTimer = setTimeout(renderFeed, 80); }

// ─── feed sort/filter state ─────────────────────────────────────────────
// v0.7 sort modes:
//   newest        — by created_at desc (default)
//   near-you      — by geohash prefix-match against lastFix (SPEC §8 spirit)
//   most-verified — truth-verdict count × evidence multiplier (§8.1 hint)
//   unresolved    — unresolved first, then highest truth, then oldest (fixer view)
//   needs-proof   — by count of outstanding evidence-requests (kind:4)
let feedSort = "newest";
let feedFilter = "all";

function tagsOf(e) { return e.tags.filter(t => t[0] === "t").map(t => t[1]); }

// ── per-report fast accessors (v0.7.1 — backed by ingest-time indexes) ──
//
// These mirror the same outputs as the pure helpers in verdicts.js but use
// the O(1) index lookups instead of filtering the global arrays every time.
// Pure helpers stay the source of truth for the algorithm; these wrappers
// are the performance path.

function truthCountsFast(reportId) {
  return truthCounts(reportId, truthByReport.get(reportId) || []);
}
function truthConsensusFast(reportId) {
  return truthConsensus(reportId, truthByReport.get(reportId) || []);
}
function latestStatusFast(reportId) {
  return latestStatus(reportId, statusByReport.get(reportId) || []);
}
function evidenceRequestCountFast(reportId) {
  return evidenceRequestCount(reportId, evidenceByReport.get(reportId) || []);
}
function duplicatesOfFast(reportId) {
  return duplicatesOf(reportId, relationsBySource.get(reportId) || []);
}
function evidenceAttachmentCountFast(reportId) {
  return (evidenceAttachByReport.get(reportId) || []).length;
}
function myActiveTruthFast(reportId) {
  return myActiveTruth(reportId, pkHex, truthByReport.get(reportId) || []);
}
function voterLocalReportCountFast(cell) {
  if (!cell) return 0;
  return myReportsByCell.get(cell) || 0;
}
function cellVerifierCountFast(cell) {
  if (!cell) return 0;
  return (verifierByCell.get(cell) || new Set()).size;
}

// How many days a report has been "open" — since creation, or since the
// most recent reopen if any kind:3 status=reopened exists.
function daysOpen(reportId, createdAt) {
  const st = latestStatusFast(reportId);
  const start = (st && st.status === "reopened") ? st.at : createdAt;
  return Math.floor((Date.now() / 1000 - start) / 86400);
}

// SPEC §3.4: render media tags inline.  Accepts data:, https:, ipfs: etc.
// data: URLs render instantly with no network call.  https:/ipfs:/etc. fall
// through the browser's standard <img> loading and show broken if unreachable.
// We do NOT validate the sha256 binding here — that's a defense-in-depth
// item for a future client to add if anyone wants to verify bytes match the
// tag claim.
function renderMediaTags(r) {
  const mediaTags = r.tags.filter(t => t[0] === "media" && typeof t[1] === "string");
  if (mediaTags.length === 0) return "";
  return `<div class="media-row">${mediaTags.map(t => {
    const url = t[1];
    // Permit data: and http(s): and ipfs:; reject other schemes to keep
    // the surface area tight against future protocol confusion.
    if (!/^(data:image\/|https?:\/\/|ipfs:\/\/)/.test(url)) return "";
    const safe = url.startsWith("data:") ? url : escapeHTML(url);
    return `<img class="media-item" loading="lazy" alt="" src="${safe}"/>`;
  }).join("")}</div>`;
}

// Page size for the visible feed. Anything beyond gets a "load more" button.
// At 50 cards the DOM cost on mobile stays comfortable; sort still runs over
// every report but that's O(N log N) and dominated by the network round-trip.
const FEED_PAGE = 50;
let feedVisible = FEED_PAGE;

function renderFeed() {
  const container = $("#feed-list");
  // Top-level feed shows ONLY standalone kind:1 reports. Evidence-attachment
  // replies (kind:1 tagged ["e", parent, "evidence"]) render inline under
  // their parent, not as their own cards.
  let reports = [];
  for (const ev of events.values()) {
    if (ev.kind !== 1) continue;
    if (evidenceParentId(ev)) continue;
    reports.push(ev);
  }

  // Filter by selected tag chip.
  if (feedFilter !== "all") {
    reports = reports.filter(r => tagsOf(r).includes(feedFilter));
  }

  // v0.7 sort modes — see SPEC §8. All comparators use O(1) fast accessors.
  if (feedSort === "most-verified") {
    reports.sort((a, b) => {
      const ac = truthCountsFast(a.id);
      const bc = truthCountsFast(b.id);
      const aw = (ac.true + ac.fake) * evidenceMultiplier(a);
      const bw = (bc.true + bc.fake) * evidenceMultiplier(b);
      return (bw - aw) || (b.created_at - a.created_at);
    });
  } else if (feedSort === "unresolved") {
    reports.sort((a, b) => {
      const aRes = (latestStatusFast(a.id) || {}).status === "resolved";
      const bRes = (latestStatusFast(b.id) || {}).status === "resolved";
      if (aRes !== bRes) return aRes ? 1 : -1;
      const aTrue = truthCountsFast(a.id).true;
      const bTrue = truthCountsFast(b.id).true;
      return (bTrue - aTrue) || (a.created_at - b.created_at);
    });
  } else if (feedSort === "needs-proof") {
    reports.sort((a, b) => (evidenceRequestCountFast(b.id) - evidenceRequestCountFast(a.id)) || (b.created_at - a.created_at));
  } else if (feedSort === "near-you") {
    const myG = lastFix ? geohashEncode(lastFix.lat, lastFix.lon, 7) : null;
    reports.sort((a, b) => {
      const ma = geohashMatchLen(myG, gTagOf(a));
      const mb = geohashMatchLen(myG, gTagOf(b));
      return (mb - ma) || (b.created_at - a.created_at);
    });
  } else {
    reports.sort((a, b) => b.created_at - a.created_at);
  }

  // Side-effects that ride on every feed render.
  renderFilterChips();
  renderRail();
  const totalCount = reports.length;
  const fc = document.getElementById("feed-count");
  if (fc) {
    if (totalCount > 0) { fc.textContent = totalCount; fc.hidden = false; }
    else { fc.hidden = true; }
  }

  if (reports.length === 0) {
    const label = feedFilter === "all" ? escapeHTML(t("feed.empty")) :
      `No reports yet for <b>#${escapeHTML(feedFilter)}</b>. Be the first cockroach.`;
    container.innerHTML = `<div class="empty">${label}</div>`;
    return;
  }

  // Cap the visible slice. "Load more" appends another FEED_PAGE.
  const visible = reports.slice(0, feedVisible);
  const hasMore = totalCount > feedVisible;

  const cardsHTML = visible.map(renderCard).join("");
  const moreHTML = hasMore
    ? `<button class="load-more" data-action="load-more">${escapeHTML(t("feed.load_more") || "load more")} · ${totalCount - feedVisible} ${escapeHTML(t("feed.remaining") || "remaining")}</button>`
    : "";
  container.innerHTML = cardsHTML + moreHTML;
}

// Render one report card with its inline evidence thread (if any).
function renderCard(r) {
  const tags = r.tags.filter(t => t[0] === "t").map(t => t[1]);
  const geo  = gTagOf(r) || "";
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

  // v0.7 closure-absence badge — the headline line on every card.
  const tc       = truthCountsFast(r.id);
  const tcv      = truthConsensusFast(r.id);
  const ereq     = evidenceRequestCountFast(r.id);
  const eatt     = evidenceAttachmentCountFast(r.id);
  const st       = latestStatusFast(r.id);
  const resolved = st && st.status === "resolved";
  const dOpen    = daysOpen(r.id, r.created_at);
  const dups     = duplicatesOfFast(r.id);

  const segs = [];
  if (tc.true > 0) segs.push(`<span class="seg seg-true">✓ ${tc.true}</span>`);
  if (tc.fake > 0) segs.push(`<span class="seg seg-fake">✗ ${tc.fake}</span>`);
  if (ereq > 0)    segs.push(`<span class="seg seg-proof">↺ ${ereq} ${escapeHTML(t("feed.proof_requested") || "asking proof")}</span>`);
  if (eatt > 0)    segs.push(`<span class="seg seg-evidence">▸ ${eatt} ${escapeHTML(t("feed.evidence_attached") || "evidence")}</span>`);
  if (dups.length) segs.push(`<span class="seg seg-dup">⇿ duplicate of #${escapeHTML(dups[0].slice(0, 4))}</span>`);
  segs.push(resolved
    ? `<span class="seg seg-resolved">▣ ${escapeHTML(t("feed.resolved_by_short") || "resolved by")} #${escapeHTML(st.by.slice(0, 4))}</span>`
    : `<span class="seg seg-open">${dOpen}d ${escapeHTML(t("feed.open_days") || "open")}</span>`);

  const consensusPill = tcv
    ? `<span class="consensus consensus-${tcv}">${tcv === "true" ? "✓ true" : "✗ fake"}</span>`
    : "";

  // SPEC §8.4 — sparse-cell badge (O(1) via cellVerifierCountFast).
  const cell = geo5(geo);
  const sparseHTML = (() => {
    if (!cell) return "";
    const n = cellVerifierCountFast(cell);
    if (n >= 3) return "";
    return `<span class="seg seg-sparse">⚠ low-density area · ${n}/3 verifiers in cell</span>`;
  })();

  const closureHTML = `<div class="closure">
    ${consensusPill}
    ${segs.join("")}
    ${sparseHTML}
  </div>`;

  // SPEC §8.3 — voter weight legibility, O(1) via myReportsByCell.
  const myWeight = voterLocalReportCountFast(cell);
  const weightLabel = myWeight === 0
    ? `${escapeHTML(t("feed.your_weight") || "your weight here")}: 0 (${escapeHTML(t("feed.new_here") || "new to this area")})`
    : `${escapeHTML(t("feed.your_weight") || "your weight here")}: ${myWeight} ${myWeight === 1 ? "report" : "reports"}`;
  const weightHTML = `<div class="voter-weight">${weightLabel}</div>`;

  // Binary truth toggles + actions overflow. "↳ attach evidence" surfaces
  // alongside when there's at least one outstanding evidence-request, so the
  // give-proof path is one click from the ask-proof state.
  const mine = myActiveTruthFast(r.id);
  const attachHTML = ereq > 0
    ? `<button class="attach-btn" data-action="attach-evidence">↳ ${escapeHTML(t("verdict.attach_evidence") || "attach evidence")}</button>`
    : "";
  const verifyHTML = `<div class="verify-row">
    <button class="truth-btn ${mine.has("true") ? "cast cast-true" : ""}" data-verdict="true">
      ✓ ${escapeHTML(t("verdict.true") || "true")}
    </button>
    <button class="truth-btn ${mine.has("fake") ? "cast cast-fake" : ""}" data-verdict="fake">
      ✗ ${escapeHTML(t("verdict.fake") || "fake")}
    </button>
    <div class="actions-menu">
      <button class="actions-toggle" data-action="actions-toggle" aria-haspopup="true">⋯ ${escapeHTML(t("verdict.actions") || "more")}</button>
      <div class="actions-pop" hidden>
        <button data-action="request-evidence">${escapeHTML(t("verdict.request_evidence") || "request evidence")}</button>
        <button data-action="attach-evidence">${escapeHTML(t("verdict.attach_evidence") || "attach evidence")}</button>
        <button data-action="mark-duplicate">${escapeHTML(t("verdict.mark_duplicate") || "mark duplicate of…")}</button>
        <button data-action="mark-resolved">${escapeHTML(resolved ? (t("verdict.reopen") || "reopen") : (t("verdict.mark_resolved") || "mark resolved"))}</button>
      </div>
    </div>
    ${attachHTML}
    <button class="share-btn" data-action="share" title="${escapeHTML(t("feed.share_title") || "share")}">${escapeHTML(t("feed.share") || "share")}</button>
  </div>`;

  // Evidence-attachment replies, rendered inline under the parent as a small thread.
  const replies = evidenceAttachByReport.get(r.id) || [];
  const repliesSorted = replies.slice().sort((a, b) => a.created_at - b.created_at);
  const repliesHTML = repliesSorted.length === 0 ? "" : `
    <div class="evidence-thread">
      <div class="thread-head">▸ ${repliesSorted.length} ${escapeHTML(t("feed.evidence_attached") || "evidence")}</div>
      ${repliesSorted.map(rep => `
        <div class="evidence-reply">
          <div class="reply-meta">${avatarSvg(rep.pubkey, 22)}<span class="id mono">${shortId(rep.pubkey)}</span><span class="time">${fmtTimeAgo(rep.created_at)}</span></div>
          <div class="reply-body">${escapeHTML(rep.content)}</div>
          ${renderMediaTags(rep)}
        </div>`).join("")}
    </div>`;

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
      ${renderMediaTags(r)}
      ${tags.length ? `<div class="tags">${tags.map(t => `<span>#${escapeHTML(t)}</span>`).join("")}</div>` : ""}
      ${closureHTML}
      ${weightHTML}
      ${verifyHTML}
      ${repliesHTML}
    </div>`;
}

// ─── feed side rail + filter chips (web design) ──────────────────────────

// Static seed filter list — augmented at render-time with any tag present in
// the live event store, so the chips reflect what's actually in the feed.
const SEED_FILTER_TAGS = ["paperleak", "road", "election", "harassment", "unemployment", "mainbhicockroach"];

function renderFilterChips() {
  const host = document.getElementById("filter-tags");
  if (!host) return;
  const seen = new Set();
  for (const e of events.values()) if (e.kind === 1) for (const tg of tagsOf(e)) seen.add(tg);
  const tags = [...new Set([...SEED_FILTER_TAGS, ...seen])];
  host.innerHTML = `<span class="pill ${feedFilter === "all" ? "selected" : ""}" data-filter="all">all</span>` +
    tags.map(tg => `<span class="pill ${feedFilter === tg ? "selected" : ""}" data-filter="${escapeHTML(tg)}">#${escapeHTML(tg)}</span>`).join("");
}

function renderRail() {
  // Relay-mini list.
  const relayHost = document.getElementById("rail-relays");
  if (relayHost) {
    const status = pool.status();
    relayHost.innerHTML = status.length === 0
      ? `<div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--ink-faint)">no relays</div>`
      : status.map(({ url, state }) => {
        const cls = state === "connected" ? "" : (state === "error" ? "bad" : "off");
        const dotColor = state === "connected" ? "var(--good)" : (state === "error" ? "var(--bad)" : "var(--warn)");
        return `<div class="relay-mini ${cls}">
          <span style="color:${dotColor}">●</span>
          <span class="url">${escapeHTML(shortUrl(url))}</span>
          <span class="ms">${escapeHTML(state)}</span>
        </div>`;
      }).join("");
  }

  // Trending tags — count #t tags over the last 7d window in the live store.
  const trendHost = document.getElementById("rail-trending");
  if (trendHost) {
    const since = Math.floor(Date.now() / 1000) - 7 * 86400;
    const counts = new Map();
    for (const e of events.values()) {
      if (e.kind !== 1 || e.created_at < since) continue;
      for (const tg of tagsOf(e)) counts.set(tg, (counts.get(tg) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    trendHost.innerHTML = top.length === 0
      ? `<div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--ink-faint)">no tags yet</div>`
      : top.map(([tg, n], i) => `
        <div class="lb-row" data-filter-tag="${escapeHTML(tg)}">
          <span class="rank">0${i + 1}</span>
          <span class="tag">#${escapeHTML(tg)}</span>
          <span class="ct">${n}</span>
        </div>`).join("");
  }
}

// ─── live preview (Report tab) ──────────────────────────────────────────

function renderLivePreview() {
  const text = $("#compose-content")?.value || "";
  const body = $("#preview-body");
  if (body) {
    const trimmed = text.trim();
    if (trimmed) {
      body.textContent = trimmed;
      body.classList.remove("empty");
    } else {
      body.textContent = "Kya hua? Kab? Kahan? — describe what you witnessed.";
      body.classList.add("empty");
    }
  }

  // Tags
  const tagHost = $("#preview-tags");
  if (tagHost) {
    const selected = [...document.querySelectorAll("#tag-pills .pill.selected")].map(el => el.textContent.replace(/^#/, ""));
    tagHost.innerHTML = selected.map(tg => `<span class="preview-tag">#${escapeHTML(tg)}</span>`).join("");
    const sigTags = $("#sig-tags");
    if (sigTags) sigTags.textContent = selected.length ? selected.map(t => "#" + t).join("  ") : "—";
  }

  // Precision indicator
  const prec = Number($("#geo-precision")?.value || 7);
  const precEl = $("#preview-precision");
  if (precEl) precEl.textContent = prec;

  // Location label
  const locEl = $("#preview-loc");
  if (locEl) {
    if (lastFix) {
      locEl.textContent = `${lastFix.lat.toFixed(2)}, ${lastFix.lon.toFixed(2)}`;
    } else {
      locEl.textContent = "no GPS fix yet";
    }
  }

  // Sig-strip fields
  const sigPk = $("#sig-pubkey");
  if (sigPk) sigPk.textContent = pkHex.slice(0, 8) + "…" + pkHex.slice(-8);
  const pkRow = $("#preview-pk");
  if (pkRow) pkRow.textContent = `ed25519:${pkHex.slice(0, 4)}…${pkHex.slice(-4)}`;
  const sigCreated = $("#sig-created");
  if (sigCreated) sigCreated.textContent = new Date().toISOString();
  const sigGeo = $("#sig-geohash");
  if (sigGeo) sigGeo.textContent = lastFix ? geohashEncode(lastFix.lat, lastFix.lon, prec) : "—";

  // Ready/draft state
  const canPublish = text.trim().length > 8;
  const stateEl = $("#preview-state");
  const stateLabel = $("#preview-state-label");
  if (stateEl) stateEl.classList.toggle("signed", canPublish);
  if (stateLabel) stateLabel.textContent = canPublish ? "ready" : "draft";
  const sigStatus = $("#sig-status");
  if (sigStatus) {
    if (canPublish) {
      sigStatus.textContent = "ready to sign (ed25519)";
      sigStatus.classList.remove("muted");
    } else {
      sigStatus.textContent = "— (write text to sign)";
      sigStatus.classList.add("muted");
    }
  }

  // Photo preview block (mirror the in-event base64 photo if attached)
  const photoBox = $("#preview-photo");
  if (photoBox) {
    const previewImg = document.querySelector("#media-preview img");
    if (previewImg) {
      photoBox.hidden = false;
      photoBox.innerHTML = `<img src="${previewImg.src}" alt=""/>`;
    } else {
      photoBox.hidden = true;
      photoBox.innerHTML = "";
    }
  }

  // Character count
  const cc = $("#compose-char-count");
  if (cc) {
    cc.textContent = `${text.length} / 500`;
    cc.classList.toggle("warn", text.length > 480);
  }
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
// Dev probe — localhost only — exposes lastFix on window so headless QA can
// stub a fix without granting geolocation permission. No-op in production.
if (typeof window !== "undefined" && location.hostname === "localhost") {
  Object.defineProperty(window, "lastFix", {
    configurable: true,
    get() { return lastFix; },
    set(v) { lastFix = v; },
  });
}
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

  // v0.7.5 — "Tell another cockroach" share button on the Identity tab.
  // Uses the Web Share API on supported devices (iOS Safari, mobile Chrome)
  // and falls back to clipboard copy + toast.
  document.getElementById("btn-share-network")?.addEventListener("click", async () => {
    const url = "https://thecockroachnetwork.com";
    const text = t("share.tell_friend_text") || "main bhi cockroach. signed civic reports — koi account nahi, koi OTP nahi, mita nahi sakte.";
    const data = { title: "The Cockroach Network", text, url };
    if (navigator.share) {
      try { await navigator.share(data); return; } catch { /* user cancelled */ }
    }
    try {
      await navigator.clipboard.writeText(`${url} — ${text}`);
      toast(t("share.tell_friend_copied") || "link copied — paste it anywhere");
    } catch {
      prompt(t("share.copy_manual") || "Copy this link:", url);
    }
  });

  // v0.7.5 — always-visible language pill in the app-bar. Click flips
  // between the two supported languages (en, hi) and reloads so every
  // translated string updates from the freshly-loaded bundle.
  const langPill = document.getElementById("lang-pill");
  if (langPill) {
    const cur = currentLang === "hi" ? "Hin" : "EN";
    const other = currentLang === "hi" ? "EN" : "Hin";
    langPill.innerHTML = `<span class="current">${cur}</span><span class="other">· ${other}</span>`;
    langPill.addEventListener("click", () => {
      const next = currentLang === "hi" ? "en" : "hi";
      localStorage.setItem(LANG_STORAGE, next);
      location.reload();
    });
  }

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
    const hint = document.getElementById("tag-hint");
    if (hint) hint.textContent = `Tap to add · ${selectedTags.size} selected`;
    renderLivePreview();
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
    const gpsLabel = document.getElementById("gps-label");
    const gpsIcon  = document.getElementById("gps-icon");
    const gpsBtn   = document.getElementById("btn-locate");
    if (gpsIcon) gpsIcon.innerHTML = `<span class="spin">◔</span>`;
    if (gpsLabel) gpsLabel.textContent = "acquiring fix…";
    try {
      const fix = await fetchLocation();
      const gh = geohashEncode(fix.lat, fix.lon, Number(precSel.value));
      geoLine.innerHTML = `${fix.lat.toFixed(4)}, ${fix.lon.toFixed(4)} → <code>${gh}</code> <span style="opacity:0.5">±${Math.round(fix.acc)}m</span>`;
      if (gpsBtn) gpsBtn.classList.add("has-fix");
      if (gpsIcon) gpsIcon.textContent = "📍";
      if (gpsLabel) gpsLabel.textContent = `${fix.lat.toFixed(2)}, ${fix.lon.toFixed(2)}`;
    } catch (e) {
      geoLine.textContent = t("compose.location_error", { msg: e.message });
      if (gpsBtn) gpsBtn.classList.remove("has-fix");
      if (gpsIcon) gpsIcon.textContent = "📡";
      if (gpsLabel) gpsLabel.textContent = t("compose.get_gps");
    }
    renderLivePreview();
  }
  $("#btn-locate").addEventListener("click", refreshGeo);
  // Precision change does NOT prompt for geolocation — only re-encodes the
  // existing fix at the new precision. New users can configure precision
  // before granting location permission.
  precSel.addEventListener("change", () => { syncPrecisionPills(); if (lastFix) refreshGeo(); else renderLivePreview(); });

  // Precision pill grid → drives the hidden <select id="geo-precision">.
  function syncPrecisionPills() {
    const cur = precSel.value;
    for (const el of document.querySelectorAll("#precision-grid .precision-pill")) {
      el.classList.toggle("on", el.dataset.prec === cur);
    }
  }
  document.getElementById("precision-grid")?.addEventListener("click", (e) => {
    const pill = e.target.closest(".precision-pill");
    if (!pill) return;
    precSel.value = pill.dataset.prec;
    syncPrecisionPills();
    // Same rule as the <select> handler — no implicit geo prompt.
    if (lastFix) refreshGeo();
    else renderLivePreview();
  });
  syncPrecisionPills();

  // ── media attachment (in-event base64) ───────────────────────────────
  let pendingMedia = null;
  const mediaInput   = $("#media-input");
  const mediaBtn     = $("#btn-attach-media");
  const mediaStatus  = $("#media-status");
  const mediaPreview = $("#media-preview");
  function clearMedia() {
    pendingMedia = null;
    if (mediaInput) mediaInput.value = "";
    if (mediaPreview) mediaPreview.innerHTML = "";
    if (mediaStatus) mediaStatus.textContent = "no photo attached";
    renderLivePreview();
  }
  if (mediaBtn && mediaInput) {
    mediaBtn.addEventListener("click", () => mediaInput.click());
    mediaInput.addEventListener("change", async () => {
      const file = mediaInput.files && mediaInput.files[0];
      if (!file) return;
      mediaStatus.textContent = "compressing…";
      mediaPreview.innerHTML = "";
      try {
        const meta = await compressImage(file);
        pendingMedia = meta;
        const kb = (meta.size / 1024).toFixed(1);
        mediaStatus.innerHTML = `<span style="color:var(--good)">✓ ready to publish</span> · ${kb} KB · embedded in event`;
        mediaPreview.innerHTML = `<img src="${meta.dataUrl}" alt="" style="max-width:240px;max-height:180px;border-radius:6px;margin-top:8px"/>
          <button type="button" id="btn-remove-media" class="ghost small" style="margin-top:6px">Remove</button>`;
        const removeBtn = $("#btn-remove-media");
        if (removeBtn) removeBtn.addEventListener("click", clearMedia);
        renderLivePreview();
      } catch (e) {
        mediaStatus.innerHTML = `<span style="color:var(--bad)">✗ ${escapeHTML(e.message)}</span>`;
        pendingMedia = null;
      }
    });
  }

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
        media: pendingMedia ? [pendingMedia] : [],
      });
      composeText.value = "";
      clearMedia();
      // Evidence-reply state is one-shot: clear the parent ID and banner.
      clearEvidenceReplyTo();
      renderLivePreview();
      showScreen("feed");
    } finally { composeBtn.disabled = false; }
  });

  // v0.7.1 evidence-reply banner wiring.
  function setEvidenceReplyTo(parentId) {
    evidenceReplyTo = parentId;
    const banner = document.getElementById("evidence-banner");
    if (banner) {
      banner.hidden = !parentId;
      const short = banner.querySelector(".short");
      if (short && parentId) short.textContent = "#" + parentId.slice(0, 4);
    }
  }
  function clearEvidenceReplyTo() { setEvidenceReplyTo(null); }
  // Expose to the feed click handler below (closure capture).
  window.__attachEvidence = (parentId) => {
    setEvidenceReplyTo(parentId);
    showScreen("compose");
    composeText?.focus();
  };
  document.getElementById("evidence-cancel")?.addEventListener("click", clearEvidenceReplyTo);

  // Feed buttons (verify + share, delegated)
  $("#feed-list").addEventListener("click", async (e) => {
    // Load-more button lives at the bottom of #feed-list, outside any card.
    const moreBtn = e.target.closest('[data-action="load-more"]');
    if (moreBtn) {
      feedVisible += FEED_PAGE;
      renderFeed();
      return;
    }

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

    // v0.7 binary truth toggle. Re-click of an active verdict retracts.
    const vBtn = e.target.closest("button.truth-btn[data-verdict]");
    if (vBtn) {
      vBtn.disabled = true;
      try {
        const verdict = vBtn.dataset.verdict;
        const mine = myActiveTruth(reportId, pkHex, truthEvents);
        publishTruthVerdict(reportId, verdict, { retract: mine.has(verdict) });
        toast(t("toast.signed_verdict", { verdict }));
        renderFeed();
      } finally { vBtn.disabled = false; }
      return;
    }

    // Actions overflow menu — toggle, then route on inner-item clicks.
    const aToggle = e.target.closest('[data-action="actions-toggle"]');
    if (aToggle) {
      const pop = aToggle.parentElement.querySelector(".actions-pop");
      pop.hidden = !pop.hidden;
      return;
    }
    const reqBtn = e.target.closest('[data-action="request-evidence"]');
    if (reqBtn) {
      const note = prompt(t("verdict.request_evidence") || "request evidence", "") || "";
      publishEvidenceRequest(reportId, note.trim());
      toast("evidence request signed");
      renderFeed();
      return;
    }
    const attBtn = e.target.closest('[data-action="attach-evidence"]');
    if (attBtn) {
      window.__attachEvidence?.(reportId);
      return;
    }
    const dupBtn = e.target.closest('[data-action="mark-duplicate"]');
    if (dupBtn) {
      const orig = prompt("original report id (hex):");
      if (orig && /^[0-9a-f]{8,64}$/.test(orig.trim())) {
        publishRelation(reportId, orig.trim(), "duplicate-of");
        toast("duplicate relation signed");
        renderFeed();
      } else if (orig) {
        toast("invalid id — expected hex");
      }
      return;
    }
    const resBtn = e.target.closest('[data-action="mark-resolved"]');
    if (resBtn) {
      const st = latestStatus(reportId, statusEvents);
      const next = (st && st.status === "resolved") ? "reopened" : "resolved";
      publishStatus(reportId, next);
      toast(`status: ${next}`);
      renderFeed();
      return;
    }
  });

  // Identity tab
  $("#about-pubkey").textContent = pkHex;
  const titleShort = document.getElementById("title-shortid");
  if (titleShort) titleShort.textContent = "#" + pkHex.slice(0, 4);
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
    if (peerIndicator) {
      peerIndicator.style.display = s.enabled ? "" : "none";
      // Mirror dot state onto the pill border (design system).
      peerIndicator.classList.toggle("live", s.connected > 0);
      peerIndicator.classList.toggle("warn", s.enabled && s.connected === 0);
    }
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

  // ─── live preview wiring (Report tab) ────────────────────────────────
  const composeContent = document.getElementById("compose-content");
  if (composeContent) composeContent.addEventListener("input", renderLivePreview);
  renderLivePreview();

  // ─── feed sort + filter wiring ───────────────────────────────────────
  document.getElementById("sort-list")?.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-sort]");
    if (!li) return;
    feedSort = li.dataset.sort;
    feedVisible = FEED_PAGE;
    for (const x of document.querySelectorAll("#sort-list li")) x.classList.toggle("on", x === li);
    renderFeed();
  });
  document.getElementById("filter-tags")?.addEventListener("click", (e) => {
    const pill = e.target.closest("[data-filter]");
    if (!pill) return;
    feedFilter = pill.dataset.filter;
    feedVisible = FEED_PAGE;
    renderFeed();
  });
  // Clicking a trending tag in the rail jumps the filter chip to that tag.
  document.getElementById("rail-trending")?.addEventListener("click", (e) => {
    const row = e.target.closest("[data-filter-tag]");
    if (!row) return;
    feedFilter = row.dataset.filterTag;
    feedVisible = FEED_PAGE;
    renderFeed();
  });

  // ─── keyboard shortcuts: 1 = report, 2 = feed, 3 = identity ──────────
  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "1") showScreen("compose");
    else if (e.key === "2") showScreen("feed");
    else if (e.key === "3") showScreen("about");
  });

  // ─── sign-row meta — keep peer count fresh as the mesh state changes ─
  function updateSignRowPeers() {
    const sp = document.getElementById("signrow-peers");
    if (!sp) return;
    const s = peers.status();
    sp.textContent = s.connected + (s.connected === 1 ? " peer" : " peers");
  }
  peers.on(updateSignRowPeers);
  updateSignRowPeers();

  // Boot
  showScreen("compose");
  // No auto-geolocation prompt — the user grants location only when they
  // click "get GPS fix" or hit publish without a fix. This is the v0.7.6
  // privacy-by-default rule: the browser's permission dialog should only
  // appear in response to a deliberate user action.
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
    { kinds: [2], since, limit: 500 },     // truth-verdicts (+ legacy translation)
    { kinds: [3], since, limit: 500 },     // status updates
    { kinds: [4], since, limit: 500 },     // evidence-requests
    { kinds: [5], since, limit: 500 },     // relations
    // WebRTC signaling — see SPEC §4.4 and peers.js. Limit window to the
    // last hour since offers expire fast; 10002/10003 only when addressed to us.
    { kinds: [10001], since: Math.floor(Date.now() / 1000) - 3600 },
    { kinds: [10002, 10003], "#p": [pkHex] },
  ]);

  // Click outside the actions menu dismisses it.
  document.addEventListener("click", (e) => {
    if (e.target.closest(".actions-menu")) return;
    for (const pop of document.querySelectorAll(".actions-pop")) pop.hidden = true;
  });
});
