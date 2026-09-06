# AGENTS.md

## Proyecto
App PWA para Android (sin framework, HTML + CSS + JS vanilla) para gestionar partidas de **Small World of Warcraft**: timer de turnos, trackador y bot de estrategia. Se edita y sirve localmente desde VS Code; no hay build, npm, tests ni lint configurados.

## Regla clave de diseño
- El tiempo que **cuenta** es el **global por jugador** (`duración total / nº jugadores`), no el tiempo por turno.
- El **tiempo por turno** es solo **informativo** (guía de duración); el excedente se muestra en rojo pero **no corta el turno** y consume del tiempo global del jugador.
- Cuando el tiempo global de un jugador llega a 0, sus turnos siguientes pasan a **modo límite: 2 min con corte duro + alarma** (sonido + vibración, finalización automática).
- **Pausa global** de partida (congelar todo) y reanudar desde donde estaba.
- Rotación estricta de turnos: J1 → J2 → … → JN → J1, sin saltos.
- Turnos por jugador según nº de jugadores: **2 o 3 jugadores → 10 turnos · 4 jugadores → 9 turnos · 5 jugadores → 8 turnos**.
- Al restaurar una partida que estaba en pleno turno, se reabre en **pausa** (congelada) para que el usuario decida reanudar.

## Estructura de archivos (Fase 1)
```
/
  index.html          # UI: 3 secciones (Timer activo, Trackador, Bot placeholder)
  styles.css          # estilos
  app.js              # lógica del timer, turnos, estado, persistencia
  manifest.json       # PWA (instalable, offline)
  sw.js               # service worker (app shell offline)
  icons/              # icon-192.png, icon-512.png, icon-maskable-512.png (ya existen)
  docs/
    plan-fase-1-timer.md   # plan aprobado de la Fase 1 (referencia)
    idea.md                # idea original + conversación de aprobación (en /idea.md, raíz)
```

## Modelos y estado
- Estado persistido en `localStorage` (ver `docs/plan-fase-1-timer.md` §3 por el esquema exacto: `game.state`, `game.config`, `game.turn`, `turnsCompleted`).
- Estados: `config` | `playing` | `paused` | `finished`.
- Alarma: Web Audio API (beep, sin archivos de audio) + `navigator.vibrate`.
- Wake Lock: `navigator.wakeLock.request('screen')` mientras dura la partida.

## Fases
- **Fase 1 (actual, aprobada):** timer completo — configuración, juego, pausa global, modo límite 2 min, resumen final, PWA instalable + offline, persistencia.
- **Fase 2 (placeholder en UI):** trackador de partida (puntos, razas, acciones por turno).
- **Fase 3 (placeholder en UI):** bot de estrategia (sugerencias por ponderaciones simples).

## Convenciones
- UI y textos **en español**, diseño oscuro, legible desde el otro lado de la mesa.
- Sin frameworks ni dependencias: todo vanilla, sin npm/pip/lockfiles.
- No hay tests; verificar abriendo `index.html` en el navegador (o `npx serve` / `python -m http.server`) e instalando como PWA.
- Antes de tocar la lógica del timer, leer `docs/plan-fase-1-timer.md` §4 (reglas de tiempo) — ahí están las decisiones aprobadas.
