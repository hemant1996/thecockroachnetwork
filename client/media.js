// Decentralized media — CID computation + browser-local storage.
//
// We do NOT run Helia (the browser IPFS node).  Helia is ~500 KB of
// transitive dependencies on esm.sh / jsdelivr, and even when it
// loads, the public IPFS DHT has no idea the browser tab is a node
// until the libp2p bootstrap dance completes — which has a low success
// rate on mobile networks and behind corporate NATs.  In practice
// browser IPFS uploads "work" intermittently at best.
//
// Honest decentralization model we ship instead:
//
//   1. SHA-256 + IPFS CIDv1 are computed LOCALLY in the browser
//      (no network, no Helia).  The CID is a real IPFS-compatible
//      content address — anyone with the bytes can verify them.
//   2. The file is stored in the uploader's browser IndexedDB,
//      keyed by CID.  Survives reloads on the same device.
//   3. The published event carries the standard SPEC §3.4 media tag:
//        ["media", "ipfs://<cid>", "sha256:<hex>", "<mime>", "<size>"]
//   4. The uploader's own feed renders media from IndexedDB via a
//      blob URL (instant, offline-capable).
//   5. Other readers' feeds try public IPFS gateways (cf-ipfs.com,
//      dweb.link, w3s.link).  These succeed ONLY if the uploader (or
//      somebody) pinned the CID to an IPFS service.  If they didn't,
//      the image stays broken — honest signal that nobody is currently
//      keeping the file alive on the network.
//   6. For cross-user permanence, advanced users can paste their own
//      Storacha or Pinata token in Settings (BYO pin, planned v0.2.5).
//      The protocol author + relay operators carry ZERO storage
//      responsibility.
//
// Trade-off owned by this choice: a fresh upload is reachable to the
// uploader only.  That's the honest cost of "no operator".

import { sha256 } from "https://esm.sh/@noble/hashes@1.8.0/sha2";

// ─── IPFS CIDv1 (raw codec) — pure local computation ────────────────
//
//   bytes  → sha256 hash (32 bytes)
//          → multihash:  [0x12 (sha2-256)] [0x20 (length=32)] [hash]
//          → CID v1:     [0x01 (v1)]      [0x55 (raw codec)]  [multihash]
//          → multibase:  "b" prefix + base32 encoding
//
// Result is a canonical CIDv1 string starting with `bafkrei…`, which is
// what public IPFS gateways expect.  Equivalent to running
// `ipfs add --cid-version=1 --raw-leaves` on the same bytes.
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function bytesToBase32(bytes) {
  let bits = 0, value = 0, out = "b"; // 'b' = multibase prefix for base32
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += BASE32[(value >> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function bytesToHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function computeCID(bytes) {
  const hash = sha256(bytes);
  const cidBytes = new Uint8Array(4 + hash.length);
  cidBytes[0] = 0x01; // CID v1
  cidBytes[1] = 0x55; // codec: raw
  cidBytes[2] = 0x12; // multihash function: sha2-256
  cidBytes[3] = 0x20; // multihash length: 32
  cidBytes.set(hash, 4);
  return { cid: bytesToBase32(cidBytes), sha256Hex: bytesToHex(hash) };
}

// ─── IndexedDB store keyed by CID ────────────────────────────────────

const DB_NAME = "cockroach-media";
const STORE = "files";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}
async function dbPut(cid, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, cid);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbGet(cid) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(cid);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// ─── Public API ──────────────────────────────────────────────────────

export async function uploadFile(file) {
  if (!file) throw new Error("no file");
  if (file.size > 20 * 1024 * 1024) throw new Error("file too large (limit 20 MB)");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { cid, sha256Hex } = await computeCID(bytes);
  const blob = new Blob([bytes], { type: file.type || "application/octet-stream" });
  try {
    await dbPut(cid, blob);
  } catch (e) {
    // IndexedDB can fail in private windows / iOS quirks.  We still
    // return the CID — the user can pin the file elsewhere if needed.
    console.warn("[media] IndexedDB unavailable, file kept in memory only:", e?.message);
  }
  return {
    cid,
    sha256: sha256Hex,
    size: file.size,
    mime: file.type || "application/octet-stream",
    name: file.name || "",
  };
}

// No-op kept for API compatibility with the earlier Helia-based version.
export function warmupHelia() { /* nothing to warm up anymore */ }

const PUBLIC_GATEWAYS = [
  (cid) => `https://${cid}.ipfs.dweb.link`,
  (cid) => `https://${cid}.ipfs.w3s.link`,
  (cid) => `https://${cid}.ipfs.cf-ipfs.com`,
];

export function publicGatewayUrl(cid) { return PUBLIC_GATEWAYS[0](cid); }
export function publicGatewayUrls(cid) { return PUBLIC_GATEWAYS.map(g => g(cid)); }

/**
 * Returns a URL that can be used as <img src> for this CID.
 * If the file is in local IndexedDB, returns an instant blob: URL.
 * Otherwise returns the first public gateway URL — caller's onerror
 * fallback chain should walk the rest of the gateway list.
 */
export async function urlForCid(cid) {
  try {
    const blob = await dbGet(cid);
    if (blob) return URL.createObjectURL(blob);
  } catch { /* fall through to gateway */ }
  return publicGatewayUrl(cid);
}

/**
 * Best-effort retrieval — local first, then gateway race.
 */
export async function retrieveFile(cid) {
  try {
    const local = await dbGet(cid);
    if (local) return local;
  } catch { /* try gateways */ }
  for (const make of PUBLIC_GATEWAYS) {
    try {
      const r = await fetch(make(cid));
      if (r.ok) return await r.blob();
    } catch { /* try next */ }
  }
  throw new Error("file not found");
}
