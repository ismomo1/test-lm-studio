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
    lastTick: null
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

  if (game.turnsCompleted >= totalTurns()) {
    finishGame();
    return;
  }

  // Avanzar al siguiente jugador (rotación estricta)
  t.playerIndex = (t.playerIndex + 1) % game.config.playerCount;
  const p = currentPlayer();
  p.turnsPlayed++;

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
  game = saved;
  save();
} else if (saved && saved.state === 'finished') {
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
