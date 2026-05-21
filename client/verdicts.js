// Pure helpers for the Cockroach reference client.
// No DOM, no network, no globals. Tested via client/test/verdicts.test.js.
//
// Covers:
//   - SPEC §4.2.5 dedupe rules per kind
//   - SPEC §4.2.6 legacy-verdict translation
//   - SPEC §8.3 voter weight legibility (geohash-5 local-report counts)
//   - SPEC §8.4 sparse-cell detection
//
// All functions are deterministic from their inputs. Pass in the event store
// arrays you want them to operate on. The caller is responsible for selecting
// the right slice (e.g. truthEvents only).

// ─── canonical helpers ─────────────────────────────────────────────────

export function eTagOf(event)   { return event.tags.find(t => t[0] === "e")?.[1]; }
export function vTagOf(event)   { return event.tags.find(t => t[0] === "v")?.[1]; }
export function gTagOf(event)   { return event.tags.find(t => t[0] === "g")?.[1]; }
export function statusTagOf(ev) { return ev.tags.find(t => t[0] === "status")?.[1]; }
export function relTagOf(ev)    { return ev.tags.find(t => t[0] === "rel")?.[1]; }
export function isRetracted(ev) { return ev.tags.some(t => t[0] === "state" && t[1] === "retracted"); }

// Geohash-5 prefix of a geohash string (any precision ≥ 5).
export function geo5(g) { return typeof g === "string" && g.length >= 5 ? g.slice(0, 5) : null; }

// ─── legacy translation (SPEC §4.2.6) ──────────────────────────────────

// Translate a legacy pre-v0.7 kind:2 event into its v0.7 equivalent.
// Returns: the original event for non-legacy inputs, a new event object for
// translated legacy events (with `_legacy: true` so the caller knows not to
// re-broadcast), or null for events that should be discarded.
export function translateLegacyVerdict(event) {
  if (event.kind !== 2) return event;
  const v = vTagOf(event);
  if (v === "true" || v === "fake") return event;
  const baseTags = event.tags.filter(t => t[0] !== "v");
  if (v === "needs-more-proof") {
    return { ...event, kind: 4, tags: baseTags, _legacy: true };
  }
  if (v === "resolved") {
    return { ...event, kind: 3, tags: [...baseTags, ["status", "resolved"]], _legacy: true };
  }
  if (v === "duplicate") return null;
  return event;
}

// ─── truth-verdict math (kind:2, binary) ───────────────────────────────

// Dedupe truth-verdict events per (pubkey, e-tag, v-tag) per SPEC §4.2.5.
// Returns Map<key, event> where key = "pubkey:eTag:v". Retracted entries
// (latest event has ["state","retracted"]) are excluded.
export function dedupeTruthVerdicts(truthEvents) {
  const latest = new Map();
  for (const ev of truthEvents) {
    if (ev.kind !== 2) continue;
    const v = vTagOf(ev);
    const e = eTagOf(ev);
    if (!v || !e) continue;
    if (v !== "true" && v !== "fake") continue;
    const key = `${ev.pubkey}:${e}:${v}`;
    const cur = latest.get(key);
    if (!cur
        || ev.created_at > cur.created_at
        || (ev.created_at === cur.created_at && ev.id < cur.id)) {
      latest.set(key, ev);
    }
  }
  for (const [key, ev] of latest) {
    if (isRetracted(ev)) latest.delete(key);
  }
  return latest;
}

// { true: N, fake: M } where N, M count distinct pubkeys asserting that
// verdict on the given report.
export function truthCounts(reportId, truthEvents) {
  const forThis = truthEvents.filter(ev => eTagOf(ev) === reportId);
  const latest = dedupeTruthVerdicts(forThis);
  const counts = { true: 0, fake: 0 };
  for (const ev of latest.values()) {
    const v = vTagOf(ev);
    if (v === "true") counts.true++;
    else if (v === "fake") counts.fake++;
  }
  return counts;
}

// Modal truth verdict requiring ≥3 distinct verifiers in the winning bucket.
// Returns "true" | "fake" | null. Ties yield null.
export function truthConsensus(reportId, truthEvents) {
  const c = truthCounts(reportId, truthEvents);
  if (c.true === c.fake) return null;
  const top = c.true > c.fake ? "true" : "fake";
  if (c[top] < 3) return null;
  return top;
}

// Set of truth verdicts the given pubkey currently asserts on the report.
export function myActiveTruth(reportId, myPubkey, truthEvents) {
  const latest = dedupeTruthVerdicts(truthEvents);
  const out = new Set();
  for (const ev of latest.values()) {
    if (ev.pubkey !== myPubkey) continue;
    if (eTagOf(ev) !== reportId) continue;
    const v = vTagOf(ev);
    if (v) out.add(v);
  }
  return out;
}

// ─── status (kind:3) ───────────────────────────────────────────────────

// { status, by, at } for the most recent status across pubkeys per report,
// or null if none. Dedupes per-pubkey first (latest wins), then picks the
// newest assertion across pubkeys.
export function latestStatus(reportId, statusEvents) {
  const forThis = statusEvents.filter(ev => ev.kind === 3 && eTagOf(ev) === reportId);
  const perPubkey = new Map();
  for (const ev of forThis) {
    const cur = perPubkey.get(ev.pubkey);
    if (!cur
        || ev.created_at > cur.created_at
        || (ev.created_at === cur.created_at && ev.id < cur.id)) {
      perPubkey.set(ev.pubkey, ev);
    }
  }
  let top = null;
  for (const ev of perPubkey.values()) {
    if (!top || ev.created_at > top.created_at
        || (ev.created_at === top.created_at && ev.id < top.id)) {
      top = ev;
    }
  }
  if (!top) return null;
  return { status: statusTagOf(top), by: top.pubkey, at: top.created_at };
}

// ─── evidence-request (kind:4) ─────────────────────────────────────────

// Distinct pubkeys with an outstanding evidence request on the report.
export function evidenceRequestCount(reportId, evidenceEvents) {
  const perPubkey = new Set();
  for (const ev of evidenceEvents) {
    if (ev.kind !== 4) continue;
    if (eTagOf(ev) !== reportId) continue;
    perPubkey.add(ev.pubkey);
  }
  return perPubkey.size;
}

// ─── relation (kind:5) ─────────────────────────────────────────────────

// Distinct target ids for duplicate-of relations FROM the given report.
export function duplicatesOf(reportId, relationEvents) {
  const targets = new Set();
  for (const ev of relationEvents) {
    if (ev.kind !== 5) continue;
    if (relTagOf(ev) !== "duplicate-of") continue;
    const eTags = ev.tags.filter(t => t[0] === "e").map(t => t[1]);
    if (eTags[0] !== reportId) continue;
    if (eTags[1]) targets.add(eTags[1]);
  }
  return [...targets];
}

// ─── locality (SPEC §8.3, §8.4) ────────────────────────────────────────

// A voter's local-reports count in the geohash-5 cell of the given target.
// Per SPEC §8.3, this is the legibility floor: a voter sees this number
// before they cast. The full §8.1 weight formula is left to L2+ clients.
export function voterLocalReportCount(myPubkey, targetCell, allEvents) {
  if (!targetCell) return 0;
  const cell = geo5(targetCell);
  if (!cell) return 0;
  let n = 0;
  for (const ev of allEvents) {
    if (ev.kind !== 1) continue;
    if (ev.pubkey !== myPubkey) continue;
    const g = gTagOf(ev);
    if (geo5(g) === cell) n++;
  }
  return n;
}

// Distinct pubkeys who have voted (kind:2/3/4) on any kind:1 event in the
// given geohash-5 cell. Used by SPEC §8.4 sparse-cell detection.
export function cellVerifierCount(cell, reports, truthEvents, statusEvents, evidenceEvents) {
  const target = geo5(cell);
  if (!target) return 0;
  const reportIds = new Set();
  for (const r of reports) {
    if (r.kind !== 1) continue;
    if (geo5(gTagOf(r)) === target) reportIds.add(r.id);
  }
  const voters = new Set();
  for (const ev of [...truthEvents, ...statusEvents, ...evidenceEvents]) {
    if (reportIds.has(eTagOf(ev))) voters.add(ev.pubkey);
  }
  return voters.size;
}

// Locality match length: how many leading characters of two geohashes agree.
// Used by the "near you" feed sort. Pure prefix match — no geographic trig.
// This is intentionally simple and decentralized: each client computes from
// its own last GPS fix without any shared coordinate frame beyond geohash.
export function geohashMatchLen(a, b) {
  if (!a || !b) return 0;
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}

// Evidence multiplier for ranking. 1.0 baseline; +0.5 if the report carries
// a media tag, +0.3 if its content contains a specific date/time mention.
// The regex is intentionally loose — better to over-credit specifics than to
// gatekeep behind a strict format.
const SPECIFIC_WHEN_RE = /\b(\d{1,2}[:.]\d{2}|\d{1,2}\s*(am|pm)|\d{1,2}\/\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
export function evidenceMultiplier(report) {
  let m = 1;
  if (report.tags.some(t => t[0] === "media")) m += 0.5;
  if (SPECIFIC_WHEN_RE.test(report.content || "")) m += 0.3;
  return m;
}
