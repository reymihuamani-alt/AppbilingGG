/* Music theory helpers: key names, Camelot wheel, harmonic compatibility. */
const Theory = (function () {
  const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const NAMES_ES = ['Do', 'Do♯', 'Re', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];

  function camelot(pc, mode) {
    const majorPc = mode === 'minor' ? (pc + 3) % 12 : pc;
    const num = ((majorPc * 7) % 12 + 7) % 12 + 1;
    return { num, letter: mode === 'minor' ? 'A' : 'B' };
  }
  function camelotStr(k) { const c = camelot(k.pc, k.mode); return c.num + c.letter; }
  function fromCamelot(num, letter) {
    for (let pc = 0; pc < 12; pc++) {
      const mode = letter === 'A' ? 'minor' : 'major';
      const c = camelot(pc, mode);
      if (c.num === num) return { pc, mode };
    }
    return null;
  }
  function keyName(k, lang) {
    const n = (lang === 'es' ? NAMES_ES : NAMES)[((k.pc % 12) + 12) % 12];
    if (lang === 'es') return n + (k.mode === 'minor' ? ' menor' : ' mayor');
    return n + (k.mode === 'minor' ? 'm' : '');
  }
  // Transpose a key by semitones (may be fractional; rounded to nearest)
  function transpose(k, semis) {
    const s = Math.round(semis);
    return { pc: ((k.pc + s) % 12 + 12) % 12, mode: k.mode };
  }

  // Returns {score 0..3, label, detail}
  function relation(a, b) {
    const ca = camelot(a.pc, a.mode), cb = camelot(b.pc, b.mode);
    const d = ((cb.num - ca.num) % 12 + 12) % 12; // 0..11
    const same = ca.letter === cb.letter;
    if (same && d === 0) return { score: 3, label: 'Misma tonalidad', detail: 'Mezcla armónica perfecta.' };
    if (!same && d === 0) return { score: 3, label: 'Relativa mayor/menor', detail: 'Comparten las mismas notas: cambio de color emocional sin choque.' };
    if (same && (d === 1 || d === 11)) return { score: 2, label: d === 1 ? 'Adyacente (+1 Camelot)' : 'Adyacente (−1 Camelot)', detail: 'Difieren en una sola nota: transición suave' + (d === 1 ? ' que sube la energía.' : ' que relaja la energía.') };
    if (!same && (d === 1 || d === 11)) return { score: 1, label: 'Diagonal', detail: 'Compatible con cuidado: mejor en transiciones cortas o con filtro.' };
    if (same && (d === 2 || d === 10)) return { score: 1, label: 'Salto de energía (±2)', detail: 'Arriesgado pero usable como “energy boost”. Mantén los medios separados.' };
    if (same && (d === 7 || d === 5)) return { score: 1, label: d === 7 ? 'Modulación +1 semitono' : 'Modulación −1 semitono', detail: 'Cambio de tono dramático: funciona con un corte limpio.' };
    return { score: 0, label: 'Choque armónico', detail: 'Las notas chocan. Usa “Armonizar”, un corte, eco de salida o aísla los medios.' };
  }

  // Find semitone shift for B (in -6..6) giving the best compatibility with A.
  // baseShift: pitch shift B already has from tempo change (keylock off).
  function harmonize(a, b, baseShift) {
    let best = null;
    for (let s = -6; s <= 6; s++) {
      const kb = transpose(b, s + (baseShift || 0));
      const r = relation(a, kb);
      const cost = (3 - r.score) * 10 + Math.abs(s) + (s > 0 ? 0.1 : 0);
      if (!best || cost < best.cost) best = { semis: s, key: kb, rel: r, cost };
    }
    return best;
  }

  return { NAMES, NAMES_ES, camelot, camelotStr, fromCamelot, keyName, transpose, relation, harmonize };
})();
