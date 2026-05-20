# Running a relay

Anyone can run a Cockroach relay. *Anyone* means anyone — there is no registration, no allow-list, no "official" relay. If you stand one up and a client adds your URL, you are part of the network.

This guide walks the friction ladder, from zero-install to bare-metal. Pick whichever fits your setup. The first option is a literal download-and-double-click; the next two need no terminal and no laptop install (they work from a phone browser).

> **Coming in v0.2** — every PWA install of the reference client will join a WebRTC peer-relay mesh automatically. No setup at all: opening the client makes your device part of the network. The current options below remain valid; the v0.2 mesh complements them, doesn't replace them.

---

## Option 0 — Download the executable (operators, ~1 minute)

**[Releases page →](https://github.com/hemant1996/thecockroachnetwork/releases/latest)**

> If you just want to **use** the network, open the client at `https://hemant1996.github.io/thecockroachnetwork/client/` on your phone — zero download, zero install. The relay binary is for people running their own node.

Pick the archive for your platform. Archives preserve the executable bit so you don't need `chmod`.

| Platform | Archive |
|---|---|
| Mac (Apple Silicon — M1/M2/M3/M4) | `cockroach-relay-darwin-arm64.tar.gz` |
| Mac (Intel) | `cockroach-relay-darwin-x64.tar.gz` |
| Windows | `cockroach-relay-windows-x64.zip` |
| Linux (x86_64) | `cockroach-relay-linux-x64.tar.gz` |
| Linux (ARM — Raspberry Pi 4/5) | `cockroach-relay-linux-arm64.tar.gz` |

Each binary is ~70 MB and bundles Bun + SQLite + the relay code into a single file. No dependencies. No install.

### Mac and Linux

Double-click the `.tar.gz` to extract (Archive Utility on macOS, `tar -xzf` on Linux), then from a terminal in the same folder:

```sh
./cockroach-relay-darwin-arm64
```

### Windows

Double-click the `.zip` to extract. Double-click the `.exe` inside.

### First-run warnings (unsigned binaries)

These cannot be avoided without code signing ($99/yr Apple, $200–500/yr Microsoft — not in v0.1 budget).

- **macOS Gatekeeper** blocks unsigned binaries the first time. To allow:
  ```sh
  xattr -d com.apple.quarantine cockroach-relay-darwin-arm64
  ```
  Or right-click → **Open** → **Open** in the confirmation dialog.
- **Windows SmartScreen** warns *"Windows protected your PC."* Click **More info** → **Run anyway**.

The truly zero-warning operator path lands in v0.2 as the WebRTC peer-relay mesh: every PWA install of the client becomes a relay automatically, no binary, no install. See [`docs/v0.2-webrtc-peer-relay.md`](../docs/v0.2-webrtc-peer-relay.md).

### Verify and reproduce

Each archive ships with a `.sha256` checksum file:

```sh
shasum -a 256 -c cockroach-relay-darwin-arm64.sha256
```

Don't trust the prebuilt archives? Reproduce them locally with the same source and same Bun version:

```sh
./relay/scripts/build-binaries.sh
```

### Joining the public network

The relay listens on `ws://localhost:7447`. Database lives at `~/.cockroach-relay/relay.db`.

Running on `localhost` reaches only your own machine. To be part of the public network: TLS reverse proxy + open port (see *Option 7*), or Tor hidden service (see *Behind Tor*). Both work with the same downloaded binary — no rebuild needed.

---

## Option 1 — Render.com (~3 minutes, zero install)

[Deploy to Render →](https://render.com/deploy?repo=https://github.com/hemant1996/thecockroachnetwork)

Click the link, sign in with GitHub or email, click "Apply." Render reads [`render.yaml`](../render.yaml), builds the Docker image, and gives you `wss://cockroach-relay-yourname.onrender.com` with TLS already configured.

**Free tier caveats:** the relay spins down after 15 minutes of inactivity and loses any stored events when it restarts. That's fine for testing or a low-traffic relay; for production retention upgrade to a $7/month plan and uncomment the `disk:` block in `render.yaml`.

---

## Option 2 — Replit (~2 minutes, browser-based)

[Run on Replit →](https://replit.com/github/hemant1996/thecockroachnetwork)

Click the link, fork the project, click Run. Replit gives you a public URL while the workspace is open. Pin the project to keep it running.

**Free tier caveats:** Replit free workspaces sleep after a while. Storage is ephemeral on the free tier. Good for testing and small communities; pin the project or pay for always-on if you want durability.

---

## Option 3 — Termux on Android (~5 minutes, runs on your phone)

```sh
pkg install git curl
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/hemant1996/thecockroachnetwork
cd cockroachparty/relay
~/.bun/bin/bun install
~/.bun/bin/bun run server.ts
```

The relay listens on the phone's local network. Useful for testing, for running a relay over Tor on-device (`pkg install tor`), or for very small communities that share a Wi-Fi network or VPN.

---

## Option 4 — Docker on your laptop (~5 minutes)

```sh
git clone https://github.com/hemant1996/thecockroachnetwork
cd cockroachparty/relay
docker compose up -d
# → ws://localhost:7447
```

Persistent storage in `./data`. Stop with `docker compose down`. To expose it publicly over TLS, see *Option 7 — TLS reverse proxy* below.

---

## Option 5 — Fly.io free tier (~10 minutes, needs CLI + credit card on file)

```sh
cd cockroachparty/relay
fly launch --copy-config --name cockroach-relay-yourname
fly volumes create cockroach_data --region bom --size 1
fly deploy
```

Fly gives you `wss://cockroach-relay-yourname.fly.dev` with TLS and a persistent volume. Fly *requires* a credit card on file even for the free tier, so this option has more friction than the first three despite being technically easier to scale.

---

## Option 6 — Bare VPS (~15 minutes, needs SSH skills)

```sh
sudo SOURCE_URL=https://github.com/hemant1996/thecockroachnetwork/archive/refs/tags/v0.1.0.tar.gz \
  bash install.sh
```

The installer writes a systemd unit, creates a non-root user, and starts the relay. Put a TLS reverse proxy in front; see *Option 7*.

---

## Option 7 — TLS reverse proxy (required for production browsers)

Browsers refuse `ws://` from `https://` pages. Production relays need TLS. Pick one:

**Caddy** (one-liner config, auto-renews Let's Encrypt):

```
relay.example.org {
  reverse_proxy localhost:7447
}
```

**nginx** (snippet for the relevant `server { }` block):

```nginx
location / {
    proxy_pass http://127.0.0.1:7447;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

Render, Fly, and Replit all handle TLS for you automatically; this section only applies to Docker-on-VPS and bare-metal setups.

---

## Behind Tor (for hostile environments)

Add a hidden service to `/etc/tor/torrc`:

```
HiddenServiceDir /var/lib/tor/cockroach-relay/
HiddenServicePort 80 127.0.0.1:7447
```

`sudo systemctl restart tor`, then read the `.onion` address from `/var/lib/tor/cockroach-relay/hostname`. Give that URL to anyone who needs to publish from inside a censored network.

Tor and clearnet hosting are not mutually exclusive — the same relay can serve both. Most reporters reach you over `wss://`, dissidents reach you over the onion. Same events, same store.

---

## Operator responsibilities

You decide your relay's policy. The protocol is owned by no one; your relay has a content policy *you* choose. Publish it at `/policy` on your relay's host so users know what they're publishing to.

A starting template is at [`POLICY.example.md`](POLICY.example.md) — copy it, edit it, host it.

A reasonable default:

- **Drop:** illegal content under your jurisdiction's law, doxxing of private individuals, targeted harassment, non-civic spam.
- **Keep:** signed civic reports in any language, including ones critical of governments and powerful people.
- **Never:** modify events. Never alter signatures. Never censor a pubkey based on identity claims you can't verify (you can't).

When in doubt, drop reports but DO NOT modify them. A modified event would fail signature verification and clients would discard it anyway — but the *attempt* to modify is a protocol violation that fragments the network. Drop, don't tamper.

---

## When you're done operating

Shut the relay down. Tell anyone who knows about it that you're stopping. The network does not depend on you continuing.

That is, on purpose, the entire deployment guide.
