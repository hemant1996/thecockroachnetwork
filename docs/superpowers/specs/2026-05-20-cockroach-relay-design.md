---
title: Cockroach Relay Protocol — v0.1 design
date: 2026-05-20
status: approved
---

# Cockroach Relay Protocol — v0.1 design

This design document captures the decisions reached in the brainstorming session on 2026-05-20. The normative specification lives at [`SPEC.md`](../../../SPEC.md). This document records the *why* behind each decision so future contributors can change things on purpose, not by accident.

## Problem

Civic problems — broken roads, outages, corruption, scams, abuses of power — are reported today through centralized channels (apps owned by a company, complaint portals owned by a government, social platforms owned by an algorithm). Each channel has a single point of capture, censorship, or shutdown. There is no shared public memory of what is broken, where it is broken, how long it has been broken, or whether anyone is acting on it.

## What we are building

A decentralized civic signal protocol. Citizens publish signed reports of real-world problems. Anyone can run a relay. Anyone can run a client. Reputation is earned by useful contributions and computed at the edges, not by an authority. No single entity owns the network.

The v0.1 deliverable is the **smallest end-to-end thing that proves the protocol works**: a normative spec, a working relay, a working mobile-first client, a white paper, and a landing page.

## Decisions locked in brainstorming

| Decision | Choice | Why |
|---|---|---|
| Protocol base | New, pure, Nostr-*inspired* but not Nostr-compatible | User wanted "pure"; Nostr's culture and event-kind space carry baggage we don't want. |
| Anti-sybil | Locality-weighted reputation + burst tolerance | Only approach that survives the revolution use case: no social-graph leakage, no external verifier, fresh keys still usable. |
| Token | Reputation = non-transferable score, recomputed by clients | No chain, no wallet, no regulatory surface; "token" aspiration captured as social currency. |
| Wire format | Compact deterministic JSON over WebSocket; optional CBOR for constrained transports | Bandwidth + memory-conscious but forkable by anyone who can write JSON + WS. |
| Event size | ≤ 500 bytes per event; media referenced by hash, never embedded | A 5 MB photo per event would kill the network instantly. |
| Report taxonomy | One event kind, open-tag vocabulary | No committee deciding what counts as "corruption"; tags emerge from use. |
| Verification verbs | Fixed set: `true`, `duplicate`, `resolved`, `fake`, `needs-more-proof` | Matches how humans actually triage. Small, durable, durable. |
| Truth computation | Client-side, never server-side | Different observers (NGO, government, journalist) apply different weighting policies on the same event stream. |
| Key recovery | Out of scope for v0.1 | Strict but pure. v0.2 can add encrypted seed-phrase backup. |
| Relay implementation | Bun + TypeScript + SQLite | Single-process, hot-reloadable, runs on Termux on a phone. |
| Client implementation | Vanilla TS + IndexedDB, PWA-installable | Zero framework lock-in; reviewable in one sitting. |
| Landing logo | Original cockroach mark designed for this project | The site at cockroachjantaparty.org is behind a Cloudflare challenge and its `robots.txt` disallows AI crawlers; copying another organization's logo would be wrong on copyright grounds and confuses protocol vs. party identity. |

## Out of scope for v0.1

These belong to v0.2+ and are explicitly *not* being built now:

- Vouching events (web of trust)
- Encrypted seed-phrase backup
- Mesh / sneakernet / Tor transport adapters (the protocol *supports* them, the reference client doesn't ship them)
- Native iOS / Android apps (PWA only)
- Map view with clustering (the v0.1 client ships a list view + a coarse map; rich clustering is later)
- Anti-spam relay economics (pricing, proof-of-work admission)
- Multi-relay client fan-out (v0.1 client speaks to one relay at a time; multi-relay is later)
- Internationalization of UI strings

## Deliverable map

| Artifact | Path | Purpose |
|---|---|---|
| Normative protocol spec | `SPEC.md` | The source of truth. Anyone implementing a second relay or client works from this. |
| White paper | `WHITEPAPER.md` | The *why* — vision, threat model, civic theory, comparison to alternatives. |
| Reference relay | `relay/` | Bun + TypeScript WebSocket broker, SQLite storage, geo + tag + time filters. |
| Reference client | `client/` | Single-page PWA. Keygen, signed compose, feed, verification UI. |
| Landing page | `web/` | Static HTML. Explains the protocol, links to client + run-a-relay guide. |
| Readme | `README.md` | Project entry point, quick start, repo map. |

## Acceptance criteria

The v0.1 build is considered done when:

1. A user can open `client/index.html` in a phone browser, generate a keypair, write a signed report with a geohash, and publish it to a relay.
2. A second user on the same relay sees the report in their feed within one second.
3. The second user can sign a `true` verification of the report.
4. The first user sees the verification, and the report's score (computed client-side) reflects it.
5. `bun test` in `relay/` passes — at minimum, signature verification, filter matching, geohash prefix indexing.
6. The landing page loads, displays the cockroach mark, and links to the live client and the run-a-relay guide.
