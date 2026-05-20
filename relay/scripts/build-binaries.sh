#!/usr/bin/env bash
# Build standalone executables for all 5 supported platforms locally.
# Output: dist/cockroach-relay-<platform>
#
# CI does the same thing in .github/workflows/release.yml on tag push.  This
# script is here so anyone can produce identical binaries from source
# without trusting the release artifacts.
#
# Usage:  ./relay/scripts/build-binaries.sh
# Requires: bun >= 1.1

set -euo pipefail
cd "$(dirname "$0")/.."  # → relay/

mkdir -p ../dist

TARGETS=(
  "bun-linux-x64        cockroach-relay-linux-x64"
  "bun-linux-arm64      cockroach-relay-linux-arm64"
  "bun-darwin-x64       cockroach-relay-darwin-x64"
  "bun-darwin-arm64     cockroach-relay-darwin-arm64"
  "bun-windows-x64      cockroach-relay-windows-x64.exe"
)

for row in "${TARGETS[@]}"; do
  read -r target artifact <<<"$row"
  out="../dist/$artifact"
  echo ""
  echo "→ $target  →  $out"
  bun build --compile --minify --sourcemap=none \
    --target="$target" server.ts --outfile "$out"
  shasum -a 256 "$out" | tee "$out.sha256"
done

echo ""
echo "Done. Binaries in dist/:"
ls -lh ../dist/cockroach-relay-* | awk '{print "  "$5"\t"$NF}'
echo ""
echo "Verify any binary later with:  shasum -c <binary>.sha256"
