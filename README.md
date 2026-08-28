# Strength Trainer

A self-hosted A/B 5×5 linear-progression strength tracker. Single user, zero npm
dependencies (Node.js 22+ with built-in SQLite), works on phones, tablets, and
desktops, and installs to an Android home screen as a PWA.

## The program

| | Workout A | Workout B |
|---|---|---|
| 1 | Squat | Squat |
| 2 | Bench Press | Overhead Barbell Press |
| 3 | Bent-Over Barbell Row | Deadlift |

- Workouts alternate A → B → A → …, either 2 or 3 days a week (your choice in Settings).
- Every lift is **5 sets of 5 reps**, starting at the empty 45 lb bar.
- Complete all 25 reps → that lift goes up **5 lb** the next time it appears
  (Squat progresses every workout; the others on their A or B day).
- Miss reps → repeat the same weight next time.
- Miss **3 sessions in a row** at a weight → automatic **10% deload** (rounded to 5 lb).

The History tab shows your current weights, a monthly calendar of completed
workouts, a strength-over-time chart for all five lifts, and your recent
sessions.

## Run locally

```bash
node server.js
```

Then open http://localhost:3000. The database is created at `data/strength.db`.

## Deploy to Proxmox

Run this one-liner on the Proxmox host as root — no checkout needed:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/awarwick-mscst/strength-trainer/main/deploy/deploy.sh)
```

The script:

1. Downloads the Debian 12 LXC template (if needed) and creates an unprivileged
   container (next free CTID, DHCP on `vmbr0`, 512 MB RAM, 4 GB disk). On later
   runs it finds the existing container by its hostname (`strength-trainer`)
   and refuses to touch any unrelated container.
2. Installs Node.js 22 inside it.
3. The container downloads the latest app code from this GitHub repo into
   `/opt/strength-trainer`, and a hardened systemd service runs it as a
   dedicated user on **port 80**.
4. Prints the URL when done.

The SQLite database lives at `/var/lib/strength-trainer/strength.db` inside the
container and survives app updates.

## Updates are automatic

The installer sets up a systemd timer inside the container
(`strength-trainer-update.timer`) that checks this GitHub repo every 30
minutes. When you push a new version, the container downloads it, swaps it into
place, and restarts the service on its own — your workout database is never
touched. Just `git push` and wait up to half an hour.

Useful commands (run on the Proxmox host, replace `<ctid>`):

```bash
pct exec <ctid> -- /usr/local/bin/strength-trainer-update   # update right now
```

```bash
pct exec <ctid> -- journalctl -u strength-trainer-update -n 20   # updater log
```

Re-running the install one-liner also works — it finds the existing container
by hostname, refreshes the service configuration, and deploys the latest code.

Defaults can be overridden with environment variables:

```bash
CTID=210 STORAGE=local-zfs BRIDGE=vmbr1 NET_IP=192.168.1.50/24,gw=192.168.1.1 ./deploy/deploy.sh
```

(`CTID`, `HOSTNAME_CT`, `STORAGE`, `TEMPLATE_STORAGE`, `DISK_GB`, `MEMORY_MB`,
`CORES`, `BRIDGE`, `NET_IP`)

## Use it on your phone

Open `http://<container-ip>/` in Chrome on Android and choose
**Add to Home screen** (or the "Install app" prompt). It opens full-screen like
a native app.

## Backup

Everything is one file. From the Proxmox host:

```bash
pct exec 200 -- sqlite3 /var/lib/strength-trainer/strength.db ".backup /tmp/backup.db" 2>/dev/null || pct exec 200 -- cp /var/lib/strength-trainer/strength.db /tmp/backup.db
pct pull 200 /tmp/backup.db ./strength-backup.db
```

Or simply back up the whole container with Proxmox's built-in vzdump/PBS.

## API (for the curious)

- `GET /api/state` — current weights, settings, and the next planned workout
- `POST /api/workouts` — log a finished workout (applies progression)
- `GET /api/workouts` — history
- `PUT /api/settings` — `{ "daysPerWeek": 2 | 3 }`
- `PUT /api/lifts/:name` — manually override a lift's next weight
