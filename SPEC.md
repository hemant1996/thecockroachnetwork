# Cockroach Relay Protocol — SPEC

**Version:** v0.1
**Status:** Draft
**License:** CC0 — public domain. Fork freely.

## 0. What this is

A wire protocol for publishing, fetching, and verifying signed civic-signal events through dumb relays. No accounts, no central server, no admin. A pubkey is an identity. A relay is a broker. Truth is computed at the edges.

This document is normative. A compatible implementation is one that interoperates with another implementation that follows this document.

## 1. Terminology

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY** are used in the sense of RFC 2119.

- **Event** — an immutable, signed JSON object.
- **Pubkey** — a 32-byte ed25519 public key, lowercase hex (64 chars).
- **Sig** — a 64-byte ed25519 signature, lowercase hex (128 chars).
- **Relay** — a process that accepts, stores, and serves events over WebSocket.
- **Client** — a process that creates events and/or subscribes to events.
- **Geohash** — a base-32 geohash string, precision 1–9.

## 2. Cryptography

- Signing algorithm: **ed25519** (RFC 8032).
- Hash algorithm: **SHA-256**.
- Event IDs are lowercase hex.

Implementations MUST use constant-time signature verification.

## 3. Event format

An event is a JSON object with exactly these fields:

```json
{
  "id":         "<64-char hex sha256 of canonical form>",
  "pubkey":     "<64-char hex ed25519 public key>",
  "created_at": <integer unix seconds>,
  "kind":       <non-negative integer>,
  "tags":       [ [<string>, ...], ... ],
  "content":    "<utf-8 string>",
  "sig":        "<128-char hex ed25519 signature over id>"
}
```

### 3.1 Canonical form (for `id` and `sig`)

The canonical form is the JSON serialization of:

```
[ 0, pubkey, created_at, kind, tags, content ]
```

with the following rules:

- Use compact JSON: no whitespace between tokens.
- UTF-8 encoded.
- String escaping: only the minimal escapes — `"`, `\`, `\n`, `\r`, `\t`, `\b`, `\f`, and `\uXXXX` for control characters U+0000 through U+001F. All other characters serialized as-is.
- Integers serialized without leading zeros, without a sign for non-negative values.
- Arrays serialized as `[a,b,c]`.
- Objects MUST NOT appear in the canonical form. The canonical form is an array of scalars and arrays.

The `id` is the lowercase hex of `sha256(canonical_form_bytes)`.
The `sig` is the lowercase hex of `ed25519_sign(secret_key, hex_to_bytes(id))`.

A relay MUST reject events where:

- `id` does not match the recomputed hash of the canonical form, OR
- `sig` does not verify against `pubkey` and `id`, OR
- `pubkey` is not 64 hex chars, `sig` is not 128 hex chars, or `id` is not 64 hex chars, OR
- `created_at` is more than **900 seconds** in the future or more than **86400 seconds** in the past relative to the relay's clock, OR
- the event size exceeds **8192 bytes** of UTF-8 encoded JSON, OR
- any tag is not an array of strings, OR
- `content` is not a string.

A relay MAY apply stricter policies but MUST NOT relax any of the above.

### 3.2 Tags

A tag is an array of strings. The first string is the tag name; the remaining strings are tag values. A tag name is a non-empty string of ASCII characters in `[a-zA-Z_]` and digits (no spaces).

Some tags are *indexed* by relays and queryable via filters (§5.3). All single-letter tag names (e.g. `"e"`, `"p"`, `"t"`, `"g"`) are reserved as indexed tags. Multi-letter tag names are non-indexed (carried in the event but not queryable).

Defined tags in v0.1:

| Tag | Indexed | Meaning |
|---|---|---|
| `["g", "<geohash>"]` | yes | Location of the event, base-32 geohash precision 5–9 (most reports use 7 ≈ 150 m). REQUIRED on `kind:1`. |
| `["t", "<topic>"]` | yes | Topic tag (e.g. `"road"`, `"corruption"`, `"outage"`). At least one REQUIRED on `kind:1`. Multiple `["t", ...]` tags allowed. |
| `["e", "<event-id>"]` | yes | References another event by id. REQUIRED on `kind:2` (the report being verified). |
| `["p", "<pubkey>"]` | yes | References another pubkey. Optional. |
| `["v", "<verdict>"]` | no | Verification verdict; see §4.2. REQUIRED on `kind:2`. Exactly one. |
| `["media", "sha256:<hex>", "<url1>", "<url2>", ...]` | no | Media attachment by content-address. The first value is the content hash; subsequent values are URLs from which the media MAY be fetched. Multiple `["media", ...]` tags allowed. |
| `["lang", "<bcp47>"]` | no | Language of `content`. Optional. |
| `["severity", "<1-5>"]` | no | Author-asserted severity. Optional. |

Implementations MUST preserve unknown tags verbatim (round-trip preservation) and MUST NOT reject events solely on the basis of unknown tags.

## 4. Event kinds

### 4.1 `kind: 1` — civic report

A signed observation of a real-world problem. Required tags: at least one `["g", ...]` and at least one `["t", ...]`. The `content` field is free-form UTF-8 describing the issue.

Example:

```json
{
  "id":         "...",
  "pubkey":     "...",
  "created_at": 1747700000,
  "kind":       1,
  "tags": [
    ["g", "tdr1y4d"],
    ["t", "road"],
    ["t", "pothole"],
    ["lang", "en"],
    ["severity", "3"],
    ["media", "sha256:9f8e7d...", "https://w3s.link/ipfs/bafy..."]
  ],
  "content":    "Pothole at the corner, has eaten two scooters this week.",
  "sig":        "..."
}
```

### 4.2 `kind: 2` — verification

A signed opinion about a report. Required tags: exactly one `["e", "<report-id>"]` and exactly one `["v", "<verdict>"]`, where verdict is one of:

| Verdict | Meaning |
|---|---|
| `true` | I observed this and it is real. |
| `duplicate` | Same issue as another report; the `content` field MAY include the duplicate target id. |
| `resolved` | This issue is no longer present. |
| `fake` | I observed this and it is misleading or fabricated. |
| `needs-more-proof` | The report may be real but lacks sufficient evidence to verify. |

Optional `content` is a brief human note ("Walked past it this morning, still broken").

Implementations MUST NOT count more than one verification per `(verifier_pubkey, report_id)` pair when computing scores; if multiple exist, the one with the greatest `created_at` wins, ties broken by lower `id`.

### 4.3 Reserved kind ranges

| Range | Purpose |
|---|---|
| 0 | Reserved for v0.2 profile metadata. |
| 1–999 | Civic content kinds. |
| 1000–9999 | Reserved. |
| 10000+ | Application-specific, ephemeral or experimental. |

### 4.4 `kind: 10001` — peer offer (v0.2)

A signed WebRTC connection offer, broadcast through relays so other peers can discover and connect. Ephemeral: relays MAY drop these after the offer expires.

Required tags:
- `["sdp", "<SDP offer text>"]` — the WebRTC session description.
- `["expires", "<unix timestamp>"]` — after this time, peers MUST NOT attempt to connect.

Optional tags:
- `["g", "<geohash>"]` — coarse geohash (precision 5 recommended) for locality-based peer selection. Privacy-conscious peers use lower precision or omit.

### 4.5 `kind: 10002` — peer answer (v0.2)

A signed WebRTC answer addressed to the author of a specific `kind:10001` event.

Required tags:
- `["p", "<offerer-pubkey-hex>"]` — the offer author this answer is for.
- `["e", "<offer-event-id>"]` — the offer being answered.
- `["sdp", "<SDP answer text>"]` — the WebRTC answer.

### 4.6 `kind: 10003` — ICE candidate (v0.2)

A trickle-ICE candidate addressed to a specific peer. Reserved; the v0.2 reference client gathers ICE fully before publishing the offer/answer, so it does not produce or consume these. Implementations supporting trickle-ICE for faster connection establishment use this kind.

Required tags:
- `["p", "<other-peer-pubkey-hex>"]`
- `["e", "<offer-or-answer-event-id>"]`
- `["ice", "<ICE candidate>"]`

### 4.7 Peer mesh behavior

A peer-enabled client publishes a `kind:10001` offer through its relays, subscribes to incoming offers and to answers addressed to itself (`#p` = own pubkey), and uses any data channels it establishes to gossip events of kinds `1` and `2` with deduplication by event id.

Implementations MUST NOT trust the contents of events received over peer connections without verifying the signature. The peer layer is a transport, not a trust boundary; signature verification is the trust boundary.

The peer layer is OPT-IN. Implementations expose this to the user with explicit disclosure of the IP-address-exposure consequence.

### 4.8 Share-URL relay discovery (v0.4)

Implementations SHOULD make event permalinks shareable via a URL of the form:

```
https://<host>/r/<event-id>#relays=<comma-separated wss:// URLs>
```

The `#relays=` fragment is part of the URL fragment (NOT a query parameter), so it is never sent to the host in HTTP requests, Referer headers, or server logs.

When a client opens such a URL, it SHOULD:
1. Parse the fragment, URL-decode each comma-separated entry.
2. For each URL, fetch `GET /` over HTTPS with a short timeout.
3. Verify the response is JSON with `name === "cockroach-relay"`.
4. Add the URL to the client's known relay pool, tagged with provenance source `"share"` and the originating event ID for user-facing transparency.
5. Clear the fragment from the URL so a page reload does not reprocess the same hint.

This mechanism is the protocol's answer to client-side bootstrap without a central registry: discovery propagates via human shares.

### 4.9 `PEERS` verb — client-to-relay peer hints

A client MAY send the following message to a relay it is connected to:

```
["PEERS", "<wss:// url 1>", "<wss:// url 2>", ...]
```

The relay treats each well-formed URL as a candidate peer for relay-to-relay sync (see §6). The relay MUST verify each candidate via `GET /` before opening any outgoing connection. A relay MAY bound the number of candidates per `PEERS` message (the reference implementation caps at 8). The verb has no acknowledgement; clients send it opportunistically after connecting.

## 4a. Relay-to-relay sync (v0.4)

To prevent siloed feeds — where users on one set of relays cannot see events published to a disjoint set — relays MAY synchronize with each other. The reference implementation does so by default.

### 4a.1 Peer discovery

A relay MAY learn about other relays from any of these sources:

- **Operator configuration**: environment variable `COCKROACH_PEERS=wss://a,wss://b,...` or an equivalent config file entry, set at startup. Operator-vouched; not subject to `/info` verification.
- **Client hints**: the `PEERS` verb (§4.9). The relay MUST verify each candidate via `GET /` before opening a subscription.
- **Static config additions** at runtime (out of scope for the spec).

Relays MUST persist their known peer set across restarts so the network does not need to rediscover itself.

### 4a.2 Sync mechanism

For each known peer, a relay maintains a single outgoing WebSocket subscription. On connection, the subscribing relay issues:

```
["REQ", "peer-sync", { "kinds": [1, 2], "since": <watermark - 60>, "limit": 1000 }]
```

The 60-second overlap defends against minor clock skew at watermark boundaries. Events received from a peer are validated (signature check) and inserted via the same `storeEvent` path the relay uses for direct client publishes; the insert is a no-op on duplicate ID. The watermark for each peer is the maximum `created_at` of any event accepted from that peer.

Re-broadcast of an event the relay has already stored is a single hash-lookup no-op; signed-event immutability removes the need for TTL or loop-prevention counters.

### 4a.3 Public peer inventory

Relays SHOULD expose `GET /peers` returning JSON describing their known peer set, for operator inspection and for clients to surface in their UIs:

```json
{
  "peers": [
    { "url": "wss://relay-2.example.com",
      "source": "env",
      "added_at": 1716280000,
      "last_seen": 1716290000,
      "connected": true }
  ]
}
```

### 4a.4 Loops, partitions, eventual consistency

Because storage is content-addressed by `id` and events are immutable, the sync forms a CRDT G-set (grow-only set) under set-union semantics. Any partition heals as connectivity is restored: each side will eventually see every event held by the other. Tag-based filters and `since` bounds shape *what* a sync mirrors, but never *how* — duplicates are always safe.

## 5. Relay wire protocol

The wire protocol runs over WebSocket. Messages are JSON arrays. A relay MUST accept connections on `ws://` and SHOULD also serve `wss://`.

### 5.1 Client → Relay messages

```
["EVENT", <event-object>]
["REQ", <subscription-id>, <filter-object>, <filter-object>, ...]
["CLOSE", <subscription-id>]
```

- `EVENT` — publish an event.
- `REQ` — open a subscription. One or more filters; an event matches if it matches *any* filter. The relay MUST first send all stored matching events, then send `EOSE`, then stream new matches as they arrive.
- `CLOSE` — close a subscription.

A `subscription-id` is a client-chosen string, ≤ 64 chars, unique per connection.

### 5.2 Relay → Client messages

```
["EVENT", <subscription-id>, <event-object>]
["OK", <event-id>, <accepted-boolean>, <message-string>]
["EOSE", <subscription-id>]
["NOTICE", <message-string>]
```

- `EVENT` — a stored or newly received event matching a subscription.
- `OK` — acknowledgement of a published `EVENT`. `accepted=false` MUST include a reason in the message (e.g. `"invalid: bad signature"`, `"rejected: rate-limited"`).
- `EOSE` — end of stored events for the subscription; live stream begins.
- `NOTICE` — human-readable diagnostic.

### 5.3 Filters

A filter is a JSON object. All listed conditions must hold simultaneously for an event to match.

```json
{
  "ids":     ["<event-id-prefix>", ...],
  "authors": ["<pubkey-prefix>", ...],
  "kinds":   [<int>, ...],
  "#g":      ["<geohash-prefix>", ...],
  "#t":      ["<topic>", ...],
  "#e":      ["<event-id>", ...],
  "#p":      ["<pubkey>", ...],
  "since":   <unix>,
  "until":   <unix>,
  "limit":   <int>
}
```

Notes:

- `ids` and `authors` match by **prefix** (lowercase hex).
- `#<single-letter>` keys match against indexed tags of that name. Match semantics: the event has at least one tag whose first element is `<letter>` and whose second element equals (for `#t`, `#e`, `#p`) or starts with (for `#g`, geohash) one of the listed values.
- `since` / `until` are inclusive bounds on `created_at`.
- `limit` caps the number of *stored* events returned before `EOSE`. Live stream is not capped.
- Empty arrays in a filter mean "no constraint on this field," not "match nothing."

A relay SHOULD support at least 64 concurrent subscriptions per connection and SHOULD enforce a reasonable global event-rate ceiling.

## 6. Storage (informative)

Relays MAY compress event blobs at the storage layer. The reference implementation gzip-compresses the JSON representation of any event whose raw form exceeds 256 bytes, base64-encodes the gzipped bytes for TEXT-column storage, and falls back to uncompressed storage when the encoded length is not strictly smaller than the original. A boolean `compressed` column flag tells the read path whether decompression is required. Compression is invisible to clients — it affects only storage cost.

## 6.5. Geohash

Implementations MUST use the standard base-32 geohash alphabet:

```
0123456789bcdefghjkmnpqrstuvwxyz
```

Each character encodes 5 bits, alternating between longitude and latitude bits, starting with longitude. Precision 7 yields cells of approximately 153 m × 153 m at the equator and is the recommended default for civic reports.

The reference geohash encoder is informative; any correctly-implemented geohash interoperates.

## 7. Media

Media MUST be referenced by content-address using the `["media", "sha256:<hex>", "<url>", ...]` tag. Clients fetching media MUST verify that `sha256(fetched_bytes)` equals the declared hash and MUST discard the bytes if it does not.

The protocol does not standardize where media is stored. Recommended options: IPFS, web3.storage, the reporter's own phone over libp2p, any public HTTPS host. Multiple URLs MAY be provided as fallbacks.

Media MUST NOT be embedded in the event body.

## 8. Reputation (reference algorithm)

Reputation is computed by clients, not by relays. Different clients MAY use different algorithms. The reference algorithm below is what the v0.1 reference client uses; it is not normative.

For a pubkey `p`, over a known event set `E`:

```
a(p) = | { r in E : r.kind=1, r.pubkey=p, |distinct_verifiers_true(r)| >= 3 } |
b(p) = | { v in E : v.kind=2, v.pubkey=p, v.verdict == consensus_verdict(v.target) } |
c(p) = sum over geohash-5 cells g of log(1 + |{ e in E : e.pubkey=p,
                                                 geo5(e) = g,
                                                 now - e.created_at <= 180 days }|)
d(p) = | { r in E : r.kind=1, r.pubkey=p, consensus_verdict(r) == "fake" } |

rep(p) = 2*a(p) + 1*b(p) + 1*c(p) - 5*d(p)
```

where `consensus_verdict(r)` is the modal verdict among ≥3 distinct verifiers, or `undefined` if fewer than 3 distinct verifiers exist.

### 8.1 Weighting a verification on a specific report

```
weight(v on r) = max(1, rep(v.pubkey))
               * (1 + log(1 + |events_by(v.pubkey)_within_geohash5(r.g)_last_180d|))
               * exp( -(now - v.created_at) / (30 days) )
```

### 8.2 Burst tolerance

In any geohash-5 cell, in any 1-hour window, if `k >= 10` distinct fresh pubkeys (created within the last 30 days) publish `kind:1` events sharing at least one `t` tag, the effective reputation multiplier for those events rises to `log(k)`. This is what prevents legitimate crowd events (a sudden protest, a city-wide outage) from being suppressed as suspected sybil activity.

## 9. Threat model

The protocol is designed to survive:

- **Hostile state actors** flooding with fake reports → defended by locality-weighting + burst-vs-flood distinction (§8.2).
- **Relay shutdown** → anyone may run a relay; clients SHOULD support multiple relays (v0.2 in the reference client).
- **Identity correlation** weaponizing the protocol against users → defended by no profile-server, free pseudonym creation (each user MAY hold many unlinked pubkeys).
- **Sybil farms** → defended by the cost of building locality over time (§8.1).
- **Coerced verification** (regime forces high-rep keys to mark protest reports `fake`) → mitigated by client-side scoring: any client MAY ignore specific pubkeys or relays it distrusts.
- **Compromised media hosts** → media is content-addressed; a swap-in is detected at hash check (§7).

## 10. Security and privacy notes

- A `["g", ...]` tag at precision 7 reveals the reporter's approximate location. Reporters in sensitive contexts SHOULD use lower precision (5 ≈ 5 km, 4 ≈ 40 km).
- A pubkey reused across many reports is a long-term pseudonym. Clients SHOULD make it easy to generate new pubkeys for distinct contexts (routine vs. sensitive).
- Media metadata (EXIF GPS, device identifiers) MUST be stripped by the client before publishing.
- Timestamps are author-asserted. The 900s future / 86400s past tolerance (§3.1) bounds clock skew without enabling backdating attacks.

## 11. Forward compatibility

- New `kind` values are allocated by adding an entry here; existing implementations ignore kinds they don't recognize.
- New tag names are added without a version bump; existing implementations preserve them round-trip.
- A new wire-protocol verb is a breaking change and bumps the major version.

## 12. Conformance levels

| Level | Requirements |
|---|---|
| **L1 Relay** | §3, §5, §6 supported. Verifies signatures, indexes single-letter tags, serves filter queries. |
| **L1 Client** | §3, §5 supported. Generates ed25519 keypairs, signs and publishes `kind:1` events with `g` and `t` tags, subscribes and renders incoming events, signs `kind:2` verifications. |
| **L2 Client** | L1 + computes reputation per §8. |
| **L3 Client** | L2 + media handling per §7, burst tolerance per §8.2. |

The v0.1 reference relay is L1. The v0.1 reference client is L3.
