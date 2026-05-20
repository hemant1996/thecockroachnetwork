// Cockroach Relay Protocol — shared primitives.
// Canonical serialization, ed25519 verification, filter matching, geohash.

import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2";

// @noble/ed25519 needs a sync sha512 wired in to expose sync verify/sign.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// ──────────────────────────────────────────────────────────────────────────
// Types

export type Tag = string[];

export interface SignedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: Tag[];
  content: string;
  sig: string;
}

export interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tagKey: `#${string}`]: string[] | undefined;
}

// ──────────────────────────────────────────────────────────────────────────
// Canonical JSON (per SPEC §3.1)

const CTRL: Record<number, string> = {
  0x08: "\\b", 0x09: "\\t", 0x0a: "\\n", 0x0c: "\\f", 0x0d: "\\r",
};

function escapeString(s: string): string {
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

function canonicalScalar(v: string | number): string {
  if (typeof v === "number") return Number.isInteger(v) ? v.toString() : (() => { throw new Error("non-integer in canonical form"); })();
  return `"${escapeString(v)}"`;
}

function canonicalArray(arr: (string | number | string[])[]): string {
  return "[" + arr.map(canonicalValue).join(",") + "]";
}

function canonicalValue(v: string | number | string[] | string[][]): string {
  if (Array.isArray(v)) {
    return "[" + v.map((inner) =>
      Array.isArray(inner) ? canonicalArray(inner as string[]) : canonicalScalar(inner as string | number)
    ).join(",") + "]";
  }
  return canonicalScalar(v as string | number);
}

export function canonicalForm(e: Pick<SignedEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">): string {
  return "[0," + canonicalScalar(e.pubkey) + "," + e.created_at + "," + e.kind + "," + canonicalArray(e.tags) + "," + canonicalScalar(e.content) + "]";
}

export function eventId(e: Pick<SignedEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">): string {
  const bytes = new TextEncoder().encode(canonicalForm(e));
  return bytesToHex(sha256(bytes));
}

// ──────────────────────────────────────────────────────────────────────────
// Hex helpers

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(h: string): Uint8Array {
  if (h.length % 2) throw new Error("odd hex length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Event validation (per SPEC §3.1)

const MAX_EVENT_BYTES = 8192;
const FUTURE_TOLERANCE = 900;       // 15 minutes
const PAST_TOLERANCE = 86400;       // 24 hours

export interface ValidationOk { ok: true; event: SignedEvent; size: number; }
export interface ValidationErr { ok: false; reason: string; }
export type ValidationResult = ValidationOk | ValidationErr;

export function validateEvent(raw: unknown, now: number = Math.floor(Date.now() / 1000)): ValidationResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "invalid: not an object" };
  const e = raw as Record<string, unknown>;

  // Field shape
  if (typeof e.id !== "string" || e.id.length !== 64 || !/^[0-9a-f]+$/.test(e.id))
    return { ok: false, reason: "invalid: id" };
  if (typeof e.pubkey !== "string" || e.pubkey.length !== 64 || !/^[0-9a-f]+$/.test(e.pubkey))
    return { ok: false, reason: "invalid: pubkey" };
  if (typeof e.sig !== "string" || e.sig.length !== 128 || !/^[0-9a-f]+$/.test(e.sig))
    return { ok: false, reason: "invalid: sig" };
  if (typeof e.created_at !== "number" || !Number.isInteger(e.created_at) || e.created_at < 0)
    return { ok: false, reason: "invalid: created_at" };
  if (typeof e.kind !== "number" || !Number.isInteger(e.kind) || e.kind < 0)
    return { ok: false, reason: "invalid: kind" };
  if (typeof e.content !== "string")
    return { ok: false, reason: "invalid: content" };
  if (!Array.isArray(e.tags))
    return { ok: false, reason: "invalid: tags" };
  for (const t of e.tags) {
    if (!Array.isArray(t) || t.length === 0 || !t.every((x) => typeof x === "string"))
      return { ok: false, reason: "invalid: tag shape" };
  }

  // Clock window
  if (e.created_at > now + FUTURE_TOLERANCE)
    return { ok: false, reason: "rejected: created_at too far in future" };
  if (e.created_at < now - PAST_TOLERANCE)
    return { ok: false, reason: "rejected: created_at too far in past" };

  // Size
  const serialized = JSON.stringify(e);
  const size = new TextEncoder().encode(serialized).byteLength;
  if (size > MAX_EVENT_BYTES) return { ok: false, reason: "rejected: event too large" };

  // ID match
  const expected = eventId(e as SignedEvent);
  if (expected !== e.id) return { ok: false, reason: "invalid: id mismatch" };

  // Signature
  try {
    const ok = ed.verify(hexToBytes(e.sig as string), hexToBytes(e.id as string), hexToBytes(e.pubkey as string));
    if (!ok) return { ok: false, reason: "invalid: signature" };
  } catch (err) {
    return { ok: false, reason: "invalid: signature error" };
  }

  return { ok: true, event: e as SignedEvent, size };
}

// ──────────────────────────────────────────────────────────────────────────
// Filter matching (per SPEC §5.3)

function tagIndexOf(filterKey: string): string | null {
  if (filterKey.length === 2 && filterKey[0] === "#") return filterKey[1];
  return null;
}

export function matchesFilter(e: SignedEvent, f: Filter): boolean {
  if (f.ids && f.ids.length && !f.ids.some((p) => e.id.startsWith(p))) return false;
  if (f.authors && f.authors.length && !f.authors.some((p) => e.pubkey.startsWith(p))) return false;
  if (f.kinds && f.kinds.length && !f.kinds.includes(e.kind)) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;

  for (const k of Object.keys(f)) {
    const tagName = tagIndexOf(k);
    if (!tagName) continue;
    const wanted = (f as Record<string, string[] | undefined>)[k];
    if (!wanted || wanted.length === 0) continue;
    const tagValues = e.tags.filter((t) => t[0] === tagName).map((t) => t[1] ?? "");
    if (tagValues.length === 0) return false;
    // Geohash tag matches by prefix; others by equality.
    const matched = wanted.some((w) =>
      tagName === "g"
        ? tagValues.some((tv) => tv.startsWith(w))
        : tagValues.includes(w)
    );
    if (!matched) return false;
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// Geohash (encode lat/lon → base32 of given precision)
// Reference encoder; any standard implementation interoperates.

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function geohashEncode(lat: number, lon: number, precision: number = 7): string {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let bit = 0, ch = 0, even = true;
  let out = "";
  while (out.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { ch = (ch << 1) | 1; lonMin = mid; } else { ch = ch << 1; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latMin = mid; } else { ch = ch << 1; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) { out += BASE32[ch]; bit = 0; ch = 0; }
  }
  return out;
}
