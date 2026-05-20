# Cockroach Relay Protocol

**A public network for reporting, verifying, and organizing around real-world civic problems — owned by no one.**

Version 0.1 · 2026-05-20

---

## Abstract

Cockroach Relay is a wire protocol for publishing signed reports of real-world civic problems through dumb message brokers called relays. Identity is a keypair held on a phone; reports are signed events; verification is social and computed at the edges. There is no central server, no admin, no token, no DAO, no company. Reputation is a non-transferable score derived from accuracy and sustained presence in a place. The network is designed to survive hostile state actors, regime-level censorship, and the failure of any single participant — including its original authors.

This paper explains what the protocol is, why it is shaped the way it is, and what it is not.

---

## 1. The problem

Civic problems are everywhere — broken roads, water outages, garbage dumps, predatory scams, abuses of power, election irregularities. The infrastructure for *reporting* those problems is, almost everywhere, captured:

- **Company apps** are owned by the company. The company can be acquired, can lose interest, can be pressured by a government, or can simply log out the wrong person.
- **Government complaint portals** are owned by the government being complained about. Their incentive structure is to make problems disappear from the queue, not to fix them.
- **Social platforms** are owned by an algorithm tuned for engagement, not for civic memory. A report posted on a feed is gone in a day.

The result is that we have no public, durable, verifiable record of what is broken in our cities and countries. Citizens cannot prove a pothole has been open for nine months. Journalists cannot compare reported outages across districts. Local organizers cannot find each other before the third recurrence of the same crisis. And no one — not a citizen, not a reporter, not even a sympathetic official — has a shared map of reality to act on.

The premise of this protocol is that the missing infrastructure is not another app. It is **a public, signed, content-addressed, censorship-resistant record of civic reality**, with no operator.

## 2. Design principles

These principles drive every decision in the spec. They are listed in priority order; later principles defer to earlier ones.

### 2.1 Zero control from day one

The authors of this protocol MUST NOT be able to censor, modify, throttle, or deplatform any user, report, relay, or client. The protocol MUST be valuable even if its original repository is deleted. This is not aspirational — it is a constraint that disqualifies any architecture that retains a central kill switch.

### 2.2 The protocol is the product

The thing we are building is a specification. Everything else — the reference relay, the reference client, the landing page — is an example implementation. A second implementation is a feature of the protocol, not a competitor.

### 2.3 Survive the hostile case

We design for a global political revolution, not for a friendly pilot in one city. If the protocol works in Tahrir Square under a hostile regime, it will work for potholes in suburbia. The reverse is not true. Every design decision is checked against the question: *does this still work when the people running the relays, the people writing the client, and the people verifying the reports are all targets?*

### 2.4 Truth lives at the edges

No relay decides what is true. No central index ranks reports. The event stream is a sequence of signed claims; each observer computes their own view by applying their own weighting policy. A human-rights NGO and a city engineer can run different policies over the same stream and both be served by the same network.

### 2.5 Identity is owned, never granted

A user creates their own keypair on their own device. There is no signup, no email verification, no profile server, no third-party identity provider. A user MAY hold many unlinked keypairs for many contexts. Losing the key means losing the identity — this is a feature, not a bug.

### 2.6 Reputation is earned by presence, not by votes

Reputation is not a token. It is not voted. It is not granted. It is computed from sustained, geographically-anchored, accurate contributions. The cost of becoming an influential voice in a place is to actually be there over time. The cost of becoming an influential voice for a flood of fake reports is the same — and is therefore prohibitive.

### 2.7 Make forking easy

The protocol uses JSON over WebSocket, ed25519 signatures, and SHA-256 hashes — primitives available in every programming environment. The full spec is one document. A new relay or a new client can be written in a weekend by anyone with patience. This is the only meaningful defense against capture: the network must be cheap to re-create.

## 3. Architecture

Three roles. Three primitives. That is the entire protocol.

```
            +-----------+        +-----------+
            |  client A | <----> |   relay   | <----> |  client B |
            +-----------+        +-----------+        +-----------+
                  |                                         |
                  v                                         v
              keypair                                   keypair
              (on-device)                               (on-device)
```

A **client** holds the user's ed25519 keypair, lets the user compose a report, signs the report, and pushes it to one or more relays. A **relay** verifies the signature, indexes the event, and serves it to subscribers. A second client subscribes to the relay, receives the report, lets its user sign a verification, and pushes that verification back. Done.

The protocol does not standardize the UI, the storage, the choice of relays, or the reputation algorithm. It standardizes the event format, the signing rules, the wire messages, and the meaning of the five verification verbs. That is the entire surface area.

## 4. The Report event

The smallest civic act in this network is the publication of a signed report. A report is a JSON object containing a 32-byte ed25519 public key, a 32-byte hash that is also the event's identifier, a 64-byte signature over that hash, a unix timestamp, a topic kind, an open-tag vocabulary, and a free-form UTF-8 description. Total event size is bounded at 8 KB; typical events are under 500 bytes.

Reports MUST carry a geohash and at least one topic tag. Reports MAY attach media by content-address — the event contains a SHA-256 of the media plus a list of URLs from which the media may be fetched. Media is never embedded in the event itself; embedding 5-megabyte photos into the protocol would kill it.

The schema is intentionally minimal. There is no `title` field, no `category` enum, no `priority` rating set by a central authority, no `status` machine. A report is a signed observation. Everything else is computed downstream.

## 5. Verification, and the five verbs

A report on its own is one person's claim. The network's value comes from what happens after — *others observing the same reality and signing what they see*.

A verification is a separate event, signed by a different pubkey, referencing the original report and carrying exactly one verdict from a fixed vocabulary of five:

- **true** — I observed this and it is real.
- **duplicate** — same issue as another report.
- **resolved** — this issue is no longer present.
- **fake** — I observed this and it is misleading or fabricated.
- **needs-more-proof** — may be real, lacks sufficient evidence.

That vocabulary is deliberately small. It is not a Likert scale, not a star rating, not a 17-emoji palette. It corresponds to the verdicts a human triage system actually produces. The verbs are durable: in five years, the same five words will still describe how people verify a report.

There is no global `verified=true` boolean ever attached to a report. There is only a stream of signed verifications. Different clients aggregate them differently. A government dashboard might trust verifications from municipal-employee keys; an opposition newsroom might explicitly ignore those same keys. The protocol does not adjudicate. The protocol surfaces the *evidence* and lets the consumer compute the conclusion.

## 6. Reputation = locality × accuracy

If anyone can sign a verification, what stops one person from spinning up ten thousand keys and self-verifying their own fake reports?

The answer cannot be a central registry of "real" users — that would re-introduce the authority we just eliminated. The answer cannot be proof-of-personhood — that hands the kill switch to whoever runs the orb. The answer cannot be vouching — that creates a social graph that becomes a kill list in hostile regimes.

The answer is **locality**. A key's verification of a report counts in proportion to that key's prior sustained signed presence in the area where the report was filed. A fresh key with no history in that geohash counts for little. A key with 180 days of accurate verifications anchored to the same neighborhood counts for a lot. The cost of building influence is therefore not money or social capital or proof of citizenship — it is *being present in a place, over time, and being right when others check your work*.

This is the cost a sybil farm cannot cheaply pay. Ten thousand fresh keys in a server room have zero locality. A coordinated attack must distribute itself across real geographies and survive months of accurate behavior before its votes carry weight. By that point it is no longer an attack; it is a slow infiltration that any active observer will notice.

For the case the locality defense would otherwise mis-handle — a *real* crowd suddenly appearing in a place — the algorithm includes a burst-tolerance rule. When many distinct fresh keys in a small geographic cell publish related events in a short window, the cluster itself becomes a high-confidence signal rather than being suppressed. This is what makes "a protest just started in the plaza" legible to the network the moment it happens, without weakening the defense against a flood of fakes from a single source.

Section 8 of the spec gives the reference formulas. They are not normative. A client MAY use any other algorithm. The point of the protocol is that the *raw evidence* is the same for everyone; the *interpretation* is plural by design.

## 7. Threat model

The protocol is designed against five concrete adversaries.

**The flood.** A bad actor publishes thousands of fake reports, or thousands of fake verifications, in an attempt to drown the signal. Defense: events from low-locality keys carry low weight; burst tolerance distinguishes a real crowd from a single-source flood; relays MAY enforce per-pubkey rate limits.

**The shutdown.** A government orders the operator of the only relay to take it offline. Defense: there is no "only relay." Relay software runs on a $5 VPS, a Raspberry Pi, or a phone under Termux. The protocol leaves room for Tor and I2P transports; in v0.1, this is operator-configured rather than client-default.

**The honeypot.** An adversary stands up a relay that records publishers' IP addresses, hoping to identify dissidents. Defense: the protocol does not authenticate to a relay — the relay learns the client's network address regardless. Reporters in sensitive contexts MUST use Tor, a VPN, or otherwise sanitize their network identity. The protocol can defend the *content*; it cannot defend the *channel*. We do not pretend otherwise.

**The correlation attack.** An adversary uses the protocol's own event stream against its users — building social graphs from co-located reporting, identifying real-world identities from EXIF data in attached media, or de-anonymizing pseudonyms across kinds. Defense: there are no vouching events in v0.1, so no explicit social graph exists. Clients MUST strip media metadata. Users MAY (and the reference client makes it easy) hold multiple unlinked pubkeys for distinct contexts.

**The coercion.** A regime forces a known high-reputation key to mark protest reports as `fake`. Defense: client-side scoring. Any client MAY ignore any pubkey or any relay. The protocol does not centralize the trust decision; it cannot be coerced because there is no single throat to grab.

A sixth adversary — **the corporate acquirer** — is mentioned in passing because it is the slow-motion version of the shutdown. An entity acquires the company behind the popular client and quietly degrades its independence. Defense: the protocol is the product. A degraded client is not a degraded protocol. A second client can be built in a weekend.

## 8. What this is not

- **Not a token.** No issuance, no transfer, no chain. Reputation is recomputed by clients from the event log; it has no monetary semantics and cannot be sold.
- **Not a DAO.** No treasury, no governance vote, no on-chain proposal. Decisions about the protocol are made the way any open spec evolves: by writing implementations and finding interoperability.
- **Not an app.** The reference client is an example. If the reference client is bad, write a better one. If the authors of the reference client are corrupted, fork it.
- **Not a Nostr NIP.** The wire shape is similar — JSON over WebSocket, signed events, dumb relays — because that shape works. The protocol is its own, with its own event kinds, its own tag vocabulary, its own reputation semantics, and its own threat model. Nostr is a sibling, not a parent.
- **Not a complaint queue.** The protocol publishes signed observations. Whether a government acts on them is, in the most literal sense, none of the protocol's business. The protocol's job is to make the observations exist, irrevocably, in public.

## 9. What success looks like

If this protocol works, several things become true that are not true today.

A citizen with a phone can sign a report of a real problem and know that it cannot be silently deleted, edited, or buried. A journalist can query for verified reports of a specific kind in a specific district over a specific period and get a structured, timestamped, signed answer. A community organizer can subscribe to incoming reports in their neighborhood and find others who care about the same issue *before* it becomes a crisis. A municipal engineer can ingest a stream of locally-verified reports and prioritize by actual local consensus rather than by who complained loudest.

None of this requires the authors of this protocol to remain in existence. The protocol is a public good. We expect to be irrelevant to it within a year.

That is the goal.

---

## Appendix A — Why "Cockroach"

Cockroaches are the canonical symbol of survival under hostile conditions. They thrive in the cracks where authority is not looking. They cannot be stamped out by any single boot. They are, in a literal biological sense, decentralized — no queen, no nest, no head of organization, just resilient distributed copies of the same blueprint.

A protocol for surfacing civic problems that survives hostile actors, censorship, regime-level shutdown, and the failure of any single participant is — in the metaphor — a cockroach. We took the name on purpose.

## Appendix B — Versioning and forks

This protocol uses semantic versioning at the wire level. A change to the event format, the signing rules, or the message verbs is a major-version change. Adding a new event kind or a new tag name is not — implementations are required to round-trip preserve anything they don't recognize.

A fork of the protocol is welcomed. The license on this specification is CC0; copy it, change it, take credit for the changes, publish under any name. If your fork is better, ours will lose, and the network will be richer for it.

## Appendix C — Status of v0.1

The v0.1 deliverable is a normative spec, a reference relay, a reference client, this paper, and a landing page. The reference relay is L1-conformant; the reference client is L3-conformant; the implementations together prove the spec is implementable from scratch in a few hundred lines of code. v0.2 will add encrypted seed-phrase backup, optional vouching events, multi-relay client fan-out, and richer map UI. None of v0.2 is required for the protocol to be useful today.
