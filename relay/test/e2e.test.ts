// End-to-end test: spin up the relay in a child process, drive it via
// WebSocket exactly the way the browser client does, exercise the full
// publish → subscribe → verify → re-query loop.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";
import { rmSync, existsSync } from "node:fs";
import {
  eventId,
  bytesToHex,
  hexToBytes,
  geohashEncode,
  type SignedEvent,
} from "../lib.ts";

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const PORT = 17447;
const DB_PATH = "/tmp/cockroach-e2e.db";
const URL = `ws://127.0.0.1:${PORT}`;

let relay: Subprocess | null = null;

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`);
      if (r.ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error("relay did not become ready in time");
}

beforeAll(async () => {
  for (const ext of ["", "-journal", "-wal", "-shm"]) {
    const p = DB_PATH + ext;
    if (existsSync(p)) rmSync(p);
  }
  relay = spawn({
    cmd: ["bun", "run", "server.ts"],
    env: { ...process.env, PORT: String(PORT), DB: DB_PATH },
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForReady();
});

afterAll(async () => {
  if (relay) {
    relay.kill();
    await relay.exited;
  }
  for (const ext of ["", "-journal", "-wal", "-shm"]) {
    const p = DB_PATH + ext;
    if (existsSync(p)) rmSync(p);
  }
});

function makeSigner() {
  const sk = ed.utils.randomPrivateKey();
  const pkHex = bytesToHex(ed.getPublicKey(sk));
  return {
    sk, pkHex,
    sign(partial: { created_at: number; kind: number; tags: string[][]; content: string }): SignedEvent {
      const withPk = { pubkey: pkHex, ...partial };
      const id = eventId(withPk);
      const sig = bytesToHex(ed.sign(hexToBytes(id), sk));
      return { ...withPk, id, sig };
    },
  };
}

interface Client {
  ws: WebSocket;
  okPromise(id: string): Promise<{ accepted: boolean; reason: string }>;
  collectSub(subId: string, ms: number): Promise<SignedEvent[]>;
  send(msg: unknown[]): void;
  close(): void;
}

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const oks = new Map<string, (v: { accepted: boolean; reason: string }) => void>();
    const subs = new Map<string, { events: SignedEvent[]; doneAfterEose: boolean; resolve?: (e: SignedEvent[]) => void }>();
    ws.addEventListener("open", () => {
      resolve({
        ws,
        send(msg) { ws.send(JSON.stringify(msg)); },
        close() { ws.close(); },
        okPromise(id: string) {
          return new Promise((res) => oks.set(id, res));
        },
        collectSub(subId, ms) {
          subs.set(subId, { events: [], doneAfterEose: false });
          return new Promise((res) => {
            const entry = subs.get(subId)!;
            entry.resolve = res;
            setTimeout(() => {
              const e = subs.get(subId);
              if (e) { res(e.events); subs.delete(subId); }
            }, ms);
          });
        },
      });
    });
    ws.addEventListener("error", reject);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (!Array.isArray(msg)) return;
      const verb = msg[0];
      if (verb === "OK") {
        const [, id, accepted, reason] = msg;
        const f = oks.get(id);
        if (f) { f({ accepted, reason }); oks.delete(id); }
      } else if (verb === "EVENT") {
        const [, subId, e] = msg;
        const s = subs.get(subId);
        if (s) s.events.push(e);
      } else if (verb === "EOSE") {
        // Subscription remains open for live events; let the timer end it.
      }
    });
  });
}

describe("end-to-end against a live relay", () => {
  test("publish, subscribe by tag, retrieve", async () => {
    const alice = makeSigner();
    const c = await connect();
    const ev = alice.sign({
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [["g", geohashEncode(19.076, 72.8777, 7)], ["t", "road"], ["t", "pothole"]],
      content: "Pothole at the corner.",
    });
    const okPromise = c.okPromise(ev.id);
    c.send(["EVENT", ev]);
    const ok = await okPromise;
    expect(ok.accepted).toBe(true);

    // Query
    const sub = c.collectSub("s1", 400);
    c.send(["REQ", "s1", { kinds: [1], "#t": ["road"] }]);
    const got = await sub;
    expect(got.some((g) => g.id === ev.id)).toBe(true);
    c.close();
  });

  test("publish kind:2 verification, retrieve by #e", async () => {
    const alice = makeSigner();
    const bob = makeSigner();
    const c = await connect();

    const report = alice.sign({
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [["g", geohashEncode(19.076, 72.8777, 7)], ["t", "garbage"]],
      content: "Pile of trash on 5th street.",
    });
    const okA = c.okPromise(report.id);
    c.send(["EVENT", report]);
    expect((await okA).accepted).toBe(true);

    const verification = bob.sign({
      created_at: Math.floor(Date.now() / 1000),
      kind: 2,
      tags: [["e", report.id], ["v", "true"]],
      content: "Confirmed, walked past it.",
    });
    const okB = c.okPromise(verification.id);
    c.send(["EVENT", verification]);
    expect((await okB).accepted).toBe(true);

    const sub = c.collectSub("s2", 400);
    c.send(["REQ", "s2", { kinds: [2], "#e": [report.id] }]);
    const got = await sub;
    expect(got.some((g) => g.id === verification.id)).toBe(true);
    expect(got.find((g) => g.id === verification.id)?.pubkey).toBe(bob.pkHex);
    c.close();
  });

  test("relay rejects tampered event", async () => {
    const alice = makeSigner();
    const c = await connect();
    const ev = alice.sign({
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [["g", geohashEncode(19.076, 72.8777, 7)], ["t", "test"]],
      content: "original",
    });
    const tampered = { ...ev, content: "tampered" };
    const ok = c.okPromise(tampered.id);
    c.send(["EVENT", tampered]);
    const r = await ok;
    expect(r.accepted).toBe(false);
    c.close();
  });

  test("live stream: second subscriber receives a freshly published event", async () => {
    const writer = await connect();
    const reader = await connect();
    const sub = reader.collectSub("live", 700);
    reader.send(["REQ", "live", { kinds: [1], "#t": ["live-test"] }]);
    await new Promise((r) => setTimeout(r, 100)); // give the REQ time to register

    const alice = makeSigner();
    const ev = alice.sign({
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [["g", geohashEncode(19.076, 72.8777, 7)], ["t", "live-test"]],
      content: "live broadcast",
    });
    const ok = writer.okPromise(ev.id);
    writer.send(["EVENT", ev]);
    expect((await ok).accepted).toBe(true);

    const got = await sub;
    expect(got.some((g) => g.id === ev.id)).toBe(true);
    writer.close();
    reader.close();
  });

  test("permalink page renders signed report with OG tags", async () => {
    const alice = makeSigner();
    const c = await connect();
    const ev = alice.sign({
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [["g", geohashEncode(19.076, 72.8777, 7)], ["t", "permalink-test"]],
      content: "Sample report for permalink rendering.",
    });
    const ok = c.okPromise(ev.id);
    c.send(["EVENT", ev]);
    expect((await ok).accepted).toBe(true);
    c.close();

    // Static HTML permalink
    const res = await fetch(`http://127.0.0.1:${PORT}/r/${ev.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("og:title");
    expect(html).toContain("og:image");
    expect(html).toContain("Sample report for permalink rendering.");
    expect(html).toContain(ev.id);

    // 404 for unknown event id
    const miss = await fetch(`http://127.0.0.1:${PORT}/r/${"0".repeat(64)}`);
    expect(miss.status).toBe(404);

    // 400 for bad id format
    const bad = await fetch(`http://127.0.0.1:${PORT}/r/not-a-hex-id`);
    expect(bad.status).toBe(400);

    // OG SVG served
    const og = await fetch(`http://127.0.0.1:${PORT}/og.svg`);
    expect(og.status).toBe(200);
    expect(og.headers.get("content-type")).toContain("image/svg");
  });

  test("v0.2 signaling kinds 10001/10002/10003 flow through the relay unchanged", async () => {
    // Sanity check: the relay imposes no code changes for the WebRTC peer
    // mesh.  Any non-negative kind passes through; single-letter tags index
    // and filter normally.
    const alice = makeSigner();
    const bob = makeSigner();
    const c = await connect();

    // kind:10001 — peer offer broadcast
    const offer = alice.sign({
      created_at: Math.floor(Date.now() / 1000),
      kind: 10001,
      tags: [
        ["sdp", "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n"],
        ["expires", String(Math.floor(Date.now() / 1000) + 3600)],
        ["g", geohashEncode(19.076, 72.8777, 5)],
      ],
      content: "",
    });
    const okOffer = c.okPromise(offer.id);
    c.send(["EVENT", offer]);
    expect((await okOffer).accepted).toBe(true);

    // kind:10002 — peer answer addressed to alice
    const answer = bob.sign({
      created_at: Math.floor(Date.now() / 1000),
      kind: 10002,
      tags: [
        ["p", alice.pkHex],
        ["e", offer.id],
        ["sdp", "v=0\r\no=- 3 4 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n"],
      ],
      content: "",
    });
    const okAnswer = c.okPromise(answer.id);
    c.send(["EVENT", answer]);
    expect((await okAnswer).accepted).toBe(true);

    // kind:10003 — ICE candidate
    const ice = bob.sign({
      created_at: Math.floor(Date.now() / 1000),
      kind: 10003,
      tags: [
        ["p", alice.pkHex],
        ["e", offer.id],
        ["ice", "candidate:1 1 udp 2113929471 192.0.2.1 50000 typ host"],
      ],
      content: "",
    });
    const okIce = c.okPromise(ice.id);
    c.send(["EVENT", ice]);
    expect((await okIce).accepted).toBe(true);

    // Subscriptions: alice should be able to retrieve all three by their
    // intended filters.
    const offersSub = c.collectSub("offers", 400);
    c.send(["REQ", "offers", { kinds: [10001] }]);
    const offersGot = await offersSub;
    expect(offersGot.some(g => g.id === offer.id)).toBe(true);

    const answersSub = c.collectSub("answers", 400);
    c.send(["REQ", "answers", { kinds: [10002], "#p": [alice.pkHex] }]);
    const answersGot = await answersSub;
    expect(answersGot.some(g => g.id === answer.id)).toBe(true);

    const iceSub = c.collectSub("ice", 400);
    c.send(["REQ", "ice", { kinds: [10003], "#p": [alice.pkHex] }]);
    const iceGot = await iceSub;
    expect(iceGot.some(g => g.id === ice.id)).toBe(true);

    c.close();
  });

  test("geohash prefix filter matches nearby reports", async () => {
    const alice = makeSigner();
    const c = await connect();
    const gh = geohashEncode(19.076, 72.8777, 7); // e.g. te7udxx
    const ev = alice.sign({
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [["g", gh], ["t", "geo-test"]],
      content: "near me",
    });
    const ok = c.okPromise(ev.id);
    c.send(["EVENT", ev]);
    expect((await ok).accepted).toBe(true);

    const sub = c.collectSub("g1", 400);
    c.send(["REQ", "g1", { kinds: [1], "#g": [gh.slice(0, 4)] }]); // 4-char prefix
    const got = await sub;
    expect(got.some((g) => g.id === ev.id)).toBe(true);
    c.close();
  });
});
