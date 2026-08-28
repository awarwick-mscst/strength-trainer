'use strict';
// Strength Trainer — zero-dependency Node.js server (requires Node 22+ for node:sqlite)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'strength.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

const START_WEIGHT = 45;
const INCREMENT = 5;
const FAILS_BEFORE_DELOAD = 3;
const SETS = 5;
const REPS = 5;

const LIFTS = {
  squat: 'Squat',
  bench: 'Bench Press',
  row: 'Bent-Over Barbell Row',
  ohp: 'Overhead Barbell Press',
  deadlift: 'Deadlift',
};
const WORKOUTS = {
  A: ['squat', 'bench', 'row'],
  B: ['squat', 'ohp', 'deadlift'],
};

// ---------- database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lifts (
    name       TEXT PRIMARY KEY,
    weight     REAL NOT NULL,
    fail_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS workouts (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('A','B'))
  );
  CREATE TABLE IF NOT EXISTS workout_sets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    lift       TEXT NOT NULL,
    weight     REAL NOT NULL,
    set_number INTEGER NOT NULL,
    reps       INTEGER NOT NULL
  );
`);
const seedLift = db.prepare('INSERT OR IGNORE INTO lifts (name, weight) VALUES (?, ?)');
for (const name of Object.keys(LIFTS)) seedLift.run(name, START_WEIGHT);
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('daysPerWeek', '3');

// ---------- helpers ----------
const roundTo5 = (w) => Math.round(w / 5) * 5;

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getLifts() {
  const out = {};
  for (const row of db.prepare('SELECT name, weight, fail_count FROM lifts').all()) {
    out[row.name] = { label: LIFTS[row.name], weight: row.weight, failCount: row.fail_count };
  }
  return out;
}

function nextWorkoutType() {
  const last = db.prepare('SELECT type FROM workouts ORDER BY id DESC LIMIT 1').get();
  if (!last) return 'A';
  return last.type === 'A' ? 'B' : 'A';
}

function buildState() {
  const lifts = getLifts();
  const type = nextWorkoutType();
  return {
    daysPerWeek: Number(getSetting('daysPerWeek')),
    lifts,
    nextWorkout: {
      type,
      sets: SETS,
      reps: REPS,
      exercises: WORKOUTS[type].map((name) => ({
        lift: name,
        label: LIFTS[name],
        weight: lifts[name].weight,
      })),
    },
  };
}

function recordWorkout(body) {
  const { type, date, exercises } = body;
  if (!WORKOUTS[type]) throw httpError(400, 'type must be "A" or "B"');
  if (!Array.isArray(exercises) || exercises.length === 0) throw httpError(400, 'exercises required');
  const expected = WORKOUTS[type];
  for (const ex of exercises) {
    if (!expected.includes(ex.lift)) throw httpError(400, `lift "${ex.lift}" is not part of workout ${type}`);
    if (!Array.isArray(ex.reps) || ex.reps.length !== SETS) throw httpError(400, `${ex.lift}: reps must be an array of ${SETS} numbers`);
    if (!ex.reps.every((r) => Number.isInteger(r) && r >= 0 && r <= 20)) throw httpError(400, `${ex.lift}: each set is 0-20 reps`);
    if (typeof ex.weight !== 'number' || ex.weight < 0) throw httpError(400, `${ex.lift}: weight required`);
  }

  const workoutDate = date || new Date().toISOString().slice(0, 10);
  const insertWorkout = db.prepare('INSERT INTO workouts (date, type) VALUES (?, ?)');
  const insertSet = db.prepare(
    'INSERT INTO workout_sets (workout_id, lift, weight, set_number, reps) VALUES (?, ?, ?, ?, ?)'
  );
  const getLift = db.prepare('SELECT weight, fail_count FROM lifts WHERE name = ?');
  const updateLift = db.prepare('UPDATE lifts SET weight = ?, fail_count = ? WHERE name = ?');

  db.exec('BEGIN');
  try {
    const workoutId = insertWorkout.run(workoutDate, type).lastInsertRowid;
    for (const ex of exercises) {
      ex.reps.forEach((r, i) => insertSet.run(workoutId, ex.lift, ex.weight, i + 1, r));
      // progression: all sets at target reps -> +5 lb; otherwise a fail.
      const lift = getLift.get(ex.lift);
      const success = ex.reps.every((r) => r >= REPS);
      if (success) {
        updateLift.run(lift.weight + INCREMENT, 0, ex.lift);
      } else {
        const fails = lift.fail_count + 1;
        if (fails >= FAILS_BEFORE_DELOAD) {
          updateLift.run(Math.max(START_WEIGHT, roundTo5(lift.weight * 0.9)), 0, ex.lift);
        } else {
          updateLift.run(lift.weight, fails, ex.lift);
        }
      }
    }
    db.exec('COMMIT');
    return workoutId;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getHistory(limit = 50) {
  const workouts = db
    .prepare('SELECT id, date, type FROM workouts ORDER BY id DESC LIMIT ?')
    .all(limit);
  const setsFor = db.prepare(
    'SELECT lift, weight, set_number, reps FROM workout_sets WHERE workout_id = ? ORDER BY id'
  );
  return workouts.map((w) => {
    const byLift = {};
    for (const s of setsFor.all(w.id)) {
      if (!byLift[s.lift]) byLift[s.lift] = { lift: s.lift, label: LIFTS[s.lift], weight: s.weight, reps: [] };
      byLift[s.lift].reps.push(s.reps);
    }
    return { id: w.id, date: w.date, type: w.type, exercises: Object.values(byLift) };
  });
}

// ---------- http ----------
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(httpError(413, 'body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(httpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJSON(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJSON(res, 200, buildState());
    }
    if (pathname === '/api/workouts' && req.method === 'GET') {
      return sendJSON(res, 200, getHistory());
    }
    if (pathname === '/api/workouts' && req.method === 'POST') {
      const body = await readBody(req);
      const id = recordWorkout(body);
      return sendJSON(res, 201, { id, state: buildState() });
    }
    if (pathname === '/api/settings' && req.method === 'PUT') {
      const body = await readBody(req);
      if (![2, 3].includes(body.daysPerWeek)) throw httpError(400, 'daysPerWeek must be 2 or 3');
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'daysPerWeek',
        String(body.daysPerWeek)
      );
      return sendJSON(res, 200, buildState());
    }
    if (pathname.startsWith('/api/lifts/') && req.method === 'PUT') {
      const name = pathname.split('/')[3];
      if (!LIFTS[name]) throw httpError(404, 'unknown lift');
      const body = await readBody(req);
      const w = Number(body.weight);
      if (!Number.isFinite(w) || w < 0 || w > 2000) throw httpError(400, 'weight must be 0-2000');
      db.prepare('UPDATE lifts SET weight = ?, fail_count = 0 WHERE name = ?').run(w, name);
      return sendJSON(res, 200, buildState());
    }
    if (pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'not found' });
    return serveStatic(req, res, pathname);
  } catch (err) {
    return sendJSON(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Strength Trainer listening on http://0.0.0.0:${PORT} (db: ${DB_PATH})`);
});
