#!/usr/bin/env bash
# Cockroach Relay — bare-VPS installer.
# Usage: curl -fsSL https://<your-mirror>/install.sh | bash
# or:    bash install.sh
#
# Installs Bun, clones a tarball, installs deps, and writes a systemd unit
# that keeps the relay alive. Tested on Debian 12, Ubuntu 22.04+, and Fedora 39.

set -euo pipefail

PORT="${PORT:-7447}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cockroach-relay}"
DATA_DIR="${DATA_DIR:-/var/lib/cockroach-relay}"
USER_NAME="${USER_NAME:-cockroach}"
SOURCE_URL="${SOURCE_URL:-}"  # tarball or git URL; set to your fork or release URL

say() { printf "\033[1;32m==>\033[0m %s\n" "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1"; exit 1; }; }

if [ "$(id -u)" -ne 0 ]; then
  echo "this installer needs root (use sudo)"; exit 1
fi

if [ -z "$SOURCE_URL" ]; then
  cat <<'EOM'
SOURCE_URL is not set. Set it to where this relay's source lives, e.g.

  SOURCE_URL=https://github.com/your-handle/cockroachparty/archive/refs/tags/v0.1.tar.gz \
    bash install.sh

or for IPFS:

  SOURCE_URL=https://ipfs.io/ipfs/<your-cid>/cockroachparty-v0.1.tar.gz \
    bash install.sh
EOM
  exit 1
fi

say "creating user $USER_NAME"
id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$USER_NAME"

say "creating dirs"
mkdir -p "$INSTALL_DIR" "$DATA_DIR"
chown -R "$USER_NAME:$USER_NAME" "$INSTALL_DIR" "$DATA_DIR"

say "installing bun (per-user)"
if ! sudo -u "$USER_NAME" bash -lc 'command -v bun >/dev/null 2>&1'; then
  sudo -u "$USER_NAME" bash -lc 'curl -fsSL https://bun.sh/install | bash'
fi

say "fetching source from $SOURCE_URL"
TMP_TAR=$(mktemp --suffix=.tar.gz)
curl -fsSL "$SOURCE_URL" -o "$TMP_TAR"
say "extracting"
tar -xzf "$TMP_TAR" --strip-components=1 -C "$INSTALL_DIR" "*/relay" 2>/dev/null || \
  tar -xzf "$TMP_TAR" --strip-components=2 -C "$INSTALL_DIR"
rm -f "$TMP_TAR"
chown -R "$USER_NAME:$USER_NAME" "$INSTALL_DIR"

say "installing deps"
sudo -u "$USER_NAME" bash -lc "cd $INSTALL_DIR && \$HOME/.bun/bin/bun install --production"

say "writing systemd unit"
cat >/etc/systemd/system/cockroach-relay.service <<EOF
[Unit]
Description=Cockroach Relay
After=network.target

[Service]
Type=simple
User=$USER_NAME
Environment=PORT=$PORT
Environment=DB=$DATA_DIR/relay.db
Environment=RETENTION_DAYS=90
WorkingDirectory=$INSTALL_DIR
ExecStart=/home/$USER_NAME/.bun/bin/bun run server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

say "starting service"
systemctl daemon-reload
systemctl enable --now cockroach-relay.service
sleep 1
systemctl --no-pager status cockroach-relay.service | head -8

cat <<EOF

cockroach-relay is up on port $PORT.

Next steps:
  - Put a TLS reverse proxy in front (Caddy, nginx, traefik) so clients can
    connect over wss://.  Example for Caddy:

      relay.example.org {
        reverse_proxy localhost:$PORT
      }

  - Optionally run a Tor hidden service in addition (see relay/RUN.md).

  - Tell the network. Add your relay URL to the seed lists of one or two
    client mirrors. There is no central directory to register with.

logs:    journalctl -u cockroach-relay -f
restart: systemctl restart cockroach-relay
data:    $DATA_DIR
EOF
