// Bundle entry for @noble/hashes/sha2 — exposes the sha256 + sha512 hashes
// app.js needs (sha256 for event-id canonicalization, sha512 for the
// ed25519 sync wiring). See vendor-ed25519.js for why this is same-origin.

export { sha256, sha512 } from "@noble/hashes/sha2";
