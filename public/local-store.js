'use strict';
// Shared by the bundled Android/Windows apps and the browser's ?offline=1 preview.
(function (root) {
  const labels = { squat: 'Squat', bench: 'Bench Press', row: 'Bent-Over Barbell Row', ohp: 'Overhead Barbell Press', deadlift: 'Deadlift' };
  const plans = { A: ['squat', 'bench', 'row'], B: ['squat', 'ohp', 'deadlift'] };
  const key = 'strength-trainer-data-v1';
  function createStore(storage) {
    function read() {
      const raw = storage.getItem(key);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.version !== 1) throw new Error('Unsupported local data version.');
        return data;
      }
      return { version: 1, daysPerWeek: 3, lifts: Object.fromEntries(Object.keys(labels).map(name => [name, { label: labels[name], weight: 45, failCount: 0 }])), workouts: [] };
    }
    function state(data) {
      const type = data.workouts.length && data.workouts[data.workouts.length - 1].type === 'A' ? 'B' : 'A';
      const plan = t => plans[t].map(lift => ({ lift, label: labels[lift], weight: data.lifts[lift].weight }));
      return { daysPerWeek: data.daysPerWeek, lifts: data.lifts, nextWorkout: { type, sets: 5, reps: 5, exercises: plan(type), plans: { A: plan('A'), B: plan('B') } } };
    }
    async function api(path, opts = {}) {
      const data = read();
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (path === '/api/state' && method === 'GET') return state(data);
      if (path === '/api/workouts' && method === 'GET') return data.workouts.slice().reverse();
      let result;
      if (path === '/api/workouts' && method === 'POST') {
        const expected = plans[body.type];
        if (!expected || !Array.isArray(body.exercises) || body.exercises.length !== expected.length || new Set(body.exercises.map(e => e.lift)).size !== expected.length) throw new Error('A workout must contain all three lifts.');
        const parsedDate = new Date(body.date + 'T12:00:00Z');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== body.date) throw new Error('Invalid workout date.');
        for (const e of body.exercises) {
          if (!expected.includes(e.lift) || !Number.isFinite(e.weight) || e.weight < 0 || e.weight > 2000 || !Array.isArray(e.reps) || e.reps.length !== 5 || !e.reps.every(r => Number.isInteger(r) && r >= 0 && r <= 20)) throw new Error('Invalid workout sets or weight.');
        }
        const id = data.workouts.length ? data.workouts[data.workouts.length - 1].id + 1 : 1;
        if (body.durationSeconds != null && (!Number.isSafeInteger(body.durationSeconds) || body.durationSeconds < 0)) throw new Error('Invalid workout duration.');
        if (body.startedAt != null || body.finishedAt != null) {
          if (!Number.isFinite(Date.parse(body.startedAt)) || !Number.isFinite(Date.parse(body.finishedAt)) || Date.parse(body.finishedAt) < Date.parse(body.startedAt)) throw new Error('Invalid workout times.');
        }
        data.workouts.push({ id, type: body.type, date: body.date, startedAt: body.startedAt ?? null, finishedAt: body.finishedAt ?? null, durationSeconds: body.durationSeconds ?? null, exercises: body.exercises.map(e => ({ ...e, label: labels[e.lift] })) });
        for (const e of body.exercises) {
          const lift = data.lifts[e.lift];
          if (e.reps.every(r => r >= 5)) { lift.weight += 5; lift.failCount = 0; }
          else if (++lift.failCount >= 3) { lift.weight = Math.max(45, Math.round(lift.weight * 0.9 / 5) * 5); lift.failCount = 0; }
        }
        result = { id, state: state(data) };
      } else if (/^\/api\/workouts\/\d+\/heart-rate$/.test(path) && method === 'PUT') {
        const workout = data.workouts.find(w => w.id === Number(path.split('/')[3]));
        if (!workout) throw new Error('Workout not found.');
        if (![body.averageBpm, body.minBpm, body.maxBpm].every(v => Number.isFinite(v) && v > 0 && v <= 300) || !Number.isSafeInteger(body.sampleCount) || body.sampleCount <= 0 || body.minBpm > body.averageBpm || body.averageBpm > body.maxBpm || body.source !== 'com.fitbit.FitbitMobile') throw new Error('Invalid heart-rate summary.');
        workout.heartRate = { averageBpm: body.averageBpm, minBpm: body.minBpm, maxBpm: body.maxBpm, sampleCount: body.sampleCount, source: body.source };
        result = workout;
      } else if (path === '/api/settings' && method === 'PUT') {
        if (![2, 3].includes(body.daysPerWeek)) throw new Error('Choose two or three workouts per week.');
        data.daysPerWeek = body.daysPerWeek;
        result = state(data);
      } else if (path.startsWith('/api/lifts/') && method === 'PUT') {
        const name = path.split('/')[3];
        if (!Object.hasOwn(labels, name)) throw new Error('Unknown lift.');
        if (!Number.isFinite(body.weight) || body.weight < 0 || body.weight > 2000) throw new Error('Weight must be between 0 and 2000 lb.');
        data.lifts[name].weight = body.weight;
        data.lifts[name].failCount = 0;
        result = state(data);
      } else throw new Error('Unknown local operation.');
      // A failed write leaves the previous committed data and active session intact.
      if (path === '/api/workouts' && method === 'POST' && storage.commitWorkout) storage.commitWorkout(key, JSON.stringify(data));
      else storage.setItem(key, JSON.stringify(data));
      return result;
    }
    return { api };
  }
  root.StrengthLocal = { createStore };
  if (typeof module !== 'undefined') module.exports = root.StrengthLocal;
})(globalThis);
