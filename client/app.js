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
const LEGACY_RELAY_STORAGE = "cockroach.relay"; // pre-multi-relay key

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
  peers.broadcast(event);              // fan out to WebRTC peers as well
  if (sent === 0) toast(t("toast.published_0"));
  else if (sent === 1) toast(t("toast.published_1", { n: sent }));
  else toast(t("toast.published_n", { n: sent }));
  return event;
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
  peers.broadcast(event);              // fan out to WebRTC peers as well
  return event;
}

// ─── reputation ──────────────────────────────────────────────────────────

function consensusVerdict(reportId) {
  const vs = verifications.get(reportId) || [];
  if (vs.length < 3) return null;
  const seen = new Set(); const counts = {};
  for (const v of vs) {
    if (seen.has(v.pubkey)) continue;
    seen.add(v.pubkey);
    const verdict = v.tags.find(t => t[0] === "v")?.[1];
    if (verdict) counts[verdict] = (counts[verdict] || 0) + 1;
  }
  if (Object.keys(counts).length === 0) return null;
  let best = null, bestN = 0;
  for (const [k, n] of Object.entries(counts)) if (n > bestN) { best = k; bestN = n; }
  return best;
}

function verdictCounts(reportId) {
  const vs = verifications.get(reportId) || [];
  const counts = {}; const seen = new Set();
  for (const v of vs) {
    if (seen.has(v.pubkey)) continue;
    seen.add(v.pubkey);
    const verdict = v.tags.find(t => t[0] === "v")?.[1];
    if (verdict) counts[verdict] = (counts[verdict] || 0) + 1;
  }
  return counts;
}

// ─── UI helpers ──────────────────────────────────────────────────────────

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
function shortUrl(u) { try { return new URL(u).host; } catch { return u; } }
function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  const origin = r ? relayHttpOrigin(r) : null;
  return origin ? `${origin}/r/${eventId}` : null;
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
    const counts = verdictCounts(r.id);
    const cv = consensusVerdict(r.id);
    return `
      <div class="report-card" data-id="${r.id}">
        <div class="meta">
          <span class="pub" title="${r.pubkey}">${r.pubkey.slice(0, 8)}…</span>
          <span>·</span>
          <span>${fmtTimeAgo(r.created_at)}</span>
          <span>·</span>
          <span title="geohash">${escapeHTML(geo)}</span>
          ${r.pubkey === pkHex ? `<span>·</span><span style="color:var(--accent)">${escapeHTML(t("feed.you"))}</span>` : ""}
        </div>
        <div class="content">${escapeHTML(r.content)}</div>
        ${tags.length ? `<div class="tags">${tags.map(t => `<span>#${escapeHTML(t)}</span>`).join("")}</div>` : ""}
        <div class="score">
          ${cv ? `<span>${escapeHTML(t("feed.consensus_label"))} <b>${escapeHTML(t("verdict." + cv) !== "verdict." + cv ? t("verdict." + cv) : cv)}</b></span>` : `<span style="opacity:0.6">${escapeHTML(t("feed.awaiting_verifications"))}</span>`}
          ${Object.entries(counts).map(([k, n]) => `<span>${escapeHTML(t("verdict." + k) !== "verdict." + k ? t("verdict." + k) : k)}: <b>${n}</b></span>`).join(" ")}
        </div>
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
  list.innerHTML = status.map(({ url, state }) => `
    <div class="relay-row" data-url="${escapeHTML(url)}">
      <span class="dot ${state}" title="${state}"></span>
      <span class="relay-url mono">${escapeHTML(url)}</span>
      <button class="remove-relay ghost small" aria-label="remove">×</button>
    </div>
  `).join("");
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

  const DEFAULT_TAGS = ["road", "outage", "garbage", "corruption", "scam", "public-safety", "environment", "protest"];
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

  if (peerToggle) {
    peerToggle.addEventListener("change", async () => {
      if (peerToggle.checked) {
        const consented = localStorage.getItem(PEER_PREF_KEY) === "1" || confirm(
          "Enable WebRTC peer mode?\n\n" +
          "Peer mode opens direct connections from your browser to other peers, which exposes your IP address to them (not just to your relay's operator).\n\n" +
          "Don't enable this from a hostile network or when reporting sensitive content. You can turn it off any time."
        );
        if (!consented) { peerToggle.checked = false; return; }
        localStorage.setItem(PEER_PREF_KEY, "1");
        try { await peers.enable(); } catch (e) { toast("peer mode failed: " + (e?.message || e)); peerToggle.checked = false; }
      } else {
        peers.disable();
        localStorage.removeItem(PEER_PREF_KEY);
      }
      updatePeerStatus();
    });
    if (localStorage.getItem(PEER_PREF_KEY) === "1") {
      peerToggle.checked = true;
      // Defer enable until we have at least one relay connected, otherwise the
      // offer publish lands nowhere.
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
