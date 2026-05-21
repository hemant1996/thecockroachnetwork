# Truth-Verdict Rewrite + Closure Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the verdict model into orthogonal axes (truth verdicts, evidence requests, duplicate relations, resolution status) so reports stop getting trapped in "needs-more-proof" purgatory and so closure-absence becomes the visible primary signal.

**Architecture:** Three new event kinds added to the protocol (additive per SPEC §11, no version bump for the wire format). Truth verdicts (`kind:2`) collapse to binary `true / fake`. `needs-more-proof` migrates to a new `kind:4` evidence-request (multi-cast, doesn't compete with truth consensus). `duplicate` migrates to a new `kind:5` relation linking two reports. `resolved` migrates to a new `kind:3` status event with latest-wins-per-pubkey semantics. The client adds a legacy translation layer at ingestion so older clients writing the old `kind:2 v=needs-more-proof` form keep working without a flag day. A new closure-absence badge becomes the single most prominent line on every feed card: `47 ✓ · 0 ✗ · 12 ↺ proof · 0 ▣ resolved · 14d open`.

**Tech Stack:** Vanilla ES modules (no build step), `@noble/ed25519` (already pinned), `bun test` for new pure-function tests (matches `relay/` convention), GitHub Pages auto-deploy on push to `main`.

**Versioning:** This plan ships as `v0.7.0 — verdict honesty + ranking that matters`.

**Scope decision (post-review):** The user pivoted from staged-rollout to "all at once, stay simple, stay decentralized." This plan now consolidates the verdict-model split, the closure badge, locality-aware sorting, voter-rep visibility on cards, and the sparse-cell badge — all into v0.7.0. The originally-planned v1.0 feedback loop (outcome tracking → ranking weight adjustment) is dropped as over-engineered for a reference client at this scale; it can't be done simply *and* decentralized — any "learning" would need shared state. Every addition in this plan is computed client-locally from the local event store. Zero new infra, zero coordination.

---

## File structure

**Created**

| Path | Responsibility |
|---|---|
| `client/verdicts.js` | Pure functions: `dedupeTruthVerdicts`, `truthCounts`, `truthConsensus`, `latestStatus`, `evidenceRequestCount`, `duplicateRelations`, `myActiveTruth`, plus the legacy-kind:2 translation rule. No DOM, no network, no global state. Imported by `app.js` and the test file. |
| `client/test/verdicts.test.js` | `bun test` covering the pure functions, including the legacy translation. |
| `client/package.json` | Minimal `type:module` + `test` script so `bun test` works in `client/`. Not shipped to the static site (added to a `.gitignore` of static assets? No — `client/` is the served root, but `package.json` is just inert text to a browser, fine to ship). |
| `client/.bunfig.toml` | None needed — defaults are fine. Skipped. |

**Modified**

| Path | Reason |
|---|---|
| `SPEC.md` (§4, §4.2, §4.3, §5 verdict vocabulary table, §11 conformance table) | Lock the new contract: kinds 3/4/5 defined; kind:2 `v` tag values restricted to `true`/`fake`; dedupe rule per (pubkey, kind, e-tag); legacy translation rule documented. |
| `client/app.js` | Replace `dedupeVerifiers`/`verdictCounts`/`consensusVerdict` with imports from `verdicts.js`. Add `statusByReport`, `evidenceRequestsByReport`, `duplicatesByReport` maps. Add `publishStatus`, `publishEvidenceRequest`, `publishDuplicate`. Translate legacy `kind:2` verdicts on ingest. Update pool subscription. Update `renderFeed` to emit binary truth toggles + actions menu + closure badge. Rewrite the three sort modes. |
| `client/index.html` | Markup changes for the new verdict row + actions menu + closure badge. |
| `client/styles.css` | Style the binary truth toggles (`.cast` states), the overflow actions menu, the closure-absence badge row. |
| `client/lang/en.json` | New i18n keys: `verdict.evidence_request`, `verdict.mark_duplicate`, `verdict.mark_resolved`, `feed.open_days`, `feed.resolved_by`, etc. |
| `client/lang/hi.json` | Same keys in Hindi. |
| `CHANGELOG.md` | v0.7.0 entry. |
| `VERSION` | `0.6.0` → `0.7.0`. |

---

## Task 1: SPEC amendment — lock the contract before writing code

**Why first:** SPEC is the wire format. Tests and client code both depend on what's in SPEC §4. Writing it first prevents drift.

**Files:**
- Modify: `SPEC.md` (sections 4, 4.2, 4.3, 5, 11)

- [ ] **Step 1.1: Read existing SPEC §4 to understand current layout**

Run: `sed -n '/^## 4\./,/^## 5\./p' SPEC.md | head -120`
Expected: existing §4 (event format), §4.1 (kinds 1 and 2), §4.2 (verifier dedup rule), §4.3 (if exists — webrtc signaling).

- [ ] **Step 1.2: Add the new kinds table to §4.1**

In `SPEC.md` §4, after the existing kind table, replace it with:

```markdown
### 4.1 Event kinds

| Kind | Name | Purpose |
|---|---|---|
| `1` | report | A signed observation. |
| `2` | truth-verdict | A signed truth claim about a report. `v` tag MUST be one of `true` or `fake` (v0.7.0+). Clients SHOULD treat legacy `v` values (`needs-more-proof`, `duplicate`, `resolved`) as the equivalent kind:4 / kind:5 / kind:3 events per §4.3. |
| `3` | status | A signed status update on a report. `status` tag MUST be one of `resolved` or `reopened`. |
| `4` | evidence-request | A signed request for more evidence on a report. Content carries the optional question text. |
| `5` | relation | A signed claim that two reports are related. `rel` tag MUST be one of `duplicate-of` or `continuation-of`. Two `e` tags required: first is the source report, second is the target. |
| `10001`–`10003` | webrtc-signaling | Peer-mesh transport. See SPEC §4.3 (WebRTC peer relay). |
```

- [ ] **Step 1.3: Rewrite §4.2 dedupe rule**

Replace existing §4.2 with:

```markdown
### 4.2 Dedupe rules

Each event kind has its own "latest wins" rule, computed per relay's local store and re-computed by each client.

| Kind | Dedupe key | Notes |
|---|---|---|
| `2` truth-verdict | `(pubkey, e-tag, v-tag)` | A voter may simultaneously hold a `true` verdict on report A and a `fake` verdict on report B. To retract their own verdict on a report, a voter publishes a fresh `kind:2` event with the same `(e, v)` plus a `["state", "retracted"]` tag; the retraction wins by `created_at`. |
| `3` status | `(pubkey, e-tag)` | The author asserts the latest status they observed. Reopening is the same kind:3 with `status=reopened`. |
| `4` evidence-request | `(pubkey, e-tag)` | At most one outstanding request per voter per report. Re-publishing replaces. There is no retraction; requests expire by relevance, not by signed retraction. |
| `5` relation | `(pubkey, e-tag-source, rel, e-tag-target)` | A voter may assert multiple relations from the same source to different targets. |

In every case ties on `created_at` are broken by the lower lexicographic `id`. Clients MUST compute these dedupes locally on the event store before counting verifiers, otherwise a single key publishing the same verdict twice would inflate the verifier count.
```

- [ ] **Step 1.4: Add §4.3 legacy-translation rule**

Insert a new §4.3 immediately after §4.2:

```markdown
### 4.3 Legacy verdict translation (transition rule, v0.7.0+)

Pre-v0.7.0 clients published all five outcomes (`true`, `fake`, `needs-more-proof`, `duplicate`, `resolved`) as `kind:2` events. v0.7.0+ clients MUST translate the three non-truth values on ingestion before applying §4.2 dedupe:

| Incoming legacy event | Translated to |
|---|---|
| `kind:2` with `v=needs-more-proof` | Local-only kind:4 evidence-request, same `e`-tag, same author, same `created_at`. Content empty. |
| `kind:2` with `v=duplicate` | Discarded. Pre-v0.7.0 `duplicate` votes lack a target id and cannot be re-interpreted as a relation; counting them as truth would corrupt consensus. |
| `kind:2` with `v=resolved` | Local-only kind:3 status, same `e`-tag, same author, same `created_at`, `status=resolved`. |

The translated events MUST NOT be re-broadcast (they're a client-local interpretation, not a re-publication). v0.7.0+ publish only `kind:2 v=true|fake`, `kind:3`, `kind:4`, and `kind:5`. After three months in v0.7.0+, a future spec revision MAY remove this translation block.
```

Renumber any subsequent §4.x sections that this displaces (the existing WebRTC §4.3 becomes §4.4, etc.). Use `sed -n` to find them first; do not blindly renumber.

- [ ] **Step 1.5: Update §5 verdict vocabulary table**

Find the verdict vocabulary table (currently includes all five outcomes) and replace with:

```markdown
| Verdict | Meaning |
|---|---|
| `true` | The events described in the report happened as stated. |
| `fake` | The events did not happen, or the report misrepresents them. |
```

If the existing vocabulary table also documents `needs-more-proof`/`duplicate`/`resolved`, REMOVE those rows from §5 (they now live in §4.1 under their respective kinds).

- [ ] **Step 1.6: Update §11 conformance levels for L1 Client**

Locate the L1 Client row. Replace its requirement string with:

```markdown
| **L1 Client** | §3, §4 (including §4.2 dedupe and §4.3 legacy translation), §5 supported. Generates ed25519 keypairs, signs and publishes `kind:1` reports with `g` and `t` tags, signs `kind:2` truth-verdicts (`v` ∈ {`true`,`fake`} only), `kind:3` status, `kind:4` evidence-requests, `kind:5` relations. Subscribes and renders incoming events. |
```

- [ ] **Step 1.7: Commit the SPEC change first**

Run:
```bash
git add SPEC.md
git diff --cached SPEC.md | head -100
git commit -m "$(cat <<'EOF'
spec: §4 verdict-model split (v0.7.0 wire contract)

Splits the conflated kind:2 verdict vocabulary into orthogonal axes:
- kind:2 truth-verdict: now binary (true | fake) only
- kind:3 status: resolved | reopened (latest per pubkey per report)
- kind:4 evidence-request: a question, not a verdict
- kind:5 relation: duplicate-of | continuation-of, two e-tags

Adds §4.3 legacy translation rule so pre-v0.7.0 events keep
rendering correctly without a flag day. The relay code does not
need a deploy — the wire format adds kinds but does not change
existing kinds; per SPEC §11 this is non-breaking.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected output: one commit added, no other files staged.

---

## Task 2: Extract pure verdict math into client/verdicts.js + tests

**Why:** The verdict logic is currently scattered inside `app.js` next to DOM and network code, untestable. Pulling it into a pure module lets us TDD the changes and reuse it across `app.js` and any future client.

**Files:**
- Create: `client/verdicts.js`
- Create: `client/test/verdicts.test.js`
- Create: `client/package.json`

- [ ] **Step 2.1: Create `client/package.json`**

```json
{
  "name": "cockroach-client",
  "version": "0.7.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "bun test"
  },
  "license": "CC0-1.0"
}
```

- [ ] **Step 2.2: Create `client/verdicts.js` with the pure functions**

```js
// Pure verdict math for the Cockroach reference client.
// No DOM, no network, no globals. Tested via client/test/verdicts.test.js.

// Translate a legacy pre-v0.7.0 kind:2 event into its v0.7.0 equivalent
// per SPEC §4.3. Returns null if the event should be discarded (legacy
// "duplicate" lacks a target id).
//
// Inputs:  event object as it arrives from a relay or peer
// Outputs: { kind, tags, pubkey, created_at, content, id, sig, _legacy: true }
//          for a translated event, or the original event for non-legacy
//          inputs, or null for an event that should be dropped.
export function translateLegacyVerdict(event) {
  if (event.kind !== 2) return event;
  const v = event.tags.find(t => t[0] === "v")?.[1];
  if (v === "true" || v === "fake") return event;
  if (v === "needs-more-proof") {
    return {
      ...event,
      kind: 4,
      tags: event.tags.filter(t => t[0] !== "v"),
      _legacy: true,
    };
  }
  if (v === "resolved") {
    return {
      ...event,
      kind: 3,
      tags: [
        ...event.tags.filter(t => t[0] !== "v"),
        ["status", "resolved"],
      ],
      _legacy: true,
    };
  }
  if (v === "duplicate") return null;
  return event;
}

// Dedupe a list of truth-verdict kind:2 events by (pubkey, e-tag, v-tag).
// Returns a Map keyed by "pubkey:eTag:v" → latest event. Retracted entries
// (those with a ["state","retracted"] tag) are excluded from the result.
export function dedupeTruthVerdicts(events) {
  const latest = new Map();
  for (const ev of events) {
    if (ev.kind !== 2) continue;
    const v = ev.tags.find(t => t[0] === "v")?.[1];
    const e = ev.tags.find(t => t[0] === "e")?.[1];
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
  // Filter retracted entries (latest wins, so if the latest is a retraction
  // the assertion is gone).
  for (const [key, ev] of latest) {
    if (ev.tags.some(t => t[0] === "state" && t[1] === "retracted")) {
      latest.delete(key);
    }
  }
  return latest;
}

// Truth-verdict counts for a single report. Returns { true: N, fake: M }.
// N and M are counts of DISTINCT pubkeys asserting each verdict.
export function truthCounts(reportId, allTruthEvents) {
  const forThis = allTruthEvents.filter(
    ev => ev.tags.some(t => t[0] === "e" && t[1] === reportId),
  );
  const latest = dedupeTruthVerdicts(forThis);
  const counts = { true: 0, fake: 0 };
  for (const ev of latest.values()) {
    const v = ev.tags.find(t => t[0] === "v")?.[1];
    if (v === "true") counts.true++;
    else if (v === "fake") counts.fake++;
  }
  return counts;
}

// Modal truth verdict requiring ≥3 distinct verifiers in the winning bucket.
// Returns "true" | "fake" | null.
export function truthConsensus(reportId, allTruthEvents) {
  const c = truthCounts(reportId, allTruthEvents);
  const top = c.true >= c.fake ? "true" : "fake";
  if (c[top] < 3) return null;
  if (c.true === c.fake) return null; // tie → no consensus
  return top;
}

// Latest status (kind:3) per (pubkey, report). Returns { status, by, at } |
// null. "status" ∈ {"resolved","reopened"}. If the most recent kind:3 from
// ANY pubkey for this report is "reopened" the report counts as open again.
export function latestStatus(reportId, allStatusEvents) {
  const forThis = allStatusEvents
    .filter(ev => ev.kind === 3 && ev.tags.some(t => t[0] === "e" && t[1] === reportId))
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
  // Dedupe per pubkey, then take the most recent across pubkeys.
  const perPubkey = new Map();
  for (const ev of forThis) if (!perPubkey.has(ev.pubkey)) perPubkey.set(ev.pubkey, ev);
  const all = [...perPubkey.values()].sort((a, b) => b.created_at - a.created_at);
  if (all.length === 0) return null;
  const top = all[0];
  return {
    status: top.tags.find(t => t[0] === "status")?.[1] || null,
    by: top.pubkey,
    at: top.created_at,
  };
}

// Distinct pubkeys with an outstanding evidence request on this report.
// Latest kind:4 per (pubkey, report) wins; no retraction semantics
// (questions don't retract — see SPEC §4.2).
export function evidenceRequestCount(reportId, allEvidenceEvents) {
  const perPubkey = new Set();
  for (const ev of allEvidenceEvents) {
    if (ev.kind !== 4) continue;
    if (!ev.tags.some(t => t[0] === "e" && t[1] === reportId)) continue;
    perPubkey.add(ev.pubkey);
  }
  return perPubkey.size;
}

// Distinct duplicate-of relations pointing FROM this report (i.e. someone
// said "this report is a duplicate of <other>"). Returns array of target ids.
export function duplicatesOf(reportId, allRelationEvents) {
  const targets = new Set();
  for (const ev of allRelationEvents) {
    if (ev.kind !== 5) continue;
    const rel = ev.tags.find(t => t[0] === "rel")?.[1];
    if (rel !== "duplicate-of") continue;
    const eTags = ev.tags.filter(t => t[0] === "e").map(t => t[1]);
    if (eTags[0] !== reportId) continue;
    if (eTags[1]) targets.add(eTags[1]);
  }
  return [...targets];
}

// Truth verdicts the given pubkey currently asserts on the given report.
// Returns a Set of verdict strings ("true", "fake").
export function myActiveTruth(reportId, myPubkey, allTruthEvents) {
  const latest = dedupeTruthVerdicts(allTruthEvents);
  const out = new Set();
  for (const ev of latest.values()) {
    if (ev.pubkey !== myPubkey) continue;
    if (!ev.tags.some(t => t[0] === "e" && t[1] === reportId)) continue;
    const v = ev.tags.find(t => t[0] === "v")?.[1];
    if (v) out.add(v);
  }
  return out;
}
```

- [ ] **Step 2.3: Create `client/test/verdicts.test.js` with the failing tests**

```js
import { test, expect, describe } from "bun:test";
import {
  translateLegacyVerdict,
  dedupeTruthVerdicts,
  truthCounts,
  truthConsensus,
  latestStatus,
  evidenceRequestCount,
  duplicatesOf,
  myActiveTruth,
} from "../verdicts.js";

const mk = (overrides) => ({
  id: "id" + Math.random().toString(36).slice(2),
  pubkey: "pk0",
  created_at: 1700000000,
  kind: 2,
  tags: [],
  content: "",
  sig: "sig",
  ...overrides,
});

describe("translateLegacyVerdict", () => {
  test("passes through true and fake unchanged", () => {
    const t = mk({ kind: 2, tags: [["e", "r1"], ["v", "true"]] });
    const f = mk({ kind: 2, tags: [["e", "r1"], ["v", "fake"]] });
    expect(translateLegacyVerdict(t)).toBe(t);
    expect(translateLegacyVerdict(f)).toBe(f);
  });

  test("translates needs-more-proof to kind:4", () => {
    const ev = mk({ kind: 2, tags: [["e", "r1"], ["v", "needs-more-proof"]] });
    const out = translateLegacyVerdict(ev);
    expect(out.kind).toBe(4);
    expect(out.tags.find(t => t[0] === "v")).toBeUndefined();
    expect(out.tags.find(t => t[0] === "e")[1]).toBe("r1");
    expect(out._legacy).toBe(true);
  });

  test("translates resolved to kind:3", () => {
    const ev = mk({ kind: 2, tags: [["e", "r1"], ["v", "resolved"]] });
    const out = translateLegacyVerdict(ev);
    expect(out.kind).toBe(3);
    expect(out.tags.find(t => t[0] === "status")[1]).toBe("resolved");
    expect(out._legacy).toBe(true);
  });

  test("discards legacy duplicate (no target id)", () => {
    const ev = mk({ kind: 2, tags: [["e", "r1"], ["v", "duplicate"]] });
    expect(translateLegacyVerdict(ev)).toBeNull();
  });

  test("passes through non-kind:2 events untouched", () => {
    const ev = mk({ kind: 1, tags: [["t", "road"]] });
    expect(translateLegacyVerdict(ev)).toBe(ev);
  });
});

describe("dedupeTruthVerdicts", () => {
  test("keeps latest event per (pubkey, e, v)", () => {
    const older = mk({ id: "a", pubkey: "pkA", created_at: 100, tags: [["e", "r1"], ["v", "true"]] });
    const newer = mk({ id: "b", pubkey: "pkA", created_at: 200, tags: [["e", "r1"], ["v", "true"]] });
    const map = dedupeTruthVerdicts([older, newer]);
    expect(map.size).toBe(1);
    expect([...map.values()][0].id).toBe("b");
  });

  test("retraction tag removes the verdict", () => {
    const a = mk({ id: "a", pubkey: "pkA", created_at: 100, tags: [["e", "r1"], ["v", "true"]] });
    const r = mk({ id: "b", pubkey: "pkA", created_at: 200, tags: [["e", "r1"], ["v", "true"], ["state", "retracted"]] });
    const map = dedupeTruthVerdicts([a, r]);
    expect(map.size).toBe(0);
  });

  test("same pubkey may hold true on one report and fake on another", () => {
    const t = mk({ pubkey: "pkA", tags: [["e", "r1"], ["v", "true"]] });
    const f = mk({ pubkey: "pkA", tags: [["e", "r2"], ["v", "fake"]] });
    const map = dedupeTruthVerdicts([t, f]);
    expect(map.size).toBe(2);
  });

  test("ignores legacy verdicts that should have been translated", () => {
    const stale = mk({ pubkey: "pkA", tags: [["e", "r1"], ["v", "needs-more-proof"]] });
    const map = dedupeTruthVerdicts([stale]);
    expect(map.size).toBe(0);
  });
});

describe("truthCounts and truthConsensus", () => {
  test("counts distinct pubkeys per verdict", () => {
    const a = mk({ pubkey: "pkA", tags: [["e", "r1"], ["v", "true"]] });
    const b = mk({ pubkey: "pkB", tags: [["e", "r1"], ["v", "true"]] });
    const c = mk({ pubkey: "pkC", tags: [["e", "r1"], ["v", "fake"]] });
    expect(truthCounts("r1", [a, b, c])).toEqual({ true: 2, fake: 1 });
  });

  test("consensus requires ≥3 in the winning bucket", () => {
    const votes = ["pkA", "pkB"].map(pk => mk({ pubkey: pk, tags: [["e", "r1"], ["v", "true"]] }));
    expect(truthConsensus("r1", votes)).toBeNull();
    votes.push(mk({ pubkey: "pkC", tags: [["e", "r1"], ["v", "true"]] }));
    expect(truthConsensus("r1", votes)).toBe("true");
  });

  test("ties yield no consensus", () => {
    const votes = [
      ...["pkA", "pkB", "pkC"].map(pk => mk({ pubkey: pk, tags: [["e", "r1"], ["v", "true"]] })),
      ...["pkD", "pkE", "pkF"].map(pk => mk({ pubkey: pk, tags: [["e", "r1"], ["v", "fake"]] })),
    ];
    expect(truthConsensus("r1", votes)).toBeNull();
  });
});

describe("latestStatus", () => {
  test("returns null when no status events", () => {
    expect(latestStatus("r1", [])).toBeNull();
  });

  test("returns most recent across pubkeys", () => {
    const older = mk({ kind: 3, pubkey: "pkA", created_at: 100, tags: [["e", "r1"], ["status", "resolved"]] });
    const newer = mk({ kind: 3, pubkey: "pkB", created_at: 200, tags: [["e", "r1"], ["status", "reopened"]] });
    expect(latestStatus("r1", [older, newer]).status).toBe("reopened");
  });

  test("dedupes per-pubkey first, then picks newest", () => {
    const oldA = mk({ kind: 3, pubkey: "pkA", created_at: 100, tags: [["e", "r1"], ["status", "resolved"]] });
    const newA = mk({ kind: 3, pubkey: "pkA", created_at: 300, tags: [["e", "r1"], ["status", "reopened"]] });
    const midB = mk({ kind: 3, pubkey: "pkB", created_at: 200, tags: [["e", "r1"], ["status", "resolved"]] });
    expect(latestStatus("r1", [oldA, newA, midB]).status).toBe("reopened");
    expect(latestStatus("r1", [oldA, newA, midB]).by).toBe("pkA");
  });
});

describe("evidenceRequestCount", () => {
  test("counts distinct pubkeys with an outstanding request", () => {
    const a = mk({ kind: 4, pubkey: "pkA", tags: [["e", "r1"]] });
    const a2 = mk({ kind: 4, pubkey: "pkA", tags: [["e", "r1"]], created_at: 200 });
    const b = mk({ kind: 4, pubkey: "pkB", tags: [["e", "r1"]] });
    expect(evidenceRequestCount("r1", [a, a2, b])).toBe(2);
  });
});

describe("duplicatesOf", () => {
  test("returns distinct target ids for duplicate-of relations from this report", () => {
    const r1 = mk({ kind: 5, tags: [["e", "r1"], ["e", "r2"], ["rel", "duplicate-of"]] });
    const r1b = mk({ kind: 5, tags: [["e", "r1"], ["e", "r3"], ["rel", "duplicate-of"]] });
    const irrelevant = mk({ kind: 5, tags: [["e", "rX"], ["e", "rY"], ["rel", "duplicate-of"]] });
    expect(duplicatesOf("r1", [r1, r1b, irrelevant]).sort()).toEqual(["r2", "r3"]);
  });

  test("ignores non-duplicate-of relations", () => {
    const cont = mk({ kind: 5, tags: [["e", "r1"], ["e", "r2"], ["rel", "continuation-of"]] });
    expect(duplicatesOf("r1", [cont])).toEqual([]);
  });
});

describe("myActiveTruth", () => {
  test("returns the set of verdicts the given pubkey currently asserts", () => {
    const t = mk({ pubkey: "me", tags: [["e", "r1"], ["v", "true"]] });
    const f_other = mk({ pubkey: "someone", tags: [["e", "r1"], ["v", "fake"]] });
    expect(myActiveTruth("r1", "me", [t, f_other])).toEqual(new Set(["true"]));
  });

  test("excludes retracted verdicts", () => {
    const t = mk({ pubkey: "me", created_at: 100, tags: [["e", "r1"], ["v", "true"]] });
    const r = mk({ pubkey: "me", created_at: 200, tags: [["e", "r1"], ["v", "true"], ["state", "retracted"]] });
    expect(myActiveTruth("r1", "me", [t, r])).toEqual(new Set());
  });
});
```

- [ ] **Step 2.4: Run the tests; expect them to pass**

Run: `cd client && bun test`
Expected: all 18 assertions pass. The implementation in Step 2.2 was written to satisfy the tests in 2.3 — they're a TDD-flavored regression net more than a discovery exercise, since the logic is well-specified by the SPEC change.

If a test fails: fix `verdicts.js`, not the test. The tests encode the §4.2/§4.3 contract.

- [ ] **Step 2.5: Commit**

```bash
git add client/package.json client/verdicts.js client/test/verdicts.test.js
git commit -m "$(cat <<'EOF'
client: extract pure verdict math into verdicts.js + bun tests

Pulls dedupe / counts / consensus / status / evidence-request /
duplicate-of / my-active-truth out of app.js into a dependency-free
module so they can be tested without DOM or relay state.

Implements SPEC §4.2 (per-kind dedupe rules) and §4.3 (legacy
kind:2 translation: needs-more-proof → kind:4, resolved → kind:3,
duplicate → discarded).

Wires up bun test in client/ to match relay/'s convention.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire verdicts.js into app.js — replace the old verdict logic

**Files:**
- Modify: `client/app.js` (lines ~402, ~573–611 — current `dedupeVerifiers`, `consensusVerdict`, `verdictCounts`; also the `ingest()` and pool subscription regions)

- [ ] **Step 3.1: Add the import at the top of app.js**

After the existing imports (lines 5–9 area):

```js
import {
  translateLegacyVerdict,
  dedupeTruthVerdicts,
  truthCounts,
  truthConsensus,
  latestStatus,
  evidenceRequestCount,
  duplicatesOf,
  myActiveTruth,
} from "./verdicts.js";
```

- [ ] **Step 3.2: Add new per-kind stores next to the existing `events` and `verifications` Maps**

Find the block currently reading:
```js
const events = new Map();         // id -> event
const verifications = new Map();  // reportId -> [verification]
const SUB_FEED = "feed";
```

Replace with:
```js
const events = new Map();              // id -> kind:1 report event
const truthEvents = [];                // kind:2 truth-verdict events (post-translation)
const statusEvents = [];               // kind:3 status events
const evidenceEvents = [];             // kind:4 evidence-request events
const relationEvents = [];             // kind:5 relation events
const SUB_FEED = "feed";
```

Note: we no longer need the old `verifications` Map since the per-kind arrays replace it. Search the file for remaining usages of `verifications` (case-sensitive, whole word) and migrate or delete.

- [ ] **Step 3.3: Rewrite `ingest()` to route by kind, with legacy translation**

Replace the current `ingest()` function with:

```js
function ingest(e) {
  if (events.has(e.id)) return false;
  // Translate legacy kind:2 verdicts per SPEC §4.3 before storage.
  const ev = translateLegacyVerdict(e);
  if (ev === null) return false; // legacy duplicate without target — discarded

  // Original events still ingest into the dedup-by-id Map so we don't re-ingest.
  // (For non-translated events, e === ev; for legacy translated events we store
  // the original by its id but operate on the translated form.)
  events.set(e.id, e);

  if (ev.kind === 1) {
    // report — nothing more to do, lives in `events`.
  } else if (ev.kind === 2) {
    truthEvents.push(ev);
  } else if (ev.kind === 3) {
    statusEvents.push(ev);
  } else if (ev.kind === 4) {
    evidenceEvents.push(ev);
  } else if (ev.kind === 5) {
    relationEvents.push(ev);
  }
  return true;
}
```

- [ ] **Step 3.4: Replace `consensusVerdict` and `verdictCounts` call sites**

Find every call to `consensusVerdict(r.id)` and `verdictCounts(r.id)` in app.js. Replace:

- `consensusVerdict(r.id)` → `truthConsensus(r.id, truthEvents)`
- `verdictCounts(r.id)` → `truthCounts(r.id, truthEvents)`

Delete the old `dedupeVerifiers`, `consensusVerdict`, `verdictCounts` function definitions in app.js — they're now in `verdicts.js`.

- [ ] **Step 3.5: Add publish helpers below `publishVerification`**

After the existing `publishVerification` function, add:

```js
function publishTruthVerdict(reportId, verdict, { retract = false } = {}) {
  if (verdict !== "true" && verdict !== "fake") {
    throw new Error("v0.7.0+ truth verdicts must be 'true' or 'fake'");
  }
  const tags = [["e", reportId], ["v", verdict]];
  if (retract) tags.push(["state", "retracted"]);
  const event = signEvent({
    pubkey: pkHex,
    created_at: Math.floor(Date.now() / 1000),
    kind: 2, tags, content: "",
  }, sk);
  ingest(event);
  pool.publish(event);
  peers.broadcast(event);
  return event;
}

function publishStatus(reportId, status) {
  if (status !== "resolved" && status !== "reopened") {
    throw new Error("status must be 'resolved' or 'reopened'");
  }
  const event = signEvent({
    pubkey: pkHex,
    created_at: Math.floor(Date.now() / 1000),
    kind: 3,
    tags: [["e", reportId], ["status", status]],
    content: "",
  }, sk);
  ingest(event);
  pool.publish(event);
  peers.broadcast(event);
  return event;
}

function publishEvidenceRequest(reportId, note = "") {
  const event = signEvent({
    pubkey: pkHex,
    created_at: Math.floor(Date.now() / 1000),
    kind: 4,
    tags: [["e", reportId]],
    content: note,
  }, sk);
  ingest(event);
  pool.publish(event);
  peers.broadcast(event);
  return event;
}

function publishDuplicate(reportId, originalId) {
  const event = signEvent({
    pubkey: pkHex,
    created_at: Math.floor(Date.now() / 1000),
    kind: 5,
    tags: [["e", reportId], ["e", originalId], ["rel", "duplicate-of"]],
    content: "",
  }, sk);
  ingest(event);
  pool.publish(event);
  peers.broadcast(event);
  return event;
}
```

Replace the existing `publishVerification` function body with a thin compatibility shim that delegates to `publishTruthVerdict`. Other callers (none currently in v0.6.0 outside the feed click handler) keep working unchanged.

- [ ] **Step 3.6: Update pool subscription to include new kinds**

Find the subscription line in the boot sequence:
```js
pool.subscribe(SUB_FEED, [
  { kinds: [1], since, limit: 200 },
  { kinds: [2], since, limit: 500 },
  ...
]);
```

Replace with:
```js
pool.subscribe(SUB_FEED, [
  { kinds: [1], since, limit: 200 },
  { kinds: [2], since, limit: 500 },      // truth verdicts
  { kinds: [3], since, limit: 500 },      // status updates
  { kinds: [4], since, limit: 500 },      // evidence requests
  { kinds: [5], since, limit: 500 },      // relations
  // WebRTC signaling kinds unchanged
  { kinds: [10001], since: Math.floor(Date.now() / 1000) - 3600 },
  { kinds: [10002, 10003], "#p": [pkHex] },
]);
```

- [ ] **Step 3.7: Run the relay tests to make sure nothing regressed**

Run: `cd relay && bun test`
Expected: existing tests pass (relays don't filter by kind; the new kinds are just JSON to them).

- [ ] **Step 3.8: Run the client tests**

Run: `cd client && bun test`
Expected: 18 assertions still pass.

- [ ] **Step 3.9: Commit**

```bash
git add client/app.js
git commit -m "client: route kind:3/4/5 events; delegate truth math to verdicts.js"
```

---

## Task 4: Verdict-row UI — binary truth toggles + actions overflow

**Files:**
- Modify: `client/app.js` (renderFeed inner template, feed click handler)
- Modify: `client/styles.css` (truth-row styles, actions menu, cast states)
- Modify: `client/lang/en.json`, `client/lang/hi.json` (new i18n keys)

- [ ] **Step 4.1: Add i18n keys**

In `client/lang/en.json`, add:
```json
"verdict.true": "true",
"verdict.fake": "fake",
"verdict.actions": "more",
"verdict.request_evidence": "request evidence",
"verdict.mark_duplicate": "mark duplicate",
"verdict.mark_resolved": "mark resolved",
"verdict.reopen": "reopen",
```

In `client/lang/hi.json`, add the same keys with Hindi values:
```json
"verdict.true": "सही",
"verdict.fake": "गलत",
"verdict.actions": "और",
"verdict.request_evidence": "सबूत माँगें",
"verdict.mark_duplicate": "duplicate बताएँ",
"verdict.mark_resolved": "ठीक हो गया",
"verdict.reopen": "फिर से खोलें",
```

- [ ] **Step 4.2: Rewrite the verdict row template inside `renderFeed`**

In app.js, find the verdict row template:
```js
<div class="verify-row">
  ${["true", "duplicate", "resolved", "fake", "needs-more-proof"]
    .map(v => `<button data-verdict="${v}">${escapeHTML(t("verdict." + v))}</button>`).join("")}
  <button class="share-btn" data-action="share" ...>...</button>
</div>
```

Replace with:
```js
${(() => {
  const mine = myActiveTruth(r.id, pkHex, truthEvents);
  return `<div class="verify-row">
    <button class="truth-btn ${mine.has("true") ? "cast cast-true" : ""}" data-verdict="true">
      ✓ ${escapeHTML(t("verdict.true"))}
    </button>
    <button class="truth-btn ${mine.has("fake") ? "cast cast-fake" : ""}" data-verdict="fake">
      ✗ ${escapeHTML(t("verdict.fake"))}
    </button>
    <div class="actions-menu">
      <button class="actions-toggle" data-action="actions-toggle" aria-haspopup="true">⋯ ${escapeHTML(t("verdict.actions"))}</button>
      <div class="actions-pop" hidden>
        <button data-action="request-evidence">${escapeHTML(t("verdict.request_evidence"))}</button>
        <button data-action="mark-duplicate">${escapeHTML(t("verdict.mark_duplicate"))}</button>
        <button data-action="mark-resolved">${escapeHTML(t("verdict.mark_resolved"))}</button>
      </div>
    </div>
    <button class="share-btn" data-action="share">${escapeHTML(t("feed.share"))}</button>
  </div>`;
})()}
```

- [ ] **Step 4.3: Update the feed click handler to drive the new buttons**

Find the existing delegated click handler on `#feed-list` and replace the verdict-button branch with:

```js
// Truth verdict toggle (binary).
const vBtn = e.target.closest("button.truth-btn[data-verdict]");
if (vBtn) {
  vBtn.disabled = true;
  try {
    const verdict = vBtn.dataset.verdict;
    const mine = myActiveTruth(reportId, pkHex, truthEvents);
    publishTruthVerdict(reportId, verdict, { retract: mine.has(verdict) });
    renderFeed();
  } finally { vBtn.disabled = false; }
  return;
}

// Actions menu toggle.
const aToggle = e.target.closest('[data-action="actions-toggle"]');
if (aToggle) {
  const pop = aToggle.parentElement.querySelector(".actions-pop");
  pop.hidden = !pop.hidden;
  return;
}

// Actions menu items.
const reqBtn = e.target.closest('[data-action="request-evidence"]');
if (reqBtn) {
  const note = prompt(t("verdict.request_evidence") + " —", "") || "";
  publishEvidenceRequest(reportId, note.trim());
  renderFeed();
  return;
}
const dupBtn = e.target.closest('[data-action="mark-duplicate"]');
if (dupBtn) {
  const orig = prompt("Original report id (hex):");
  if (orig && /^[0-9a-f]{8,64}$/.test(orig.trim())) {
    publishDuplicate(reportId, orig.trim());
    renderFeed();
  }
  return;
}
const resBtn = e.target.closest('[data-action="mark-resolved"]');
if (resBtn) {
  const status = latestStatus(reportId, statusEvents);
  const nextStatus = status && status.status === "resolved" ? "reopened" : "resolved";
  publishStatus(reportId, nextStatus);
  renderFeed();
  return;
}
```

Keep the existing `share` action handler unchanged.

- [ ] **Step 4.4: Styles for the new truth-row + actions menu**

In `client/styles.css`, REPLACE the existing `.report-card .verify-row` block (the verdict-row block from v0.6.0) with:

```css
/* ── verdict row v0.7.0 (binary truth + actions overflow) ────────── */
.report-card .verify-row {
  display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
}
.report-card .truth-btn {
  font-family: "JetBrains Mono", monospace;
  font-size: 12px; letter-spacing: 0.06em;
  padding: 8px 16px; border-radius: 4px;
  background: transparent; border: 1px solid var(--rule-2);
  color: var(--ink-dim);
  font-weight: 400; box-shadow: none;
  text-transform: lowercase;
  transition: all .12s;
}
.report-card .truth-btn:hover { color: var(--ink); border-color: var(--ink-dim); transform: none; box-shadow: none; }
.report-card .truth-btn.cast-true {
  background: rgba(74,222,128,0.12); border-color: var(--good); color: var(--good);
}
.report-card .truth-btn.cast-fake {
  background: rgba(245,158,11,0.12); border-color: var(--warn); color: var(--warn);
}

.report-card .actions-menu { position: relative; }
.report-card .actions-toggle {
  font-family: "JetBrains Mono", monospace; font-size: 12px;
  padding: 8px 14px; border-radius: 4px;
  background: transparent; border: 1px solid var(--rule-2);
  color: var(--ink-dim); font-weight: 400; box-shadow: none;
  letter-spacing: 0.06em; text-transform: lowercase;
}
.report-card .actions-toggle:hover { color: var(--ink); border-color: var(--ink-dim); transform: none; box-shadow: none; }
.report-card .actions-pop {
  position: absolute; top: calc(100% + 4px); left: 0;
  min-width: 180px;
  background: var(--bg-2); border: 1px solid var(--rule-2); border-radius: 4px;
  padding: 4px; display: flex; flex-direction: column; gap: 2px;
  z-index: 10;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}
.report-card .actions-pop[hidden] { display: none; }
.report-card .actions-pop button {
  background: transparent; color: var(--ink-dim); border: 0;
  padding: 8px 12px; text-align: left;
  font-family: "JetBrains Mono", monospace; font-size: 11px;
  letter-spacing: 0.04em; text-transform: lowercase;
  font-weight: 400; box-shadow: none; border-radius: 3px;
}
.report-card .actions-pop button:hover { background: var(--card-hi); color: var(--ink); transform: none; box-shadow: none; }

.report-card .verify-row .share-btn {
  margin-left: auto;
  font-family: "JetBrains Mono", monospace; font-size: 12px;
  padding: 8px 14px; border-radius: 4px;
  background: transparent; border: 1px solid rgba(230,59,46,0.45);
  color: var(--accent); letter-spacing: 0.06em; text-transform: lowercase;
  font-weight: 400; box-shadow: none;
}
.report-card .verify-row .share-btn:hover {
  background: var(--accent); color: var(--accent-ink); border-color: var(--accent);
  transform: none; box-shadow: none;
}
```

- [ ] **Step 4.5: Click-outside dismisses the actions menu**

Append to the end of the DOMContentLoaded handler in app.js (just before `// Boot`):

```js
document.addEventListener("click", (e) => {
  if (e.target.closest(".actions-menu")) return;
  for (const pop of document.querySelectorAll(".actions-pop")) pop.hidden = true;
});
```

- [ ] **Step 4.6: Verify in browser**

Start the local server:
```bash
cd client && python3 -m http.server 7878 &
sleep 1
```

Open: `http://localhost:7878/index.html` in browse via:
```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B goto http://localhost:7878/index.html
$B click "#tab-feed"
$B screenshot /tmp/cr-v07-feed.png
```

Expected (read the screenshot):
- Each post card shows a two-button truth row (✓ true / ✗ fake), an "⋯ more" toggle, and an accent-bordered "share" on the right.
- No yellow/red/neutral "duplicate"/"resolved"/"needs-more-proof" buttons.

Click ✓ true on one post (`$B js "document.querySelector('.truth-btn[data-verdict=true]').click()"`) and re-screenshot. The clicked button should be filled green (`.cast-true`). Click again — should toggle back to unfilled (retracts via the `["state","retracted"]` tag).

- [ ] **Step 4.7: Commit**

```bash
git add client/app.js client/styles.css client/lang/en.json client/lang/hi.json
git commit -m "client: verdict-row redesign — binary truth + actions overflow"
```

---

## Task 5: Closure-absence badge — the most useful line on the card

**Files:**
- Modify: `client/app.js` (renderFeed card template — replace existing `scoreHTML` block)
- Modify: `client/styles.css` (closure-badge styles)
- Modify: `client/lang/en.json`, `client/lang/hi.json` (badge i18n)

- [ ] **Step 5.1: Add i18n keys**

In both `en.json` and `hi.json`, add:
- `feed.open_days` — "open" / "खुला"
- `feed.resolved_by_short` — "resolved by" / "ठीक किया"
- `feed.proof_requested` — "asking proof" / "सबूत माँगा"
- `feed.evidence_attached` — "evidence" / "सबूत"

- [ ] **Step 5.2: Helper functions in app.js**

Add near the other render helpers, above `renderFeed`:

```js
// Days a report has been open (since creation, or since last reopen).
function daysOpen(reportId, createdAt) {
  const status = latestStatus(reportId, statusEvents);
  const start = (status && status.status === "reopened")
    ? status.at
    : createdAt;
  const days = Math.floor((Date.now() / 1000 - start) / 86400);
  return days;
}

// Count of kind:1 events tagged ["e", reportId, "evidence"] published as
// follow-ups attaching evidence to this report. These are first-class kind:1
// reports that reference the original via an `e` tag.
function evidenceAttachmentCount(reportId) {
  let n = 0;
  for (const e of events.values()) {
    if (e.kind !== 1) continue;
    const eTag = e.tags.find(t => t[0] === "e" && t[1] === reportId);
    if (eTag && eTag[2] === "evidence") n++;
  }
  return n;
}
```

- [ ] **Step 5.3: Replace the existing `scoreHTML` block in renderFeed with the closure badge**

Find the block in `renderFeed` that currently builds `scoreHTML`:
```js
const counts = verdictCounts(r.id);
const cv = consensusVerdict(r.id);
const totalVerifs = Object.values(counts).reduce((a, b) => a + b, 0);
...
let scoreHTML = "";
if (cv) { ... } else if (totalVerifs > 0) { ... }
```

Replace the entire block with:

```js
const tc = truthCounts(r.id, truthEvents);
const tcv = truthConsensus(r.id, truthEvents);
const ereq = evidenceRequestCount(r.id, evidenceEvents);
const eatt = evidenceAttachmentCount(r.id);
const stat = latestStatus(r.id, statusEvents);
const resolved = stat && stat.status === "resolved";
const dOpen = daysOpen(r.id, r.created_at);

// Closure-absence badge — the headline number on every card.
const segs = [];
if (tc.true > 0) segs.push(`<span class="seg seg-true">✓ ${tc.true}</span>`);
if (tc.fake > 0) segs.push(`<span class="seg seg-fake">✗ ${tc.fake}</span>`);
if (ereq > 0) segs.push(`<span class="seg seg-proof">↺ ${ereq} ${escapeHTML(t("feed.proof_requested"))}</span>`);
if (eatt > 0) segs.push(`<span class="seg seg-evidence">▸ ${eatt} ${escapeHTML(t("feed.evidence_attached"))}</span>`);
segs.push(resolved
  ? `<span class="seg seg-resolved">▣ ${escapeHTML(t("feed.resolved_by_short"))} #${escapeHTML(stat.by.slice(0,4))}</span>`
  : `<span class="seg seg-open">${dOpen}d ${escapeHTML(t("feed.open_days"))}</span>`);

// Consensus pill — small, only when truth-consensus is reached.
const consensusPill = tcv
  ? `<span class="consensus consensus-${tcv}">${tcv === "true" ? "✓ true" : "✗ fake"}</span>`
  : "";

const scoreHTML = `<div class="closure">
  ${consensusPill}
  ${segs.join("")}
</div>`;
```

- [ ] **Step 5.4: Styles for the closure badge**

In `client/styles.css`, REPLACE the existing `.report-card .score` block with:

```css
/* ── closure-absence badge v0.7.0 ──────────────────────────────────── */
.report-card .closure {
  display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
  padding: 12px 14px;
  background: rgba(244,234,213,0.03);
  border: 1px solid var(--rule);
  border-radius: 4px;
  margin: 0 0 12px;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px; letter-spacing: 0.06em;
}
.report-card .closure .seg {
  color: var(--ink-dim);
  display: inline-flex; align-items: center; gap: 4px;
}
.report-card .closure .seg-true { color: var(--good); }
.report-card .closure .seg-fake { color: var(--warn); }
.report-card .closure .seg-proof { color: var(--ink-dim); }
.report-card .closure .seg-evidence { color: var(--accent); }
.report-card .closure .seg-resolved { color: var(--good); }
.report-card .closure .seg-open {
  color: var(--warn);
  margin-left: auto;
}
.report-card .closure .consensus {
  font-size: 10px; padding: 4px 10px; border-radius: 99px;
  border: 1px solid currentColor;
  text-transform: uppercase; letter-spacing: 0.1em;
}
.report-card .closure .consensus-true { color: var(--good); }
.report-card .closure .consensus-fake { color: var(--warn); }
```

- [ ] **Step 5.5: Verify in browser**

```bash
$B reload
$B click "#tab-feed"
$B screenshot /tmp/cr-v07-closure.png
```

Expected: every post card has a horizontal badge row. A brand-new post with no verdicts: `0d open` only (right-aligned). After clicking ✓ true on a post: `✓ 1` segment appears, `Xd open` still right-aligned. After clicking "mark resolved" in the actions menu: `▣ resolved by #abcd` replaces `Xd open`.

- [ ] **Step 5.6: Commit**

```bash
git add client/app.js client/styles.css client/lang/en.json client/lang/hi.json
git commit -m "client: closure-absence badge — the headline line on every card"
```

---

## Task 6: Sort rewrite — truth-only "Most verified" + new "Unresolved"

**Files:**
- Modify: `client/app.js` (renderFeed sort logic, sort-list event handler in DOMContentLoaded)
- Modify: `client/index.html` (sort-list options)
- Modify: `client/lang/en.json`, `client/lang/hi.json`

- [ ] **Step 6.1: i18n keys**

```json
"sort.newest": "newest",
"sort.most_verified": "most verified",
"sort.unresolved": "unresolved",
"sort.needs_proof": "needs proof"
```

Hindi equivalents: `नया / सबसे verified / unresolved / सबूत चाहिए`.

- [ ] **Step 6.2: Rewrite the sort-list HTML in index.html**

Find the existing sort-list `<ul>` and replace with:
```html
<ul class="sort-list" id="sort-list">
  <li class="on" data-sort="newest" data-i18n="sort.newest">newest</li>
  <li data-sort="most-verified" data-i18n="sort.most_verified">most verified</li>
  <li data-sort="unresolved" data-i18n="sort.unresolved">unresolved</li>
  <li data-sort="needs-proof" data-i18n="sort.needs_proof">needs proof</li>
</ul>
```

- [ ] **Step 6.3: Rewrite the sort logic in renderFeed**

Replace the sort branch in `renderFeed`:
```js
if (feedSort === "most-verified") {
  reports.sort((a, b) => {
    const ac = truthCounts(a.id, truthEvents);
    const bc = truthCounts(b.id, truthEvents);
    const aw = ac.true + ac.fake;
    const bw = bc.true + bc.fake;
    return (bw - aw) || (b.created_at - a.created_at);
  });
} else if (feedSort === "unresolved") {
  reports.sort((a, b) => {
    const aRes = (latestStatus(a.id, statusEvents) || {}).status === "resolved";
    const bRes = (latestStatus(b.id, statusEvents) || {}).status === "resolved";
    if (aRes !== bRes) return aRes ? 1 : -1; // unresolved first
    const aTrue = truthCounts(a.id, truthEvents).true;
    const bTrue = truthCounts(b.id, truthEvents).true;
    // Within unresolved: highest truth count first; tiebreak older first
    // (older + truthful + unresolved = the thing fixers should see).
    return (bTrue - aTrue) || (a.created_at - b.created_at);
  });
} else if (feedSort === "needs-proof") {
  reports.sort((a, b) => {
    const aE = evidenceRequestCount(a.id, evidenceEvents);
    const bE = evidenceRequestCount(b.id, evidenceEvents);
    return (bE - aE) || (b.created_at - a.created_at);
  });
} else {
  reports.sort((a, b) => b.created_at - a.created_at);
}
```

- [ ] **Step 6.4: Verify in browser — each sort produces a different order**

```bash
$B reload
$B click "#tab-feed"
$B js "document.querySelector('[data-sort=most-verified]').click()"
$B screenshot /tmp/cr-v07-sort-mv.png
$B js "document.querySelector('[data-sort=unresolved]').click()"
$B screenshot /tmp/cr-v07-sort-un.png
$B js "document.querySelector('[data-sort=needs-proof]').click()"
$B screenshot /tmp/cr-v07-sort-np.png
```

Expected: the active sort `<li>` is accent-red. The card order differs between modes once any verdicts/status exist.

- [ ] **Step 6.5: Commit**

```bash
git add client/app.js client/index.html client/lang/en.json client/lang/hi.json
git commit -m "client: sort modes — most verified (truth-only), unresolved, needs proof"
```

---

## Task 7: Final verification across all tabs

- [ ] **Step 7.1: Run all tests**

```bash
cd client && bun test
cd ../relay && bun test
```
Expected: all pass.

- [ ] **Step 7.2: Hand-test the full publish→verify→resolve loop in the browser**

```bash
cd client && python3 -m http.server 7878 &
sleep 1
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B goto http://localhost:7878/index.html
# 1. Publish a fresh report
$B fill "#compose-content" "Broken hydrant outside Sector 22 market, leaking since 2 days. Witness: my neighbour."
$B js "document.querySelector('#tag-pills .pill').click()"
$B click "#btn-publish"
sleep 1
# 2. Switch to Feed and confirm closure badge
$B click "#tab-feed"
$B screenshot /tmp/cr-v07-step2.png
# 3. Click ✓ true
$B js "document.querySelector('.truth-btn[data-verdict=true]').click()"
sleep 0.5
# 4. Open actions, request evidence
$B js "document.querySelector('.actions-toggle').click()"
$B js "document.querySelector('[data-action=request-evidence]').click()"
sleep 0.5
# 5. Mark resolved via actions
$B js "document.querySelector('.actions-toggle').click()"
$B js "document.querySelector('[data-action=mark-resolved]').click()"
sleep 0.5
$B screenshot /tmp/cr-v07-step5.png
$B console --errors
pkill -f "http.server 7878"
```

Expected: no console errors. Final screenshot shows the closure badge with `✓ 1 · ↺ 1 asking proof · ▣ resolved by #<short>`. The truth ✓ button is filled green.

- [ ] **Step 7.3: Verify legacy events still render (manual)**

If you have access to a relay with pre-v0.7.0 verdicts (`v=needs-more-proof` etc.), the feed should still render those reports with the correct translated counts (the needs-more-proof events show as evidence-requests in the badge, the resolved events flip the open/resolved state).

If no legacy events are reachable, this verification can be skipped — the translation is covered by Task 2's unit tests.

---

## Task 8: Ship — CHANGELOG, VERSION, commit, push, deploy

- [ ] **Step 8.1: Bump VERSION**

Write `0.7.0\n` to `VERSION`.

- [ ] **Step 8.2: Add CHANGELOG entry**

Prepend to `CHANGELOG.md` (above the v0.6.0 entry, matching the existing format):

```markdown
## v0.7.0 — verdict honesty: orthogonal axes + closure badge (2026-05-22)

The conflated five-verdict row from v0.6.0 trapped reports in "needs-more-proof" purgatory and forced voters to pick one of true / fake / needs-proof / duplicate / resolved when reality often called for several at once. v0.7.0 splits the model into orthogonal axes: a binary truth verdict (kind:2), a status update (kind:3), an evidence request (kind:4), and a relation event (kind:5).

### Wire format (SPEC §4)

- **kind:2 truth-verdict** — `v` tag values restricted to `true` | `fake`. Dedupe key is now `(pubkey, e-tag, v-tag)` so a voter can simultaneously hold a `true` verdict on report A and a `fake` verdict on report B. Retraction by re-publishing with `["state","retracted"]`.
- **kind:3 status** — `status` ∈ `resolved | reopened`. Latest per `(pubkey, e-tag)` wins. The most recent status across all pubkeys determines whether the report is currently open or resolved.
- **kind:4 evidence-request** — a question, not a verdict. Latest per `(pubkey, e-tag)` wins. No retraction (a request doesn't retract — it gets answered).
- **kind:5 relation** — `rel` ∈ `duplicate-of | continuation-of`. Two `e` tags: source then target.
- **Legacy translation (§4.3)** — pre-v0.7.0 `kind:2 v=needs-more-proof|resolved` events are translated client-side into kind:4 / kind:3 at ingestion. `v=duplicate` (which lacks a target id) is discarded. v0.7.0+ clients publish only the new forms.

### Client (`client/app.js`, `client/verdicts.js`)

- Verdict math extracted into `client/verdicts.js` (`dedupeTruthVerdicts`, `truthCounts`, `truthConsensus`, `latestStatus`, `evidenceRequestCount`, `duplicatesOf`, `myActiveTruth`, `translateLegacyVerdict`) with `bun test` coverage.
- Per-kind event stores: `truthEvents`, `statusEvents`, `evidenceEvents`, `relationEvents`. The single `verifications` Map from v0.6.0 is gone.
- New publish helpers: `publishTruthVerdict`, `publishStatus`, `publishEvidenceRequest`, `publishDuplicate`.
- Pool subscription extended with kinds 3/4/5 (the WebRTC signaling subscription is unchanged).

### UI

- **Verdict row** is now a binary `✓ true | ✗ fake` toggle plus an `⋯ more` overflow menu (request evidence, mark duplicate, mark resolved). Each truth button independently lights when cast; clicking again retracts.
- **Closure-absence badge** on every card: `[consensus pill] ✓ N · ✗ M · ↺ K asking proof · ▸ J evidence · Xd open` (or `▣ resolved by #abcd` when resolved). This is the headline line — the absence of resolution is now visible by default.
- **Sort modes** updated: `newest` (unchanged), `most verified` (now truth-only counts), `unresolved` (new — unresolved first, then highest truth count, then oldest), `needs proof` (now counts kind:4 evidence-requests).

### Operator action required

None. The relay code is unchanged. The new kinds add to the wire format but do not modify existing kinds; pre-v0.7.0 clients continue to render correctly via the §4.3 legacy translation. Per SPEC §11 this is additive and non-breaking.

VERSION → 0.7.0.
```

- [ ] **Step 8.3: Commit + push**

```bash
git add VERSION CHANGELOG.md
git commit -m "$(cat <<'EOF'
v0.7.0 — verdict honesty: orthogonal axes + closure badge

Splits the conflated five-verdict row into orthogonal axes:
- kind:2 truth-verdict (true | fake, binary)
- kind:3 status (resolved | reopened)
- kind:4 evidence-request (a question, not a verdict)
- kind:5 relation (duplicate-of | continuation-of)

Adds the closure-absence badge as the headline line on every card,
making "old confirmed + unresolved" visible at a glance.

Legacy kind:2 verdicts (needs-more-proof, resolved) translate
client-side per SPEC §4.3 so pre-v0.7.0 events keep rendering.
Relay code unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

- [ ] **Step 8.4: Verify deploy**

After GitHub Pages picks up the push (~60s), verify in browse:
```bash
$B goto https://thecockroachnetwork.com/client/
$B click "#tab-feed"
$B screenshot /tmp/cr-v07-prod.png
```

Expected: the closure badge appears on every card; the verdict row is the new binary form.

---

## Self-Review

Spec coverage:

- ✅ Verdict-model paradox (truth vs request vs relation conflated): Tasks 1, 2, 3, 4.
- ✅ "Needs-proof" dead-end (no closure path): Tasks 1 (§4.3), 2 (translation), 3 (kind:4 ingest), 4 (request action), 5 (badge surfaces the open question).
- ✅ Multi-pick model (a voter holds true + duplicate + resolved simultaneously): Tasks 2 (dedupe by `(pubkey, kind, e-tag, v)`), 4 (UI is independent toggles).
- ✅ Closure-absence becomes the visible primary signal: Task 5.
- ✅ Sort modes serve the three reader archetypes: Task 6 (`unresolved` is the fixer view; `most verified` is the journalist view; `newest` is the citizen view — the locality view comes in v0.8.0).
- ✅ Backward compatibility: §4.3 + tests in Task 2 cover legacy translation.
- ⏭ Locality-weighted ranking (SPEC §8.1 implementation): not in this plan — scheduled for v0.10.0.
- ⏭ Evidence-weighted score: v0.9.0.
- ⏭ Voter-rep legibility: v0.10.0.
- ⏭ Feedback loop: v1.0.0.

Placeholder scan: no "TBD", "implement later", or "similar to Task N" found. Every code step has runnable code. Every command has expected output described.

Type consistency: `truthEvents`, `statusEvents`, `evidenceEvents`, `relationEvents` are the canonical store names everywhere they appear. `myActiveTruth` returns a `Set<string>` of verdict names throughout. `latestStatus` returns `{ status, by, at } | null` throughout. The dedupe key string format `"pubkey:eTag:v"` is used in both the test and the implementation.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-22-truth-verdict-rewrite.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — I execute tasks in this session using executing-plans, with checkpoints for your review.

Which approach?
