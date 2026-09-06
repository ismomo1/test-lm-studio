'use strict';

// ============================================================
// SWoW Timer — Fase 1
// Reglas clave (ver docs/plan-fase-1-timer.md §1 y §4):
//  - El tiempo que CUESTA es el GLOBAL por jugador (duración total / jugadores).
//  - El tiempo por turno es INFORMATIVO; el excedente se muestra en rojo,
//    no corta el turno, y consume del tiempo global (que descuenta el tiempo
//    real jugado).
//  - Si el tiempo global de un jugador llega a 0, sus turnos siguientes pasan
//    a MODO LÍMITE: 2 min con corte duro + alarma (sonido + vibración) y
//    finalización automática del turno.
//  - Pausa global: congela todo. Reanudar: continúa donde estaba.
//  - Rotación estricta J1 -> J2 -> ... -> JN -> J1.
//  - Al restaurar una partida en pleno turno, se reabre en PAUSA.
// ============================================================

const STORAGE_KEY = 'swow.game.v1';
const HARD_CAP_MS = 120000; // 2 min en modo límite
const TICK_MS = 250;

const TURNS_PER_PLAYER = { 2: 10, 3: 10, 4: 9, 5: 8 };

// ---------------- Estado ----------------
let game = null;
let timerId = null;
let wakeLock = null;
let audioCtx = null;
let lastAlarmAt = 0;

// ---------------- Utilidades ----------------
const $ = (sel) => document.querySelector(sel);

function fmtTime(ms) {
  const negative = ms < 0;
  let t = Math.abs(Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const core = h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  return negative ? `-${core}` : core;
}

function fmtLong(ms) {
  const negative = ms < 0;
  const t = Math.abs(Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.round((t % 3600) / 60);
  let core;
  if (h > 0) core = `${h} h ${m} min`;
  else if (m >= 1) core = `${m} min`;
  else core = `${t} s`;
  return negative ? `-${core}` : core;
}

function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) {}
}

function beep(freq = 880, durMs = 180, delayMs = 0, gainVal = 0.25) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime + delayMs / 1000;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(gainVal, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + durMs / 1000 + 0.05);
  } catch (_) {}
}

function alarmOver() { beep(660, 220, 0); beep(660, 220, 300); vibrate([200, 120, 200]); }
function alarmHard() {
  beep(880, 200, 0); beep(880, 200, 280); beep(880, 200, 560); beep(1200, 320, 840, 0.3);
  vibrate([300, 150, 300, 150, 500]);
}

let toastTimer = null;
function toast(msg, alarm = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('alarm', alarm);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), alarm ? 4000 : 2600);
}

// ---------------- Persistencia ----------------
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(game));
    return true;
  } catch (err) {
    // localStorage bloqueado (file://, modo privado, cuota...). El estado sigue
    // vivo en memoria; se avisa para que se sirva por http:// en producción.
    console.warn('No se pudo guardar la partida en localStorage:', err);
    toast('⚠ No se pudo guardar la partida — sálvala por http:// para no perderla al recargar');
    return false;
  }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch (_) { return null; }
}

function clearStorage() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
}

// ---------------- Wake Lock ----------------
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (_) {}
}

function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch (_) {}
  wakeLock = null;
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    if (game && (game.state === 'playing' || game.state === 'paused')) {
      await requestWakeLock();
    }
  }
});

// ---------------- Derivados ----------------
function totalTurns() { return game.config.playerCount * game.config.turnsPerPlayer; }

function currentPlayer() { return game.config.players[game.turn.playerIndex]; }

function playerGlobalLeft(p) { return game.config.timePerPlayerMs - p.activeTimeMs; }

function playerInLimit(p) { return p.activeTimeMs >= game.config.timePerPlayerMs; }

function turnElapsedNow() {
  const t = game.turn;
  if (!t.active) return 0;
  const base = t.elapsedAtAnchor || 0;
  return t.running ? base + (Date.now() - t.anchorTime) : base;
}

// ---------------- Crear partida ----------------
function newGame(durationMin, playerCount, names) {
  const turnsPerPlayer = TURNS_PER_PLAYER[playerCount];
  const timePerPlayerMs = Math.round((durationMin * 60000) / playerCount);
  const timePerTurnMs = Math.round(timePerPlayerMs / turnsPerPlayer);
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      name: (names[i] && names[i].trim()) ? names[i].trim() : `Jugador ${i + 1}`,
      activeTimeMs: 0,
      turnsPlayed: 0,
      turnsTotal: turnsPerPlayer
    });
  }
  game = {
    version: 1,
    state: 'playing',
    config: {
      durationMin,
      playerCount,
      turnsPerPlayer,
      timePerPlayerMs,
      timePerTurnMs,
      players
    },
    turn: {
      active: false,
      playerIndex: 0,
      running: false,
      anchorTime: null,
      elapsedAtAnchor: 0,
      hardCapMs: null
    },
    turnsCompleted: 0,
    lastTick: null,
    // Fase 2 — Trackador: acciones registradas por jugador, por turno.
    // actions[playerIndex][turnIndex] = [{ id, text, at }]
    // turnIndex = nº de turno que ESE jugador ha finalizado hasta el momento (0..turnsPerPlayer-1).
    actions: players.map(() => [])
  };
}

// ---------------- Motor de turnos ----------------
function startTurn() {
  if (!game || game.state !== 'playing') return;
  const t = game.turn;
  if (t.active) return;
  const p = currentPlayer();
  console.log('[INICIAR TURNO] antes:', JSON.stringify({ active: t.active, elapsedAtAnchor: t.elapsedAtAnchor }));

  // Modo límite: el jugador ya agotó su tiempo global
  t.hardCapMs = playerInLimit(p) ? HARD_CAP_MS : null;
  t.active = true;
  t.running = true;
  t.elapsedAtAnchor = 0;
  t.anchorTime = Date.now();
  console.log('[INICIAR TURNO] después:', JSON.stringify({ active: t.active, elapsedAtAnchor: t.elapsedAtAnchor, anchorTime: t.anchorTime }));
  game.lastTick = Date.now();
  save();
  requestWakeLock();
  render();
}

function endTurn(auto = false) {
  if (!game || !game.turn.active) return;
  const t = game.turn;
  const now = Date.now();

  // Consolidar tiempo real jugado en el tiempo global del jugador
  if (t.running) {
    const delta = now - t.anchorTime;
    const p = currentPlayer();
    p.activeTimeMs += delta;
  }
  t.elapsedAtAnchor = turnElapsedNow();
  t.active = false;
  t.running = false;
  t.anchorTime = null;
  t.hardCapMs = null;
  game.turnsCompleted++;
  game.lastTick = now;

  // Marcar que el jugador que TERMINA el turno ha jugado 1 turno más.
  // (Convención: turnsPlayed = nº de turnos terminados por ese jugador.
  //  Es coherente con el mapeo de la lista del trackador y con el resumen.)
  currentPlayer().turnsPlayed++;

  if (game.turnsCompleted >= totalTurns()) {
    finishGame();
    return;
  }

  // Avanzar al siguiente jugador (rotación estricta)
  t.playerIndex = (t.playerIndex + 1) % game.config.playerCount;
  const p = currentPlayer();

  save();
  render();
  if (!auto) {
    const limited = playerInLimit(p);
    toast(limited ? `Turno de ${p.name} — MODO LÍMITE (2 min)` : `Turno de ${p.name}`);
  }
}

function pauseGame() {
  if (!game || game.state !== 'playing') return;
  // Capturar el tiempo transcurrido ANTES de modificar running/anchorTime,
  // porque turnElapsedNow() depende de ambos para el cálculo.
  const frozen = (game.turn.active && game.turn.running) ? turnElapsedNow() : (game.turn.elapsedAtAnchor || 0);
  game.state = 'paused';
  if (game.turn.active) {
    game.turn.running = false;
    game.turn.elapsedAtAnchor = frozen;
    game.turn.anchorTime = null;
  }
  game.lastTick = null;
  save();
  releaseWakeLock();
  console.log('[PAUSA]', JSON.stringify({ elapsedAtAnchor: game.turn.elapsedAtAnchor, active: game.turn.active, running: game.turn.running }));
  render();
  toast('Partida en pausa');
}

function resumeGame() {
  if (!game || game.state !== 'paused') return;
  const t = game.turn;
  const now = Date.now();
  // Si el turno estaba en marcha (no pausado), consolidar el tiempo real
  // jugado desde la última anclaje en el tiempo global del jugador.
  if (t.active && t.running && t.anchorTime) {
    const delta = Math.max(0, now - t.anchorTime);
    if (delta > 0) currentPlayer().activeTimeMs += delta;
  }
  // Reanudar: el tiempo acumulado (elapsedAtAnchor) se conserva tal cual.
  game.state = 'playing';
  if (t.active) {
    t.running = true;
    t.anchorTime = now;
  }
  game.lastTick = now;
  save();
  requestWakeLock();
  console.log('[REANUDAR]', JSON.stringify({ elapsedAtAnchor: t.elapsedAtAnchor, active: t.active, running: t.running, anchorTime: t.anchorTime }));
  render();
}

function finishGame() {
  game.state = 'finished';
  if (game.turn.active) {
    game.turn.active = false;
    game.turn.running = false;
  }
  save();
  releaseWakeLock();
  render();
}

function abortGame() {
  if (!game) return;
  clearStorage();
  releaseWakeLock();
  stopTick();
  game = null;
  render();
  toast('Partida abandonada');
}

// ---------------- Tick ----------------
function tick() {
  if (!game || game.state !== 'playing' || !game.turn.active || !game.turn.running) return;

  const now = Date.now();
  const delta = now - (game.lastTick || now);
  game.lastTick = now;

  const p = currentPlayer();
  p.activeTimeMs += delta;

  const turnElapsed = turnElapsedNow();
  const t = game.turn;

  // Corte duro del modo límite
  if (t.hardCapMs !== null && turnElapsed >= t.hardCapMs) {
    alarmHard();
    toast(`⏰ Tiempo límite de ${p.name} agotado — turno finalizado`, true);
    endTurn(true);
    return;
  }

  // Alarma al entrar en excedente (solo informativa)
  const crossed = (t.elapsedAtAnchor || 0) < game.config.timePerTurnMs && turnElapsed >= game.config.timePerTurnMs;
  if (crossed && Date.now() - lastAlarmAt > 3000) {
    lastAlarmAt = Date.now();
    alarmOver();
  }

  render();
}

function startTick() {
  stopTick();
  timerId = setInterval(tick, TICK_MS);
}

function stopTick() {
  if (timerId) { clearInterval(timerId); timerId = null; }
}

// ---------------- Render ----------------
function render() {
  renderScreen();
  if (game && (game.state === 'playing' || game.state === 'paused')) renderGame();
  if (typeof renderTracker === 'function') renderTracker();
  if (typeof renderBot === 'function') renderBot();
}

function renderScreen() {
  const hasActive = game && (game.state === 'playing' || game.state === 'paused');
  const isFinished = game && game.state === 'finished';

  $('#screen-config').hidden = hasActive || isFinished;
  $('#screen-game').hidden = !hasActive;
  $('#screen-summary').hidden = !isFinished;

  if (isFinished) renderSummary();
  if (!hasActive && !isFinished) renderConfigSummary();
}

function getDurationMin() {
  const sel = $('#cfg-duration');
  if (sel.value === 'custom') {
    const v = parseInt($('#cfg-duration-custom').value, 10);
    if (Number.isFinite(v) && v >= 5) return v;
  }
  const preset = parseInt(sel.value, 10);
  return Number.isFinite(preset) && preset > 0 ? preset : 60;
}

function renderConfigSummary() {
  const durationMin = getDurationMin();
  const playerCount = parseInt(getSelectedPlayerCount(), 10);
  const turnsPerPlayer = TURNS_PER_PLAYER[playerCount];
  const timePerPlayerMs = Math.round((durationMin * 60000) / playerCount);
  const timePerTurnMs = Math.round(timePerPlayerMs / turnsPerPlayer);

  $('#sum-time-player').textContent = fmtLong(timePerPlayerMs);
  $('#sum-time-turn').textContent = fmtLong(timePerTurnMs);
  $('#sum-turns').textContent = String(turnsPerPlayer);
  $('#sum-total').textContent = String(playerCount * turnsPerPlayer);
  $('#cfg-turns-hint').textContent = `${turnsPerPlayer} turnos por jugador · ${playerCount * turnsPerPlayer} turnos totales`;
  syncNameInputs(playerCount);
}

function getSelectedPlayerCount() {
  const sel = $('#cfg-players .chip.selected');
  return sel ? sel.dataset.value : '3';
}

function renderGame() {
  const t = game.turn;
  const p = currentPlayer();
  const total = totalTurns();
  const done = game.turnsCompleted;

  $('#game-progress').textContent = `Turno ${done + 1}/${total}`;
  const pill = $('#game-state-pill');
  if (game.state === 'paused') {
    pill.textContent = 'En pausa';
    pill.className = 'pill state-paused';
  } else if (playerInLimit(p)) {
    pill.textContent = 'Modo límite';
    pill.className = 'pill state-limited';
  } else {
    pill.textContent = 'Jugando';
    pill.className = 'pill state-playing';
  }

  $('#cur-name').textContent = p.name;
  const mode = $('#cur-mode');
  const limited = playerInLimit(p);
  mode.textContent = limited ? 'MODO LÍMITE — máximo 2 min, corte duro' : 'tiempo por turno (informativo)';
  mode.classList.toggle('limited', limited);

  // Countdown
  const cd = $('#countdown');
  let display;
  if (!t.active) {
    display = limited ? '02:00' : fmtTime(game.config.timePerTurnMs);
    cd.classList.remove('over', 'limited');
    if (limited) cd.classList.add('limited');
  } else {
    const elapsed = turnElapsedNow();
    if (t.hardCapMs !== null) {
      display = fmtTime(t.hardCapMs - elapsed);
      cd.classList.add('limited');
      cd.classList.remove('over');
    } else {
      display = fmtTime(game.config.timePerTurnMs - elapsed);
      cd.classList.toggle('over', elapsed > game.config.timePerTurnMs);
      cd.classList.remove('limited');
    }
    if (elapsed < 1000) console.log('[RENDER] elapsed bajo:', elapsed, 'elapsedAtAnchor:', t.elapsedAtAnchor, 'running:', t.running, 'anchor:', t.anchorTime);
  }
  cd.textContent = display;
  $('#countdown-sub').textContent = t.active
    ? (t.hardCapMs !== null ? 'modo límite — se corta en 0' : 'el excedente se descuenta del tiempo global')
    : (limited ? 'listo para turno de 2:00' : 'pulsa Iniciar turno');

  // Tiempo global
  const gLeft = playerGlobalLeft(p);
  const gEl = $('#gtime');
  gEl.textContent = gLeft <= 0 ? '0:00' : fmtTime(gLeft);
  gEl.classList.toggle('zero', gLeft <= 0);
  $('#gtime-name').textContent = p.name;

  const frac = Math.max(0, Math.min(1, gLeft / game.config.timePerPlayerMs));
  const fill = $('#gtime-bar-fill');
  fill.style.width = `${(frac * 100).toFixed(1)}%`;
  fill.classList.toggle('zero', gLeft <= 0);
  fill.classList.toggle('low', gLeft > 0 && frac < 0.33);

  // Botones
  const inPaused = game.state === 'paused';
  $('#btn-turn-start').disabled = t.active || inPaused;
  $('#btn-turn-end').disabled = !t.active || inPaused;
  const pauseBtn = $('#btn-pause');
  pauseBtn.disabled = false;
  pauseBtn.textContent = inPaused ? 'Reanudar partida' : 'Pausar partida';
}

function renderSummary() {
  const wrap = $('#summary-rows');
  wrap.innerHTML = '';
  let overCount = 0;
  game.config.players.forEach((p) => {
    const left = playerGlobalLeft(p);
    const over = p.activeTimeMs > game.config.timePerPlayerMs;
    const limited = playerInLimit(p);
    if (over) overCount++;
    const row = document.createElement('div');
    row.className = 'summary-row';
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = p.name;
    const valEl = document.createElement('div');
    valEl.className = 'value' + (over ? ' over' : '') + (limited ? ' limited' : '');
    valEl.textContent = `${fmtLong(p.activeTimeMs)} jugados · ${limited ? 'agotado' : (over ? 'excedido' : 'con tiempo')}`;
    row.appendChild(nameEl);
    row.appendChild(valEl);
    wrap.appendChild(row);
  });
  const note = $('#summary-note');
  note.textContent = overCount > 0
    ? `${overCount} jugador(es) agotaron su tiempo global y pasaron a modo límite en sus últimos turnos.`
    : 'Ningún jugador agotó su tiempo global.';
}

// ---------------- Config: jugadores y nombres ----------------
function syncNameInputs(playerCount) {
  const box = $('#cfg-names');
  box.innerHTML = '';
  const existing = box.dataset.names ? JSON.parse(box.dataset.names || '[]') : [];
  for (let i = 0; i < playerCount; i++) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.style.cssText = 'width:72px;flex:0 0 72px;color:var(--text-dim);font-size:0.85rem;align-self:center;';
    label.textContent = `Jugador ${i + 1}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = `Jugador ${i + 1}`;
    input.maxLength = 24;
    input.value = existing[i] || '';
    input.addEventListener('input', () => {
      const names = [];
      box.querySelectorAll('input').forEach((el) => names.push(el.value));
      box.dataset.names = JSON.stringify(names);
    });
    row.appendChild(label);
    row.appendChild(input);
    box.appendChild(row);
  }
}

// ---------------- Fase 2: Trackador ----------------
// actions[playerIndex][turnIndex] = [{ id, text, at }]
// turnIndex del jugador = nº de turnos que ESE jugador ya ha finalizado (0-based).

function trkEnsureActionsOn(state) {
  if (!state || !state.config) return;
  if (!Array.isArray(state.actions)) state.actions = [];
  const n = state.config.playerCount || 0;
  for (let i = 0; i < n; i++) {
    if (!Array.isArray(state.actions[i])) state.actions[i] = [];
    // Sanitizar sub-índices: null / undefined -> array vacío (evita "Cannot read length of null")
    for (let k = 0; k < state.actions[i].length; k++) {
      if (!Array.isArray(state.actions[i][k])) state.actions[i][k] = [];
    }
  }
}

function trkEnsureActions() {
  if (!game) return;
  trkEnsureActionsOn(game);
}

function trkCurrentPlayerIdx() {
  return game ? game.turn.playerIndex : 0;
}

function trkCurrentTurnIdx() {
  // Índice del turno propio del jugador actual = nº de turnos que YA termino
  // ese jugador (turnsPlayed). Coincide con el mapeo de la lista:
  //   globalTurn g -> pIdx=(g-1)%N, turnsBefore=floor((g-1)/N) = player.turnsPlayed
  const pIdx = trkCurrentPlayerIdx();
  const p = game.config.players[pIdx];
  return Math.max(0, p ? p.turnsPlayed : 0);
}

function trkAddAction(text) {
  if (!game || !game.config) return;
  const t = text && text.trim();
  if (!t) return;
  trkEnsureActions();
  const pIdx = trkCurrentPlayerIdx();
  const tIdx = trkCurrentTurnIdx();
  const arr = game.actions[pIdx];
  if (!Array.isArray(arr) || !Array.isArray(arr[tIdx])) arr[tIdx] = [];
  arr[tIdx].push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: t.slice(0, 400),
    at: Date.now()
  });
  save();
  renderTracker();
  toast('Acción registrada');
}

function trkDeleteAction(pIdx, tIdx, actionId) {
  if (!game) return;
  trkEnsureActions();
  const arr = game.actions[pIdx];
  if (Array.isArray(arr) && Array.isArray(arr[tIdx])) {
    arr[tIdx] = arr[tIdx].filter((a) => a.id !== actionId);
    // Mantener como array vacío en vez de `delete` (evita slots null al serializar)
  }
  save();
  renderTracker();
}

function renderTracker() {
  const empty = $('#tracker-empty');
  const body = $('#tracker-body');
  const hasGame = game && game.config && game.config.players;
  empty.hidden = !!hasGame;
  body.hidden = !hasGame;
  if (!hasGame) return;

  // Topbar
  const total = totalTurns();
  const done = game.turnsCompleted;
  $('#trk-progress').textContent = `Turno ${done + 1}/${total}`;
  const p = currentPlayer();
  $('#trk-current').textContent = `Turno de ${p.name}`;

  // Compose: solo habilitado si hay turno activo o la partida está en pausa
  const canCompose = game.state === 'playing' || game.state === 'paused';
  $('#btn-trk-add').disabled = !canCompose;

  // Lista de turnos
  const list = $('#trk-list');
  list.innerHTML = '';

  // Orden de visualización: turnos ya finalizados (1..done) + turno en curso (done+1)
  const shownTurns = Math.min(total, done + 1);
  for (let globalTurn = 1; globalTurn <= shownTurns; globalTurn++) {
    // ¿Qué jugador y qué índice de turno propio corresponde a ese turno global?
    // Rotación estricta: turno global g (1-based) -> jugador (g-1) % N
    const pIdx = (globalTurn - 1) % game.config.playerCount;
    const player = game.config.players[pIdx];
    // El índice de turno propio del jugador en ese turno global:
    // = cuántas veces ha jugado ese jugador ANTES de este turno global.
    // Con rotación estricta J1..JN..J1.., el jugador p aparece en los turnos
    // p+1, p+1+N, p+1+2N, ... → su k-ésimo turno propio está en el turno global
    // p+1+k·N → k = floor((globalTurn-1)/N).
    const turnsBefore = Math.floor((globalTurn - 1) / game.config.playerCount);

    const card = document.createElement('div');
    card.className = 'trk-turn';
    const head = document.createElement('div');
    head.className = 'trk-turn-head';
    const num = document.createElement('span');
    num.className = 'trk-turn-num';
    num.textContent = `Turno ${globalTurn}`;
    const pname = document.createElement('span');
    pname.className = 'trk-turn-player';
    pname.textContent = player.name;
    head.appendChild(num);
    head.appendChild(pname);
    card.appendChild(head);

    const slot = (game.actions && Array.isArray(game.actions[pIdx])) ? game.actions[pIdx][turnsBefore] : null;
    const actions = Array.isArray(slot) ? slot : [];

    if (actions.length === 0) {
      const e = document.createElement('div');
      e.className = 'trk-empty-turn';
      e.textContent = 'Sin acciones registradas';
      card.appendChild(e);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'trk-turn-actions';
      actions.forEach((a) => {
        const row = document.createElement('div');
        row.className = 'trk-action';
        const txt = document.createElement('span');
        txt.className = 'txt';
        txt.textContent = a.text;
        const del = document.createElement('button');
        del.className = 'del';
        del.type = 'button';
        del.setAttribute('aria-label', 'Eliminar acción');
        del.textContent = '×';
        del.addEventListener('click', () => trkDeleteAction(pIdx, turnsBefore, a.id));
        row.appendChild(txt);
        row.appendChild(del);
        wrap.appendChild(row);
      });
      card.appendChild(wrap);
    }
    list.appendChild(card);
  }

  // Si no hay turnos jugados todavía, mostrar un aviso
  if (shownTurns === 0) {
    const e = document.createElement('div');
    e.className = 'placeholder';
    e.innerHTML = '<p class="hint">Aún no hay turnos registrados.</p>';
    list.appendChild(e);
  }
}

// ---------------- Fase 3: Bot de estrategia ----------------
// El bot muestra: (1) estado de la partida, (2) sugerencias basadas en el
// trackador + estado, (3) recordatorio de reglas. Sin IA pesada: reglas
// simples de ponderación sobre las acciones registradas.

const BOT_RULES = [
  'El tiempo que cuenta es el <b>global por jugador</b> (duración total ÷ jugadores).',
  'El tiempo por turno es <b>informativo</b>: el excedente se descuenta del tiempo global pero no corta el turno.',
  'Si un jugador agota su tiempo global, sus turnos siguientes pasan a <b>modo límite: 2 min con corte duro</b>.',
  'Rotación estricta: J1 → J2 → … → JN → J1, sin saltos.',
  'Turnos por jugador: <b>2–3 jugadores → 10 · 4 → 9 · 5 → 8</b>.',
  'Pausa global: congela todo (tiempo de turno y global).',
  'Al restaurar una partida en pleno turno, se reabre en <b>pausa</b>.'
];

function botStateSummary() {
  if (!game || !game.config) return null;
  const p = currentPlayer();
  const total = totalTurns();
  const done = game.turnsCompleted;
  const gLeft = playerGlobalLeft(p);
  const limited = playerInLimit(p);
  return {
    state: game.state,
    progress: `Turno ${done + 1}/${total}`,
    current: p.name,
    currentLimited: limited,
    currentGlobalLeft: gLeft,
    players: game.config.players.map((pl) => ({
      name: pl.name,
      turnsPlayed: pl.turnsPlayed,
      globalLeft: playerGlobalLeft(pl),
      limited: playerInLimit(pl)
    }))
  };
}

function botSuggest() {
  if (!game || !game.config) return [];
  const out = [];
  const p = currentPlayer();
  const pIdx = game.turn.playerIndex;

  // 1. Aviso de modo límite
  if (playerInLimit(p)) {
    out.push({
      level: 'danger',
      tag: 'Límite',
      text: `${p.name} está en <b>modo límite</b>: turno máximo 2 min con corte duro. Juega rápido.`
    });
  }

  // 2. Aviso de tiempo global bajo
  const gLeft = playerGlobalLeft(p);
  if (!playerInLimit(p) && gLeft > 0 && gLeft < game.config.timePerPlayerMs * 0.33) {
    out.push({
      level: 'warn',
      tag: 'Tiempo',
      text: `${p.name} le quedan <b>${fmtLong(gLeft)}</b> de tiempo global. El excedente de este turno le restará más.`
    });
  }

  // 3. Sugerencias basadas en el trackador del jugador actual
  const myTurns = (game.actions && Array.isArray(game.actions[pIdx])) ? game.actions[pIdx] : [];
  const myActions = myTurns.filter((a) => Array.isArray(a)).flat();

  // Patrones simples sobre el texto de acciones
  const PATTERNS = [
    { re: /(atac|invadi|derrot|elimina)/i, tag: 'Ofensiva', text: 'Has estado <b>atacando</b> últimamente. Si el rival ha construido defensas, considera una jugada más defensiva o de reubicación.' },
    { re: /(construy|defens|muro|fortific|muralla)/i, tag: 'Defensa', text: 'Has estado <b>construyendo</b>. Si el rival ataca, tus defensas te protegen; si no, considera invertir esa fuerza en ofensiva.' },
    { re: /(movi|reubica|desplaz|retira)/i, tag: 'Movilidad', text: 'Has estado <b>moviendo</b> piezas. La movilidad da opciones; asegúrate de tener un objetivo claro para el siguiente turno.' },
    { re: /(recog|colect|recuper|pesc)/i, tag: 'Economía', text: 'Has estado <b>recolectando</b>. La economía sostiene el resto de acciones; si vas corto de tiempo, prioriza objetivos de victoria.' }
  ];
  for (const pat of PATTERNS) {
    const hits = myActions.filter((a) => pat.re.test(a.text)).length;
    if (hits >= 2) {
      out.push({ level: 'tipsy', tag: pat.tag, text: pat.text.replace('Has estado', `${p.name} ha estado`) });
      break; // solo la sugerencia más relevante
    }
  }

  // 4. Si el jugador actual no ha registrado nada aún
  if (myActions.length === 0) {
    out.push({
      level: 'tipsy',
      tag: 'Consejo',
      text: `${p.name} todavía no ha registrado acciones. Usa el <b>Trackador</b> para anotar qué hizo en cada turno: el bot dará sugerencias más precisas.`
    });
  }

  // 5. Recordatorio de turno
  out.push({
    level: 'tipsy',
    tag: 'Turno',
    text: `Ahora es turno de <b>${p.name}</b>. Recuerda: el tiempo por turno es informativo; el que cuenta es el global.`
  });

  return out.slice(0, 5);
}

function renderBot() {
  const empty = $('#bot-empty');
  const body = $('#bot-body');
  const hasGame = game && game.config && game.config.players;
  empty.hidden = !!hasGame;
  body.hidden = !hasGame;
  if (!hasGame) return;

  // Estado
  const s = botStateSummary();
  const stateEl = $('#bot-state');
  stateEl.innerHTML = '';
  if (s) {
    const rows = [
      ['Estado', s.state === 'playing' ? 'En juego' : s.state === 'paused' ? 'En pausa' : 'Finalizada', s.state === 'paused' ? 'warn' : ''],
      ['Progreso', s.progress, ''],
      ['Turno de', s.current, s.currentLimited ? 'danger' : '']
    ];
    if (s.currentLimited) rows.push(['Modo', 'LÍMITE (2 min)', 'danger']);
    else if (s.currentGlobalLeft > 0) rows.push(['Tiempo global', fmtLong(s.currentGlobalLeft), s.currentGlobalLeft < game.config.timePerPlayerMs * 0.33 ? 'warn' : 'ok']);

    rows.forEach(([k, v, cls]) => {
      const r = document.createElement('div');
      r.className = 'row';
      const kk = document.createElement('span'); kk.className = 'k'; kk.textContent = k;
      const vv = document.createElement('span'); vv.className = 'v ' + (cls || ''); vv.textContent = v;
      r.appendChild(kk); r.appendChild(vv);
      stateEl.appendChild(r);
    });

    // Jugadores
    const div = document.createElement('div');
    div.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid var(--border);';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:0.8rem;color:var(--text-dim);margin-bottom:6px;';
    title.textContent = 'Jugadores';
    div.appendChild(title);
    s.players.forEach((pl) => {
      const r = document.createElement('div');
      r.className = 'row';
      r.style.cssText = 'padding:2px 0;';
      const kk = document.createElement('span'); kk.className = 'k'; kk.textContent = pl.name;
      const vv = document.createElement('span');
      vv.className = 'v ' + (pl.limited ? 'danger' : (pl.globalLeft < game.config.timePerPlayerMs * 0.33 ? 'warn' : 'ok'));
      vv.textContent = pl.limited ? 'agotado' : `${pl.turnsPlayed}/${game.config.turnsPerPlayer} · ${fmtLong(pl.globalLeft)}`;
      r.appendChild(kk); r.appendChild(vv);
      div.appendChild(r);
    });
    stateEl.appendChild(div);
  }

  // Sugerencias
  const sugEl = $('#bot-suggestions');
  sugEl.innerHTML = '';
  const suggestions = botSuggest();
  if (suggestions.length === 0) {
    const e = document.createElement('div');
    e.className = 'bot-no-suggestions';
    e.textContent = 'Sin sugerencias por ahora. Registra acciones en el Trackador para recibir análisis.';
    sugEl.appendChild(e);
  } else {
    suggestions.forEach((sg) => {
      const card = document.createElement('div');
      card.className = 'bot-suggestion ' + (sg.level || '');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = sg.tag || 'Info';
      const txt = document.createElement('span');
      txt.innerHTML = sg.text;
      card.appendChild(tag);
      card.appendChild(txt);
      sugEl.appendChild(card);
    });
  }

  // Reglas
  const rulesEl = $('#bot-rules');
  rulesEl.innerHTML = '';
  BOT_RULES.forEach((rule) => {
    const li = document.createElement('li');
    li.innerHTML = rule;
    rulesEl.appendChild(li);
  });
}

// ---------------- Service worker ----------------
function registerSW() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ---------------- Inicialización ----------------
function bindEvents() {
  // Duración: preset o valor manual
  const durSel = $('#cfg-duration');
  const durCustom = $('#cfg-duration-custom');
  durSel.addEventListener('change', () => {
    const isCustom = durSel.value === 'custom';
    durCustom.hidden = !isCustom;
    if (isCustom) {
      if (!durCustom.value) durCustom.value = durSel.dataset.lastPreset || 60;
      durCustom.focus();
    } else {
      durSel.dataset.lastPreset = durSel.value;
    }
    renderConfigSummary();
  });
  durCustom.addEventListener('input', () => {
    if (durSel.value === 'custom') renderConfigSummary();
  });

  // Nº jugadores
  $('#cfg-players').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#cfg-players .chip').forEach((c) => c.classList.remove('selected'));
    chip.classList.add('selected');
    renderConfigSummary();
  });

  // Iniciar partida
  $('#btn-start').addEventListener('click', () => {
    const durationMin = getDurationMin();
    const playerCount = parseInt(getSelectedPlayerCount(), 10);
    const names = JSON.parse($('#cfg-names').dataset.names || '[]');
    newGame(durationMin, playerCount, names);
    save();
    requestWakeLock();
    startTick();
    render();
    toast(`Partida iniciada: ${playerCount} jugadores, ${durationMin} min`);
  });

  // Turno
  $('#btn-turn-start').addEventListener('click', startTurn);
  $('#btn-turn-end').addEventListener('click', () => endTurn(false));
  $('#btn-pause').addEventListener('click', () => {
    if (game.state === 'playing') pauseGame();
    else resumeGame();
  });
  $('#btn-abort').addEventListener('click', () => {
    if (confirm('¿Abandonar la partida? Se perderá todo el progreso.')) abortGame();
  });

  // Resumen
  $('#btn-new-game').addEventListener('click', () => {
    clearStorage();
    releaseWakeLock();
    stopTick();
    game = null;
    render();
  });

  // Fase 2 — Trackador
  const noteEl = $('#trk-note');
  $('#btn-trk-add').addEventListener('click', () => {
    trkAddAction(noteEl.value);
    noteEl.value = '';
  });
  noteEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      trkAddAction(noteEl.value);
      noteEl.value = '';
    }
  });
  $('#btn-trk-clear').addEventListener('click', () => { noteEl.value = ''; noteEl.focus(); });

  // Fase 3 — Bot
  $('#btn-bot-refresh').addEventListener('click', () => {
    renderBot();
    toast('Análisis actualizado');
  });

  // Tabs
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => {
        t.classList.remove('selected');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('selected');
      tab.setAttribute('aria-selected', 'true');
      const which = tab.dataset.tab;
      $('#timer-section').hidden = which !== 'timer';
      $('#tracker-section').hidden = which !== 'tracker';
      $('#bot-section').hidden = which !== 'bot';
      if (which === 'tracker') renderTracker();
      if (which === 'bot') renderBot();
    });
  });

  // Desbloqueo de audio: primer gesto del usuario
  const unlock = () => {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (_) {}
    document.removeEventListener('pointerdown', unlock);
  };
  document.addEventListener('pointerdown', unlock);
}

function init() {
  const saved = load();
  if (saved && saved.state === 'playing') {
    // Estaba en pleno turno/activo: se reabre en PAUSA (según plan §7)
    saved.state = 'paused';
    if (saved.turn && saved.turn.running) {
    saved.turn.running = false;
    saved.turn.elapsedAtAnchor = saved.turn.elapsedAtAnchor || 0;
    saved.turn.anchorTime = null;
  }
  saved.lastTick = null;
  trkEnsureActionsOn(saved);
  game = saved;
  save();
  toast('Partida restaurada en pausa — pulsa Reanudar para continuar');
} else if (saved && saved.state === 'paused') {
  if (saved.turn && saved.turn.running) {
    saved.turn.running = false;
    saved.turn.elapsedAtAnchor = saved.turn.elapsedAtAnchor || 0;
    saved.turn.anchorTime = null;
  }
  saved.lastTick = null;
  trkEnsureActionsOn(saved);
  game = saved;
  save();
} else if (saved && saved.state === 'finished') {
    trkEnsureActionsOn(saved);
    game = saved;
  } else {
    game = null;
    clearStorage();
  }

  bindEvents();
  render();
  if (game && game.state === 'playing') startTick();
  registerSW();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
