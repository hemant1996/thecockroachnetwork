# cockroach client

Reference web client for the [Cockroach Relay Protocol](../SPEC.md). Single-page, mobile-first, ~700 lines of plain JavaScript. No build step.

## Run locally

The client is a static site. Serve it any way:

```sh
# from this directory
bunx serve .        # or:  python3 -m http.server 8080
```

Then open `http://localhost:3000` (or whatever port the static server picked) on your phone or laptop. The client expects a relay at `ws://<hostname>:7447` by default — change it in the "Identity" tab.

## Behavior

- On first load, the client generates a new ed25519 keypair in your browser and stores the secret key in `localStorage`. The key never leaves your device.
- Tap "Report" to compose a signed civic-report event. The client fetches a GPS fix, encodes it as a geohash at the precision you choose, signs the event, and sends it to the relay.
- Tap "Feed" to see incoming reports near you. Tap a verification verb to sign a `kind:2` verification of someone else's report.
- Tap "Identity" to view your public key, export your secret key, switch relays, or generate a new identity.

## Privacy

- The relay you're talking to sees your IP. For sensitive reporting use Tor or a VPN.
- Geohash precision 7 reveals your location to ~150 m. Use 5 or lower for sensitive contexts.
- The client strips no media metadata in v0.1 because it does not yet handle media uploads. Any media URL you reference in `content` must already be sanitized.

## License

CC0.
