# Plan de la App — Fase 1: Temporizador de Turnos

> App PWA instalable para organizar las partidas de **Small World of Warcraft**
> con un temporizador de turnos por jugador y recordatorios de tiempo.

---

## 1. Cambios de este plan (respecto a la idea original)

Se incorporan dos reglas clave acordadas:

1. **El tiempo que cuenta es el GLOBAL (por jugador).**
   - Cada jugador dispone de un tiempo total de partida
     (`duración total / nº de jugadores`).
   - El **tiempo por turno** es solo **informativo** (una guía de cuánto
     debería durar cada turno). Si un turno se alarga, el excedente se
     muestra en rojo pero **no corta el turno**.
   - El excedente de un turno consume directamente del tiempo global del
     jugador (porque el tiempo global va descontando el tiempo real jugado).

2. **Límite duro de 2 minutos cuando el tiempo global se agota.**
   - Cuando el tiempo global de un jugador llega a 0, sus **siguientes turnos**
     se limitan a **2 minutos** con **corte duro**.
   - Al llegar a 0 en ese modo, suena una **alarma** (sonido + vibración) y el
     turno se **finaliza automáticamente**.

---

## 2. Funcionalidades (Fase 1)

### 2.1 Pantalla de configuración
- Selección de **número de jugadores** (2 a 5).
- Selección de **duración total** de la partida (en minutos).
- Nombres de los jugadores (o "Jugador 1", "Jugador 2", …).
- Cálculo automático:
  - `tiempo por jugador = duración total / nº de jugadores`
  - `tiempo por turno = tiempo por jugador / turnos por jugador`
  - **Turnos por jugador:**
    - 2 o 3 jugadores → 10 turnos
    - 4 jugadores → 9 turnos
    - 5 jugadores → 8 turnos
- Botón **Iniciar partida**.

### 2.2 Pantalla de juego (temporizador activo)
- **Cuyo turno es** (rotación estricta J1 → J2 → J3 → J1 …).
- **Botón Iniciar turno** → empieza a contar el tiempo del turno.
- **Botón Finalizar turno** → termina el turno, avanza al siguiente jugador.
- **Countdown grande** con el tiempo del turno (tiempo por turno,
  informativo). Al llegar a 0, sigue contando en **negativo** (excedente,
  en rojo).
- **Indicador del tiempo global** restante del jugador actual.
- **Botón Pausar partida** → congela todo (tiempo de turno y global).
- **Botón Reanudar partida** → continúa desde donde estaba.
- **Modo límite (2 min):** si el jugador ya agotó su tiempo global, el
  countdown parte de 2:00, corta en 0 con **alarma** y finaliza el turno.
- **Pantalla de resumen** al completar todos los turnos:
  tiempo total usado por jugador, excedente, turnos jugados.

### 2.3 Otras funciones (Fase 1)
- **PWA instalable:** icono, manifest, service worker (funciona offline).
- **Wake Lock** (pantalla siempre encendida durante la partida).
- **Alarma** (sonido con Web Audio + vibración) al inicio del excedente y en
  el corte duro del modo límite.
- **Persistencia en `localStorage`:** si cierras/refrescas la app, la partida
  se restaura donde estaba.
- **Recordatorio de tiempo:** la app no se cierra sola; siempre disponible para
  mirar la cuenta atrás.

---

## 3. Modelo de datos (localStorage)

```
game = {
  version: 1,
  state: 'config' | 'playing' | 'paused' | 'finished',
  config: {
    durationMin,        // duración total en minutos
    playerCount,        // 2-5
    turnsPerPlayer,     // 2/3 jugadores: 10 | 4: 9 | 5: 8
    timePerPlayerMs,    // duración total / jugadores
    timePerTurnMs,      // tiempo por jugador / turnos por jugador
    players: [
      { name, activeTimeMs, turnsPlayed, turnsTotal }
    ]
  },
  turn: {
    active,             // hay turno en curso
    playerIndex,        // índice del jugador en el turno
    running,            // reloj activo (no en pausa global)
    anchorTime,         // timestamp (wall clock) del segmento en curso
    elapsedAtAnchor,    // ms acumulados antes de este segmento
    hardCapMs,          // 2 min en modo límite, null si informativo
  },
  turnsCompleted,       // nº de turnos finalizados
  lastTick,             // timestamp del último tick (para deltas)
}
```

**Derivados:**
- `tiempo global restante del jugador = timePerPlayerMs - player.activeTimeMs`
- `tiempo de turno actual = elapsedAtAnchor + (now - anchorTime)` (si `running`)
- `modo límite del jugador = (activeTimeMs >= timePerPlayerMs)`

---

## 4. Reglas de tiempo (detalle)

1. Al **iniciar un turno** se fija `anchorTime = now`, `elapsedAtAnchor = 0`
   (o el valor restaurado) y `running = true`.
2. Cada tick: si `running`, `delta = now - lastTick`; se suma `delta` a
   `player.activeTimeMs` (tiempo global real jugado). `lastTick = now`.
3. El **excedente** de un turno = `tiempo de turno - timePerTurnMs` (si > 0).
   Es informativo; el consumo real ya se refleja en el tiempo global.
4. **Pausa global:** `running = false`; se consolida
   `elapsedAtAnchor = tiempo actual del turno`. Nada suma tiempo.
5. **Reanudar:** `anchorTime = now`, `running = true`.
6. **Finalizar turno:** se consolida el tiempo del jugador, se avanza al
   siguiente jugador (rotación), `turnsCompleted++`. Si `turnsCompleted`
   alcanza `playerCount * turnsPerPlayer`, la partida **termina** → resumen.
7. **Modo límite:** al iniciar un turno de un jugador cuyo tiempo global ya es
   <= 0, `hardCapMs = 120000` (2 min). El countdown parte de 2:00. Si el tiempo
   del turno llega a 0 → **alarma + finalización automática** del turno.

---

## 5. Estructura de archivos

```
/
  index.html          # UI: 3 secciones (Timer activo, Trackador, Bot placeholder)
  styles.css          # estilos
  app.js              # lógica del temporizador, turnos, estado, persistencia
  manifest.json       # PWA
  sw.js               # service worker (offline / app shell)
  icons/
    icon-192.png
    icon-512.png
    icon-maskable-512.png
  docs/
    plan-fase-1-timer.md   # este plan
    idea.md                # (idea original, ya existe)
```

---

## 6. Fases

### Fase 1 (esta)
- Temporizador de turnos completo (config, juego, pausa, límite 2 min, resumen).
- PWA instalable + offline.
- Persistencia en localStorage.

### Fase 2 (futuro, placeholder ya previsto en la UI)
- **Trackador:** memoria de acciones por jugador (qué hizo en cada turno).
- **Bot:** asistente que recuerda las reglas y el estado de la partida.

---

## 7. Decisiones / supuestos

- **Stack:** HTML + CSS + JavaScript vanilla (sin framework), PWA. Es lo más
  simple de mantener y de instalar; no requiere instalación de dependencias.
- **Sonido:** Web Audio API (beep) para no depender de archivos de audio.
- **Vibración:** API `navigator.vibrate` (disponible en móvil; inofensiva si
  no existe).
- **Wake Lock:** `navigator.wakeLock.request('screen')`.
- **Iconos:** generados con Pillow (Python), PNG 192/512 + maskable.
- **Rotación estricta:** el orden de turnos es siempre
  J1 → J2 → … → JN → J1 → … (no se puede saltar).
- Al **restaurar** una partida que estaba en pleno turno, se reabre en
  **pausa** (con el tiempo congelado donde estaba) para que el usuario decida
  reanudar.
