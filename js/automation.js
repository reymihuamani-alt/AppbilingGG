/* Automation lanes: definitions, curve evaluation, parameter mapping, presets. */
const Automation = (function () {
  const LANES = [
    { id: 'vol', name: 'Volumen', short: 'Vol', color: '#4fb3ff', def: 1, desc: 'Nivel de cada pista' },
    { id: 'low', name: 'Graves', short: 'Low', color: '#f7c948', def: 0.5, desc: 'EQ < 250 Hz', group: 'eq' },
    { id: 'mid', name: 'Medios', short: 'Mid', color: '#5ad19a', def: 0.5, desc: 'EQ 250 Hz – 3 kHz', group: 'eq' },
    { id: 'high', name: 'Agudos', short: 'High', color: '#ff7ab6', def: 0.5, desc: 'EQ > 3 kHz', group: 'eq' },
    { id: 'filter', name: 'Filtro', short: 'Filt', color: '#b18cff', def: 0.5, desc: '← paso bajo · paso alto →' },
    { id: 'echo', name: 'Eco', short: 'Echo', color: '#ff9f43', def: 0, desc: 'Envío al delay sincronizado' },
    { id: 'reverb', name: 'Reverb', short: 'Verb', color: '#2ee6d6', def: 0, desc: 'Envío a la reverberación' },
    { id: 'speed', name: 'Velocidad', short: 'Spd', color: '#ff5d5d', def: 1, desc: 'Freno / arranque de vinilo' }
  ];
  const LANE = Object.fromEntries(LANES.map(l => [l.id, l]));
  const SHAPES = [
    { id: 'smooth', name: 'Suave' },
    { id: 'linear', name: 'Lineal' },
    { id: 'fast', name: 'Rápida' },
    { id: 'slow', name: 'Lenta' },
    { id: 'hold', name: 'Escalón' }
  ];

  function shapeT(shape, t) {
    switch (shape) {
      case 'linear': return t;
      case 'fast': return 1 - (1 - t) * (1 - t);
      case 'slow': return t * t;
      case 'hold': return 0;
      default: return (1 - Math.cos(Math.PI * t)) / 2;
    }
  }
  function evalLane(pts, x) {
    if (x <= pts[0].x) return pts[0].v;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (x <= b.x) {
        const dx = b.x - a.x;
        if (dx <= 1e-9) return b.v;
        return a.v + (b.v - a.v) * shapeT(a.shape, (x - a.x) / dx);
      }
    }
    return pts[pts.length - 1].v;
  }

  // ---- mapping lane value (0..1) to audio parameter values ----
  function eqDb(v) {
    if (v >= 0.5) return (v - 0.5) * 2 * 6;
    const r = v / 0.5;
    if (r <= 0.01) return -40;
    return Math.max(-40, 40 * Math.log10(r));
  }
  function lpFreq(v) { return v >= 0.48 ? 22000 : 70 * Math.pow(20000 / 70, Math.max(0, v) / 0.48); }
  function hpFreq(v) { return v <= 0.52 ? 10 : 20 * Math.pow(9000 / 20, (v - 0.52) / 0.48); }
  const map = {
    vol: v => v,
    low: v => eqDb(v), mid: v => eqDb(v), high: v => eqDb(v),
    echo: v => v * 0.85,
    reverb: v => v * 1.1,
    speed: v => Math.max(0.0001, v)
  };
  // Approximate linear gain for drawing waveforms
  function dbToGain(db) { return Math.pow(10, db / 20); }

  function fmt(id, v) {
    switch (id) {
      case 'vol': return Math.round(v * 100) + '%';
      case 'low': case 'mid': case 'high': {
        const d = eqDb(v);
        return d <= -39.5 ? 'Corte (−∞)' : (d > 0 ? '+' : '') + d.toFixed(1) + ' dB';
      }
      case 'filter': {
        if (v < 0.48) { const f = lpFreq(v); return 'Paso bajo ' + (f >= 1000 ? (f / 1000).toFixed(1) + ' kHz' : Math.round(f) + ' Hz'); }
        if (v > 0.52) { const f = hpFreq(v); return 'Paso alto ' + (f >= 1000 ? (f / 1000).toFixed(1) + ' kHz' : Math.round(f) + ' Hz'); }
        return 'Sin filtro';
      }
      case 'echo': case 'reverb': return Math.round(v * 100) + '% envío';
      case 'speed': return Math.round(v * 100) + '% velocidad';
    }
    return v.toFixed(2);
  }

  // ---- presets ----
  const P = (x, v, shape) => ({ x, v, shape: shape || 'smooth' });
  function flat(id) { const d = LANE[id].def; return [P(0, d, 'linear'), P(1, d, 'linear')]; }
  function defaultLanes() {
    const out = { A: {}, B: {} };
    for (const l of LANES) { out.A[l.id] = flat(l.id); out.B[l.id] = flat(l.id); }
    return out;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isFlat(id, pts) {
    const d = LANE[id].def;
    return pts.every(p => Math.abs(p.v - d) < 1e-3);
  }

  const swap = (at, hi) => ({ A: [P(0, hi, 'hold'), P(at, 0, 'linear'), P(1, 0, 'linear')], B: [P(0, 0, 'hold'), P(at, hi, 'linear'), P(1, hi, 'linear')] });

  // Lane presets per lane id: name -> {A, B}
  const LANE_PRESETS = {
    vol: {
      'Crossfade suave': () => ({ A: [P(0, 1), P(1, 0)], B: [P(0, 0), P(1, 1)] }),
      'Crossfade lineal': () => ({ A: [P(0, 1, 'linear'), P(1, 0)], B: [P(0, 0, 'linear'), P(1, 1)] }),
      'Potencia constante': () => ({ A: [P(0, 1, 'slow'), P(1, 0)], B: [P(0, 0, 'fast'), P(1, 1)] }),
      'Corte central': () => ({ A: [P(0, 1, 'hold'), P(0.5, 0, 'linear'), P(1, 0)], B: [P(0, 0, 'hold'), P(0.5, 1, 'linear'), P(1, 1)] }),
      'Entrada temprana': () => ({ A: [P(0, 1, 'hold'), P(0.5, 1, 'smooth'), P(1, 0)], B: [P(0, 0, 'fast'), P(0.4, 1, 'linear'), P(1, 1)] }),
      'Salida tardía': () => ({ A: [P(0, 1, 'hold'), P(0.75, 1, 'smooth'), P(1, 0)], B: [P(0, 0, 'smooth'), P(0.75, 1, 'linear'), P(1, 1)] }),
      'Mantener ambas': () => ({ A: [P(0, 1, 'linear'), P(1, 1)], B: [P(0, 1, 'linear'), P(1, 1)] })
    },
    eq: {
      'Sin cambios': id => ({ A: flat(id), B: flat(id) }),
      'Intercambio central': () => swap(0.5, 0.5),
      'Intercambio temprano': () => swap(0.25, 0.5),
      'Intercambio tardío': () => swap(0.75, 0.5),
      'Intercambio gradual': () => ({ A: [P(0, 0.5), P(1, 0)], B: [P(0, 0), P(1, 0.5)] }),
      'Cortar saliente': () => ({ A: [P(0, 0.5), P(0.5, 0, 'linear'), P(1, 0)], B: [P(0, 0.5, 'linear'), P(1, 0.5)] }),
      'Realce entrante': () => ({ A: [P(0, 0.5, 'linear'), P(1, 0.5)], B: [P(0, 0.75), P(1, 0.5)] })
    },
    filter: {
      'Sin filtro': () => ({ A: flat('filter'), B: flat('filter') }),
      'Paso bajo ↘ / paso alto ↗': () => ({ A: [P(0, 0.5, 'slow'), P(1, 0.08)], B: [P(0, 0.92, 'fast'), P(1, 0.5)] }),
      'Paso alto ↗ / paso bajo ↘': () => ({ A: [P(0, 0.5, 'slow'), P(1, 0.9)], B: [P(0, 0.1, 'fast'), P(1, 0.5)] }),
      'Barrido saliente': () => ({ A: [P(0, 0.5, 'slow'), P(0.8, 0.1, 'linear'), P(1, 0.1)], B: flat('filter') }),
      'Apertura entrante': () => ({ A: flat('filter'), B: [P(0, 0.12, 'smooth'), P(0.8, 0.5, 'linear'), P(1, 0.5)] })
    },
    echo: {
      'Sin eco': () => ({ A: flat('echo'), B: flat('echo') }),
      'Eco de salida': () => ({ A: [P(0, 0, 'fast'), P(0.45, 0.85, 'linear'), P(1, 0.85)], B: flat('echo') }),
      'Eco al final': () => ({ A: [P(0, 0, 'hold'), P(0.75, 0.9, 'linear'), P(1, 0.9)], B: flat('echo') }),
      'Eco en ambas': () => ({ A: [P(0, 0), P(0.5, 0.6), P(1, 0.6)], B: [P(0, 0.6), P(0.5, 0.6), P(1, 0)] })
    },
    reverb: {
      'Sin reverb': () => ({ A: flat('reverb'), B: flat('reverb') }),
      'Lavado de salida': () => ({ A: [P(0, 0, 'slow'), P(0.6, 1, 'linear'), P(1, 1)], B: flat('reverb') }),
      'Entrada desde reverb': () => ({ A: flat('reverb'), B: [P(0, 1, 'smooth'), P(0.6, 0, 'linear'), P(1, 0)] })
    },
    speed: {
      'Normal': () => ({ A: flat('speed'), B: flat('speed') }),
      'Freno al final': () => ({ A: [P(0, 1, 'hold'), P(0.625, 1, 'linear'), P(0.75, 0, 'linear'), P(1, 0)], B: flat('speed') }),
      'Freno a la mitad': () => ({ A: [P(0, 1, 'hold'), P(0.375, 1, 'linear'), P(0.5, 0, 'linear'), P(1, 0)], B: flat('speed') }),
      'Arranque de vinilo': () => ({ A: flat('speed'), B: [P(0, 0, 'fast'), P(0.12, 1, 'linear'), P(1, 1)] })
    }
  };
  function lanePresetGroup(id) { return LANE[id].group === 'eq' ? 'eq' : id; }
  function lanePresetNames(id) { return Object.keys(LANE_PRESETS[lanePresetGroup(id)]); }
  function lanePreset(id, name) {
    const f = LANE_PRESETS[lanePresetGroup(id)][name];
    return f ? clone(f(id)) : null;
  }

  // Global transition presets: list of [laneId, lanePresetName] or custom
  const PRESETS = [
    {
      id: 'fade', name: 'Fade', desc: 'Crossfade suave clásico',
      lanes: { vol: 'Crossfade suave' }
    },
    {
      id: 'bass', name: 'Intercambio de graves', desc: 'Crossfade + cambio de graves en el centro (estilo DJ)',
      lanes: { vol: 'Crossfade suave', low: 'Intercambio central' }
    },
    {
      id: 'bands', name: 'Intercambio por bandas', desc: 'Agudos → medios → graves, uno tras otro',
      custom: () => {
        const o = {};
        o.vol = { A: [P(0, 1, 'hold'), P(0.75, 1, 'smooth'), P(1, 0)], B: [P(0, 0, 'smooth'), P(0.25, 1, 'linear'), P(1, 1)] };
        o.high = swap(0.25, 0.5); o.mid = swap(0.5, 0.5); o.low = swap(0.75, 0.5);
        return o;
      }
    },
    {
      id: 'crescendo', name: 'Crescendo', desc: 'La entrante sube filtrada y explota en el último cuarto',
      custom: () => ({
        vol: { A: [P(0, 1, 'hold'), P(0.75, 1, 'smooth'), P(1, 0)], B: [P(0, 0, 'slow'), P(0.75, 1, 'linear'), P(1, 1)] },
        filter: { A: [P(0, 0.5, 'slow'), P(0.75, 0.3, 'linear'), P(1, 0.15)], B: [P(0, 0.92, 'smooth'), P(0.75, 0.5, 'linear'), P(1, 0.5)] },
        low: swap(0.75, 0.5)
      })
    },
    {
      id: 'filter', name: 'Barrido de filtro', desc: 'Paso bajo en la saliente, paso alto que se abre en la entrante',
      lanes: { vol: 'Potencia constante', filter: 'Paso bajo ↘ / paso alto ↗' }
    },
    {
      id: 'echo', name: 'Eco de salida', desc: 'La saliente se corta en el centro dejando ecos a tempo',
      custom: () => ({
        vol: LANE_PRESETS.vol['Corte central'](),
        echo: { A: [P(0, 0, 'fast'), P(0.45, 0.85, 'linear'), P(1, 0.85)] },
        filter: { A: [P(0, 0.5, 'slow'), P(0.5, 0.7, 'linear'), P(1, 0.8)], B: flat('filter') }
      })
    },
    {
      id: 'reverb', name: 'Lavado de reverb', desc: 'La saliente se disuelve en reverberación',
      custom: () => ({
        vol: { A: [P(0, 1, 'hold'), P(0.6, 1, 'linear'), P(0.68, 0, 'linear'), P(1, 0)], B: [P(0, 0, 'hold'), P(0.55, 0, 'smooth'), P(1, 1)] },
        reverb: LANE_PRESETS.reverb['Lavado de salida'](),
        filter: { A: [P(0, 0.5, 'slow'), P(0.6, 0.78, 'linear'), P(1, 0.78)], B: flat('filter') }
      })
    },
    {
      id: 'cut', name: 'Corte', desc: 'Cambio seco en el compás central',
      lanes: { vol: 'Corte central' }
    },
    {
      id: 'brake', name: 'Freno', desc: 'La saliente frena como un vinilo y entra la nueva de golpe',
      custom: () => ({
        speed: LANE_PRESETS.speed['Freno al final'](),
        vol: { A: [P(0, 1, 'hold'), P(0.75, 0, 'linear'), P(1, 0)], B: [P(0, 0, 'hold'), P(0.75, 1, 'linear'), P(1, 1)] },
        echo: { A: [P(0, 0, 'hold'), P(0.62, 0.5, 'linear'), P(1, 0.5)], B: flat('echo') }
      })
    }
  ];

  // Build a full lane set from a preset. Returns {lanes, lanePresetNames}
  function buildPreset(preset) {
    const lanes = defaultLanes();
    const names = {};
    for (const l of LANES) names[l.id] = lanePresetNames(l.id)[0];
    if (preset.lanes) {
      for (const [id, nm] of Object.entries(preset.lanes)) {
        const lp = lanePreset(id, nm);
        lanes.A[id] = lp.A; lanes.B[id] = lp.B; names[id] = nm;
      }
    }
    if (preset.custom) {
      const c = preset.custom();
      for (const [id, v] of Object.entries(c)) {
        if (Array.isArray(v.A)) { lanes.A[id] = clone(v.A); names[id] = 'Personalizada'; }
        if (Array.isArray(v.B)) { lanes.B[id] = clone(v.B); names[id] = 'Personalizada'; }
      }
      // try to recognise lane presets
      for (const l of LANES) {
        for (const nm of lanePresetNames(l.id)) {
          const lp = lanePreset(l.id, nm);
          if (JSON.stringify(lp.A) === JSON.stringify(lanes.A[l.id]) && JSON.stringify(lp.B) === JSON.stringify(lanes.B[l.id])) { names[l.id] = nm; break; }
        }
      }
    }
    return { lanes, names };
  }

  return { LANES, LANE, SHAPES, PRESETS, evalLane, shapeT, map, eqDb, lpFreq, hpFreq, dbToGain, fmt, defaultLanes, flat, clone, isFlat, lanePresetNames, lanePreset, buildPreset };
})();
