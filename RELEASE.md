# Release process

This document is for whoever is cutting a release of the protocol and its reference implementations. Most users never need to read it.

The goal of this document is to keep the release itself censorship-resistant. A protocol that lives on one Git host with one maintainer pinning one tarball is not decentralized; it has a single throat to grab. A release that lives in ten places, signed by its author, mirrored on IPFS, and reproducible from the spec alone is.

---

## What a release contains

A versioned release bundles:

```
SPEC.md
WHITEPAPER.md
README.md
RELEASE.md
relay/        ← reference relay source
client/       ← reference client source
web/          ← landing page
docs/         ← design notes
```

Nothing else. No binaries, no compiled artifacts. Everything is source. Anyone reading the release can audit it in an afternoon.

The release tag uses semantic versioning at the wire-protocol level (see SPEC §11). Cosmetic changes to the landing page do not bump versions. A new event kind or tag doesn't either. Only a breaking change to the event format, signing rules, or wire messages bumps a major.

---

## Step-by-step

### 1. Tag the release in your local Git

```sh
# from repo root
git tag -s v0.1.0 -m "Cockroach Relay v0.1.0"
git push <your-primary-remote> v0.1.0
```

Sign the tag with your PGP/SSH key. People retrieving the release should be able to verify *you* cut it, even if their copy comes from a mirror you don't control.

### 2. Build a deterministic tarball

```sh
git archive --format=tar.gz --prefix=cockroachparty-v0.1.0/ v0.1.0 \
  -o cockroachparty-v0.1.0.tar.gz

sha256sum cockroachparty-v0.1.0.tar.gz > cockroachparty-v0.1.0.tar.gz.sha256
gpg --armor --detach-sign cockroachparty-v0.1.0.tar.gz   # optional but recommended
```

Anyone with the tarball + sha256 file + signature can verify they got the same thing you cut, without trusting any Git host.

### 3. Mirror to multiple Git hosts

Push the tag to at least three independent Git hosts. Examples:

- GitHub
- GitLab
- Codeberg
- A self-hosted Gitea instance
- sourcehut

```sh
git remote add github  git@github.com:<you>/cockroachparty.git
git remote add gitlab  git@gitlab.com:<you>/cockroachparty.git
git remote add codeberg git@codeberg.org:<you>/cockroachparty.git

for r in github gitlab codeberg; do
  git push "$r" main
  git push "$r" v0.1.0
done
```

Diversity matters more than count. Three jurisdictions and three operators beat ten mirrors all on the same provider.

### 4. Pin to IPFS

```sh
# Adds the tarball and returns a CID like bafy...
ipfs add cockroachparty-v0.1.0.tar.gz

# Pin the source tree as a directory (browsable on any IPFS gateway)
ipfs add -r --pin -Q cockroachparty/
```

Take the two CIDs and pin them on at least two pinning services so they survive your local node going down:

- web3.storage (free tier, generous)
- Pinata (free tier)
- Filebase
- A friend's IPFS cluster
- Your own ipfs-cluster on two machines in two countries

Publish the CIDs at the top of `RELEASE.md` of the next commit so anyone reading the repo on any mirror can resolve them.

```
v0.1.0 IPFS CIDs:
  tarball:     bafyXXXXXXXXXXXXXXXXXXXXXXXXXXX
  source tree: bafyYYYYYYYYYYYYYYYYYYYYYYYYYYY
  sha256:      bafyZZZZZZZZZZZZZZZZZZZZZZZZZZZ
```

### 5. Update the install scripts

`relay/install.sh` accepts a `SOURCE_URL` env var. After a release, advertise *two or three* URLs the script will accept:

```
SOURCE_URL=https://github.com/<you>/cockroachparty/archive/refs/tags/v0.1.0.tar.gz \
  bash install.sh

SOURCE_URL=https://gitlab.com/<you>/cockroachparty/-/archive/v0.1.0/cockroachparty-v0.1.0.tar.gz \
  bash install.sh

SOURCE_URL=https://<gateway>/ipfs/<tarball-cid>/cockroachparty-v0.1.0.tar.gz \
  bash install.sh
```

If one host goes down, operators bringing up new relays use a different URL. Nothing changes about the *protocol* — only where the bytes happen to live today.

### 6. Notify the network

A release isn't a release until the operators of existing relays know about it. Notification channels in priority order:

1. **The flagship signing key.** Cut a `kind:1` event from the release author's pubkey on every relay you have access to, with content like `"v0.1.0 released. CIDs: ..."` and a tag `["t", "release-notice"]`. The notice is itself a signed event that propagates through the network it announces.
2. **The repo `RELEASE.md` at HEAD.** Update the top of this file with the new version's CIDs.
3. **Out-of-band channels.** Telegram, Signal, Matrix room — whatever the operator community is using.

Do NOT rely on a single channel. Operators may have muted your Matrix room, switched Telegram accounts, or stopped reading the GitHub repo months ago. The network has to learn about its own updates through itself.

---

## Coordinated launches

The first release of a new protocol is special. You want as many independent operators as possible bringing up their relays in roughly the same week, so the network has multiple nodes from the moment it exists publicly.

Recommended sequence:

1. **Pre-coordinate quietly.** Reach out to 5–10 trusted people. Show them this repo. Ask if they'll run a relay. Don't broadcast publicly yet.
2. **Set a launch window** (a week, not an hour — operators have day jobs).
3. **Each operator brings up a relay**, picks their own URL, chooses their own jurisdiction, decides their own content policy, and pins it at `/policy` on their relay's host.
4. **Each operator emails / DMs / signals you their relay URL.** You collect them.
5. **You ship `client/relays.json` with the collected URLs.** Each operator who is *also* hosting a client mirror can choose to ship the same seed list, a subset, or a different one entirely. Independence is the feature.
6. **Public announcement.** Pinned link, hero video, the works. By the time the public lands, the network already exists.

The launch is the moment the public is told. The network itself was already running by then.

---

## Operator coordination after launch

Independent operators have no central coordinator. That is correct. But independent operators benefit from talking to each other about:

- Spam waves and effective rate-limiting policy
- Legal threats and how to respond (the EFF has good templates for some jurisdictions)
- Software updates to the relay reference code

A reasonable structure: a public Matrix room or mailing list called something like `cockroach-operators`, run by a rotating set of volunteers, with read-only archives. Operators choose whether to be in it. No operator is required to participate. The room is *advisory*, never directive.

---

## What this document is not

- It is not a constitution. Nobody is bound by it. An operator who ignores every step here is still part of the network, as long as their relay implements the spec.
- It is not exhaustive. Different operators will work out different practices. The only thing this document asks is: *make the release retrievable from more places than one*.
- It is not for users. If you are using the network — publishing reports, signing verifications — you do not need to do any of this.

If the maintainers of this repo disappear tomorrow, this document still works. Anyone with a copy of the source can cut their own release of their own fork from whichever Git host they prefer. That is the design.
