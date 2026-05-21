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
  voterLocalReportCount,
  cellVerifierCount,
  geohashMatchLen,
  evidenceMultiplier,
} from "../verdicts.js";

let _id = 0;
const mk = (overrides) => ({
  id: "id" + (++_id).toString(36).padStart(8, "0"),
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
    const t = mk({ tags: [["e", "r1"], ["v", "true"]] });
    const f = mk({ tags: [["e", "r1"], ["v", "fake"]] });
    expect(translateLegacyVerdict(t)).toBe(t);
    expect(translateLegacyVerdict(f)).toBe(f);
  });

  test("translates needs-more-proof to kind:4", () => {
    const ev = mk({ tags: [["e", "r1"], ["v", "needs-more-proof"]] });
    const out = translateLegacyVerdict(ev);
    expect(out.kind).toBe(4);
    expect(out.tags.find(t => t[0] === "v")).toBeUndefined();
    expect(out.tags.find(t => t[0] === "e")[1]).toBe("r1");
    expect(out._legacy).toBe(true);
  });

  test("translates resolved to kind:3", () => {
    const ev = mk({ tags: [["e", "r1"], ["v", "resolved"]] });
    const out = translateLegacyVerdict(ev);
    expect(out.kind).toBe(3);
    expect(out.tags.find(t => t[0] === "status")[1]).toBe("resolved");
    expect(out._legacy).toBe(true);
  });

  test("discards legacy duplicate (no target id)", () => {
    const ev = mk({ tags: [["e", "r1"], ["v", "duplicate"]] });
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
    expect(dedupeTruthVerdicts([a, r]).size).toBe(0);
  });

  test("same pubkey may hold true on one report and fake on another", () => {
    const t = mk({ pubkey: "pkA", tags: [["e", "r1"], ["v", "true"]] });
    const f = mk({ pubkey: "pkA", tags: [["e", "r2"], ["v", "fake"]] });
    expect(dedupeTruthVerdicts([t, f]).size).toBe(2);
  });

  test("ignores legacy verdict values that should have been translated", () => {
    const stale = mk({ pubkey: "pkA", tags: [["e", "r1"], ["v", "needs-more-proof"]] });
    expect(dedupeTruthVerdicts([stale]).size).toBe(0);
  });
});

describe("truthCounts and truthConsensus", () => {
  test("counts distinct pubkeys per verdict", () => {
    const a = mk({ pubkey: "pkA", tags: [["e", "r1"], ["v", "true"]] });
    const b = mk({ pubkey: "pkB", tags: [["e", "r1"], ["v", "true"]] });
    const c = mk({ pubkey: "pkC", tags: [["e", "r1"], ["v", "fake"]] });
    expect(truthCounts("r1", [a, b, c])).toEqual({ true: 2, fake: 1 });
  });

  test("consensus requires >=3 in the winning bucket", () => {
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

  test("dedupes per-pubkey first then picks newest", () => {
    const oldA = mk({ kind: 3, pubkey: "pkA", created_at: 100, tags: [["e", "r1"], ["status", "resolved"]] });
    const newA = mk({ kind: 3, pubkey: "pkA", created_at: 300, tags: [["e", "r1"], ["status", "reopened"]] });
    const midB = mk({ kind: 3, pubkey: "pkB", created_at: 200, tags: [["e", "r1"], ["status", "resolved"]] });
    const ls = latestStatus("r1", [oldA, newA, midB]);
    expect(ls.status).toBe("reopened");
    expect(ls.by).toBe("pkA");
  });
});

describe("evidenceRequestCount", () => {
  test("counts distinct pubkeys with an outstanding request", () => {
    const a  = mk({ kind: 4, pubkey: "pkA", tags: [["e", "r1"]] });
    const a2 = mk({ kind: 4, pubkey: "pkA", tags: [["e", "r1"]], created_at: 200 });
    const b  = mk({ kind: 4, pubkey: "pkB", tags: [["e", "r1"]] });
    expect(evidenceRequestCount("r1", [a, a2, b])).toBe(2);
  });
});

describe("duplicatesOf", () => {
  test("returns distinct target ids for duplicate-of from this report", () => {
    const r1a = mk({ kind: 5, tags: [["e", "r1"], ["e", "r2"], ["rel", "duplicate-of"]] });
    const r1b = mk({ kind: 5, tags: [["e", "r1"], ["e", "r3"], ["rel", "duplicate-of"]] });
    const ir  = mk({ kind: 5, tags: [["e", "rX"], ["e", "rY"], ["rel", "duplicate-of"]] });
    expect(duplicatesOf("r1", [r1a, r1b, ir]).sort()).toEqual(["r2", "r3"]);
  });

  test("ignores non-duplicate-of relations", () => {
    const c = mk({ kind: 5, tags: [["e", "r1"], ["e", "r2"], ["rel", "continuation-of"]] });
    expect(duplicatesOf("r1", [c])).toEqual([]);
  });
});

describe("myActiveTruth", () => {
  test("returns set of verdicts the pubkey currently asserts", () => {
    const t = mk({ pubkey: "me", tags: [["e", "r1"], ["v", "true"]] });
    const o = mk({ pubkey: "other", tags: [["e", "r1"], ["v", "fake"]] });
    expect(myActiveTruth("r1", "me", [t, o])).toEqual(new Set(["true"]));
  });

  test("excludes retracted verdicts", () => {
    const t = mk({ pubkey: "me", created_at: 100, tags: [["e", "r1"], ["v", "true"]] });
    const r = mk({ pubkey: "me", created_at: 200, tags: [["e", "r1"], ["v", "true"], ["state", "retracted"]] });
    expect(myActiveTruth("r1", "me", [t, r])).toEqual(new Set());
  });
});

describe("voterLocalReportCount (§8.3)", () => {
  test("counts my prior kind:1 reports in the target's geohash-5 cell", () => {
    const r1 = mk({ kind: 1, pubkey: "me", tags: [["g", "tdr1jq8"]] });
    const r2 = mk({ kind: 1, pubkey: "me", tags: [["g", "tdr1jqz"]] });   // same geo-5 (tdr1j)
    const r3 = mk({ kind: 1, pubkey: "me", tags: [["g", "abcde22"]] });   // different
    const r4 = mk({ kind: 1, pubkey: "other", tags: [["g", "tdr1jq8"]] }); // not mine
    expect(voterLocalReportCount("me", "tdr1jq8", [r1, r2, r3, r4])).toBe(2);
  });

  test("returns 0 when target has no geohash", () => {
    expect(voterLocalReportCount("me", undefined, [])).toBe(0);
  });
});

describe("cellVerifierCount (§8.4)", () => {
  test("counts distinct pubkeys who voted on any report in the cell", () => {
    const r = mk({ kind: 1, id: "r1", pubkey: "rep", tags: [["g", "tdr1jq8"]] });
    const v1 = mk({ kind: 2, pubkey: "pkA", tags: [["e", "r1"], ["v", "true"]] });
    const v2 = mk({ kind: 2, pubkey: "pkB", tags: [["e", "r1"], ["v", "true"]] });
    const s1 = mk({ kind: 3, pubkey: "pkA", tags: [["e", "r1"], ["status", "resolved"]] }); // dup pubkey
    const e1 = mk({ kind: 4, pubkey: "pkC", tags: [["e", "r1"]] });
    expect(cellVerifierCount("tdr1jq8", [r], [v1, v2], [s1], [e1])).toBe(3);
  });

  test("returns 0 for a cell with no reports", () => {
    expect(cellVerifierCount("zzzzzzz", [], [], [], [])).toBe(0);
  });
});

describe("geohashMatchLen", () => {
  test("returns count of leading equal characters", () => {
    expect(geohashMatchLen("tdr1jq8", "tdr1jqz")).toBe(6);
    expect(geohashMatchLen("tdr1jq8", "abcde22")).toBe(0);
    expect(geohashMatchLen("tdr",     "tdr1jq8")).toBe(3);
    expect(geohashMatchLen(null,      "tdr1")).toBe(0);
  });
});

describe("evidenceMultiplier", () => {
  test("baseline is 1.0", () => {
    expect(evidenceMultiplier(mk({ kind: 1, content: "broken thing" }))).toBe(1);
  });

  test("+0.5 with a media tag", () => {
    expect(evidenceMultiplier(mk({ kind: 1, content: "broken", tags: [["media", "data:..."]] }))).toBe(1.5);
  });

  test("+0.3 with a specific time mention", () => {
    expect(evidenceMultiplier(mk({ kind: 1, content: "happened at 4:15pm Tuesday" }))).toBeCloseTo(1.3);
  });

  test("compounding photo + specific time", () => {
    expect(evidenceMultiplier(mk({
      kind: 1,
      content: "at 4:15pm Tuesday",
      tags: [["media", "data:..."]],
    }))).toBeCloseTo(1.8);
  });
});
