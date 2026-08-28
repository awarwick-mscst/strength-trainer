'use strict';

const view = document.getElementById('view');
const badge = document.getElementById('next-type-badge');
let state = null; // server state
let session = null; // in-progress workout { type, exercises: [{lift,label,weight,reps:[null|0-5,...]}] }
let tab = 'today';

const SESSION_KEY = 'st-session';

// ---------- api ----------
async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const loadState = async () => { state = await api('/api/state'); };

// ---------- session persistence ----------
function saveSession() {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}
function restoreSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) session = JSON.parse(raw);
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
  const plan = state.nextWorkout;
  session = {
    type: plan.type,
    exercises: plan.exercises.map((e) => ({ ...e, reps: Array(plan.sets).fill(null) })),
  };
  saveSession();
  render();
}

function cycleSet(exIdx, setIdx) {
  const reps = session.exercises[exIdx].reps;
  const cur = reps[setIdx];
  // empty -> 5 -> 4 -> ... -> 0 -> empty
  if (cur === null) reps[setIdx] = 5;
  else if (cur === 0) reps[setIdx] = null;
  else reps[setIdx] = cur - 1;
  saveSession();
  render();
}

async function finishWorkout() {
  const payload = {
    type: session.type,
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
    saveSession();
    render();
    toast(allDone ? 'Workout complete — weights go up!' : 'Logged. Missed lifts repeat next time.', !allDone);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderToday() {
  view.innerHTML = '';
  if (!session) {
    const plan = state.nextWorkout;
    view.appendChild(el(`
      <div class="card">
        <h2>Workout ${plan.type}</h2>
        <p class="sub">${plan.sets}×${plan.reps} — ${plan.exercises.map((e) => e.label).join(', ')}</p>
      </div>`));
    for (const e of plan.exercises) {
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
      session = null;
      saveSession();
      render();
    }
  };
  view.appendChild(cancel);
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

  if (history.length === 0) {
    view.appendChild(el('<p class="hint">No workouts yet. Your first is Workout A at 45 lb.</p>'));
    return;
  }
  for (const w of history) {
    const rows = w.exercises.map((e) => {
      const ok = e.reps.every((r) => r >= 5);
      return `<div class="row"><span>${e.label} — ${e.weight} lb</span>
        <span class="reps${ok ? ' ok' : ''}">${e.reps.join('/')}</span></div>`;
    }).join('');
    view.appendChild(el(`
      <div class="card history-item">
        <h2>Workout ${w.type} <span class="sub">${w.date}</span></h2>${rows}
      </div>`));
  }
}

// ---------- settings ----------
function renderSettings() {
  view.innerHTML = '';
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
      state = await api('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daysPerWeek: Number(b.dataset.d) }),
      });
      render();
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
    view.innerHTML = '<p class="hint">Cannot reach the server. Is it running?</p>';
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
