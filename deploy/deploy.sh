#!/usr/bin/env bash
# Strength Trainer — Proxmox LXC installer.
#
# Run this ON THE PROXMOX HOST (as root). No checkout needed — it can be
# curl'd straight from GitHub:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/awarwick-mscst/strength-trainer/main/deploy/deploy.sh)
#
# First run: creates a Debian 12 LXC (next free CTID unless CTID= is given),
# installs Node.js 22, then the container downloads the app from GitHub and a
# systemd service starts it on port 80.
# Later runs: finds the existing container by its hostname (strength-trainer),
# re-downloads the latest code from GitHub, and restarts (the SQLite database
# in /var/lib/strength-trainer is untouched).
#
# The container also installs a systemd timer that checks GitHub every 30
# minutes and redeploys automatically when you push a new version — so after
# the first install you normally never need to run this script again.
#
# Override any of these via environment variables, e.g.:
#   CTID=210 STORAGE=local-zfs ./deploy.sh
set -euo pipefail

REPO="${REPO:-awarwick-mscst/strength-trainer}"
BRANCH="${BRANCH:-main}"

CTID="${CTID:-}"                         # empty = find by hostname / next free id
HOSTNAME="${HOSTNAME_CT:-strength-trainer}"
STORAGE="${STORAGE:-local-lvm}"          # rootfs storage
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
DISK_GB="${DISK_GB:-4}"
MEMORY_MB="${MEMORY_MB:-512}"
CORES="${CORES:-1}"
BRIDGE="${BRIDGE:-vmbr0}"
NET_IP="${NET_IP:-dhcp}"                 # or e.g. 192.168.1.50/24,gw=192.168.1.1

APP_DIR=/opt/strength-trainer
DATA_DIR=/var/lib/strength-trainer

say() { echo -e "\e[1;32m==>\e[0m $*"; }

if ! command -v pct >/dev/null; then
  echo "ERROR: 'pct' not found. Run this script on the Proxmox host." >&2
  exit 1
fi

# ------------------------------------------------------- find or pick CTID
ct_hostname() { pct config "$1" 2>/dev/null | awk '/^hostname:/{print $2}'; }

find_ct_by_hostname() {
  local id
  for id in $(pct list | awk 'NR>1{print $1}'); do
    if [ "$(ct_hostname "$id")" = "$HOSTNAME" ]; then
      echo "$id"
      return 0
    fi
  done
  return 1
}

if [ -z "$CTID" ]; then
  if CTID="$(find_ct_by_hostname)"; then
    say "Found existing '$HOSTNAME' container: CTID $CTID."
  else
    CTID="$(pvesh get /cluster/nextid)"
    say "No existing '$HOSTNAME' container — will create CTID $CTID."
  fi
elif pct status "$CTID" >/dev/null 2>&1 && [ "$(ct_hostname "$CTID")" != "$HOSTNAME" ]; then
  echo "ERROR: container $CTID exists but its hostname is '$(ct_hostname "$CTID")'," >&2
  echo "       not '$HOSTNAME' — refusing to touch it. Re-run without CTID= to" >&2
  echo "       auto-pick a free id, or pass a different CTID." >&2
  exit 1
fi

# ---------------------------------------------------------------- create CT
if pct status "$CTID" >/dev/null 2>&1; then
  say "Container $CTID already exists — updating app only."
  if ! pct status "$CTID" | grep -q running; then
    say "Container is stopped — starting it..."
    pct start "$CTID"
    for i in $(seq 1 30); do
      if pct exec "$CTID" -- ping -c1 -W2 github.com >/dev/null 2>&1; then break; fi
      sleep 2
      [ "$i" = 30 ] && { echo "ERROR: container has no network." >&2; exit 1; }
    done
  fi
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

fi

# ------------------------------------ configure (idempotent on every run)
say "Configuring service user and directories..."
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

say "Installing auto-updater (checks GitHub every 30 minutes)..."
# Note: \$-escaped variables are resolved when the updater RUNS in the
# container; unescaped ones ($REPO, $BRANCH, ...) are baked in now.
pct exec "$CTID" -- bash -c "cat > /usr/local/bin/strength-trainer-update" <<UPDATER
#!/usr/bin/env bash
# Auto-generated by deploy.sh — checks GitHub and redeploys if there is a
# new commit on $REPO@$BRANCH. The database is never touched.
set -euo pipefail
LATEST="\$(curl -fsSL "https://api.github.com/repos/$REPO/commits/$BRANCH" | grep -m1 '"sha"' | cut -d'"' -f4)"
[ -n "\$LATEST" ] || { echo "could not resolve latest commit; skipping"; exit 0; }
CURRENT="\$(cat $DATA_DIR/deployed-sha 2>/dev/null || echo none)"
if [ "\$LATEST" = "\$CURRENT" ] && [ -d $APP_DIR ]; then
  exit 0
fi
echo "Updating to \$LATEST..."
curl -fsSL "https://github.com/$REPO/archive/\$LATEST.tar.gz" -o /tmp/strength-trainer.tar.gz
rm -rf $APP_DIR.new
mkdir $APP_DIR.new
tar -xzf /tmp/strength-trainer.tar.gz -C $APP_DIR.new --strip-components=1
rm -rf $APP_DIR.old
[ -d $APP_DIR ] && mv $APP_DIR $APP_DIR.old
mv $APP_DIR.new $APP_DIR
rm -rf $APP_DIR.old /tmp/strength-trainer.tar.gz
echo "\$LATEST" > $DATA_DIR/deployed-sha
systemctl restart strength-trainer
echo "Updated and restarted."
UPDATER
pct exec "$CTID" -- chmod +x /usr/local/bin/strength-trainer-update

pct exec "$CTID" -- bash -c "cat > /etc/systemd/system/strength-trainer-update.service" <<UNIT
[Unit]
Description=Strength Trainer auto-update check
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/strength-trainer-update
UNIT

pct exec "$CTID" -- bash -c "cat > /etc/systemd/system/strength-trainer-update.timer" <<UNIT
[Unit]
Description=Check GitHub for Strength Trainer updates every 30 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=30min
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
UNIT

pct exec "$CTID" -- systemctl daemon-reload
pct exec "$CTID" -- systemctl enable strength-trainer >/dev/null 2>&1
pct exec "$CTID" -- systemctl enable --now strength-trainer-update.timer >/dev/null 2>&1

# ------------------------------------------- pull app from GitHub into CT
say "Deploying latest code from github.com/$REPO ($BRANCH)..."
pct exec "$CTID" -- /usr/local/bin/strength-trainer-update

say "Starting service..."
pct exec "$CTID" -- systemctl restart strength-trainer
sleep 2
pct exec "$CTID" -- systemctl --no-pager --lines=5 status strength-trainer || true

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
say "Done. Strength Trainer is running at: http://$IP/"
echo "    On your Android phone, open that URL in Chrome and choose 'Install app'."
