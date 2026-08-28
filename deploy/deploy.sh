#!/usr/bin/env bash
# Strength Trainer — Proxmox LXC installer.
#
# Run this ON THE PROXMOX HOST (as root). No checkout needed — it can be
# curl'd straight from GitHub:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/awarwick-mscst/strength-trainer/main/deploy/deploy.sh)
#
# First run: creates a Debian 12 LXC, installs Node.js 22, then the container
# downloads the app from GitHub and a systemd service starts it on port 80.
# Later runs with the same CTID: the container re-downloads the latest code
# from GitHub and restarts (the SQLite database in /var/lib/strength-trainer
# is untouched).
#
# Override any of these via environment variables, e.g.:
#   CTID=210 STORAGE=local-zfs ./deploy.sh
set -euo pipefail

REPO="${REPO:-awarwick-mscst/strength-trainer}"
BRANCH="${BRANCH:-main}"

CTID="${CTID:-200}"
HOSTNAME="${HOSTNAME_CT:-strength-trainer}"
STORAGE="${STORAGE:-local-lvm}"          # rootfs storage
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
DISK_GB="${DISK_GB:-4}"
MEMORY_MB="${MEMORY_MB:-512}"
CORES="${CORES:-1}"
BRIDGE="${BRIDGE:-vmbr0}"
NET_IP="${NET_IP:-dhcp}"                 # or e.g. 192.168.1.50/24,gw=192.168.1.1

TARBALL_URL="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"
APP_DIR=/opt/strength-trainer
DATA_DIR=/var/lib/strength-trainer

say() { echo -e "\e[1;32m==>\e[0m $*"; }

if ! command -v pct >/dev/null; then
  echo "ERROR: 'pct' not found. Run this script on the Proxmox host." >&2
  exit 1
fi

# ---------------------------------------------------------------- create CT
if pct status "$CTID" >/dev/null 2>&1; then
  say "Container $CTID already exists — updating app only."
else
  say "Finding Debian 12 template..."
  pveam update >/dev/null
  TEMPLATE_NAME="$(pveam available --section system | awk '{print $2}' | grep '^debian-12-standard' | sort -V | tail -1)"
  if [ -z "$TEMPLATE_NAME" ]; then
    echo "ERROR: no debian-12-standard template available via pveam." >&2
    exit 1
  fi
  if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE_NAME"; then
    say "Downloading template $TEMPLATE_NAME..."
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_NAME"
  fi

  say "Creating LXC $CTID ($HOSTNAME)..."
  pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE_NAME" \
    --hostname "$HOSTNAME" \
    --memory "$MEMORY_MB" \
    --cores "$CORES" \
    --rootfs "$STORAGE:$DISK_GB" \
    --net0 "name=eth0,bridge=$BRIDGE,ip=$NET_IP" \
    --unprivileged 1 \
    --features nesting=1 \
    --onboot 1

  pct start "$CTID"

  say "Waiting for network..."
  for i in $(seq 1 30); do
    if pct exec "$CTID" -- ping -c1 -W2 github.com >/dev/null 2>&1; then break; fi
    sleep 2
    [ "$i" = 30 ] && { echo "ERROR: container has no network." >&2; exit 1; }
  done

  say "Installing Node.js 22..."
  pct exec "$CTID" -- bash -c '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
    node --version
  '

  say "Creating service user and directories..."
  pct exec "$CTID" -- bash -c "
    set -e
    id -u strength >/dev/null 2>&1 || useradd --system --home $DATA_DIR --shell /usr/sbin/nologin strength
    mkdir -p $DATA_DIR
    chown strength:strength $DATA_DIR
  "

  say "Installing systemd service..."
  pct exec "$CTID" -- bash -c "cat > /etc/systemd/system/strength-trainer.service" <<UNIT
[Unit]
Description=Strength Trainer
After=network.target

[Service]
Type=simple
User=strength
Group=strength
Environment=PORT=80
Environment=DB_PATH=$DATA_DIR/strength.db
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT
  pct exec "$CTID" -- systemctl daemon-reload
  pct exec "$CTID" -- systemctl enable strength-trainer >/dev/null 2>&1
fi

# ------------------------------------------- pull app from GitHub into CT
say "Downloading app from github.com/$REPO ($BRANCH) inside the container..."
pct exec "$CTID" -- bash -c "
  set -e
  curl -fsSL '$TARBALL_URL' -o /tmp/strength-trainer.tar.gz
  rm -rf $APP_DIR.new
  mkdir $APP_DIR.new
  tar -xzf /tmp/strength-trainer.tar.gz -C $APP_DIR.new --strip-components=1
  rm -rf $APP_DIR.old
  [ -d $APP_DIR ] && mv $APP_DIR $APP_DIR.old
  mv $APP_DIR.new $APP_DIR
  rm -rf $APP_DIR.old /tmp/strength-trainer.tar.gz
"

say "Starting service..."
pct exec "$CTID" -- systemctl restart strength-trainer
sleep 2
pct exec "$CTID" -- systemctl --no-pager --lines=5 status strength-trainer || true

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
say "Done. Strength Trainer is running at: http://$IP/"
echo "    On your Android phone, open that URL in Chrome and choose 'Install app'."
