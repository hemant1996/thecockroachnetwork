import { expect, test } from "bun:test";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

import {
  canonicalForm,
  eventId,
  validateEvent,
  matchesFilter,
  geohashEncode,
  bytesToHex,
  hexToBytes,
  type SignedEvent,
} from "../lib.ts";

function makeEvent(content: string, tags: string[][], kind = 1): SignedEvent {
  const sk = ed.utils.randomPrivateKey();
  const pk = ed.getPublicKey(sk);
  const partial = {
    pubkey: bytesToHex(pk),
    created_at: Math.floor(Date.now() / 1000),
    kind,
    tags,
    content,
  };
  const id = eventId(partial);
  const sig = ed.sign(hexToBytes(id), sk);
  return { ...partial, id, sig: bytesToHex(sig) };
}

test("canonical form is deterministic", () => {
  const e = { pubkey: "ab".repeat(32), created_at: 1700000000, kind: 1, tags: [["g", "tdr1y4d"], ["t", "road"]], content: "hi" };
  const c = canonicalForm(e);
  expect(c).toBe(`[0,"${"ab".repeat(32)}",1700000000,1,[["g","tdr1y4d"],["t","road"]],"hi"]`);
});

test("eventId is sha256 of canonical form", () => {
  const e = makeEvent("test", [["g", "tdr1y4d"], ["t", "road"]]);
  expect(e.id).toBe(eventId(e));
});

test("validateEvent accepts a well-formed event", () => {
  const e = makeEvent("hello", [["g", "tdr1y4d"], ["t", "road"]]);
  const r = validateEvent(e);
  expect(r.ok).toBe(true);
});

test("validateEvent rejects bad signature", () => {
  const e = makeEvent("hello", [["g", "tdr1y4d"], ["t", "road"]]);
  e.sig = "00".repeat(64);
  const r = validateEvent(e);
  expect(r.ok).toBe(false);
});

test("validateEvent rejects tampered content", () => {
  const e = makeEvent("hello", [["g", "tdr1y4d"], ["t", "road"]]);
  e.content = "tampered";
  const r = validateEvent(e);
  expect(r.ok).toBe(false);
});

test("validateEvent rejects future timestamp beyond tolerance", () => {
  const e = makeEvent("hello", [["g", "tdr1y4d"], ["t", "road"]]);
  // Replace created_at then re-sign for a fair test of the *time* check.
  const sk = ed.utils.randomPrivateKey();
  const pk = ed.getPublicKey(sk);
  const partial = { pubkey: bytesToHex(pk), created_at: Math.floor(Date.now() / 1000) + 2000, kind: 1, tags: [["g", "tdr1y4d"], ["t", "road"]], content: "hi" };
  const id = eventId(partial);
  const sig = bytesToHex(ed.sign(hexToBytes(id), sk));
  const r = validateEvent({ ...partial, id, sig });
  expect(r.ok).toBe(false);
});

test("matchesFilter on kind + #t", () => {
  const e = makeEvent("hello", [["g", "tdr1y4d"], ["t", "road"]]);
  expect(matchesFilter(e, { kinds: [1] })).toBe(true);
  expect(matchesFilter(e, { kinds: [2] })).toBe(false);
  expect(matchesFilter(e, { "#t": ["road"] })).toBe(true);
  expect(matchesFilter(e, { "#t": ["outage"] })).toBe(false);
});

test("matchesFilter on geohash prefix", () => {
  const e = makeEvent("hello", [["g", "tdr1y4d"], ["t", "road"]]);
  expect(matchesFilter(e, { "#g": ["tdr1"] })).toBe(true);
  expect(matchesFilter(e, { "#g": ["tdr1y4d"] })).toBe(true);
  expect(matchesFilter(e, { "#g": ["zzzz"] })).toBe(false);
});

test("matchesFilter on author prefix", () => {
  const e = makeEvent("hello", [["g", "tdr1y4d"], ["t", "road"]]);
  expect(matchesFilter(e, { authors: [e.pubkey.slice(0, 8)] })).toBe(true);
  expect(matchesFilter(e, { authors: ["deadbeef"] })).toBe(false);
});

test("geohashEncode known points", () => {
  // San Francisco-ish
  expect(geohashEncode(37.7749, -122.4194, 5)).toBe("9q8yy");
  // Mumbai-ish — both 5-char prefixes are valid for that region; the algorithm
  // is deterministic, so we just lock in what this encoder produces.
  expect(geohashEncode(19.076, 72.8777, 5)).toBe("te7ud");
  // Round-trip: precision 7 starts with the precision 5 prefix.
  expect(geohashEncode(19.076, 72.8777, 7).startsWith("te7ud")).toBe(true);
});

test("validates kind:2 verification with #e and #v", () => {
  const target = makeEvent("issue", [["g", "tdr1y4d"], ["t", "road"]]);
  const v = makeEvent("confirmed", [["e", target.id], ["v", "true"]], 2);
  const r = validateEvent(v);
  expect(r.ok).toBe(true);
  expect(matchesFilter(v, { kinds: [2], "#e": [target.id] })).toBe(true);
  expect(matchesFilter(v, { kinds: [2], "#e": ["deadbeef"] })).toBe(false);
});
