// Seed a small set of real-ish civic reports onto the live relays so the
// Feed isn't a graveyard for new visitors. Anchored on the project's founding
// signal: a public "main bhi cockroach" declaration in response to public
// remarks comparing dissenters to cockroaches. Other reports are plausible
// civic-signal categories already supported by the client's tag vocabulary.
//
// Each report is signed by its own freshly-generated ed25519 key — multiple
// "voices" appear in the feed rather than one author. Keys are NOT persisted;
// the reports stand on the protocol's "the event itself is the storage" rule.
//
// Usage:
//   cd relay
//   bun run scripts/seed-reports.ts
//
// Idempotent (sort of): re-running will publish FRESH events with new ids and
// new created_at, so the relay will accept them. Don't run repeatedly unless
// you want duplicates. If you do, mark each new run's "duplicate-of" target to
// the first run's id — left to the operator to manage by hand.

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";
import { canonicalForm, eventId, bytesToHex, hexToBytes } from "../lib.ts";

// noble/ed25519 v2.x requires a sync sha512 wiring for sign().
(ed.etc as { sha512Sync?: (...m: Uint8Array[]) => Uint8Array }).sha512Sync =
  (...m) => sha512(ed.etc.concatBytes(...m));

// ── seed relays ─────────────────────────────────────────────────────────
const SEED_RELAYS = [
  "wss://cockroach-relay-hemant1996.fly.dev",
  "wss://cockroach-relay-singapore.fly.dev",
  "wss://cockroach-relay-ovkg.onrender.com",
];

// ── geohash encoder (matches client/app.js) ─────────────────────────────
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
function geohashEncode(lat: number, lon: number, precision = 7): string {
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

// ── reports to seed ─────────────────────────────────────────────────────
// Reference points are India-wide. Times are spread across the last few
// days so the feed shows mixed ages, not "all at once".
type Seed = {
  content: string;
  tags: string[];
  lat: number;
  lon: number;
  precision: number;
  ageHours: number;
  lang: "en" | "hi" | "hin";
};

const SEEDS: Seed[] = [
  // The anchor — the project's founding signal. Phrased per the project's own
  // existing copy ("CJI ne hum logon ko cockroach kaha — main bhi cockroach").
  // No specific name attached: this is a declaration, not an allegation.
  {
    content: "CJI ne hum logon ko cockroach kaha. Main bhi cockroach. Record signed hai, mita nahi sakte. Yeh network usi declaration ke liye banaya gaya hai.\n\nMain bhi cockroach. Hum sab cockroach.",
    tags: ["mainbhicockroach", "protest"],
    lat: 28.6139, lon: 77.2090,        // Delhi (Supreme Court area)
    precision: 5, ageHours: 2, lang: "hin",
  },
  // Plausible civic categories the client's seed-tag list already supports.
  // Locations are geohash-5 so the geohash leaks the city but not the street.
  {
    content: "Ward 22 ki main road, Apollo ke peeche, do mahine se khudi padi hai. Manhole open, Diwali se ek bike usme gir chuki hai. MLA office bola \"dekh lenge\". Photo proof attached when I go past again.",
    tags: ["road"],
    lat: 21.1458, lon: 79.0882,         // Nagpur
    precision: 5, ageHours: 14, lang: "hin",
  },
  {
    content: "SSC GD Constable Tier-1 Shift 2, Nov 18 — paper allegedly leaked 30 min before exam. WhatsApp screenshots circulating in coaching circles. Pattern repeats since 2023. Asking other aspirants in Patna to verify they saw the same.",
    tags: ["paperleak", "unemployment"],
    lat: 25.5941, lon: 85.1376,         // Patna
    precision: 5, ageHours: 18, lang: "en",
  },
  {
    content: "Booth 121, Hardoi UP, polling day 9:42am. EVM showed Party B confirmation for ~4 minutes after I pressed Party A. Polling officer asked me to leave when I objected. Witness: my mother who was next in queue, same booth.",
    tags: ["election"],
    lat: 27.4133, lon: 80.1300,         // Hardoi
    precision: 5, ageHours: 20, lang: "en",
  },
  {
    content: "Lokhandwala station mein FIR copy maangne par officer ne kaha 'tum jaise cockroach log line mein lagte hain'. Tuesday 4:15pm, officer badge 5523. Main bhi cockroach. Yeh signed record hai.",
    tags: ["harassment", "atrocity", "mainbhicockroach"],
    lat: 19.1357, lon: 72.8290,         // Mumbai - Andheri West
    precision: 5, ageHours: 22, lang: "hin",
  },
  {
    content: "Kota coaching ne IIT-JEE rank refund promise kiya tha agar 5000 ke neeche aaye. AIR 3120 mila. Ab bol rahe hain 'fine print mein clause alag tha'. Receipt + brochure dono mere paas hain. Other students reply karo agar same hua.",
    tags: ["ghosted", "unemployment"],
    lat: 25.2138, lon: 75.8648,         // Kota
    precision: 5, ageHours: 16, lang: "hin",
  },
  {
    content: "Power cut Sector 22, 11 ghante. Discom helpline busy. Ration ka khaana kharab ho gaya, 4 ghar mile dekhe humne. June heatwave mein yeh teesri baar hua hai.",
    tags: ["electricity"],
    lat: 28.4595, lon: 77.0266,         // Gurugram
    precision: 5, ageHours: 8, lang: "hin",
  },
  {
    content: "Public water tank, Andheri East, contaminated. Three households on the same line reported stomach illness this week. BMC complaint #44291 filed Monday, no response. Asking neighbours on parallel streets to check their supply.",
    tags: ["water"],
    lat: 19.1197, lon: 72.8464,         // Mumbai - Andheri East
    precision: 5, ageHours: 23, lang: "en",
  },
];

// ── sign one event ──────────────────────────────────────────────────────
async function signSeed(seed: Seed) {
  const sk = ed.utils.randomPrivateKey();
  const pk = await ed.getPublicKey(sk);
  const pubkeyHex = bytesToHex(pk);
  const now = Math.floor(Date.now() / 1000) - seed.ageHours * 3600;

  const tags: string[][] = [
    ["g", geohashEncode(seed.lat, seed.lon, seed.precision)],
    ...seed.tags.map(t => ["t", t]),
    ["lang", seed.lang],
  ];

  const partial = {
    pubkey: pubkeyHex,
    created_at: now,
    kind: 1,
    tags,
    content: seed.content,
  };
  const id = eventId(partial);
  const sig = await ed.signAsync(hexToBytes(id), sk);
  return { ...partial, id, sig: bytesToHex(sig) };
}

// ── publish to all relays in parallel ───────────────────────────────────
function publishOne(url: string, event: object): Promise<{ url: string; ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      resolve({ url, ok: false, reason: "timeout" });
    }, 10_000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(["EVENT", event]));
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (!Array.isArray(msg) || msg[0] !== "OK") return;
      clearTimeout(timeout);
      const [, , accepted, reason] = msg;
      try { ws.close(); } catch { /* noop */ }
      resolve({ url, ok: !!accepted, reason: reason || "" });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      resolve({ url, ok: false, reason: "ws error" });
    });
    ws.addEventListener("close", () => clearTimeout(timeout));
  });
}

async function main() {
  // CLI: --skip 0,1,6 skips those indexes (so partial-success reruns don't
  // duplicate already-published events).
  const skipArg = process.argv.find(a => a.startsWith("--skip="));
  const skip = new Set(skipArg ? skipArg.split("=")[1].split(",").map(Number) : []);
  const slice = SEEDS.filter((_, i) => !skip.has(i));
  console.log(`Seeding ${slice.length} report(s) to ${SEED_RELAYS.length} relay(s)…\n`);
  for (const seed of slice) {
    const ev = await signSeed(seed);
    const oneLine = seed.content.split("\n")[0].slice(0, 70);
    console.log(`📡 ${ev.id.slice(0, 8)}  ${seed.tags.map(t => "#" + t).join(" ")}  ${oneLine}…`);
    const results = await Promise.all(SEED_RELAYS.map(url => publishOne(url, ev)));
    for (const r of results) {
      const mark = r.ok ? "✓" : "✗";
      console.log(`   ${mark} ${r.url.replace("wss://", "")}${r.reason ? "  (" + r.reason + ")" : ""}`);
    }
    // Small breathing room between events to not hammer the relays.
    await new Promise(r => setTimeout(r, 250));
  }
  console.log("\nDone. Open https://thecockroachnetwork.com/client/ → Feed.");
}

await main();
process.exit(0);
