const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../public/local-store.js');
const { createWorkbook } = require('../public/excel-export.js');
function memory() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
function workout(type, reps = [5, 5, 5, 5, 5], weight = 45) {
  return { method: 'POST', body: JSON.stringify({ type, date: '2026-10-10', exercises: (type === 'A' ? ['squat', 'bench', 'row'] : ['squat', 'ohp', 'deadlift']).map(lift => ({ lift, weight, reps })) }) };
}
test('completed workouts persist and advance the A/B rotation', async () => {
  const storage = memory(), api = createStore(storage).api;
  assert.equal((await api('/api/state')).nextWorkout.type, 'A');
  await api('/api/workouts', workout('A'));
  const reopened = createStore(storage).api;
  const state = await reopened('/api/state');
  assert.equal(state.nextWorkout.type, 'B');
  assert.equal(state.lifts.squat.weight, 50);
  assert.equal(state.lifts.bench.weight, 50);
  assert.equal(state.lifts.ohp.weight, 45);
  assert.equal((await reopened('/api/workouts')).length, 1);
});
test('three failed sessions deload and reset the miss counter', async () => {
  const api = createStore(memory()).api;
  await api('/api/lifts/squat', { method: 'PUT', body: '{"weight":100}' });
  for (let i = 0; i < 3; i++) await api('/api/workouts', workout('A', [5, 5, 4, 3, 0], 100));
  const state = await api('/api/state');
  assert.equal(state.lifts.squat.weight, 90);
  assert.equal(state.lifts.squat.failCount, 0);
  assert.equal(state.lifts.bench.weight, 45);
});
test('invalid records and failed writes leave committed data intact', async () => {
  const storage = memory(), api = createStore(storage).api;
  await api('/api/workouts', workout('A'));
  const incomplete = workout('B');
  const body = JSON.parse(incomplete.body); body.exercises.pop(); incomplete.body = JSON.stringify(body);
  await assert.rejects(api('/api/workouts', incomplete), /all three lifts/);
  storage.setItem = () => { throw new Error('Storage full'); };
  await assert.rejects(api('/api/workouts', workout('B')), /Storage full/);
  assert.equal((await api('/api/workouts')).length, 1);
  assert.equal((await api('/api/state')).nextWorkout.type, 'B');
});
test('settings and overrides persist; edits reset consecutive misses', async () => {
  const storage = memory(), api = createStore(storage).api;
  await api('/api/workouts', workout('A', [0, 0, 0, 0, 0]));
  await api('/api/settings', { method: 'PUT', body: '{"daysPerWeek":2}' });
  await api('/api/lifts/squat', { method: 'PUT', body: '{"weight":135}' });
  const state = await createStore(storage).api('/api/state');
  assert.equal(state.daysPerWeek, 2); assert.equal(state.lifts.squat.weight, 135); assert.equal(state.lifts.squat.failCount, 0);
  await assert.rejects(api('/api/lifts/squat', { method: 'PUT', body: '{"weight":-5}' }));
});
test('native workout commit clears the saved session in the same transaction', async () => {
  const storage = memory(); let committed = false;
  storage.commitWorkout = (key, value) => { committed = true; storage.setItem(key, value); storage.setItem('st-session', null); };
  storage.setItem('st-session', 'active');
  await createStore(storage).api('/api/workouts', workout('A'));
  assert.equal(committed, true); assert.equal(storage.getItem('st-session'), null);
});
test('Excel output is a ZIP workbook with all sheets, numeric values, and safe text', async () => {
  const api = createStore(memory()).api;
  await api('/api/workouts', workout('A'));
  const state = await api('/api/state'), history = await api('/api/workouts');
  history[0].exercises[0].label = '=SUM(1,2) & <Squat>';
  const bytes = createWorkbook(state, history);
  const text = Buffer.from(bytes).toString('utf8');
  assert.equal(Buffer.from(bytes).readUInt32LE(0), 0x04034b50);
  assert.match(text, /Current weights/); assert.match(text, /Settings/);
  assert.match(text, /=SUM\(1,2\) &amp; &lt;Squat&gt;/);
  assert.match(text, /<c r="E2"><v>45<\/v><\/c>/);
  assert.equal((text.match(/<f>/g) || []).length, 0);
  if (process.env.EXPORT_TEST_PATH) require('node:fs').writeFileSync(process.env.EXPORT_TEST_PATH, bytes);
});
