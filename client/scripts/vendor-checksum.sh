#!/usr/bin/env bash
# Record SHA-256 of every vendored crypto bundle so future regressions in
# vendored bytes are caught by `bun run build:vendor && git diff vendor/CHECKSUMS`.
set -euo pipefail
cd "$(dirname "$0")/.."
shasum -a 256 vendor/vendor-ed25519.js vendor/vendor-hashes.js > vendor/CHECKSUMS
echo "wrote vendor/CHECKSUMS:"
cat vendor/CHECKSUMS
