/* Procedural demo tracks so the app can be tried without loading files. */
const Demo = (function () {
  const SR = 44100;

  function makeTable(harm, size) {
    const t = new Float32Array(size + 1);
    for (let h = 1; h <= harm; h++) {
      const a = 1 / h;
      for (let i = 0; i <= size; i++) t[i] += a * Math.sin(2 * Math.PI * h * i / size);
    }
    let mx = 0; for (const v of t) mx = Math.max(mx, Math.abs(v));
    for (let i = 0; i <= size; i++) t[i] /= mx;
    return t;
  }
  const TBL = 2048;
  const SAW = makeTable(14, TBL);
  const SOFT = makeTable(4, TBL);
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

  function tone(L, R, start, dur, midi, amp, table, opts) {
    opts = opts || {};
    const s0 = Math.floor(start * SR), n = Math.floor(dur * SR);
    const f = mtof(midi), detune = opts.detune || 0;
    const att = (opts.attack || 0.005) * SR, rel = (opts.release || 0.05) * SR, decay = opts.decay || 0;
    const pan = opts.pan || 0, gl = amp * (1 - Math.max(0, pan)), gr = amp * (1 + Math.min(0, pan));
    let ph1 = 0, ph2 = 0.37;
    const inc1 = f * TBL / SR, inc2 = f * (1 + detune) * TBL / SR;
    let lp = 0;
    const cut = opts.cutoff ? Math.exp(-2 * Math.PI * opts.cutoff / SR) : 0;
    for (let i = 0; i < n + rel; i++) {
      const j = s0 + i;
      if (j >= L.length) break;
      let env = i < att ? i / att : 1;
      if (decay) env *= Math.exp(-i / (decay * SR));
      if (i > n) env *= 1 - (i - n) / rel;
      const a = ph1 | 0, b = ph2 | 0;
      let v = table[a] + (detune ? table[b] : 0);
      ph1 += inc1; if (ph1 >= TBL) ph1 -= TBL;
      ph2 += inc2; if (ph2 >= TBL) ph2 -= TBL;
      if (cut) { lp = (1 - cut) * v + cut * lp; v = lp; }
      v *= env;
      L[j] += v * gl; R[j] += v * gr;
    }
  }
  function kick(L, R, t, amp) {
    const s0 = Math.floor(t * SR), n = Math.floor(0.4 * SR);
    let ph = 0;
    for (let i = 0; i < n && s0 + i < L.length; i++) {
      const tt = i / SR;
      const f = 45 + 110 * Math.exp(-tt * 28);
      ph += 2 * Math.PI * f / SR;
      const v = Math.sin(ph) * Math.exp(-tt * 7) * amp;
      L[s0 + i] += v; R[s0 + i] += v;
    }
  }
  function noiseHit(L, R, t, dur, amp, hp, rnd, pan) {
    const s0 = Math.floor(t * SR), n = Math.floor(dur * SR);
    let prev = 0, lp = 0;
    const c = Math.exp(-2 * Math.PI * hp / SR);
    pan = pan || 0;
    for (let i = 0; i < n && s0 + i < L.length; i++) {
      const x = rnd() * 2 - 1;
      lp = (1 - c) * x + c * lp;
      const v = (x - lp) * Math.exp(-i / (dur * SR * 0.25)) * amp;
      prev = v;
      L[s0 + i] += v * (1 - Math.max(0, pan)); R[s0 + i] += v * (1 + Math.min(0, pan));
    }
  }
  function snare(L, R, t, amp, rnd) {
    noiseHit(L, R, t, 0.22, amp * 0.8, 1200, rnd);
    tone(L, R, t, 0.08, 52, amp * 0.5, SOFT, { decay: 0.05, release: 0.02 });
  }

  function finish(L, R) {
    let mx = 0;
    for (let i = 0; i < L.length; i++) mx = Math.max(mx, Math.abs(L[i]), Math.abs(R[i]));
    const g = 0.89 / (mx || 1);
    for (let i = 0; i < L.length; i++) { L[i] = Math.tanh(L[i] * g * 1.1) * 0.9; R[i] = Math.tanh(R[i] * g * 1.1) * 0.9; }
    return [L, R];
  }

  // Track 1: 124 BPM house, A minor. Am - F - C - G
  function trackOne() {
    const bpm = 124, beat = 60 / bpm, bars = 56;
    const len = Math.ceil((bars * 4 * beat + 2) * SR);
    const L = new Float32Array(len), R = new Float32Array(len);
    const rnd = rng(7);
    const prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
    const roots = [45, 41, 48, 43];
    for (let bar = 0; bar < bars; bar++) {
      const t = bar * 4 * beat;
      const sec = bar < 8 ? 'intro' : bar < 24 ? 'main' : bar < 32 ? 'break' : bar < 48 ? 'main2' : 'outro';
      const ch = prog[bar % 4], root = roots[bar % 4];
      for (let b = 0; b < 4; b++) {
        const bt = t + b * beat;
        if (sec !== 'break') kick(L, R, bt, 0.9);
        if (sec !== 'intro' || bar >= 4) noiseHit(L, R, bt + beat / 2, 0.06, 0.25, 6000, rnd, 0.3);
        if ((sec === 'main' || sec === 'main2') && (b === 1 || b === 3)) noiseHit(L, R, bt, 0.18, 0.28, 1500, rnd, -0.2);
        if (sec === 'main2') noiseHit(L, R, bt + beat * 0.25, 0.03, 0.12, 8000, rnd, -0.4);
      }
      if (sec !== 'intro' && sec !== 'break') {
        for (let e = 0; e < 8; e++) {
          if (e % 2 === 0) continue;
          tone(L, R, t + e * beat / 2, beat * 0.45, root - 12 + (e === 7 ? 7 : 0), 0.32, SAW, { cutoff: 500, release: 0.02 });
        }
      }
      if (sec !== 'intro') {
        for (const m of ch) tone(L, R, t, 4 * beat, m, sec === 'break' ? 0.11 : 0.07, SAW, { detune: 0.006, attack: 0.25, release: 0.4, cutoff: sec === 'break' ? 2500 : 1600, pan: (m % 3 - 1) * 0.4 });
      }
      if (sec === 'main2' || sec === 'break') {
        for (let s = 0; s < 8; s++) {
          const m = ch[s % 3] + 12 + (s >= 6 ? 12 : 0);
          tone(L, R, t + s * beat / 2, beat * 0.3, m, 0.08, SOFT, { decay: 0.12, release: 0.03, pan: s % 2 ? 0.5 : -0.5 });
        }
      }
      if (sec === 'outro' && bar % 2 === 0) tone(L, R, t, 8 * beat, 57, 0.06, SAW, { attack: 0.5, release: 0.6, cutoff: 900 });
    }
    return { name: 'Neon Drift', artist: 'Demo · 124 BPM', channels: finish(L, R), sr: SR, color: ['#ff6a3d', '#5b1a2a'] };
  }

  // Track 2: 100 BPM half-time groove, D major. D - Bm - G - A
  function trackTwo() {
    const bpm = 100, beat = 60 / bpm, bars = 44;
    const len = Math.ceil((bars * 4 * beat + 2) * SR);
    const L = new Float32Array(len), R = new Float32Array(len);
    const rnd = rng(99);
    const prog = [[62, 66, 69], [59, 62, 66], [55, 59, 62], [57, 61, 64]];
    const roots = [38, 35, 43, 45];
    for (let bar = 0; bar < bars; bar++) {
      const t = bar * 4 * beat;
      const sec = bar < 4 ? 'intro' : bar < 20 ? 'verse' : bar < 36 ? 'chorus' : 'outro';
      const ch = prog[bar % 4], root = roots[bar % 4];
      // drums
      if (sec !== 'intro') {
        kick(L, R, t, 0.95); kick(L, R, t + 2 * beat, 0.85); kick(L, R, t + 2.5 * beat, 0.45);
        if (sec === 'chorus') kick(L, R, t + 1.75 * beat, 0.5);
        snare(L, R, t + beat, 0.55, rnd); snare(L, R, t + 3 * beat, 0.55, rnd);
      }
      for (let s = 0; s < 8; s++) noiseHit(L, R, t + s * beat / 2, 0.05, s % 2 ? 0.12 : 0.2, 7000, rnd, 0.25);
      // bass
      if (sec !== 'intro') {
        tone(L, R, t, beat * 1.4, root, 0.4, SAW, { cutoff: 380, release: 0.05 });
        tone(L, R, t + 2 * beat, beat * 0.9, root, 0.35, SAW, { cutoff: 380, release: 0.05 });
        tone(L, R, t + 3.5 * beat, beat * 0.4, root + 7, 0.3, SAW, { cutoff: 380, release: 0.03 });
      }
      // keys (electric-piano like)
      for (let k = 0; k < 2; k++)
        for (const m of ch) tone(L, R, t + k * 2 * beat + (k ? beat * 0.5 : 0), beat * 1.6, m, 0.1, SOFT, { decay: 0.9, release: 0.2, pan: (m % 2 ? 0.3 : -0.3) });
      // lead melody in chorus
      if (sec === 'chorus') {
        const mel = [74, 73, 71, 69, 71, 69, 66, 69];
        for (let i = 0; i < 4; i++) tone(L, R, t + i * beat, beat * 0.9, mel[(bar % 2) * 4 + i], 0.09, SAW, { cutoff: 2800, attack: 0.02, release: 0.1, detune: 0.004 });
      }
      if (sec === 'intro' || sec === 'outro') tone(L, R, t, 4 * beat, ch[0] - 12, 0.08, SAW, { attack: 0.6, release: 0.5, cutoff: 700, detune: 0.005 });
    }
    return { name: 'Sunday Bloom', artist: 'Demo · 100 BPM', channels: finish(L, R), sr: SR, color: ['#5fd3ff', '#2a2f7a'] };
  }

  return { trackOne, trackTwo };
})();
