const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

test('server migrates legacy history and stores timed workouts without losing old data', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strength-server-test-'));
  const dbPath = path.join(directory, 'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE workouts (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, type TEXT NOT NULL); INSERT INTO workouts (date,type) VALUES ('2026-10-09','A');");
  db.close();
  const portProbe = net.createServer();
  portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), DB_PATH: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server did not start')), 10000);
      child.stdout.on('data', text => { if (String(text).includes('listening')) { clearTimeout(timeout); resolve(); } });
      child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    });
    const url = `http://127.0.0.1:${port}`;
    const oldHistory = await (await fetch(url + '/api/workouts')).json();
    assert.equal(oldHistory.length, 1); assert.equal(oldHistory[0].durationSeconds, null);
    const payload = { type: 'B', date: '2026-10-10', startedAt: '2026-10-10T10:00:00Z', finishedAt: '2026-10-10T10:20:00Z', durationSeconds: 1000,
      exercises: ['squat', 'ohp', 'deadlift'].map(lift => ({ lift, weight: 45, reps: [5, 5, 5, 5, 5] })) };
    const response = await fetch(url + '/api/workouts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 201);
    const history = await (await fetch(url + '/api/workouts')).json();
    assert.equal(history.length, 2); assert.equal(history[0].durationSeconds, 1000); assert.equal(history[0].startedAt, payload.startedAt); assert.equal(history[1].date, '2026-10-09');
  } finally {
    const exited = once(child, 'exit'); child.kill(); await exited;
    // Remove only the exact temporary files owned by this test.
    for (const filename of ['test.db', 'test.db-wal', 'test.db-shm']) fs.rmSync(path.join(directory, filename), { force: true });
    fs.rmdirSync(directory);
  }
});
