me interesa una app para android que tenga un trackador de partida, un bot de estrategia y otra seccion que sea un timer. En el timer se podrá la duración objetivo de la partida (1 hora por ejemplo), el número de jugadores (con el que además calculará el número de turnos, si no sabes los turnos en función del número de jugadores te lo puedo decir yo) y con eso hará una distribución equitativa del tiempo total entre los jugadores de la partida (si es 1h de partida con 3 jugadores pues serían 20 min para cada jugador). Después se debe dividir el tiempo de cada jugador entre el numero de turnos para ver el tiempo estimado por turno que tiene cada jugador. La idea es que cada jugador active su timer al comienzo de su turno y lo desactive al finalizar. Al activarlo comenzará un temporizador con el tiempo de ese turno, que si llega a cero seguirá contando en negativo para ver el tiempo que se ha excedido. Al mismo tiempo verá un marcador con el tiempo total de partida que le queda, el cual también se irá reduciendo. Si un jugador consume todo su tiempo de partida, desde ese momento sus siguientes turnos serán de un máximo de 2 min.
En el plan empezaremos por la sección del timer, a continuación el trackador y luego el bot de estrategia (creo que así iríamos de menor a mayor complejidad, además de que urge más tener ese timer que el resto de cosas).
Sólo necesito la app para android, a ser posible hacerla de la manera más sencilla posible. Desconozco el stack tecnologico mas adecuado para lograrlo teniendo en cuenta que a ser posible me gustaría gestionarlo desde visual studio code

-----------------

Buen enfoque: timer primero (de menor a mayor complejidad). Antes de armar el plan, déjame darte mi recomendación de stack y cerrad las dudas.
Stack — mi recomendación: PWA (Progressive Web App)
- Es un sitio web (HTML/CSS/JS vanilla, igual stack que tu proyecto actual) que se instala en la pantalla de inicio de Android y se comporta como app (icono, pantalla completa, sin barra de navegador).
- Cero SDKs, cero builds, cero firma de APK: se edita y prueba desde VS Code directamente.
- Funciona offline, y con la Screen Wake Lock API puedo mantener la pantalla encendida mientras dura la partida (clave para un timer).
- La única limitación: si Android mata la app en segundo plano, el timer se detiene (mitigable: la app queda en primer plano sobre la mesa durante la partida).
Alternativa: Kotlin + Jetpack Compose (nativo) — app "de verdad", más robusta en segundo plano, pero exige instalar JDK + Android SDK + Gradle y compilar/sideload el APK. Mucho más fricción por muy poco beneficio para un timer de mesa.
Con esto en mente, unas preguntas para cerrar el plan del timer:
# Questions
¿Qué stack usamos para la app?
PWA installable (Recomendado)
¿Cuántos turnos juega cada jugador según el nº de jugadores (2-5)? (dime los números exactos, p.ej. '2 jugadores: 3 turnos, 3 jugadores: 2 turnos...')
Varía según jugadores (lo escribo)
Si un turno se pasa de tiempo (cuenta en negativo), ¿el exceso se descuenta del tiempo de partida total de ese jugador?
Sí, se descuenta (Recomendado)
Cuando un jugador ya sin tiempo de partida juega un turno de máximo 2 min y llega a cero, ¿qué hace el timer?
Corte duro + alarma
+ Thought: 4.9s
Perfecto, casi todo cerrado. Solo me falta la tabla de turnos que me dijiste que escribirías. ¿Me la das? Formato:
- 2 jugadores: ? turnos por jugador
- 3 jugadores: ? turnos por jugador
- 4 jugadores: ? turnos por jugador
- 5 jugadores: ? turnos por jugador
(En Small World cada jugador juega 2 razas —¿es ese el "turno" que tienes en mente, o te refieres a otra unidad como rondas?)
▣  Plan · Qwen3.8 27B · 4m 3s
2 o 3 jugadores 10 turnos, 4 jugadores 9 turnos, 5 jugadores 8 turnos
+ Thought: 28.7s
▣  Plan · Qwen3.8 27B · 57.2s
sigues ahí? has dejado de planificar parece
+ Thought: 8.9s
Sí, aquí estoy — se me cortó el mensaje anterior. Tienes todos los datos ya, aquí va el plan completo de la Fase 1 (Timer):
Plan: Timer de partida (PWA)
Stack: HTML + CSS + JS vanilla en una carpeta nueva swow-app/ (misma técnica que tu index.html actual). PWA instalable en el home de Android, 100% offline, editable desde VS Code. Sin frameworks, sin builds.
Estructura:
swow-app/
├── index.html      (3 secciones: Timer activa, Trackador y Bot como placeholder)
├── app.js          (lógica del timer)
├── manifest.json   (instalación PWA)
├── sw.js           (service worker: offline + install)
└── icons/          (icono 192/512)
1. Pantalla de configuración
- Duración objetivo de la partida (slider/presets: 30/45/60/90/120 min, default 60).
- Número de jugadores (2–5) → turnos por jugador automáticos según tu tabla: 2-3 jugadores: 10 · 4: 9 · 5: 8.
- Nombres de jugadores (opcional, por defecto J1–J5).
- Resumen calculado: tiempo por jugador = total/jugadores; tiempo por turno = ese ÷ turnos. (Ej. 60 min, 3 jugadores → 20 min/jugador → 2 min/turno. La matemática cierra exactamente: N × turnos × tiempo/turno = total.)
- Botón Iniciar partida.
2. Pantalla de juego
- Cuyo turno es (rotación estricta J1→J2→J3→J1...).
- Countdown grande con el tiempo del turno. Botones Iniciar / Pausar / Finalizar turno.
- Marcador del jugador: tiempo de partida que le queda (se reduce con el tiempo real usado en cada turno, exceso incluido).
- Modo excedido: si el turno llega a 0, sigue contando en negativo (rojo) y el exceso descuenta del tiempo de partida del jugador. Vibración + beep al llegar a 0.
- Modo límite: cuando el tiempo de partida de un jugador llega a 0, sus turnos siguientes son máx. 2:00 con corte duro + alarma (vibración + sonido, se detiene en 0 y obliga a finalizar turno).
- Fin de partida: al completar N×turnos totales → pantalla de resumen (tiempo usado por jugador, excesos).
3. Robustez
- Wake Lock API: pantalla encendida durante la partida.
- Persistencia en localStorage: si cierras/refrescas la app, la partida se restaura donde estaba.
- PWA: manifest + service worker + icono → "Añadir a pantalla de inicio", icono propio, pantalla completa.
- UI en español, diseño oscuro, legible desde el otro lado de la mesa.
Supuestos (dime si alguno no te encaja)
1. Rotación estricta de turnos (no se puede saltar jugador).
2. El tiempo no usado de un turno se pierde (no se acumula al jugador).
3. Se puede pausar el turno (marcha atrás el countdown).
Fases siguientes (ya planificadas, no se ejecutan ahora)
- Fase 2 – Trackador de partida: fichas de puntos por jugador, razas/poderes en juego, cálculo automático del puntaje final de Small World de Warcraft.
- Fase 3 – Bot de estrategia: lee el estado (tablero, razas, monedas) y sugiere jugadas; empezaría por un sistema de ponderaciones simple (no IA pesada).
¿Aprobas el plan de la Fase 1? Si algún supuesto no te encaja, dímelo y lo ajusto antes de empezar.

-------------------

apruebo el plan salvo por una modificación: el tiempo que cuenta es el global, el tiempo por turno que se muestra es más bien a nivel informativo del jugador para que se organice de manera acorde. También debe haber un botón de pausa de la partida que la detendrá y se reanudará al darle otra vez (esto es por si alguien tiene que ir al baño, recoger comida a domicilio, etc).  Modifica el plan y guárdalo en una carpeta de documentación. Después de todo esto comienza con la fase 1