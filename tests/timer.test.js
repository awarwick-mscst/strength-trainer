const { test } = require('node:test');
const assert = require('node:assert/strict');
const timer = require('../public/workout-timer.js');
const { createStore } = require('../public/local-store.js');
const { createWorkbook } = require('../public/excel-export.js');

test('elapsed time catches up after closing the app instead of counting interval ticks', () => {
  const session = { timer: timer.create(1000) };
  const restored = JSON.parse(JSON.stringify(session));
  assert.equal(timer.elapsed(restored.timer, 61000), 60000);
  assert.equal(timer.elapsed(restored.timer, 3601000), 3600000);
  assert.equal(timer.format(3600), '1:00:00');
});
test('pause survives restart and resume excludes the paused period', () => {
  const paused = JSON.parse(JSON.stringify(timer.toggle(timer.create(1000), 31000)));
  assert.equal(timer.elapsed(paused, 300000), 30000);
  const resumed = timer.toggle(paused, 300000);
  assert.equal(timer.elapsed(resumed, 320000), 50000);
  assert.equal(timer.format(50), '0:50');
  assert.equal(timer.elapsed(resumed, 290000), 30000);
});
test('timing and synced heart-rate summaries persist and export as numeric fields', async () => {
  const data = new Map(), storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const api = createStore(storage).api;
  const payload = { type: 'A', date: '2026-10-10', startedAt: '2026-10-10T10:00:00Z', finishedAt: '2026-10-10T10:30:00Z', durationSeconds: 1500,
    exercises: ['squat', 'bench', 'row'].map(lift => ({ lift, weight: 45, reps: [5, 5, 5, 5, 5] })) };
  await api('/api/workouts', { method: 'POST', body: JSON.stringify(payload) });
  const summary = { averageBpm: 110, minBpm: 80, maxBpm: 145, sampleCount: 100, source: 'com.fitbit.FitbitMobile' };
  await api('/api/workouts/1/heart-rate', { method: 'PUT', body: JSON.stringify(summary) });
  const reopened = createStore(storage).api, history = await reopened('/api/workouts');
  assert.equal(history[0].durationSeconds, 1500); assert.deepEqual(history[0].heartRate, summary);
  const bytes = createWorkbook(await reopened('/api/state'), history), text = Buffer.from(bytes).toString('utf8');
  assert.match(text, /<c r="M2"><v>1500<\/v><\/c>/);
  assert.match(text, /<c r="P2"><v>110<\/v><\/c>/);
  assert.match(text, /Fitbit \/ Google Health \(synced\)/);
  if (process.env.EXPORT_TIMED_TEST_PATH) require('node:fs').writeFileSync(process.env.EXPORT_TIMED_TEST_PATH, bytes);
  await assert.rejects(api('/api/workouts/1/heart-rate', { method: 'PUT', body: JSON.stringify({ ...summary, averageBpm: 400 }) }), /Invalid heart-rate/);
  await assert.rejects(api('/api/workouts', { method: 'POST', body: JSON.stringify({ ...payload, durationSeconds: -1 }) }), /Invalid workout duration/);
});
