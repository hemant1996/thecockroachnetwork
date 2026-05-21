# Changelog

All notable changes to the Cockroach Relay Protocol and its reference implementations are documented here.

The format follows the spirit of [Keep a Changelog](https://keepachangelog.com). The protocol versioning policy is in [SPEC.md §11](SPEC.md#11-forward-compatibility): new event kinds and new tag names are additive; only changes to the event format, signing rules, or wire verbs bump the major version.

## v0.2.4 — IPFS media uploads via Helia (browser-native, no operator) (2026-05-21)

### Client

- **File attachments now upload to IPFS directly from the browser** via Helia (`client/media.js`). When a user attaches a file, a Helia node spins up in their browser, the bytes get a real IPFS CID, and the uploader's tab serves the file via libp2p + bitswap to any other IPFS node — including public gateways like Cloudflare's `cf-ipfs.com`, Protocol Labs' `dweb.link`, and Storacha's `w3s.link`. Helia is lazy-loaded (~500 KB) on first attach to keep the initial page fast.
- The published event carries the media as a SPEC §3.4 tag: `["media", "ipfs://<cid>", "sha256:<hex>", "<mime>", "<size-bytes>"]`. SHA-256 is computed independently so non-IPFS readers can verify the bytes against the claim even if they fetched via an HTTP gateway.
- Feed cards now render `ipfs://` media inline as `<img>` / `<video>` from the first public gateway. If a gateway 404s, the element's `onerror` falls through the gateway list. After all gateways fail the image stays broken — an honest signal that nobody has the CID anymore.
- **Decentralization model**: we operate no pinning service. The protocol author and relay operators carry zero responsibility for media storage. A file is reachable as long as the uploader's tab is open OR somebody else pinned it (could be a public gateway that cached it during retrieval; could be a user's own Storacha/Pinata account). For permanence, advanced users can configure their own pinning credentials (Settings UI deferred to v0.2.5).
- 20 MB per-file cap in the client; helps keep browser memory + DHT round-trips manageable.

### Protocol / relay

- No changes. SPEC §3.4 already specified the content-addressed `media` tag format; the client now produces it via real IPFS for the first time.

## v0.2.3 — landing redesign: agitprop poster with live cockroach (2026-05-21)

### Landing

- Full visual rewrite of `index.html` from the Claude Design handoff. Dark editorial / agitprop poster aesthetic — black background, cream paper ink, rebel-red accent (`#e63b2e`). Anton (display) + Instrument Serif (italic pull) + JetBrains Mono (tags / metadata) + Inter (body).
- The cockroach is now the lead character: giant 🪳 in the hero stage with idle wiggle, cursor parallax, click-to-startle bounce, an orbiting ring of four stamps (Janta ka, Indestructible, est. 2026, Signed · Forever), and a constant background swarm of smaller scurriers crossing the viewport.
- Marquee tape strip across the top with data-driven Pehredaar count (`1 public Pehredaar live` updates to the real `relaysAlive`).
- New "Live wall" section between *What* and *How* — shows real-time `reports/24h`, `#mainbhicockroach/7d`, `cities` stats plus the latest six declarations as Instrument Serif pull-quote cards.
- Pehredaar alarm box now drives off real data: the giant "01" is `relaysAlive` padded, the headline switches between "Sirf ek Pehredaar zinda hai" / "N Pehredaar zinda hain" based on count, and the live status line in the footer shows aggregated relay + peer count + last-event time in IST.
- Mascot health caption (the honest "Akela · 1 Pehredaar · bachao" line) sits below the mascot and updates from the same resilience metric as v0.2.2.
- Removed the v0.1 stylesheet path — the landing is now self-contained with inline styles. `web/styles.css` remains for the `/build/` developer page.
- The Tweaks panel from the design handoff is intentionally excluded — it was the designer's authoring surface, not a production component.

### Protocol / relay / client

- No changes.

## v0.2.2 — relay stats endpoint + network-wide health aggregator (2026-05-21)

### Relay

- `GET /` JSON now includes a `stats` block — `ws_connected` (real-time WebSocket connections), `unique_pubkeys_1h` (distinct authors in the last hour), `peer_offers_15m` (kind:10001 events in the last 15 min, proxy for active peer mesh), `events_24h` (total events in last day). Cached for 10s to keep the endpoint cheap under load. Other relays and clients can pull this without subscribing.
- Version banner bumped to v0.2.2.

### Landing

- Cockroach health metric now aggregates `stats` from EVERY responding relay in `client/relays.json`, not just the relay the landing happens to be subscribed to. The score reads the whole network's state, not one slice of it.
- `effectivePeers()` returns the max of (locally observed kind:10001 publishers) and (network-wide peer_offers_15m sum). Whichever is more accurate wins.
- Captions now show the aggregated peer count: *"Mazboot. 5 Pehredaar, 47 peers meshing."* — the user sees the real network-wide state.

### Deploy

- Operators on v0.2.1 should `fly deploy` (or pull + restart) to pick up the new `/stats` block. Old relays that don't have it still count as "alive" — they just don't contribute to the aggregated peer/connection signal.

## v0.2.1 — peer mode on by default + Cloudflare Tunnel guide (2026-05-20)

### Changed

- **Peer mode now ON by default** in the reference client. Previous v0.2.0 default was off-with-opt-in dialog. The mesh is now alive from the first page load. Users who don't want IP exposure can explicitly disable in the Identity tab; that disable persists across reloads. Trade-off documented in WHITEPAPER §7 — operators in hostile jurisdictions should disable.
- First-time peer enablement now surfaces as a **non-blocking toast** ("Peer mode on — your device is now part of the mesh. IP exposed to peers. Disable in Identity tab anytime.") rather than a confirm dialog.

### Added

- `relay/RUN.md` — new subsection on **Cloudflare Quick Tunnel**, the fastest way to make a local relay binary publicly reachable. ~30 seconds, no account, no TLS cert, no port forwarding. URL is ephemeral and resets when cloudflared restarts; good for launch demos and short-lived experiments. Sits alongside Tor hidden service and TLS reverse proxy as the third pathway from a localhost relay to the public network.

### Known still-open

- IP exposure on first load is no longer behind a consent dialog. Users in hostile contexts should be onboarded to disable peer mode before publishing sensitive reports.

## v0.2.0 — WebRTC peer-relay mesh (2026-05-20)

### Added

- **WebRTC peer-relay mesh in the reference client** (opt-in, default off). Every PWA install can now connect directly to other peers and gossip events over RTCDataChannels. The network survives any single relay going offline; events fan out across both relays and peer connections; new clients can warm-start from existing peers without needing relays first.
- **New event kinds for peer signaling** — SPEC §4.4–4.7:
  - `kind:10001` — peer offer (SDP, expires, optional geohash)
  - `kind:10002` — peer answer (addressed to a specific offerer)
  - `kind:10003` — ICE candidate (reserved for trickle-ICE; the v0.2 reference client gathers all ICE before publishing offers/answers)
- **Peer mode toggle in Identity tab** with explicit IP-exposure disclosure on first enable. Preference persists across reloads; defers enabling until at least one relay is connected.
- **Header peer indicator** next to the relay status, showing live peer count when peer mode is on.
- **Client-side signature verification** of peer-sourced events. Relays validate events on receipt, but events arriving over WebRTC haven't been through a relay; the client now re-verifies before ingesting. Untrusted-source defense.
- **`client/peers.js`** — new file, self-contained `PeerPool` class (~270 LoC). Implements the offer / answer / ICE dance, channel wiring, fan-out, dedupe, and the 12-peer soft cap. Uses public STUN servers (Google, Cloudflare); no TURN for v0.2 — peers behind symmetric NATs stay relay-only.

### Reference relay

- No code changes required. The relay accepts any non-negative kind and indexes by single-letter tags. `kind:10001/10002/10003` events route through the existing storage and filter paths unchanged.
- The new client subscription includes the signaling kinds (10001 globally with a 1-hour window; 10002/10003 only when addressed to the user's pubkey).

### Documentation

- SPEC §4.4–4.7 formalize the three new kinds and the peer mesh trust model.
- WebRTC design doc at `docs/v0.2-webrtc-peer-relay.md` is now backed by working code.

### Known limits in v0.2

- No TURN servers shipped. Peers behind symmetric NATs cannot establish direct connections; they remain relay-only. Operators or interested users can configure their own TURN list later.
- ICE is gathered fully before publishing the offer/answer (slower first-connection latency in exchange for simpler signaling). Trickle ICE via `kind:10003` is a future enhancement.
- Subscription to `kind:10001` is global — scales to small networks. At larger scale, geohash-prefix filtering on the `#g` tag will be required.
- Mobile background tabs throttle aggressively; peer connections drop on iOS Safari / Chrome backgrounding. Peer mesh is most useful while the app is in the foreground.

## v0.1.2 — runs out of the box (2026-05-20)

### Added

- **`start.command` (Mac/Linux) and `start.bat` (Windows) launchers** bundled inside each release archive. Double-click the launcher to skip every `chmod` / `xattr` / "is damaged" ceremony — the launcher strips quarantine, sets the executable bit, and runs the relay. The "common teenager" path.
- **`client/relays.json` now seeds `ws://localhost:7447`** so a freshly downloaded relay binary + the deployed client at `thecockroachnetwork.com/client/` connect automatically with zero config.

### Fixed

- Relay startup banner now reports the correct version (was hard-coded to v0.1.0 in v0.1.1 — visible cosmetic bug, no functional impact).

### Known still-open

- macOS unsigned-binary warnings remain on the **first run** of the binary when downloaded outside the archive (raw download from the release page). The `start.command` wrapper inside the archive bypasses this. Future v0.2 work: build Mac binaries on a macOS runner so we can ad-hoc codesign them, eliminating the "is damaged" message entirely.

## v0.1.1 — release UX fixes (2026-05-20)

### Changed

- **Binary distribution now ships archives** (`.tar.gz` for Mac/Linux, `.zip` for Windows) alongside raw binaries. The archive preserves the executable bit, so `chmod +x` is no longer required after download. The previous v0.1.0 raw binaries still work but required a manual `chmod` after browser download stripped the exec bit.
- **Landing page rewritten with action-first hero.** "Open the client" is now the primary CTA (truly zero-install — just tap the URL on a phone). "Run a relay" is the secondary CTA (operator path; light terminal use required for unsigned binaries). The reframing reflects what's actually friction-free vs. what isn't.
- **SEO + social-share hardening on the landing page.** Added Open Graph meta tags including `og:image` pointing at a 1200×630 cover SVG (`web/assets/og-cover.svg`), Twitter `summary_large_image` card, JSON-LD `SoftwareSourceCode` structured data, canonical URL, expanded `<meta name="description">`, `keywords`, and a `<title>` rewritten for SEO weight.
- Added top-level `robots.txt` and `sitemap.xml` so search engines can index the protocol pages.

### Known still-open

- Native binaries remain unsigned. macOS Gatekeeper and Windows SmartScreen still warn on first run. True "double-click and go" awaits v0.2's WebRTC peer-relay mode (every PWA install becomes a relay automatically — zero binary, zero install, zero permissions). See [`docs/v0.2-webrtc-peer-relay.md`](docs/v0.2-webrtc-peer-relay.md).
- Client crypto still loaded from esm.sh CDN without SRI (HIGH finding from the v0.1.0 CSO audit, deferred to v0.2 with the noble-bundle vendoring work).

## v0.1.0 — initial release (2026-05-20)

The first public release. Sets the wire protocol baseline; subsequent v0.x releases improve reference implementations and operator tooling without changing the spec.

### Protocol

- Defined the wire protocol: ed25519 keypairs, SHA-256 event ids, canonical compact JSON, WebSocket transport.
- Defined event kinds `1` (civic-report) and `2` (verification).
- Fixed verification verb vocabulary: `true`, `duplicate`, `resolved`, `fake`, `needs-more-proof`.
- Indexed single-letter tags (`g`, `t`, `e`, `p`); free-form multi-letter tags.
- Content-addressed media via `["media", "sha256:<hex>", "<url>", ...]` — never embedded.
- Reference reputation algorithm: locality × accuracy with burst-tolerance for crowd events.

### Reference relay (`relay/`)

- Bun + TypeScript + SQLite, L1-conformant per SPEC §12.
- WebSocket broker with filter queries on ids, authors, kinds, tags, time bounds.
- 90-day default retention; per-relay configurable.
- Containerized (`Dockerfile`, `docker-compose.yml`).
- Fly.io template (`fly.toml`), bare-VPS installer (`install.sh`), operator guide (`RUN.md`).

### Reference client (`client/`)

- Vanilla JavaScript PWA, L3-conformant per SPEC §12.
- Multi-relay fan-out via a `RelayPool` abstraction; per-relay connection state.
- Seed list from `relays.json`; user-editable via Identity tab.
- ed25519 keypair generated in browser; stored in `localStorage`.
- Geohash encoding (precision 4–9) with privacy-aware default at 7.
- Verification UI with the five verbs and client-computed consensus.

### Release artifacts

- Whitepaper (`WHITEPAPER.md`).
- Normative spec (`SPEC.md`).
- Landing page (`web/`) positioning the protocol as a release, not a service.
- Release process (`RELEASE.md`) for multi-host Git mirroring and IPFS pinning.
- **Standalone executables** for Mac (arm64 + x64), Windows (x64), and Linux (x64 + arm64), built via Bun's `--compile` mode. ~70 MB per binary, no install needed, no Bun runtime required on the user's machine. Built on tag push by `.github/workflows/release.yml`; reproducible locally with `relay/scripts/build-binaries.sh`.

### Known limits in v0.1

- Media is referenced by URL; no in-client upload to IPFS (deferred to v0.2).
- No encrypted key backup; losing the device loses the identity (deferred to v0.2).
- No vouching events; web of trust is intentionally absent (deferred to v0.2+).
- No relay federation; clients fan out to multiple relays themselves.
- No native mobile apps; PWA only.

## v0.2.0 — planned

- **WebRTC peer-relay mesh.** Every PWA install of the reference client joins a peer-to-peer mesh automatically (opt-in toggle). Opening the client makes the device part of the network — no hosted infrastructure required. Design: [docs/v0.2-webrtc-peer-relay.md](docs/v0.2-webrtc-peer-relay.md). Reserves event kinds `10001` (peer offer), `10002` (peer answer), `10003` (ICE candidate).
- Direct media upload from client to a user-configured pinning service.
- Encrypted seed-phrase backup of the keypair.
- Map view with clustering.
- Push notifications for events matching saved filters.
- Optional `INFO` verb for relay self-description and peer advertisement.
