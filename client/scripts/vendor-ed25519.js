// Bundle entry for @noble/ed25519 + the sha512 wiring required by v2.x.
// `bun build` resolves the imports against node_modules and emits a single
// same-origin ES module at client/vendor/vendor-ed25519.js — the only crypto
// surface our client ships.
//
// Why this file exists: loading the signing library from a third-party CDN
// (esm.sh) with no Subresource Integrity gave whoever controlled that CDN
// the ability to swap our ed25519 sign() for one that also exfiltrates the
// secret key. Vendoring same-origin removes that lever entirely.
// See .gstack/security-reports/2026-05-23-cso.json finding #2.

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export * from "@noble/ed25519";
