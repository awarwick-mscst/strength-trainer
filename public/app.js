'use strict';

const view = document.getElementById('view');
const badge = document.getElementById('next-type-badge');
let state = null;
let session = null; // in-progress workout { type, exercises: [{lift,label,weight,reps:[null|0-5,...]}] }
let tab = 'today';
let todayType = null; // A/B override chosen on the Today screen (null = follow rotation)
let finishing = false;

const SESSION_KEY = 'st-session';
const isAndroid = typeof AndroidStorage !== 'undefined';
const isDesktop = typeof StrengthDesktop !== 'undefined';
const isLocal = isAndroid || isDesktop || new URLSearchParams(location.search).get('offline') === '1';
const storage = isAndroid ? {
  getItem: key => AndroidStorage.getItem(key),
  setItem: (key, value) => { if (!AndroidStorage.setItem(key, value)) throw new Error('Could not save on this device. Free some storage and try again.'); },
  removeItem: key => { if (!AndroidStorage.removeItem(key)) throw new Error('Could not clear the saved session.'); },
  commitWorkout: (key, value) => { if (!AndroidStorage.commitWorkout(key, value)) throw new Error('Could not save the workout. Free some storage and try again.'); },
} : isDesktop ? StrengthDesktop : localStorage;
const localApi = isLocal ? StrengthLocal.createStore(storage).api : null;

// ---------- api ----------
async function api(path, opts) {
  if (localApi) return localApi(path, opts);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const loadState = async () => { state = await api('/api/state'); };

// ---------- optional device-local Fitbit / Health Connect reader ----------
const heartRequests = new Map();
let latestHeartRate = null;
let heartRequestId = 0;
window.onHeartRateResult = (id, result) => {
  const pending = heartRequests.get(id);
  if (!pending) return;
  clearTimeout(pending.timeout);
  heartRequests.delete(id);
  if (result.error) pending.reject(new Error(result.error));
  else pending.resolve(result);
};
window.onHeartRatePermissionChanged = () => { if (state) render(); };
function readHeartRate(start, end) {
  return new Promise((resolve, reject) => {
    const id = String(++heartRequestId);
    const timeout = setTimeout(() => { heartRequests.delete(id); reject(new Error('Heart-rate read timed out. Try again.')); }, 20000);
    heartRequests.set(id, { resolve, reject, timeout });
    try { AndroidStorage.readHeartRate(id, start, end); }
    catch (err) { clearTimeout(timeout); heartRequests.delete(id); reject(err); }
  });
}
function renderHeartRateCard(settings = false) {
  const status = JSON.parse(AndroidStorage.heartRateStatus());
  const card = el(`<div class="card"><h2>Fitbit · synced heart rate</h2><p class="sub heart-status" style="margin-top:6px"></p><p class="sub" style="margin-top:8px">Versa 4 readings arrive after syncing. This is not a live heart-rate monitor.</p></div>`);
  const text = card.querySelector('.heart-status');
  text.textContent = !status.supported ? 'The optional heart-rate connector requires Android 14 or newer. Workout tracking and the timer work without it.' : !status.granted ? 'Connect Health Connect to read Fitbit heart rate stored on this phone.' : latestHeartRate ? `${latestHeartRate.bpm} bpm · recorded ${new Date(latestHeartRate.time).toLocaleString()} · Fitbit / Google Health` : 'Connected. Refresh to read the latest Fitbit reading stored on this phone.';
  if (status.supported) {
    const button = el(`<button class="ghost-btn">${status.granted ? 'Refresh synced heart rate' : 'Connect Health Connect'}</button>`);
    button.onclick = async () => {
      if (!status.granted) { AndroidStorage.connectHeartRate(); return; }
      button.disabled = true;
      try {
        const end = new Date();
        const result = await readHeartRate(new Date(end.getTime() - 86400000).toISOString(), end.toISOString());
        latestHeartRate = result.latest || null;
        text.textContent = latestHeartRate ? `${latestHeartRate.bpm} bpm · recorded ${new Date(latestHeartRate.time).toLocaleString()} · Fitbit / Google Health` : 'No Fitbit heart-rate readings in the last 24 hours. Sync your watch and enable heart-rate sharing to Health Connect.';
      } catch (err) { latestHeartRate = null; text.textContent = err.message; }
      finally { button.disabled = false; }
    };
    card.appendChild(button);
    if (settings) {
      const manage = el('<button class="ghost-btn">Manage Health Connect access</button>');
      manage.onclick = () => AndroidStorage.manageHeartRateAccess();
      card.appendChild(manage);
    }
  }
  if (settings) card.appendChild(el('<p class="sub">In Fitbit / Google Health, enable writing heart rate to Health Connect. Allow Strength Trainer to read heart rate. Reads stay local; Fitbit’s own syncing may need internet. After syncing, use History to attach readings to a finished workout and include them in Excel export.</p>'));
  return card;
}

// ---------- session persistence ----------
function saveSession() {
  if (session) storage.setItem(SESSION_KEY, JSON.stringify(session));
  else storage.removeItem(SESSION_KEY);
}
function restoreSession() {
  try {
    const raw = storage.getItem(SESSION_KEY);
    if (raw) {
      session = JSON.parse(raw);
      if (!session.timer) {
        session.startedAt = new Date().toISOString();
        session.timer = StrengthTimer.create();
        saveSession();
      }
    }
  } catch { session = null; }
}

// ---------- helpers ----------
function plateText(weight) {
  const perSide = (weight - 45) / 2;
  if (perSide <= 0) return 'Empty bar';
  return `Bar + ${perSide} lb per side`;
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function toast(msg, warn = false) {
  const t = el(`<div class="toast${warn ? ' warn' : ''}"></div>`);
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2700);
}

// ---------- today ----------
function startSession() {
  const type = todayType || state.nextWorkout.type;
  session = {
    type,
    startedAt: new Date().toISOString(),
    timer: StrengthTimer.create(),
    exercises: state.nextWorkout.plans[type].map((e) => ({
      ...e,
      reps: Array(state.nextWorkout.sets).fill(null),
    })),
  };
  try { saveSession(); render(); }
  catch (err) { session = null; toast(err.message, true); }
}

function cycleSet(exIdx, setIdx) {
  const reps = session.exercises[exIdx].reps;
  const cur = reps[setIdx];
  // empty -> 5 -> 4 -> ... -> 0 -> empty
  if (cur === null) reps[setIdx] = 5;
  else if (cur === 0) reps[setIdx] = null;
  else reps[setIdx] = cur - 1;
  try { saveSession(); render(); }
  catch (err) { reps[setIdx] = cur; toast(err.message, true); }
}

async function finishWorkout() {
  if (finishing) return;
  finishing = true;
  const now = new Date();
  const payload = {
    type: session.type,
    startedAt: session.startedAt,
    finishedAt: now.toISOString(),
    durationSeconds: Math.floor(StrengthTimer.elapsed(session.timer, now.getTime()) / 1000),
    date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    exercises: session.exercises.map((e) => ({
      lift: e.lift,
      weight: e.weight,
      reps: e.reps.map((r) => r ?? 0),
    })),
  };
  try {
    const { state: newState } = await api('/api/workouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const allDone = payload.exercises.every((e) => e.reps.every((r) => r >= 5));
    state = newState;
    session = null;
    todayType = null;
    saveSession();
    render();
    toast(allDone ? 'Workout complete — weights go up!' : 'Logged. Missed lifts repeat next time.', !allDone);
  } catch (err) {
    toast(err.message, true);
  } finally { finishing = false; }
}

function renderToday() {
  view.innerHTML = '';
  if (!session) {
    const suggested = state.nextWorkout.type;
    const selected = todayType || suggested;
    const exercises = state.nextWorkout.plans[selected];
    const head = el(`
      <div class="card">
        <div class="type-head">
          <h2>Workout ${selected}</h2>
          <div class="seg">
            <button data-t="A">A</button>
            <button data-t="B">B</button>
          </div>
        </div>
        <p class="sub">${state.nextWorkout.sets}×${state.nextWorkout.reps} — ${exercises.map((e) => e.label).join(', ')}</p>
        ${selected !== suggested ? `<p class="fail-note">Heads up: Workout ${suggested} is next in your rotation.</p>` : ''}
      </div>`);
    head.querySelectorAll('.seg button').forEach((b) => {
      if (b.dataset.t === selected) b.classList.add('active');
      b.onclick = () => { todayType = b.dataset.t; render(); };
    });
    view.appendChild(head);
    for (const e of exercises) {
      const failNote = state.lifts[e.lift].failCount > 0
        ? `<p class="fail-note">Missed ${state.lifts[e.lift].failCount}× at this weight — deload after 3</p>` : '';
      view.appendChild(el(`
        <div class="card">
          <div class="exercise-head">
            <div><h2>${e.label}</h2><p class="plates">${plateText(e.weight)}</p></div>
            <div class="weight">${e.weight} lb</div>
          </div>${failNote}
        </div>`));
    }
    const btn = el('<button class="primary-btn">Start Workout</button>');
    btn.onclick = startSession;
    view.appendChild(btn);
    return;
  }

  view.appendChild(el(`
    <div class="card">
      <h2>Workout ${session.type} — in progress</h2>
      <p class="sub">Tap a circle after each set: first tap = 5 reps, tap again to lower.</p>
    </div>`));
  const timerCard = el(`<div class="card timer-card"><div><p class="sub">Workout time${session.timer.runningSince === null ? ' · paused' : ''}</p><div id="workout-time" class="timer-value"></div></div><button class="timer-button">${session.timer.runningSince === null ? 'Resume' : 'Pause'}</button></div>`);
  timerCard.querySelector('button').onclick = () => {
    const previous = session.timer;
    session.timer = StrengthTimer.toggle(previous);
    try { saveSession(); render(); }
    catch (err) { session.timer = previous; toast(err.message, true); }
  };
  view.appendChild(timerCard);
  updateTimer();
  if (isAndroid) view.appendChild(renderHeartRateCard());
  session.exercises.forEach((e, exIdx) => {
    const card = el(`
      <div class="card">
        <div class="exercise-head">
          <div><h2>${e.label}</h2><p class="plates">${plateText(e.weight)}</p></div>
          <div class="weight">${e.weight} lb</div>
        </div>
        <div class="sets"></div>
      </div>`);
    const sets = card.querySelector('.sets');
    e.reps.forEach((r, setIdx) => {
      const b = el('<button class="set-btn"></button>');
      if (r === null) b.textContent = '';
      else {
        b.textContent = r;
        b.classList.add(r >= 5 ? 'done' : 'partial');
      }
      b.onclick = () => cycleSet(exIdx, setIdx);
      sets.appendChild(b);
    });
    view.appendChild(card);
  });

  const started = session.exercises.some((e) => e.reps.some((r) => r !== null));
  const finish = el('<button class="primary-btn">Finish Workout</button>');
  finish.disabled = !started;
  finish.onclick = finishWorkout;
  view.appendChild(finish);

  const cancel = el('<button class="ghost-btn">Discard workout</button>');
  cancel.onclick = () => {
    if (confirm('Discard this workout? Nothing will be saved.')) {
      const previous = session;
      session = null;
      try { saveSession(); render(); }
      catch (err) { session = previous; toast(err.message, true); }
    }
  };
  view.appendChild(cancel);
}

// ---------- history: calendar ----------
let calCursor = null; // { y, m } month being shown

function renderCalendar(history) {
  const today = new Date();
  if (!calCursor) calCursor = { y: today.getFullYear(), m: today.getMonth() };
  const { y, m } = calCursor;

  const byDate = {};
  for (const w of history) {
    if (!byDate[w.date]) byDate[w.date] = [];
    byDate[w.date].push(w.type);
  }

  const monthName = new Date(y, m, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const card = el(`
    <div class="card">
      <div class="cal-head">
        <button class="cal-nav" data-dir="-1" aria-label="Previous month">‹</button>
        <h2>${monthName}</h2>
        <button class="cal-nav" data-dir="1" aria-label="Next month">›</button>
      </div>
      <div class="cal-grid cal-days">
        ${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
      </div>
      <div class="cal-grid cal-cells"></div>
    </div>`);

  const cells = card.querySelector('.cal-cells');
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  for (let i = 0; i < firstDow; i++) cells.appendChild(el('<div class="cal-cell empty"></div>'));
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const types = byDate[dateStr];
    const cell = el(`<div class="cal-cell${dateStr === todayStr ? ' today' : ''}"><span class="cal-num">${d}</span></div>`);
    if (types) cell.appendChild(el(`<span class="cal-badge type-${types[0]}">${[...new Set(types)].join('')}</span>`));
    cells.appendChild(cell);
  }

  card.querySelectorAll('.cal-nav').forEach((b) => {
    b.onclick = () => {
      const next = new Date(y, m + Number(b.dataset.dir), 1);
      calCursor = { y: next.getFullYear(), m: next.getMonth() };
      render();
    };
  });
  return card;
}

// ---------- history: progress chart ----------
const LIFT_COLORS = {
  squat: '#4da3ff',
  bench: '#3ecf6e',
  row: '#ffb454',
  ohp: '#ff6b6b',
  deadlift: '#b085ff',
};

function renderChart(history) {
  // chronological series of the weight lifted per workout, per lift
  const series = {};
  for (const w of [...history].reverse()) {
    for (const e of w.exercises) {
      if (!series[e.lift]) series[e.lift] = [];
      series[e.lift].push({ t: new Date(w.date + 'T12:00:00').getTime(), wt: e.weight });
    }
  }
  const points = Object.values(series).flat();
  const card = el('<div class="card"><h2>Strength over time</h2></div>');
  if (points.length === 0) {
    card.appendChild(el('<p class="sub" style="margin-top:6px">Complete a few workouts to see your progress here.</p>'));
    return card;
  }

  const W = 360, H = 200, L = 34, R = 8, T = 12, B = 24;
  let t0 = Math.min(...points.map((p) => p.t));
  let t1 = Math.max(...points.map((p) => p.t));
  if (t0 === t1) { t0 -= 43200000; t1 += 43200000; }
  const w0 = Math.min(45, ...points.map((p) => p.wt));
  const w1 = Math.max(...points.map((p) => p.wt)) + 5;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const yy = (wt) => T + (1 - (wt - w0) / (w1 - w0)) * (H - T - B);

  let step = 5;
  for (const s of [5, 10, 25, 50, 100]) { step = s; if ((w1 - w0) / s <= 6) break; }
  let grid = '';
  for (let g = Math.ceil(w0 / step) * step; g <= w1; g += step) {
    grid += `<line x1="${L}" y1="${yy(g)}" x2="${W - R}" y2="${yy(g)}" class="chart-grid"/>` +
      `<text x="${L - 5}" y="${yy(g) + 3}" class="chart-label" text-anchor="end">${g}</text>`;
  }
  const fmt = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
  let xlab = '';
  for (let i = 0; i <= 3; i++) {
    const t = t0 + ((t1 - t0) * i) / 3;
    xlab += `<text x="${x(t)}" y="${H - 6}" class="chart-label" text-anchor="middle">${fmt(t)}</text>`;
  }

  let lines = '';
  for (const [lift, pts] of Object.entries(series)) {
    const c = LIFT_COLORS[lift];
    const coords = pts.map((p) => `${x(p.t).toFixed(1)},${yy(p.wt).toFixed(1)}`);
    if (coords.length > 1) lines += `<polyline points="${coords.join(' ')}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round"/>`;
    const last = pts[pts.length - 1];
    lines += `<circle cx="${x(last.t).toFixed(1)}" cy="${yy(last.wt).toFixed(1)}" r="3.5" fill="${c}"/>`;
  }

  card.appendChild(el(
    `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Weight per lift over time">${grid}${xlab}${lines}</svg>`
  ));
  card.appendChild(el(`
    <div class="legend">
      ${Object.entries(series).map(([lift]) =>
        `<span class="legend-item"><span class="legend-dot" style="background:${LIFT_COLORS[lift]}"></span>${state.lifts[lift].label}</span>`
      ).join('')}
    </div>`));
  return card;
}

// ---------- history ----------
async function renderHistory() {
  view.innerHTML = '<p class="hint">Loading…</p>';
  const history = await api('/api/workouts');
  view.innerHTML = '';

  const lifts = Object.entries(state.lifts)
    .map(([, l]) => `<div class="row"><span>${l.label}</span><span class="reps ok">${l.weight} lb</span></div>`)
    .join('');
  view.appendChild(el(`<div class="card history-item"><h2>Current weights</h2>${lifts}</div>`));
  view.appendChild(renderCalendar(history));
  view.appendChild(renderChart(history));

  if (history.length === 0) {
    view.appendChild(el('<p class="hint">No workouts yet. Your first is Workout A at 45 lb.</p>'));
    return;
  }
  view.appendChild(el('<h2 class="section-title">Recent workouts</h2>'));
  for (const w of history.slice(0, 15)) {
    const rows = w.exercises.map((e) => {
      const ok = e.reps.every((r) => r >= 5);
      return `<div class="row"><span>${e.label} — ${e.weight} lb</span>
        <span class="reps${ok ? ' ok' : ''}">${e.reps.join('/')}</span></div>`;
    }).join('');
    const workoutCard = el(`
      <div class="card history-item">
        <h2>Workout ${w.type} <span class="sub">${w.date}</span></h2>
        ${w.durationSeconds != null ? `<p class="sub">Workout time: ${StrengthTimer.format(w.durationSeconds)}</p>` : ''}${rows}
      </div>`);
    if (w.heartRate) {
      const summary = el('<p class="sub heart-summary"></p>');
      summary.textContent = `Synced Fitbit heart rate: ${w.heartRate.averageBpm} bpm average · ${w.heartRate.minBpm}–${w.heartRate.maxBpm} bpm · ${w.heartRate.sampleCount} readings`;
      workoutCard.appendChild(summary);
    }
    if (isAndroid && w.startedAt && w.finishedAt) {
      const button = el('<button class="ghost-btn">Read synced Fitbit heart rate</button>');
      button.onclick = async () => {
        button.disabled = true;
        try {
          const result = await readHeartRate(w.startedAt, w.finishedAt);
          if (!result.summary) throw new Error('No Fitbit readings synced for this workout yet. Sync your watch, then try again.');
          await api(`/api/workouts/${w.id}/heart-rate`, { method: 'PUT', body: JSON.stringify(result.summary) });
          if (tab === 'history') render();
          toast('Workout heart rate saved on this device.');
        } catch (err) { toast(err.message, true); }
        finally { button.disabled = false; }
      };
      workoutCard.appendChild(button);
    }
    view.appendChild(workoutCard);
  }
}

// ---------- settings ----------
function renderSettings() {
  view.innerHTML = '';
  if (isAndroid) view.appendChild(renderHeartRateCard(true));
  const exportCard = el(`<div class="card"><h2>${isLocal ? 'Saved on this device' : 'Export your data'}</h2><p class="sub" style="margin-top:6px">${isDesktop ? 'Workouts and settings stay on this PC. Export regularly to keep a copy. Updates and uninstalling keep your local workout file.' : isLocal ? 'Workouts and settings stay on this device. Export regularly: uninstalling the app or clearing its data removes your history.' : 'Download your complete workout history, current weights, and settings.'}</p><button class="primary-btn" style="margin-top:14px">Export Excel (.xlsx)</button><p class="sub" style="margin-top:8px">Includes all completed workouts. The workout currently in progress is not included.</p></div>`);
  const exportButton = exportCard.querySelector('button');
  exportButton.onclick = async () => {
    exportButton.disabled = true;
    try {
      const history = await api('/api/workouts');
      const bytes = StrengthExcel.createWorkbook(state, history);
      const filename = `strength-trainer-${new Date().toISOString().slice(0, 10)}.xlsx`;
      if (isDesktop) {
        const result = await StrengthDesktop.exportExcel(filename, bytes);
        toast(result.canceled ? 'Export canceled.' : 'Excel file saved.');
      } else if (isAndroid) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        AndroidStorage.exportExcel(filename, btoa(binary));
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        const link = document.createElement('a');
        link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        toast('Excel export downloaded.');
      }
    } catch (err) { toast(err.message, true); }
    finally { exportButton.disabled = false; }
  };
  view.appendChild(exportCard);
  const card = el(`
    <div class="card">
      <div class="settings-row">
        <span>Workouts per week</span>
        <div class="seg">
          <button data-d="2">2</button>
          <button data-d="3">3</button>
        </div>
      </div>
    </div>`);
  card.querySelectorAll('.seg button').forEach((b) => {
    if (Number(b.dataset.d) === state.daysPerWeek) b.classList.add('active');
    b.onclick = async () => {
      try {
        state = await api('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daysPerWeek: Number(b.dataset.d) }),
        });
        render();
      } catch (err) { toast(err.message, true); }
    };
  });
  view.appendChild(card);

  const weights = el('<div class="card"><h2>Adjust weights</h2><p class="sub">Next-session weight per lift. Editing resets the miss counter.</p></div>');
  for (const [name, l] of Object.entries(state.lifts)) {
    const row = el(`
      <div class="settings-row">
        <span>${l.label}</span>
        <input type="number" step="5" min="0" value="${l.weight}">
      </div>`);
    const input = row.querySelector('input');
    input.onchange = async () => {
      try {
        state = await api(`/api/lifts/${name}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weight: Number(input.value) }),
        });
        toast(`${l.label} set to ${Number(input.value)} lb`);
        render();
      } catch (err) {
        toast(err.message, true);
        input.value = l.weight;
      }
    };
    weights.appendChild(row);
  }
  view.appendChild(weights);

  view.appendChild(el(`
    <div class="card">
      <h2>How progression works</h2>
      <p class="sub" style="margin-top:6px">
        Every lift is 5×5 starting at the 45 lb bar. Hit all 25 reps and the lift goes up
        5 lb next time it appears (Squat every workout; the rest on their A or B day).
        Miss reps and you repeat the weight. Miss 3 times in a row and it deloads 10%.
      </p>
    </div>`));
}

// ---------- shell ----------
function updateTimer() {
  const value = document.getElementById('workout-time');
  if (value && session?.timer) value.textContent = StrengthTimer.format(StrengthTimer.elapsed(session.timer) / 1000);
}
setInterval(updateTimer, 1000);
document.addEventListener('visibilitychange', updateTimer);

function render() {
  badge.textContent = session ? `Workout ${session.type}` : `Next: ${state.nextWorkout.type}`;
  document.querySelectorAll('nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  if (tab === 'today') renderToday();
  else if (tab === 'history') renderHistory();
  else renderSettings();
}

document.querySelectorAll('nav button').forEach((b) => {
  b.onclick = () => { tab = b.dataset.tab; render(); };
});

(async function init() {
  restoreSession();
  try {
    await loadState();
    render();
  } catch (err) {
    view.innerHTML = '';
    const message = el('<p class="hint"></p>');
    message.textContent = isLocal ? `Could not load local data: ${err.message}` : 'Cannot reach the server. Is it running?';
    view.appendChild(message);
  }
  if (!isAndroid && !isDesktop && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
