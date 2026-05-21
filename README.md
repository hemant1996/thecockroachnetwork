# Cockroach Relay Protocol

> A public network for reporting and verifying real-world civic problems. Owned by no one.

A decentralized civic-signal protocol. Citizens publish signed reports of real-world civic problems through dumb relays. Identity is a keypair on a phone. Truth is computed at the edges. There is no central server, no admin, no token, no DAO, no company.

This repository is a **release**, not a service. The maintainers do not operate the network — they publish the specification and reference implementations and step back. Other people run the relays. Other people host the clients. If everyone associated with this repo disappears tomorrow, the network keeps working.

---

## What's in here

```
SPEC.md            Normative protocol specification
WHITEPAPER.md      The "why" — vision, threat model, civic theory
RELEASE.md         How to cut, mirror, and pin a release
CHANGELOG.md       Versioned change log
LICENSE            CC0 — public domain
VERSION            Current version (0.7.4)

relay/             Reference relay (Bun + TypeScript + SQLite, L1 conformant)
  server.ts        WebSocket broker + permalink HTTP endpoint
  lib.ts           Canonical serialization, sig verification, geohash, filter
  Dockerfile       Container image
  docker-compose.yml
  fly.toml         Fly.io deploy template
  install.sh       Bare-VPS installer
  RUN.md           Operator guide (Docker / Fly / Tor / Termux / TLS)
  POLICY.example.md Content policy template for operators
  test/            17 unit + end-to-end tests

client/            Reference web client (vanilla JS PWA, L3 conformant, multi-relay)
  index.html       Single page, mobile first
  app.js           ~750 LoC; ed25519 in browser, IndexedDB-free
  styles.css       Dark theme
  sw.js            Offline shell service worker
  manifest.webmanifest
  icon.svg
  relays.json      Seed list (per-mirror configurable)
  lang/            i18n: English + Hindi

web/               Landing page — "join the network", not "use our app"
  index.html
  styles.css
  assets/cockroach.svg

docs/              Design notes and the brainstorm record
```

## Quick start — use the network

**No download. No install.** Open the client on any phone or laptop:

**https://thecockroachnetwork.com/client/**

Generates a keypair in your browser on first load. Compose a report, sign it, watch it appear in the feed. This is the truly zero-friction entry to the network.

## Quick start — run a relay (operators)

For people willing to spin up a node. **[Download the archive for your platform from the latest release →](https://github.com/hemant1996/thecockroachnetwork/releases/latest)**

| Platform | Archive |
|---|---|
| Mac (Apple Silicon — M1/M2/M3/M4) | `cockroach-relay-darwin-arm64.tar.gz` |
| Mac (Intel) | `cockroach-relay-darwin-x64.tar.gz` |
| Windows | `cockroach-relay-windows-x64.zip` |
| Linux (x86_64) | `cockroach-relay-linux-x64.tar.gz` |
| Linux (ARM — Raspberry Pi 4/5) | `cockroach-relay-linux-arm64.tar.gz` |

**Mac/Linux:** double-click the `.tar.gz` to extract, then from a terminal in the same folder run `./cockroach-relay-darwin-arm64`.

**Windows:** double-click the `.zip` to extract. Double-click the `.exe` inside.

The relay listens on `ws://localhost:7447`. Database at `~/.cockroach-relay/relay.db`.

**First-run warnings (unsigned binaries):**
- **macOS Gatekeeper** blocks unsigned binaries the first time. Allow with `xattr -d com.apple.quarantine cockroach-relay-darwin-arm64`, or right-click in Finder → **Open** → **Open**.
- **Windows SmartScreen** warns about an unrecognized publisher. Click **More info** → **Run anyway**.

These steps can't be avoided without Apple/Microsoft code-signing certs (not in v0.1 budget). v0.2's WebRTC peer-relay mode eliminates them entirely — every PWA install of the client becomes a relay automatically.

**Don't want a binary?** Other operator paths: Docker, Render one-click, Replit one-click, Termux on Android, bare VPS via systemd. Full friction ladder in [`relay/RUN.md`](relay/RUN.md).

**Don't trust the prebuilt binaries?** Reproduce them locally with `relay/scripts/build-binaries.sh`. Same Bun version, same source, byte-identical output.

## Quick start (local development)

Two terminals.

```sh
# terminal 1 — relay
cd relay
bun install
bun run server.ts
# → ws://localhost:7447

# terminal 2 — static server for the client
cd client
bunx serve .
# → open the printed URL on your phone or laptop
```

The client auto-creates an ed25519 keypair in your browser on first load. Generate a report, sign it, watch it appear in the feed. Sign a verification on someone else's report.

## Quick start (deploy a real relay)

Zero-install paths (work from a phone browser):

- **[Deploy to Render](https://render.com/deploy?repo=https://github.com/hemant1996/thecockroachnetwork)** — ~3 min, free tier, no credit card, no CLI
- **[Run on Replit](https://replit.com/github/hemant1996/thecockroachnetwork)** — ~2 min, runs in the browser

Or locally:

```sh
# Docker (anywhere docker runs)
cd relay && docker compose up -d

# Termux on Android (on your phone)
pkg install git curl && curl -fsSL https://bun.sh/install | bash
git clone https://github.com/hemant1996/thecockroachnetwork
cd cockroachparty/relay && ~/.bun/bin/bun install && ~/.bun/bin/bun run server.ts

# Fly.io free tier (needs CC on file)
cd relay && fly launch --copy-config && fly volumes create cockroach_data --size 1 && fly deploy
```

Full friction ladder with TLS, Tor hidden service, and operator policy notes: [`relay/RUN.md`](relay/RUN.md).

**Shipped in v0.2:** WebRTC peer-relay mesh — every client browser tab joins a peer-to-peer mesh on by default, so events fan out across both relays and peer connections. Design: [`docs/v0.2-webrtc-peer-relay.md`](docs/v0.2-webrtc-peer-relay.md).

**Shipped in v0.4:** share-URL relay discovery (a recipient opens a share link and the embedded relay auto-adds), relay-to-relay sync (relays mesh with each other to prevent siloed feeds), and zero-config Pehredaar onboarding (one-click Render deploys join the mesh on first boot via `relay/seeds.json`). Default seed list ships with the current public Pehredaars; operators can edit before first start.

## Quick start (host a client mirror)

The client is a static site. Drop the `client/` directory on any static host — GitHub Pages, Cloudflare Pages, Netlify, Vercel, S3, your own nginx box, an IPFS gateway. No build step.

Edit `client/relays.json` to ship your mirror's default seed list of relays you trust. Users can add, remove, or replace these in the Identity tab.

## Read this in order

1. **[The landing page](web/index.html)** — five-minute overview.
2. **[WHITEPAPER.md](WHITEPAPER.md)** — the vision and threat model.
3. **[SPEC.md](SPEC.md)** — the normative protocol for anyone writing a second implementation.
4. **[RELEASE.md](RELEASE.md)** — how to mirror and pin the release so nobody can take it down.
5. **[relay/](relay/)** and **[client/](client/)** — the reference code.

## Tests

```sh
cd relay
bun test
# 18 pass, 0 fail
```

The relay suite covers signature verification, canonical serialization, filter matching, geohash encoding, and an end-to-end battery that spins up a live relay and drives it over WebSocket the way the browser client does — publishing reports, querying by tag, signing verifications, rejecting tampered events, live-stream delivery, and the HTML permalink rendering.

## Status

**v0.7.4** — the spec is implementable, the reference relay is L1-conformant, the reference client is L3-conformant (now L2+ with §8.3 voter-weight legibility and §8.4 sparse-cell rendering surfaced in the UI). The wire protocol is stable. The network currently has **3 public Pehredaars** (Mumbai/Fly, Singapore/Fly, Render) meshed via relay-to-relay sync.

Released versions (newest first — see `CHANGELOG.md` for full notes):

- **v0.7.x — verdict honesty + scale-safe feed** — verdict model split into orthogonal kinds (`kind:2` binary truth, `kind:3` status, `kind:4` evidence-request, `kind:5` relation); closure-absence badge on every card; locality-aware sort and voter-weight legibility (SPEC §8.3); sparse-cell badge (§8.4); ingest-time indexes so the feed stays fast at network scale; inline evidence-reply thread; mobile-first sort/filter strips.
- **v0.6.x — web client redesign** — Anton / Instrument Serif / JetBrains Mono / Inter typography, accent #e63b2e, live preview pane in the composer.
- **v0.5.x — in-event base64 media** — `compressImage()` downscales + JPEG-encodes a photo into the signed event itself; SHA-256 binding in the media tag. No external pin service required.
- **v0.4.x — anti-silo release** — share-URL relay discovery, `PEERS` wire verb, relay-to-relay WebSocket sync, gzip storage compression, zero-config seed list.
- **v0.2.x — WebRTC peer mesh** — every browser tab joins a peer mesh on by default; signaling event kinds 10001/10002/10003. Relay `/stats` endpoint.
- **v0.1.0** — protocol spec, reference relay, reference client.

**Known limits in v0.7:**

- No encrypted key backup. Losing the device loses the identity unless you export the key (Identity tab). Seed-phrase / passphrase-encrypted backup is on the road.
- No native iOS/Android apps; PWA only.
- SPEC §8.1 full locality-weighted reputation is documented and partially surfaced (the `voterLocalReportCount` floor — §8.3 — is shown on every card), but the multiplier on consensus weight is not yet applied in the reference client's ranking math. v0.10 work.
- Feedback loop / outcome tracking (a network-level memory of which signals predicted resolved reports) was dropped from the roadmap as not doable simply *and* decentralized at this scale.
- Bootstrap is still mine — `client/relays.json` and `relay/seeds.json` are lists in this repo. As more independent Pehredaars come online they'll be added to those files; eventually consider transferring ownership to a multi-operator quorum.

## License

[CC0 1.0](LICENSE) — public domain. Fork, modify, deploy, charge for it, sell it. No permission needed. The protocol is the product; the implementations are examples.
