# cockroach-relay

Reference relay for the [Cockroach Relay Protocol](../SPEC.md). L1-conformant. ~400 LoC.

## Run

```sh
bun install
bun run server.ts
```

The relay listens on `ws://localhost:7447`. Configure with env vars:

- `PORT` — port to listen on (default 7447)
- `DB` — SQLite file path (default `./relay.db`)
- `RETENTION_DAYS` — days to retain events (default 90)

## Test

```sh
bun test
```

## Run anywhere

The relay is a single Bun process plus a SQLite file. It runs on a $5 VPS, a Raspberry Pi, or a phone under Termux. There is no admin interface and no operator account — by design, the operator's job ends at "keep the process running."

## Behind Tor

Run a hidden service in front of the relay:

```
# /etc/tor/torrc
HiddenServiceDir /var/lib/tor/cockroach-relay/
HiddenServicePort 80 127.0.0.1:7447
```

Then hand out the `.onion` address. The relay code does not need to change.

## Federation

This v0.1 relay does not federate. Clients fan out to multiple relays themselves (in v0.2 of the reference client). Inter-relay event mirroring is a fine thing to build and explicitly NOT a protocol concern — any operator can run a small mirror job that publishes events from relay A to relay B.

## License

CC0. Fork, modify, deploy, charge for it, sell it — no permission needed.
