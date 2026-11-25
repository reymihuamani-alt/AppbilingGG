# Mixeo — Editor de transiciones entre canciones

App web (móvil y escritorio, sin instalación ni servidor) para diseñar transiciones entre dos canciones con control total, al estilo de un editor de mezclas pero más profundo.

## Cómo usarla
Abre `index.html` en el navegador (o publícalo con GitHub Pages). Pulsa **“Probar con canciones demo”** o carga tus propios audios (mp3, wav, m4a, ogg, flac…). Todo se procesa en tu dispositivo.

## Funciones
- **Análisis automático**: BPM, rejilla de beats/compases y tonalidad (notación Camelot). Se pueden corregir a mano (toca el BPM o la tonalidad).
- **Sincronización de tempo** (B→A, A→B o libre) con time-stretch WSOLA y **key lock**, más **cambio de tono** en semitonos por pista.
- **Rueda Camelot y compatibilidad armónica**, con botón **Armonizar** que transpone B al tono compatible más cercano.
- **8 carriles de automatización por pista**, editables con curvas: Volumen, Graves, Medios, Agudos (EQ de 3 bandas con corte total), Filtro (paso bajo ↔ paso alto con resonancia), Eco sincronizado al tempo, Reverb y Velocidad (freno / arranque de vinilo).
- **Editor de curvas**: añade, arrastra y borra puntos; cada tramo puede ser suave, lineal, rápido, lento o escalón; ajuste a la rejilla.
- **Presets**: Auto (elige según tempo y tonalidad), Fade, Intercambio de graves, Intercambio por bandas, Crescendo, Barrido de filtro, Eco de salida, Lavado de reverb, Corte y Freno. Cada carril tiene además sus propias curvas predefinidas, y puedes guardar tus propios presets.
- Duración de 1 a 32 compases, compases antes/después, punto de salida/entrada arrastrable en la miniatura con ±beat/±compás.
- Formas de onda coloreadas por bandas que reflejan en vivo el efecto de la automatización, analizador de espectro, bucle, deshacer/rehacer.
- **Exportación a WAV** de la transición y exportación/importación del proyecto en JSON.

Atajos: Espacio (reproducir), Supr (borrar punto), Ctrl+Z / Ctrl+Shift+Z, teclas 1–8 (cambiar de carril).

## Estructura
- `js/dsp.js` — análisis (bandas, BPM, tonalidad), WSOLA, resampleo y WAV (se ejecuta en un Web Worker)
- `js/engine.js` — render offline con Web Audio (EQ, filtros, eco, reverb, limitador) y reproducción
- `js/automation.js` — carriles, curvas y presets
- `js/theory.js` — tonalidades, Camelot y compatibilidad
- `js/demo.js` — canciones demo sintetizadas
- `js/app.js` — interfaz
