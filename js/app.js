/* Mixeo — UI controller */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const el = (tag, attrs, html) => {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    if (html != null) e.innerHTML = html;
    return e;
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtTime = (s, dec) => {
    const neg = s < 0; s = Math.abs(s);
    const m = Math.floor(s / 60), r = s - m * 60;
    const sec = dec ? r.toFixed(1).padStart(4, '0') : String(Math.floor(r)).padStart(2, '0');
    return (neg ? '−' : '') + String(m).padStart(2, '0') + ':' + sec;
  };

  const COLORS = { low: '#3049e0', mid: '#b97a3e', high: '#efe5d6' };
  const LS_KEY = 'mixeo.userPresets.v1';

  // ------------------------------------------------------------------ state
  const st = {
    tracks: { A: null, B: null },
    deck: {
      A: { point: 0, semis: 0, keylock: true, gain: 0 },
      B: { point: 0, semis: 0, keylock: true, gain: 0 }
    },
    trans: { bars: 8, preBars: 4, postBars: 4, sync: 'toA', echoBeats: 0.75, echoFb: 0.45, reverbSize: 0.55, filterRes: 1.2, masterDb: 0 },
    lanes: null, laneNames: {}, preset: 'bass',
    sel: { lane: 'vol', deck: null, idx: -1 },
    snap: true, fxView: true, loop: false,
    playhead: 0
  };
  {
    const b = Automation.buildPreset(Automation.PRESETS.find(p => p.id === 'bass'));
    st.lanes = b.lanes; st.laneNames = b.names;
  }
  let trackSeq = 0;
  const ready = () => !!(st.tracks.A && st.tracks.B);

  // ------------------------------------------------------------------ helpers
  const beatLen = tr => 60 / tr.bpm;
  function snapTime(tr, t, beats) {
    const u = beats * beatLen(tr);
    return tr.downbeat + Math.round((t - tr.downbeat) / u) * u;
  }
  function barOf(tr, t) {
    const b = (t - tr.downbeat) / beatLen(tr);
    const bar = Math.floor(b / 4) + 1, beat = Math.floor(((b % 4) + 4) % 4) + 1;
    return { bar, beat };
  }
  function tempoOf(deck) {
    if (!ready()) return 1;
    const tl = Engine.timeline(st);
    return deck === 'A' ? tl.tA : tl.tB;
  }
  function effectiveKey(deck) {
    const tr = st.tracks[deck], d = st.deck[deck];
    if (!tr) return null;
    const shift = d.semis + (d.keylock ? 0 : 12 * Math.log2(tempoOf(deck)));
    return Theory.transpose(tr.key, shift);
  }
  function hashColor(str) {
    let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const h1 = h % 360, h2 = (h1 + 40 + (h >> 8) % 80) % 360;
    return [`hsl(${h1} 70% 55%)`, `hsl(${h2} 55% 22%)`];
  }
  let toastT;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms || 2600);
  }
  function setBusy(on, text) {
    $('#busy').hidden = !on;
    if (text) $('#busyText').textContent = text;
  }

  // ------------------------------------------------------------------ history
  const hist = { past: [], future: [] };
  const snap = () => JSON.stringify({ lanes: st.lanes, laneNames: st.laneNames, preset: st.preset, deck: st.deck, trans: st.trans });
  let lastSnap = null;
  function commit() {
    const s = snap();
    if (s === lastSnap) return;
    if (lastSnap) hist.past.push(lastSnap);
    if (hist.past.length > 100) hist.past.shift();
    hist.future = [];
    lastSnap = s;
    updateUndo();
  }
  function restore(s) {
    const o = JSON.parse(s);
    Object.assign(st, { lanes: o.lanes, laneNames: o.laneNames, preset: o.preset, deck: o.deck, trans: o.trans });
    st.sel.idx = -1; st.sel.deck = null;
    lastSnap = s;
    refreshAll(); invalidate();
  }
  function undo() { if (!hist.past.length) return; hist.future.push(lastSnap); restore(hist.past.pop()); updateUndo(); }
  function redo() { if (!hist.future.length) return; hist.past.push(lastSnap); restore(hist.future.pop()); updateUndo(); }
  function updateUndo() { $('#undoBtn').disabled = !hist.past.length; $('#redoBtn').disabled = !hist.future.length; }

  // ------------------------------------------------------------------ loading tracks
  async function addTrack(deck, raw) {
    setBusy(true, 'Analizando ' + raw.name + '…');
    const chs = raw.channels.slice(0, 2);
    const a = await DSPWorker.analyze(chs.map(c => c.slice()), raw.sr);
    const tr = {
      id: ++trackSeq, name: raw.name, artist: raw.artist, channels: chs, sr: raw.sr,
      duration: chs[0].length / raw.sr,
      bands: a.bands, bpm: a.tempo.bpm, bpmDetected: a.tempo.bpm, downbeat: a.tempo.downbeat,
      tempoConf: a.tempo.confidence,
      key: { pc: a.key.pc, mode: a.key.mode }, keyDetected: { pc: a.key.pc, mode: a.key.mode }, keyConf: a.key.confidence,
      color: raw.color || hashColor(raw.name)
    };
    st.tracks[deck] = tr;
    st.deck[deck].semis = 0;
    defaultPoint(deck);
    if (deck === 'B' && st.tracks.A) defaultPoint('A');
    setBusy(false);
    refreshAll();
    invalidate();
    commit();
  }
  function defaultPoint(deck) {
    const tr = st.tracks[deck];
    if (!tr) return;
    if (deck === 'B') {
      let p = tr.downbeat;
      while (p < 0) p += 4 * beatLen(tr);
      st.deck.B.point = p;
    } else {
      const t = st.tracks.B ? tempoOf('A') : 1;
      const need = (st.trans.bars + st.trans.postBars) * 4 * beatLen(tr) * (st.trans.sync === 'toB' && st.tracks.B ? 1 : 1);
      let p = snapTime(tr, tr.duration - need * t - 4 * beatLen(tr), 4);
      p = clamp(p, 0, tr.duration);
      st.deck.A.point = p;
    }
  }
  async function loadFile(deck, file) {
    try {
      setBusy(true, 'Decodificando…');
      const ab = await file.arrayBuffer();
      const buf = await Engine.ctx().decodeAudioData(ab);
      const chs = [];
      for (let i = 0; i < Math.min(2, buf.numberOfChannels); i++) chs.push(buf.getChannelData(i).slice());
      if (chs.length === 1) chs.push(chs[0].slice());
      let base = file.name.replace(/\.[^.]+$/, '');
      let artist = 'Archivo local', name = base;
      const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      if (m) { artist = m[1]; name = m[2]; }
      await addTrack(deck, { name, artist, channels: chs, sr: buf.sampleRate });
      toast('Pista ' + deck + ' cargada: ' + name);
    } catch (e) {
      console.error(e);
      setBusy(false);
      toast('No se pudo leer el archivo de audio');
    }
  }
  async function loadDemo() {
    setBusy(true, 'Generando canciones demo…');
    $('#emptyState').hidden = true;
    await new Promise(r => setTimeout(r, 30));
    const a = Demo.trackOne();
    await new Promise(r => setTimeout(r, 0));
    const b = Demo.trackTwo();
    st.tracks.A = null; st.tracks.B = null;
    await addTrack('A', a);
    await addTrack('B', b);
    toast('Canciones demo cargadas — pulsa ▶ para escuchar');
  }

  // ------------------------------------------------------------------ render scheduling
  let renderVer = 0, rendered = null, renderTimer = null, wantPlay = false;
  function invalidate(immediate) {
    staticDirty = true;
    if (!ready()) return;
    renderVer++;
    clearTimeout(renderTimer);
    setBusy(true, 'Renderizando…');
    renderTimer = setTimeout(doRender, immediate ? 0 : 200);
  }
  async function doRender() {
    const v = renderVer;
    try {
      const r = await Engine.render(st);
      if (v !== renderVer) return;
      rendered = r;
      setBusy(false);
      $('#exportBtn').disabled = false;
      if (Engine.isPlaying() || wantPlay) {
        const pos = clamp(st.playhead, 0, r.buffer.duration - 0.05);
        startPlayback(pos);
      }
    } catch (e) {
      console.error(e);
      if (v === renderVer) { setBusy(false); toast('Error al renderizar: ' + e.message); }
    }
  }
  function startPlayback(from) {
    wantPlay = false;
    const dur = rendered.buffer.duration;
    if (from >= dur - 0.05) from = 0;
    Engine.play(rendered.buffer, from, st.loop, () => { $('#playBtn').classList.remove('playing'); st.playhead = 0; staticDirty = true; });
    $('#playBtn').classList.add('playing');
  }
  function togglePlay() {
    if (!ready()) { toast('Carga dos canciones primero'); return; }
    if (Engine.isPlaying() || wantPlay) {
      Engine.stop(); wantPlay = false;
      $('#playBtn').classList.remove('playing');
      return;
    }
    Engine.ctx().resume && Engine.ctx().resume();
    if (rendered && !renderTimer_pending()) startPlayback(st.playhead);
    else { wantPlay = true; $('#playBtn').classList.add('playing'); }
  }
  function renderTimer_pending() { return !$('#busy').hidden; }
  function seek(u) {
    st.playhead = clamp(u, 0, rendered ? rendered.buffer.duration : 1e9);
    if (Engine.isPlaying() && rendered) startPlayback(st.playhead);
  }

  // ------------------------------------------------------------------ deck UI
  function deckHTML(deck) {
    const tr = st.tracks[deck];
    const tag = deck === 'A' ? 'A · Saliente' : 'B · Entrante';
    if (!tr) {
      return `<div class="deck-head">
        <div class="art" style="background:#2a2a2a">${deck}</div>
        <div class="deck-info"><div class="deck-tag">${tag}</div><div class="deck-title" style="color:var(--muted)">Sin canción</div>
        <div class="deck-artist">Carga un archivo de audio (mp3, wav, m4a, ogg…)</div></div>
        <div class="deck-meta"><button class="pill-btn" data-act="load">Cargar</button></div></div>`;
    }
    return `<div class="deck-head">
      <div class="art" style="background:linear-gradient(135deg,${tr.color[0]},${tr.color[1]})">${deck}</div>
      <div class="deck-info">
        <div class="deck-tag">${tag}</div>
        <div class="deck-title" title="${esc(tr.name)}">${esc(tr.name)}</div>
        <div class="deck-artist">${esc(tr.artist)}</div>
      </div>
      <div class="deck-meta">
        <button class="bpm" data-act="bpm" title="Toca para corregir el BPM"></button>
        <div class="meta2"><button class="key-badge" data-act="key" title="Toca para corregir la tonalidad"></button><span>${fmtTime(tr.duration)}</span></div>
      </div>
    </div>
    <div class="overview-wrap">
      <canvas class="overview" data-deck="${deck}"></canvas>
      <div class="deck-controls">
        <span class="lbl">${deck === 'A' ? 'Sale en' : 'Entra en'}</span><span class="pos" data-role="pos"></span>
        <button class="chip small" data-nudge="-4">−compás</button>
        <button class="chip small" data-nudge="-1">−beat</button>
        <button class="chip small" data-nudge="1">+beat</button>
        <button class="chip small" data-nudge="4">+compás</button>
      </div>
      <div class="deck-adv">
        <span class="lbl" style="font-size:12px;color:var(--muted)">Tono</span>
        <div class="stepper"><button data-act="semi-">−</button><span data-role="semi"></span><button data-act="semi+">+</button></div>
        <button class="chip small toggle" data-act="keylock" title="Mantener el tono al cambiar el tempo"></button>
        <span class="lbl" style="font-size:12px;color:var(--muted)">Gan.</span>
        <div class="stepper"><button data-act="gain-">−</button><span data-role="gain"></span><button data-act="gain+">+</button></div>
        <button class="load-btn" data-act="load">Cambiar canción</button>
      </div>
    </div>`;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function buildDeck(deck) {
    const root = $('#deck' + deck);
    root.innerHTML = deckHTML(deck);
    const ov = root.querySelector('.overview');
    if (ov) bindOverview(ov, deck);
    updateDeck(deck);
  }
  function updateDeck(deck) {
    const root = $('#deck' + deck), tr = st.tracks[deck], d = st.deck[deck];
    if (!tr || !root.querySelector('.bpm')) return;
    const other = st.tracks[deck === 'A' ? 'B' : 'A'];
    const t = tempoOf(deck);
    const bpmBtn = root.querySelector('.bpm');
    const big = other && Math.abs(tr.bpm / other.bpm - 1) > 0.06;
    bpmBtn.className = 'bpm' + (big ? ' warn' : '');
    const shown = ready() && Math.abs(t - 1) > 1e-4 ? `${fmtBpm(tr.bpm)} → ${fmtBpm(tr.bpm * t)} bpm` : `${fmtBpm(tr.bpm)} bpm`;
    bpmBtn.innerHTML = (big ? '<span class="warn-i">!</span>' : '') + shown;
    bpmBtn.title = big ? 'Diferencia de tempo grande (' + Math.round(Math.abs(tr.bpm / other.bpm - 1) * 100) + '%). El estiramiento puede ser audible.' : 'Toca para corregir el BPM';
    const kb = root.querySelector('.key-badge');
    const ek = effectiveKey(deck);
    const orig = Theory.camelotStr(tr.key), eff = Theory.camelotStr(ek);
    kb.textContent = orig === eff ? eff : orig + '→' + eff;
    let cls = '';
    if (ready()) {
      const r = Theory.relation(effectiveKey('A'), effectiveKey('B'));
      cls = r.score >= 2 ? 'k-good' : r.score === 1 ? 'k-ok' : 'k-bad';
    }
    kb.className = 'key-badge ' + cls;
    kb.title = Theory.keyName(ek, 'es') + ' (' + Theory.keyName(ek) + ')';
    const bo = barOf(tr, d.point);
    root.querySelector('[data-role=pos]').textContent = `${fmtTime(d.point, true)} · compás ${bo.bar}.${bo.beat}`;
    root.querySelector('[data-role=semi]').textContent = (d.semis > 0 ? '+' : '') + d.semis + ' st';
    root.querySelector('[data-role=gain]').textContent = (d.gain > 0 ? '+' : '') + d.gain + ' dB';
    const kl = root.querySelector('[data-act=keylock]');
    kl.textContent = d.keylock ? '🔒 Key lock' : '🔓 Key lock';
    kl.classList.toggle('on', d.keylock);
    drawOverview(deck);
  }
  const fmtBpm = b => (Math.round(b * 10) / 10).toString().replace(/\.0$/, '');

  function onDeckClick(deck, e) {
    const b = e.target.closest('button');
    if (!b) return;
    const tr = st.tracks[deck], d = st.deck[deck];
    const act = b.dataset.act;
    if (act === 'load') { pickFile(deck); return; }
    if (!tr) return;
    if (b.dataset.nudge) {
      d.point = clamp(snapTime(tr, d.point, 1) + Number(b.dataset.nudge) * beatLen(tr), 0, tr.duration);
      changed();
    } else if (act === 'semi-' || act === 'semi+') {
      d.semis = clamp(d.semis + (act === 'semi+' ? 1 : -1), -12, 12); changed();
    } else if (act === 'gain-' || act === 'gain+') {
      d.gain = clamp(d.gain + (act === 'gain+' ? 1 : -1), -12, 12); changed();
    } else if (act === 'keylock') {
      d.keylock = !d.keylock; changed();
      toast(d.keylock ? 'Key lock activado: el tono se mantiene al cambiar el tempo' : 'Key lock desactivado: el tono sigue a la velocidad (efecto vinilo)');
    } else if (act === 'bpm') {
      const v = prompt('BPM de "' + tr.name + '" (detectado: ' + tr.bpmDetected + ').\nPuedes escribir un número, o "x2" / "/2".', tr.bpm);
      if (v == null) return;
      let n = v.trim() === 'x2' ? tr.bpm * 2 : v.trim() === '/2' ? tr.bpm / 2 : parseFloat(v.replace(',', '.'));
      if (!(n >= 40 && n <= 250)) { toast('BPM no válido'); return; }
      tr.bpm = n; changed();
    } else if (act === 'key') {
      const v = prompt('Tonalidad en notación Camelot (ej. 8A, 11B).\nDetectada: ' + Theory.camelotStr(tr.keyDetected) + ' — ' + Theory.keyName(tr.keyDetected, 'es'), Theory.camelotStr(tr.key));
      if (v == null) return;
      const m = v.trim().toUpperCase().match(/^(\d{1,2})([AB])$/);
      if (!m || +m[1] < 1 || +m[1] > 12) { toast('Formato no válido (usa por ejemplo 8A)'); return; }
      tr.key = Theory.fromCamelot(+m[1], m[2]); changed();
    }
  }
  function changed(noCommit) {
    refreshDecks(); refreshCompat(); refreshSettings();
    invalidate();
    if (!noCommit) commit();
  }
  function pickFile(deck) {
    const fi = $('#fileInput');
    fi.value = '';
    fi.onchange = () => { if (fi.files[0]) loadFile(deck, fi.files[0]); };
    fi.click();
  }

  // ------------------------------------------------------------------ overview (whole song)
  function sizeCanvas(c) {
    const r = c.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w: r.width, h: r.height };
  }
  function bandsAt(tr, s0, s1) {
    const b = tr.bands, R = b.rate;
    let i0 = Math.floor(s0 * R), i1 = Math.ceil(s1 * R);
    if (i1 <= i0) i1 = i0 + 1;
    let l = 0, m = 0, h = 0;
    if (i1 <= 0 || i0 >= b.low.length) return null;
    i0 = Math.max(0, i0); i1 = Math.min(b.low.length, i1);
    for (let i = i0; i < i1; i++) { if (b.low[i] > l) l = b.low[i]; if (b.mid[i] > m) m = b.mid[i]; if (b.high[i] > h) h = b.high[i]; }
    return [l, m, h];
  }
  function drawWaveCol(g, x, w, cy, amp, l, m, h, alpha) {
    const tot = Math.pow(l + m + h, 0.8) * amp, mh = Math.pow(m + h, 0.8) * amp, hh = Math.pow(h, 0.8) * amp * 0.9;
    g.globalAlpha = alpha;
    g.fillStyle = COLORS.low; g.fillRect(x, cy - tot, w, tot * 2);
    g.fillStyle = COLORS.mid; g.fillRect(x, cy - mh, w, mh * 2);
    g.fillStyle = COLORS.high; g.fillRect(x, cy - hh, w, hh * 2);
    g.globalAlpha = 1;
  }
  function drawOverview(deck) {
    const c = document.querySelector(`.overview[data-deck=${deck}]`);
    const tr = st.tracks[deck];
    if (!c || !tr) return;
    const { g, w, h } = sizeCanvas(c);
    g.clearRect(0, 0, w, h);
    const dur = tr.duration, cy = h / 2;
    let span = null;
    if (ready()) {
      const tl = Engine.timeline(st), t = deck === 'A' ? tl.tA : tl.tB;
      const p = st.deck[deck].point;
      span = { from: p - tl.Pr * t, a: p, b: p + tl.L * t, to: p + (tl.L + tl.Po) * t };
    }
    for (let x = 0; x < w; x += 1) {
      const s0 = x / w * dur, s1 = (x + 1) / w * dur;
      const b = bandsAt(tr, s0, s1);
      if (!b) continue;
      const mid = (s0 + s1) / 2;
      let a = 0.45;
      if (span && mid >= span.from && mid <= span.to) a = 0.8;
      if (span && mid >= span.a && mid <= span.b) a = 1;
      drawWaveCol(g, x, 1, cy, h / 2 - 3, b[0], b[1], b[2], a);
    }
    if (span) {
      const xa = span.a / dur * w, xb = span.b / dur * w;
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(xa, 0, Math.max(2, xb - xa), h);
      g.fillStyle = '#1ed760';
      g.fillRect(xa - 1, 0, 2.5, h);
      g.beginPath(); g.moveTo(xa - 6, 0); g.lineTo(xa + 7, 0); g.lineTo(xa + 0.5, 8); g.fill();
    }
  }
  function bindOverview(c, deck) {
    let drag = false;
    const setFromX = (clientX, fine) => {
      const tr = st.tracks[deck];
      const r = c.getBoundingClientRect();
      let t = clamp((clientX - r.left) / r.width, 0, 1) * tr.duration;
      t = st.snap ? snapTime(tr, t, fine ? 1 : 4) : t;
      st.deck[deck].point = clamp(t, 0, tr.duration);
      refreshDecks(); refreshCompat(); staticDirty = true;
    };
    c.addEventListener('pointerdown', e => { drag = true; c.setPointerCapture(e.pointerId); setFromX(e.clientX, e.shiftKey); });
    c.addEventListener('pointermove', e => { if (drag) setFromX(e.clientX, e.shiftKey); });
    const end = () => { if (drag) { drag = false; invalidate(); commit(); } };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------------ editor canvas
  const canvas = $('#editorCanvas');
  const off = document.createElement('canvas');
  let staticDirty = true;
  const RH = 26; // ruler height
  const M = 16;  // vertical margin for curves inside each half
  function geo() {
    const r = canvas.getBoundingClientRect();
    const W = r.width, H = r.height;
    const half = (H - RH - 8) / 2;
    const tl = Engine.timeline(st);
    const xOf = u => u / tl.total * W;
    const uOf = x => x / W * tl.total;
    const x0 = xOf(tl.Pr), x1 = xOf(tl.Pr + tl.L);
    const top = { A: RH, B: RH + half + 8 };
    const yOf = (deck, v) => top[deck] + M + (1 - v) * (half - 2 * M);
    const vOf = (deck, y) => clamp(1 - (y - top[deck] - M) / (half - 2 * M), 0, 1);
    const xr = x => (x - x0) / (x1 - x0);
    const xa = r => x0 + r * (x1 - x0);
    return { W, H, half, tl, xOf, uOf, x0, x1, top, yOf, vOf, xr, xa };
  }
  function laneGainsAt(deck, r) {
    const L = st.lanes[deck];
    const ev = id => Automation.evalLane(L[id], clamp(r, 0, 1));
    const vol = ev('vol') * Math.pow(10, (st.deck[deck].gain || 0) / 20);
    let gl = Automation.dbToGain(Automation.eqDb(ev('low'))) * vol;
    let gm = Automation.dbToGain(Automation.eqDb(ev('mid'))) * vol;
    let gh = Automation.dbToGain(Automation.eqDb(ev('high'))) * vol;
    const f = ev('filter');
    const lp = Automation.lpFreq(f), hp = Automation.hpFreq(f);
    gh *= Math.min(1, lp / 5000); gm *= Math.min(1, lp / 900); gl *= Math.min(1, lp / 120);
    gl *= Math.min(1, 180 / hp); gm *= Math.min(1, 1800 / hp); gh *= Math.min(1, 7000 / hp);
    return [gl, gm, gh];
  }
  function drawStatic() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    off.width = Math.max(1, Math.round(r.width * dpr)); off.height = Math.max(1, Math.round(r.height * dpr));
    const g = off.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    if (!ready()) return;
    const G = geo(), { W, H, half, tl, xOf, x0, x1, top } = G;

    // transition window
    g.fillStyle = '#262626';
    roundRect(g, x0, RH, x1 - x0, H - RH - 2, 18); g.fill();

    // grid
    const beat = tl.beat, nb = Math.round(tl.total / beat);
    for (let k = 0; k <= nb; k++) {
      const u = k * beat;
      const x = xOf(u);
      const rel = Math.round((u - tl.Pr) / beat);
      const isBar = ((rel % 4) + 4) % 4 === 0;
      const inside = u >= tl.Pr - 1e-6 && u <= tl.Pr + tl.L + 1e-6;
      g.fillStyle = isBar ? (inside ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.05)') : 'rgba(255,255,255,0.025)';
      g.fillRect(x, RH, 1, H - RH);
      // ruler
      g.fillStyle = isBar ? '#8a8a8a' : '#444';
      g.fillRect(x, isBar ? 6 : 15, 1, isBar ? 14 : 5);
      if (isBar) {
        const bar = rel / 4;
        const lab = bar < 0 ? String(bar) : bar < st.trans.bars ? String(bar + 1) : '+' + (bar - st.trans.bars + 1);
        g.fillStyle = inside && bar < st.trans.bars ? '#e6e6e6' : '#777';
        g.font = '11px system-ui, sans-serif';
        g.fillText(lab, x + 4, 15);
      }
    }
    // center lines
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, top.A + half / 2, W, 1);
    g.fillRect(0, top.B + half / 2, W, 1);

    // waveforms
    for (const deck of ['A', 'B']) {
      const tr = st.tracks[deck];
      const t = deck === 'A' ? tl.tA : tl.tB;
      const src = deck === 'A' ? tl.srcA : tl.srcB;
      const cy = top[deck] + half / 2, amp = half / 2 - 6;
      const step = 1;
      for (let x = 0; x < W; x += step) {
        const u0 = G.uOf(x), u1 = G.uOf(x + step);
        const b = bandsAt(tr, src(u0), src(u1));
        if (!b) continue;
        let [l, m, h] = b;
        let alpha = 0.95;
        if (st.fxView) {
          const gains = laneGainsAt(deck, ((u0 + u1) / 2 - tl.Pr) / tl.L);
          l *= gains[0]; m *= gains[1]; h *= gains[2];
        } else if (u0 < tl.Pr || u0 > tl.Pr + tl.L) alpha = 0.55;
        drawWaveCol(g, x, step + 0.4, cy, amp, l, m, h, alpha);
      }
    }

    // labels
    g.font = '600 11px system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,.55)';
    g.fillText('A  ' + st.tracks.A.name, 10, top.A + 14);
    g.fillText('B  ' + st.tracks.B.name, 10, top.B + half - 6);

    // curves
    const selLane = st.sel.lane;
    const order = Automation.LANES.filter(l => l.id !== selLane).concat([Automation.LANE[selLane]]);
    for (const lane of order) {
      for (const deck of ['A', 'B']) {
        const pts = st.lanes[deck][lane.id];
        const isSel = lane.id === selLane;
        if (!isSel && Automation.isFlat(lane.id, pts)) continue;
        g.save();
        g.beginPath(); g.rect(x0 - 2, top[deck], x1 - x0 + 4, half); g.clip();
        g.strokeStyle = lane.color; g.lineWidth = isSel ? 3.5 : 2; g.globalAlpha = isSel ? 1 : 0.4;
        g.lineJoin = 'round';
        g.beginPath();
        const n = Math.max(60, Math.round(x1 - x0));
        for (let i = 0; i <= n; i++) {
          const rr = i / n;
          const y = G.yOf(deck, Automation.evalLane(pts, rr));
          const x = G.xa(rr);
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
        g.restore();
        if (isSel) {
          pts.forEach((p, i) => {
            const x = G.xa(p.x), y = G.yOf(deck, p.v);
            const selected = st.sel.deck === deck && st.sel.idx === i;
            g.beginPath(); g.arc(x, y, selected ? 8 : 6, 0, Math.PI * 2);
            g.fillStyle = selected ? '#fff' : '#1b1b1b'; g.fill();
            g.lineWidth = 2.5; g.strokeStyle = lane.color; g.stroke();
          });
        }
      }
    }
    staticDirty = false;
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function drawFrame() {
    const { g, w, h } = sizeCanvas(canvas);
    if (staticDirty) drawStatic();
    g.clearRect(0, 0, w, h);
    if (!ready()) return;
    g.drawImage(off, 0, 0, w, h);
    const G = geo();
    const x = G.xOf(st.playhead);
    g.fillStyle = '#fff';
    g.fillRect(x - 0.75, RH - 4, 1.5, h - RH + 4);
    g.beginPath(); g.moveTo(x - 6, RH - 8); g.lineTo(x + 6, RH - 8); g.lineTo(x, RH - 1); g.fill();
  }

  // pointer interaction on editor
  const ptr = { mode: null, deck: null, idx: -1, moved: false, lastTap: 0, lastIdx: -1 };
  function hit(G, deck, px, py) {
    const pts = st.lanes[deck][st.sel.lane];
    let best = -1, bd = 22;
    pts.forEach((p, i) => {
      const d = Math.hypot(G.xa(p.x) - px, G.yOf(deck, p.v) - py);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  function snapR(r) {
    if (!st.snap) return r;
    const n = st.trans.bars * 4 * 2; // half-beat grid
    return Math.round(r * n) / n;
  }
  canvas.addEventListener('pointerdown', e => {
    if (!ready()) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const G = geo();
    canvas.setPointerCapture(e.pointerId);
    if (py < RH) { ptr.mode = 'seek'; seek(G.uOf(px)); staticDirty = true; return; }
    const deck = py < G.top.B ? 'A' : 'B';
    const pts = st.lanes[deck][st.sel.lane];
    let idx = hit(G, deck, px, py);
    const now = performance.now();
    if (idx >= 0) {
      if (now - ptr.lastTap < 320 && ptr.lastIdx === idx && st.sel.deck === deck) {
        deletePoint(deck, idx);
        ptr.lastTap = 0; ptr.mode = null;
        return;
      }
      ptr.lastTap = now; ptr.lastIdx = idx;
      st.sel.deck = deck; st.sel.idx = idx;
      ptr.mode = 'drag'; ptr.deck = deck; ptr.idx = idx; ptr.moved = false;
    } else if (px >= G.x0 - 14 && px <= G.x1 + 14) {
      const r = snapR(clamp(G.xr(px), 0, 1));
      if (r <= 0 || r >= 1) { ptr.mode = null; return; }
      const v = G.vOf(deck, py);
      let ins = pts.findIndex(p => p.x > r);
      if (ins < 0) ins = pts.length;
      const prevShape = pts[ins - 1] ? pts[ins - 1].shape : 'smooth';
      pts.splice(ins, 0, { x: r, v, shape: prevShape });
      st.sel.deck = deck; st.sel.idx = ins;
      ptr.mode = 'drag'; ptr.deck = deck; ptr.idx = ins; ptr.moved = true;
      ptr.lastTap = now; ptr.lastIdx = ins;
      markCustom(st.sel.lane);
    } else {
      st.sel.deck = null; st.sel.idx = -1; ptr.mode = null;
    }
    staticDirty = true; refreshPointBar();
  });
  canvas.addEventListener('pointermove', e => {
    if (!ptr.mode) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const G = geo();
    if (ptr.mode === 'seek') { seek(G.uOf(px)); return; }
    const pts = st.lanes[ptr.deck][st.sel.lane];
    const p = pts[ptr.idx];
    if (!p) return;
    let v = G.vOf(ptr.deck, py);
    const def = Automation.LANE[st.sel.lane].def;
    if (Math.abs(v - def) < 0.025) v = def;
    if (ptr.idx > 0 && ptr.idx < pts.length - 1) {
      const lo = pts[ptr.idx - 1].x, hi = pts[ptr.idx + 1].x;
      p.x = clamp(snapR(clamp(G.xr(px), 0, 1)), lo, hi);
    }
    if (Math.abs(p.v - v) > 1e-4) ptr.moved = true;
    p.v = v;
    markCustom(st.sel.lane);
    staticDirty = true; refreshPointBar();
  });
  const endPtr = () => {
    if (ptr.mode === 'drag' && ptr.moved) { invalidate(); commit(); refreshLanes(); refreshPresets(); }
    ptr.mode = null;
  };
  canvas.addEventListener('pointerup', endPtr);
  canvas.addEventListener('pointercancel', endPtr);

  function deletePoint(deck, idx) {
    const pts = st.lanes[deck][st.sel.lane];
    if (idx <= 0 || idx >= pts.length - 1) { toast('Los extremos no se pueden borrar (puedes moverlos verticalmente)'); return; }
    pts.splice(idx, 1);
    st.sel.idx = -1; st.sel.deck = null;
    markCustom(st.sel.lane);
    staticDirty = true; refreshPointBar(); refreshLanes(); refreshPresets(); invalidate(); commit();
  }
  function markCustom(laneId) {
    st.laneNames[laneId] = 'Personalizada';
    st.preset = 'custom';
  }

  // ------------------------------------------------------------------ point bar
  function refreshPointBar() {
    const bar = $('#pointBar');
    const { deck, idx, lane } = st.sel;
    if (!ready() || !deck || idx < 0) { bar.hidden = true; return; }
    const pts = st.lanes[deck][lane], p = pts[idx];
    if (!p) { bar.hidden = true; return; }
    const beats = p.x * st.trans.bars * 4;
    const b = Math.floor(beats / 4) + 1, bt = (beats % 4) + 1;
    const L = Automation.LANE[lane];
    bar.hidden = false;
    const last = idx === pts.length - 1;
    bar.innerHTML = `<div class="pinfo"><b style="color:${L.color}">${L.name} ${deck}</b> · compás ${b}.${(Math.round(bt * 10) / 10)} · <b>${Automation.fmt(lane, p.v)}</b></div>
      ${last ? '' : `<div class="shapes">${Automation.SHAPES.map(s => `<button class="chip small toggle ${p.shape === s.id ? 'on' : ''}" data-shape="${s.id}">${s.name}</button>`).join('')}</div>`}
      <button class="chip small" data-pact="def">Valor neutro</button>
      ${idx > 0 && !last ? '<button class="chip small del" data-pact="del">Eliminar</button>' : ''}`;
  }
  $('#pointBar').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const { deck, idx, lane } = st.sel;
    const pts = st.lanes[deck] && st.lanes[deck][lane];
    if (!pts || !pts[idx]) return;
    if (b.dataset.shape) pts[idx].shape = b.dataset.shape;
    else if (b.dataset.pact === 'del') { deletePoint(deck, idx); return; }
    else if (b.dataset.pact === 'def') pts[idx].v = Automation.LANE[lane].def;
    markCustom(lane);
    staticDirty = true; refreshPointBar(); refreshLanes(); refreshPresets(); invalidate(); commit();
  });

  // ------------------------------------------------------------------ presets
  function userPresets() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveUserPresets(list) { try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch (e) { } }

  function autoPreset() {
    const A = st.tracks.A, B = st.tracks.B;
    const r = Theory.relation(effectiveKey('A'), effectiveKey('B'));
    const ratio = Math.abs(A.bpm / B.bpm - 1);
    let id, why;
    if (st.trans.sync === 'off' && ratio > 0.02) { id = 'echo'; why = 'los tempos no están sincronizados, así que se evita solapar ritmos'; }
    else if (r.score === 0) { id = st.trans.bars <= 2 ? 'cut' : 'echo'; why = 'las tonalidades chocan (' + r.label.toLowerCase() + '), así que se minimiza el solapamiento'; }
    else if (ratio > 0.18) { id = 'filter'; why = 'hay mucha diferencia de tempo (' + Math.round(ratio * 100) + '%), el filtro disimula el estiramiento'; }
    else if (r.score >= 2 && st.trans.bars >= 16) { id = 'bands'; why = 'son armónicamente compatibles y hay espacio para un intercambio largo por bandas'; }
    else if (r.score >= 2) { id = 'bass'; why = 'son compatibles (' + r.label.toLowerCase() + '): un intercambio de graves suena limpio'; }
    else { id = 'filter'; why = 'la compatibilidad es parcial; los filtros reducen el choque de medios'; }
    return { preset: Automation.PRESETS.find(p => p.id === id), why };
  }
  function applyPreset(id) {
    if (!ready() && id === 'auto') { toast('Carga dos canciones primero'); return; }
    let p, desc;
    if (id === 'auto') {
      const a = autoPreset(); p = a.preset;
      desc = '✨ Auto eligió «' + p.name + '» porque ' + a.why + '.';
    } else if (id.startsWith('user:')) {
      const up = userPresets()[+id.slice(5)];
      if (!up) return;
      st.lanes = Automation.clone(up.lanes); st.laneNames = Object.assign({}, up.laneNames);
      if (up.trans) Object.assign(st.trans, up.trans);
      st.preset = id; desc = '★ Preset guardado: ' + up.name;
      afterPreset(desc); return;
    } else p = Automation.PRESETS.find(x => x.id === id);
    if (!p) return;
    const b = Automation.buildPreset(p);
    st.lanes = b.lanes; st.laneNames = b.names;
    st.preset = id === 'auto' ? 'auto' : p.id;
    afterPreset(desc || p.desc);
  }
  function afterPreset(desc) {
    st.sel.idx = -1; st.sel.deck = null;
    $('#presetDesc').textContent = desc;
    // focus the most interesting lane
    if (Automation.isFlat(st.sel.lane, st.lanes.A[st.sel.lane]) && Automation.isFlat(st.sel.lane, st.lanes.B[st.sel.lane]) && st.sel.lane !== 'vol') st.sel.lane = 'vol';
    refreshPresets(); refreshLanes(); refreshPointBar(); refreshSettings();
    invalidate(); commit();
  }
  function refreshPresets() {
    const box = $('#presets');
    box.innerHTML = '';
    const items = [{ id: 'auto', name: '✨ Auto' }].concat(Automation.PRESETS.map(p => ({ id: p.id, name: p.name })));
    if (st.preset === 'custom') items.splice(1, 0, { id: 'custom', name: 'Personalizada' });
    userPresets().forEach((u, i) => items.push({ id: 'user:' + i, name: '<span class="star">★</span> ' + esc(u.name), user: true }));
    for (const it of items) {
      const b = el('button', { class: 'preset' + (st.preset === it.id ? ' on' : ''), 'data-id': it.id }, it.name);
      if (it.user) {
        b.title = 'Mantén pulsado / clic derecho para borrar';
        b.addEventListener('contextmenu', e => {
          e.preventDefault();
          if (confirm('¿Borrar el preset «' + b.textContent.replace('★', '').trim() + '»?')) {
            const list = userPresets(); list.splice(+it.id.slice(5), 1); saveUserPresets(list);
            if (st.preset === it.id) st.preset = 'custom';
            refreshPresets();
          }
        });
      }
      b.addEventListener('click', () => { if (it.id !== 'custom') applyPreset(it.id); });
      box.appendChild(b);
    }
  }

  // ------------------------------------------------------------------ lanes list
  function refreshLanes() {
    const box = $('#lanes');
    box.innerHTML = '';
    Automation.LANES.forEach((l, i) => {
      const active = !Automation.isFlat(l.id, st.lanes.A[l.id]) || !Automation.isFlat(l.id, st.lanes.B[l.id]);
      const row = el('div', { class: 'lane' + (st.sel.lane === l.id ? ' on' : '') + (active ? ' active-curve' : ''), 'data-id': l.id, tabindex: '0' });
      const names = Automation.lanePresetNames(l.id);
      const cur = st.laneNames[l.id] || names[0];
      const opts = names.map(n => `<option ${n === cur ? 'selected' : ''}>${n}</option>`).join('') + (cur === 'Personalizada' ? '<option selected disabled>Personalizada</option>' : '');
      row.innerHTML = `<span class="bar" style="background:${l.color}"></span>
        <span class="name">${l.name}<small>${i + 1} · ${l.desc}</small></span>
        <select aria-label="Curva de ${l.name}">${opts}</select>`;
      row.addEventListener('click', e => {
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
        selectLane(l.id);
      });
      row.querySelector('select').addEventListener('change', e => {
        const lp = Automation.lanePreset(l.id, e.target.value);
        if (!lp) return;
        st.lanes.A[l.id] = lp.A; st.lanes.B[l.id] = lp.B;
        st.laneNames[l.id] = e.target.value;
        st.preset = 'custom';
        st.sel.lane = l.id; st.sel.idx = -1; st.sel.deck = null;
        refreshLanes(); refreshPresets(); refreshPointBar(); invalidate(); commit();
      });
      box.appendChild(row);
    });
  }
  function selectLane(id) {
    st.sel.lane = id; st.sel.idx = -1; st.sel.deck = null;
    staticDirty = true; refreshLanes(); refreshPointBar();
  }

  // ------------------------------------------------------------------ settings
  function buildSettings() {
    const bars = $('#barsSeg');
    [1, 2, 4, 8, 16, 32].forEach(n => bars.appendChild(el('button', { 'data-v': n }, n + (n === 1 ? ' compás' : ' compases'))));
    bars.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      st.trans.bars = +b.dataset.v; changed();
    });
    $('#syncSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      st.trans.sync = b.dataset.v; changed();
    });
    $('#echoSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      st.trans.echoBeats = +b.dataset.v; changed();
    });
    const stepper = (sel, key, label) => {
      const s = $(sel);
      s.innerHTML = `<button>−</button><span></span><button>+</button>`;
      const [m, p] = s.querySelectorAll('button');
      m.onclick = () => { st.trans[key] = clamp(st.trans[key] - 1, 0, 16); changed(); };
      p.onclick = () => { st.trans[key] = clamp(st.trans[key] + 1, 0, 16); changed(); };
      s.dataset.label = label;
    };
    stepper('#preStep', 'preBars', 'antes'); stepper('#postStep', 'postBars', 'después');
    const range = (sel, key, outSel, fmt) => {
      const r = $(sel);
      r.addEventListener('input', () => { st.trans[key] = +r.value; $(outSel).textContent = fmt(+r.value); invalidate(); });
      r.addEventListener('change', () => commit());
    };
    range('#fbRange', 'echoFb', '#fbOut', v => Math.round(v * 100) + '%');
    range('#revRange', 'reverbSize', '#revOut', v => (0.6 + v * 3.4).toFixed(1) + ' s');
    range('#resRange', 'filterRes', '#resOut', v => 'Q ' + v.toFixed(1));
    range('#masterRange', 'masterDb', '#masterOut', v => (v > 0 ? '+' : '') + v + ' dB');
  }
  function refreshSettings() {
    const t = st.trans;
    document.querySelectorAll('#barsSeg button').forEach(b => b.classList.toggle('on', +b.dataset.v === t.bars));
    document.querySelectorAll('#syncSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === t.sync));
    document.querySelectorAll('#echoSeg button').forEach(b => b.classList.toggle('on', +b.dataset.v === t.echoBeats));
    $('#preStep span').textContent = t.preBars + ' antes';
    $('#postStep span').textContent = t.postBars + ' después';
    $('#fbRange').value = t.echoFb; $('#fbOut').textContent = Math.round(t.echoFb * 100) + '%';
    $('#revRange').value = t.reverbSize; $('#revOut').textContent = (0.6 + t.reverbSize * 3.4).toFixed(1) + ' s';
    $('#resRange').value = t.filterRes; $('#resOut').textContent = 'Q ' + t.filterRes.toFixed(1);
    $('#masterRange').value = t.masterDb; $('#masterOut').textContent = (t.masterDb > 0 ? '+' : '') + t.masterDb + ' dB';
    $('#echoDivOut').textContent = ready() ? Math.round(Engine.timeline(st).beat * t.echoBeats * 1000) + ' ms' : '';
    let hint = '';
    if (ready()) {
      const tl = Engine.timeline(st);
      const pct = v => (v >= 1 ? '+' : '−') + Math.abs((v - 1) * 100).toFixed(1) + '%';
      if (t.sync === 'toA') hint = `B se reproduce a ${fmtBpm(tl.mixBpm)} bpm (${pct(tl.tB)}). Transición de ${tl.L.toFixed(1)} s.`;
      else if (t.sync === 'toB') hint = `A se reproduce a ${fmtBpm(tl.mixBpm)} bpm (${pct(tl.tA)}). Transición de ${tl.L.toFixed(1)} s.`;
      else hint = 'Sin sincronización: cada pista a su tempo original (los beats no coincidirán).';
    }
    $('#syncHint').textContent = hint;
  }

  // ------------------------------------------------------------------ compatibility + Camelot wheel
  function refreshCompat() {
    const box = $('#compat');
    if (!ready()) { box.innerHTML = '<p class="hint">Carga ambas pistas para ver el análisis armónico y de tempo.</p>'; $('#wheel').innerHTML = ''; return; }
    const A = st.tracks.A, B = st.tracks.B;
    const kA = effectiveKey('A'), kB = effectiveKey('B');
    const r = Theory.relation(kA, kB);
    const tl = Engine.timeline(st);
    const diff = (B.bpm / A.bpm - 1) * 100;
    const shiftB = st.deck.B.semis + (st.deck.B.keylock ? 0 : 12 * Math.log2(tl.tB));
    const cls = r.score >= 2 ? 'good' : r.score === 1 ? 'ok' : 'bad';
    const hz = Theory.harmonize(A.key && kA, B.key, st.deck.B.keylock ? 0 : 12 * Math.log2(tl.tB));
    const canImprove = hz && hz.rel.score > r.score;
    box.innerHTML = `
      <div class="row"><span>Tempo</span><span>${fmtBpm(A.bpm)} → ${fmtBpm(B.bpm)} bpm (${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%)</span></div>
      <div class="row"><span>Estiramiento</span><span>${st.trans.sync === 'off' ? 'ninguno' : (st.trans.sync === 'toA' ? 'B ×' + tl.tB.toFixed(3) : 'A ×' + tl.tA.toFixed(3))}</span></div>
      <div class="row"><span>Tonalidad A</span><span>${Theory.camelotStr(kA)} · ${Theory.keyName(kA, 'es')}</span></div>
      <div class="row"><span>Tonalidad B</span><span>${Theory.camelotStr(kB)} · ${Theory.keyName(kB, 'es')}${Math.abs(shiftB) > 0.05 ? ` <small style="color:var(--muted)">(${shiftB > 0 ? '+' : ''}${shiftB.toFixed(1)} st)</small>` : ''}</span></div>
      <div class="verdict ${cls}"><b>${r.label}.</b> ${r.detail}</div>
      <div class="actions">
        ${canImprove ? `<button class="chip" data-c="harm">🎹 Armonizar B (${hz.semis > 0 ? '+' : ''}${hz.semis} st → ${Theory.camelotStr(hz.key)})</button>` : ''}
        ${st.deck.B.semis ? '<button class="chip" data-c="resetB">Restablecer tono de B</button>' : ''}
        <button class="chip" data-c="auto">✨ Preset automático</button>
      </div>`;
    box.querySelectorAll('button').forEach(b => b.onclick = () => {
      if (b.dataset.c === 'harm') { st.deck.B.semis = hz.semis; changed(); toast('B transpuesta ' + (hz.semis > 0 ? '+' : '') + hz.semis + ' semitonos → ' + Theory.camelotStr(hz.key)); }
      else if (b.dataset.c === 'resetB') { st.deck.B.semis = 0; changed(); }
      else applyPreset('auto');
    });
    $('#wheel').innerHTML = wheelSVG(kA, kB);
  }
  function wheelSVG(kA, kB) {
    const cA = Theory.camelot(kA.pc, kA.mode), cB = Theory.camelot(kB.pc, kB.mode);
    const cx = 160, cy = 160;
    const ring = [{ letter: 'B', r0: 112, r1: 152 }, { letter: 'A', r0: 68, r1: 110 }];
    let s = `<svg viewBox="0 0 320 320" role="img" aria-label="Rueda Camelot">`;
    for (const rg of ring) {
      for (let n = 1; n <= 12; n++) {
        const a0 = ((n % 12) * 30 - 15 - 90) * Math.PI / 180, a1 = a0 + 30 * Math.PI / 180;
        const p = (r, a) => (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2);
        const key = Theory.fromCamelot(n, rg.letter);
        const rel = Theory.relation(kA, key);
        const isA = cA.num === n && cA.letter === rg.letter, isB = cB.num === n && cB.letter === rg.letter;
        let fill = '#262626';
        if (rel.score >= 2) fill = '#1d3b28';
        if (isA) fill = '#1ed760';
        if (isB) fill = isA ? 'url(#both)' : '#f5a524';
        const d = `M ${p(rg.r1, a0)} A ${rg.r1} ${rg.r1} 0 0 1 ${p(rg.r1, a1)} L ${p(rg.r0, a1)} A ${rg.r0} ${rg.r0} 0 0 0 ${p(rg.r0, a0)} Z`;
        s += `<path d="${d}" fill="${fill}" stroke="#121212" stroke-width="2"/>`;
        const am = (a0 + a1) / 2, rm = (rg.r0 + rg.r1) / 2;
        const tc = isA || isB ? '#111' : rel.score >= 2 ? '#9ff0bd' : '#8a8a8a';
        s += `<text x="${(cx + rm * Math.cos(am)).toFixed(1)}" y="${(cy + rm * Math.sin(am) + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="${tc}">${n}${rg.letter}</text>`;
      }
    }
    s += `<defs><linearGradient id="both"><stop offset="50%" stop-color="#1ed760"/><stop offset="50%" stop-color="#f5a524"/></linearGradient></defs>`;
    s += `<text x="160" y="152" text-anchor="middle" font-size="12" fill="#a7a7a7">Camelot</text>`;
    s += `<circle cx="120" cy="172" r="5" fill="#1ed760"/><text x="130" y="176" font-size="11" fill="#ddd">A</text>`;
    s += `<circle cx="172" cy="172" r="5" fill="#f5a524"/><text x="182" y="176" font-size="11" fill="#ddd">B</text>`;
    return s + '</svg>';
  }

  // ------------------------------------------------------------------ spectrum
  const spec = $('#spectrum');
  const fbuf = new Uint8Array(1024);
  function drawSpectrum() {
    const { g, w, h } = sizeCanvas(spec);
    g.clearRect(0, 0, w, h);
    const an = Engine.analyser();
    const bars = Math.max(24, Math.floor(w / 7));
    if (an && Engine.isPlaying()) an.getByteFrequencyData(fbuf); else fbuf.fill(0);
    const sr = an ? an.context.sampleRate : 44100, nyq = sr / 2, bins = an ? an.frequencyBinCount : 1024;
    for (let i = 0; i < bars; i++) {
      const f0 = 30 * Math.pow(16000 / 30, i / bars), f1 = 30 * Math.pow(16000 / 30, (i + 1) / bars);
      const b0 = Math.floor(f0 / nyq * bins), b1 = Math.max(b0 + 1, Math.floor(f1 / nyq * bins));
      let m = 0; for (let b = b0; b < b1 && b < fbuf.length; b++) m = Math.max(m, fbuf[b]);
      const v = m / 255, bh = Math.max(1.5, v * (h - 6));
      g.fillStyle = f0 < 250 ? COLORS.low : f0 < 3000 ? COLORS.mid : COLORS.high;
      g.globalAlpha = 0.35 + 0.65 * v;
      g.fillRect(i * (w / bars) + 1, h - 3 - bh, w / bars - 2, bh);
    }
    g.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ main loop
  function loop() {
    if (Engine.isPlaying() && rendered) {
      const p = Engine.position(st.loop ? rendered.buffer.duration : 0);
      if (p != null) st.playhead = p;
    }
    if (ready()) {
      const tl = Engine.timeline(st);
      $('#timeLabel').textContent = fmtTime(st.playhead - tl.Pr, true) + ' / ' + fmtTime(tl.L, true);
    }
    drawFrame();
    drawSpectrum();
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------ export / import
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function exportWav() {
    if (!ready()) { toast('Carga dos canciones primero'); return; }
    if (!rendered || !$('#busy').hidden) {
      toast('Renderizando… vuelve a pulsar en un momento'); invalidate(true); return;
    }
    const b = rendered.buffer;
    const wav = DSP.encodeWAV([b.getChannelData(0), b.getChannelData(1)], b.sampleRate);
    const name = (st.tracks.A.name + ' a ' + st.tracks.B.name + ' (transicion)').replace(/[\\/:*?"<>|]/g, '_') + '.wav';
    download(new Blob([wav], { type: 'audio/wav' }), name);
    toast('WAV exportado (' + b.duration.toFixed(1) + ' s)');
  }
  function exportProject() {
    const o = {
      app: 'mixeo', version: 1,
      tracks: { A: st.tracks.A && { name: st.tracks.A.name, bpm: st.tracks.A.bpm, key: st.tracks.A.key }, B: st.tracks.B && { name: st.tracks.B.name, bpm: st.tracks.B.bpm, key: st.tracks.B.key } },
      deck: st.deck, trans: st.trans, lanes: st.lanes, laneNames: st.laneNames, preset: st.preset
    };
    download(new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' }), 'transicion.mixeo.json');
  }
  function importProject(file) {
    file.text().then(t => {
      const o = JSON.parse(t);
      if (o.app !== 'mixeo') throw new Error('formato');
      st.lanes = o.lanes; st.laneNames = o.laneNames || {}; st.preset = o.preset || 'custom';
      Object.assign(st.trans, o.trans);
      for (const d of ['A', 'B']) {
        Object.assign(st.deck[d], o.deck[d]);
        const tr = st.tracks[d];
        if (tr) {
          st.deck[d].point = clamp(st.deck[d].point, 0, tr.duration);
          if (o.tracks[d] && o.tracks[d].name === tr.name) { tr.bpm = o.tracks[d].bpm; tr.key = o.tracks[d].key; }
        }
      }
      refreshAll(); invalidate(); commit();
      toast('Proyecto importado');
    }).catch(() => toast('Archivo de proyecto no válido'));
  }
  function savePreset() {
    const name = prompt('Nombre del preset:', 'Mi transición');
    if (!name) return;
    const list = userPresets();
    list.push({ name: name.slice(0, 40), lanes: st.lanes, laneNames: st.laneNames, trans: { bars: st.trans.bars, echoBeats: st.trans.echoBeats, echoFb: st.trans.echoFb, reverbSize: st.trans.reverbSize, filterRes: st.trans.filterRes } });
    saveUserPresets(list);
    st.preset = 'user:' + (list.length - 1);
    refreshPresets();
    toast('Preset «' + name + '» guardado');
  }

  // ------------------------------------------------------------------ wiring
  function refreshDecks() { updateDeck('A'); updateDeck('B'); staticDirty = true; }
  function refreshAll() {
    buildDeck('A'); buildDeck('B');
    $('#emptyState').hidden = ready();
    $('#playBtn').hidden = !ready();
    refreshPresets(); refreshLanes(); refreshSettings(); refreshCompat(); refreshPointBar();
    staticDirty = true;
  }
  ['A', 'B'].forEach(d => {
    const root = $('#deck' + d);
    root.addEventListener('click', e => onDeckClick(d, e));
    root.addEventListener('dragover', e => { e.preventDefault(); });
    root.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(d, f); });
  });
  $('#editor').addEventListener('dragover', e => e.preventDefault());
  $('#editor').addEventListener('drop', e => {
    e.preventDefault();
    const fs = [...e.dataTransfer.files].filter(f => f.type.startsWith('audio') || /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(f.name));
    if (fs[0]) loadFile(st.tracks.A ? 'B' : 'A', fs[0]).then(() => fs[1] && loadFile('B', fs[1]));
  });
  $('#playBtn').addEventListener('click', togglePlay);
  $('#demoBtn').addEventListener('click', loadDemo);
  $('#toStartBtn').addEventListener('click', () => { seek(0); staticDirty = true; });
  $('#toTransBtn').addEventListener('click', () => { if (ready()) { seek(Math.max(0, Engine.timeline(st).Pr - 2 * Engine.timeline(st).beat)); } });
  const toggleBtn = (sel, key, after) => $(sel).addEventListener('click', () => {
    st[key] = !st[key];
    $(sel).classList.toggle('on', st[key]); $(sel).setAttribute('aria-pressed', st[key]);
    after && after();
  });
  toggleBtn('#loopBtn', 'loop', () => { if (Engine.isPlaying() && rendered) startPlayback(st.playhead); });
  toggleBtn('#snapBtn', 'snap');
  toggleBtn('#fxViewBtn', 'fxView', () => staticDirty = true);
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#exportBtn').addEventListener('click', exportWav);
  $('#menuBtn').addEventListener('click', e => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; });
  document.addEventListener('click', () => $('#menu').hidden = true);
  $('#menu').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'savePreset') savePreset();
    else if (a === 'exportProject') exportProject();
    else if (a === 'importProject') { const fi = $('#projectInput'); fi.value = ''; fi.onchange = () => fi.files[0] && importProject(fi.files[0]); fi.click(); }
    else if (a === 'swap') {
      if (!ready()) return;
      [st.tracks.A, st.tracks.B] = [st.tracks.B, st.tracks.A];
      st.deck.A.semis = st.deck.B.semis = 0;
      defaultPoint('B'); defaultPoint('A');
      refreshAll(); invalidate(); commit();
    }
    else if (a === 'reset') applyPreset('bass');
    else if (a === 'demo') loadDemo();
    else if (a === 'help') $('#helpDlg').showModal();
  });
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && st.sel.idx >= 0) { e.preventDefault(); deletePoint(st.sel.deck, st.sel.idx); }
    else if (/^[1-8]$/.test(e.key) && !e.ctrlKey && !e.metaKey) selectLane(Automation.LANES[+e.key - 1].id);
    else if (e.key === 'Escape') { st.sel.idx = -1; st.sel.deck = null; staticDirty = true; refreshPointBar(); }
  });
  window.addEventListener('resize', () => { staticDirty = true; drawOverview('A'); drawOverview('B'); });

  buildSettings();
  refreshAll();
  $('#presetDesc').textContent = Automation.PRESETS.find(p => p.id === 'bass').desc;
  $('#exportBtn').disabled = true;
  commit();
  requestAnimationFrame(loop);

  // expose for debugging / tests
  window.Mixeo = { st, loadDemo, applyPreset, togglePlay, get rendered() { return rendered; } };
})();
