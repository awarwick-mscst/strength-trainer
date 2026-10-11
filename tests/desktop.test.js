const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileStore } = require('../desktop/store.cjs');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strength-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('desktop storage persists settings and atomically completes an active workout', t => {
  const dir = directory(t), store = new FileStore(dir);
  store.setItem('st-session', '{"timer":{"runningSince":123}}');
  store.setItem('strength-trainer-data-v1', '{"workouts":[]}');
  assert.equal(new FileStore(dir).getItem('st-session'), '{"timer":{"runningSince":123}}');
  store.commitWorkout('strength-trainer-data-v1', '{"workouts":[{"type":"A"}]}');
  const reopened = new FileStore(dir);
  assert.equal(reopened.getItem('st-session'), null);
  assert.equal(reopened.getItem('strength-trainer-data-v1'), '{"workouts":[{"type":"A"}]}');
});

test('failed desktop file replacement preserves the previous workout and session', t => {
  const dir = directory(t), store = new FileStore(dir);
  store.setItem('st-session', 'active');
  store.setItem('strength-trainer-data-v1', 'original');
  const failing = new FileStore(dir, { ...fs, renameSync() { throw new Error('disk failure'); } });
  assert.throws(() => failing.commitWorkout('strength-trainer-data-v1', 'replacement'), /disk failure/);
  assert.equal(failing.getItem('strength-trainer-data-v1'), 'original');
  assert.equal(new FileStore(dir).getItem('st-session'), 'active');
  assert.equal(fs.existsSync(path.join(dir, 'workouts.json.tmp')), false);
});

test('corrupt desktop data is reported without overwriting the existing file', t => {
  const dir = directory(t), file = path.join(dir, 'workouts.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new FileStore(dir));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.writeFileSync(file, '{"unexpected":"value"}');
  assert.throws(() => new FileStore(dir), /invalid/);
});

test('desktop storage accepts only the two application keys', t => {
  const store = new FileStore(directory(t));
  assert.throws(() => store.setItem('../other', 'value'), /Unknown/);
  assert.throws(() => store.setItem('st-session', {}), /Invalid/);
  assert.throws(() => store.commitWorkout('st-session', 'value'), /Invalid/);
});
