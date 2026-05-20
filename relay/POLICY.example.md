# Content policy — example template for relay operators

> **This is an example. Copy it, edit it, publish it at `/policy` on your relay, and link to it from anywhere your relay's URL appears. Your relay's policy is yours. The protocol does not dictate what you keep or drop.**

This document describes what events this relay accepts, what it drops, and how disputes are handled. It is not a constitution and it does not bind any other relay on the network.

## What this relay is for

This relay forwards signed civic-signal events under the Cockroach Relay Protocol ([SPEC.md](../SPEC.md)). It exists to make real-world civic problems — broken infrastructure, outages, corruption, abuses of power, fraud, environmental damage, public-safety incidents — visible and verifiable in public.

## What this relay accepts

- Signed `kind:1` reports of civic issues in any language.
- Signed `kind:2` verifications of those reports.
- Events whose `created_at` is within the protocol's clock-skew tolerance (15 minutes future, 24 hours past).
- Events under 8 KB total.
- Reports about powerful people, institutions, and governments — including ones critical of them.

## What this relay drops

This relay will refuse (return `["OK", id, false, ...]` and not store) events that, in the operator's judgment, fall into any of the following categories:

- **Illegal under the operator's jurisdiction.** Examples vary by country. The operator is responsible for understanding their own legal exposure.
- **Doxxing of private individuals.** Reports MAY name public officials acting in their official capacity, businesses, brands, and accounts that are themselves public. Reports MUST NOT publish home addresses, phone numbers, or family details of private individuals not themselves the subject of the report.
- **Targeted harassment.** Patterns of repeated reports against a specific named individual that do not describe a verifiable civic incident.
- **Spam and commercial promotion.** Events whose primary purpose is to advertise a product, service, or affiliate link.
- **Imminent-harm content.** Content that, if propagated, would create an imminent threat to physical safety of identifiable people. This is narrower than "anything that might offend"; the test is imminence, identification, and verifiable harm.

The operator does not pre-screen events. Drops happen after the fact, when reported or noticed.

## What this relay never does

- Modify events. A modified event would fail signature verification anyway.
- Censor based on identity claims the operator cannot verify. The operator does not know who is behind any given pubkey.
- Share IP logs with any party in the absence of a lawful order specific to a named event id. (See *Logging and retention* below.)

## Logging and retention

- WebSocket connection logs (IP, timestamp, connection duration) are retained for **N days** for abuse investigation, then purged. *(Edit to your real number, e.g. 7.)*
- Event store is retained for **90 days** by default per relay configuration. After that, events are deleted from this relay; they may still exist on other relays.
- The operator does NOT correlate IP logs with stored event content as a routine matter.

## Disputes and appeals

If your event was dropped and you believe it should not have been:

1. Email **{operator-email}** with the event id (it is in the `OK` rejection message your client received) and a one-paragraph explanation.
2. The operator will respond within **N days** *(edit)* with either reinstatement, a clarification of policy, or a confirmation of the drop.
3. If you disagree, publish your event to a different relay. The protocol is owned by no one; one relay's drop is not the network's drop.

## Legal demands

The operator will respond to lawful orders specific to identified events or pubkeys. The operator will publish a transparency note at `/transparency` *(once at least one demand has been received)* summarizing the nature of each demand and how it was handled, redacted only as legally required.

The operator does NOT have:

- A user database. There is no signup, no profile, no email.
- Pubkey-to-real-identity mappings. The operator cannot map a pubkey to a person.
- Recoverable secret keys. Keys are generated client-side and never transmitted.

## Operator

- **Name / handle:** {YOUR NAME OR HANDLE}
- **Contact:** {email, PGP key, Signal, Matrix — pick what fits}
- **Jurisdiction:** {country / state where the relay is physically operated}
- **Operating since:** {date}

## Changes to this policy

This policy may change. Material changes will be announced in a signed `kind:1` event from the operator's pubkey with the tag `["t", "policy-update"]` and posted at `/policy/changelog` on this relay.

---

*Last updated: {date}. Template version 0.1.*
