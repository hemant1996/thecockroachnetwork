# Changelog

All notable changes to the Cockroach Relay Protocol and its reference implementations are documented here.

The format follows the spirit of [Keep a Changelog](https://keepachangelog.com). The protocol versioning policy is in [SPEC.md §11](SPEC.md#11-forward-compatibility): new event kinds and new tag names are additive; only changes to the event format, signing rules, or wire verbs bump the major version.

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
