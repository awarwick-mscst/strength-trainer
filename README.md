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

## Standalone Android app

The `android/` project builds an installable app for Android 6.0 and newer.
The interface is bundled inside the APK; workouts, settings, and unfinished
sessions are stored privately on the device. It requires no Node server,
account, cloud service, or internet connection. The app has no internet
permission, and automatic Android cloud backup is disabled.

In **Settings → Export Excel (.xlsx)**, choose a location such as **Downloads**
in Android's file picker. The workbook contains all completed workouts (one row
per exercise, including all five sets), current weights and miss counts, and
settings. Export works offline and requires no broad storage permission.
An unfinished workout is saved in the app but excluded from the workbook.

Uninstalling the app or clearing app data deletes the local history. Export
regularly. Excel export is for viewing/archiving; importing it back into the
app is not currently supported. Installing an update with the same application
ID and signing key preserves the data. The Android app starts with its own
history; it does not automatically import the existing server database.

To build with JDK 17+ and Android SDK 34 (Android Studio can install them):

```powershell
cd android
# Set ANDROID_HOME to your SDK, or create local.properties with sdk.dir=...
.\gradlew.bat assembleDebug
```

Install `android/app/build/outputs/apk/debug/app-debug.apk` on your phone.
The debug APK is suitable for personal testing. Keep the same signing key for
future updates; use a private release key for long-term distribution. Building
may download Gradle/Android build dependencies; running the app needs none.

For a browser preview of device-local behavior, run the web server and open
`http://localhost:3000/?offline=1`. This preview uses browser storage, separate
from both the server database and the Android app. The existing server-backed
web version also includes Excel export.

Run the local-storage and workbook tests with `npm test`.
The workout stopwatch starts automatically and continues while the app is
closed. Pause/resume is saved on the device. Finished workout durations appear
in History and in Excel exports; older workouts have no recorded duration.

### Fitbit Versa 4 / synced heart rate

The optional connector uses the phone's **Health Connect** store on **Android
14 or newer**. Strength Trainer reads locally and still has no internet
permission. On older Android versions the timer, workouts, and Excel export
work, but this connector is unavailable.

Versa 4 is not listed among Google's supported live Bluetooth heart-rate
broadcasting models. This connector reads **synced readings, not a live feed**.
Fitbit / Google Health's own syncing may require internet, and readings may be
delayed or absent. This is optional; workout tracking remains entirely offline.

1. Enable writing **heart rate** to Health Connect in Fitbit / Google Health.
2. In Strength Trainer Settings, tap **Connect Health Connect** and allow
   heart-rate read access. No write or background health permissions are requested.
3. Use **Refresh synced heart rate** to see the latest reading and its timestamp.
4. After syncing the watch, go to History and tap **Read synced Fitbit heart rate**
   on a completed workout. This saves an average, minimum, maximum, and sample
   count for its start/end interval. The interval includes any paused time.
   These summaries are included in Excel export. Missing readings stay blank.

Only Fitbit / Google Health records (`com.fitbit.FitbitMobile`) are imported.
Other Health Connect sources are excluded. Reading is foreground-only and
subject to Health Connect's permission/history limits. Revoking access prevents
new reads but does not delete summaries already saved or exported.

Reference: [Google's heart-rate broadcasting models](https://support.google.com/googlehealth/answer/14236705)
and [Health Connect sharing](https://support.google.com/googlehealth/answer/14506680).

With a disposable Android emulator running, use
`cd android` then `.\gradlew.bat connectedDebugAndroidTest lintDebug` for the
native storage/restart/export checks. The instrumentation test resets this
app's data on the test device; do not run it against your personal workout phone.

## Run the server-backed web version

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
