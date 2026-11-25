/*
 * DSP library: analysis (bands, BPM, beat grid, key), time-stretch (WSOLA),
 * pitch shift (resampling) and WAV encoding.
 * Wrapped in a function so the exact same code can run on the main thread
 * and inside a Web Worker created from a Blob (works even from file://).
 */
function DSPLib() {
  'use strict';

  // ---------- helpers ----------
  function toMono(chs) {
    const n = chs[0].length;
    if (chs.length === 1) return chs[0];
    const out = new Float32Array(n);
    const k = 1 / chs.length;
    for (let c = 0; c < chs.length; c++) {
      const ch = chs[c];
      for (let i = 0; i < n; i++) out[i] += ch[i] * k;
    }
    return out;
  }

  function onePoleCoef(fc, sr) {
    return Math.exp(-2 * Math.PI * fc / sr);
  }

  // In-place radix-2 FFT
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < half; j++) {
          const a = i + j, b = a + half;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  // ---------- 3-band waveform + onset envelopes ----------
  // Returns per-bucket RMS of low / mid / high bands (rate buckets per second)
  // and onset envelopes at 100 frames/s for tempo detection.
  function analyzeBands(mono, sr, rate) {
    rate = rate || 150;
    const hop = sr / rate;
    const nB = Math.ceil(mono.length / hop);
    const low = new Float32Array(nB), mid = new Float32Array(nB), high = new Float32Array(nB);

    const ofr = 100, ohop = sr / ofr;
    const nO = Math.ceil(mono.length / ohop);
    const eLow = new Float32Array(nO), eAll = new Float32Array(nO);

    const aL = onePoleCoef(200, sr), aH = onePoleCoef(2600, sr);
    let l1 = 0, l2 = 0, h1 = 0, h2 = 0;
    let sL = 0, sM = 0, sH = 0, cnt = 0, b = 0, nextB = hop;
    let oL = 0, oA = 0, ocnt = 0, o = 0, nextO = ohop;
    for (let i = 0; i < mono.length; i++) {
      const x = mono[i];
      l1 = (1 - aL) * x + aL * l1; l2 = (1 - aL) * l1 + aL * l2;
      h1 = (1 - aH) * x + aH * h1; h2 = (1 - aH) * h1 + aH * h2;
      const lo = l2, hi = x - h2, mi = h2 - l2;
      sL += lo * lo; sM += mi * mi; sH += hi * hi; cnt++;
      oL += lo * lo; oA += x * x; ocnt++;
      if (i + 1 >= nextB) {
        low[b] = Math.sqrt(sL / cnt); mid[b] = Math.sqrt(sM / cnt); high[b] = Math.sqrt(sH / cnt);
        b++; nextB += hop; sL = sM = sH = 0; cnt = 0;
      }
      if (i + 1 >= nextO) {
        eLow[o] = oL / ocnt; eAll[o] = oA / ocnt;
        o++; nextO += ohop; oL = oA = 0; ocnt = 0;
      }
    }
    if (cnt && b < nB) { low[b] = Math.sqrt(sL / cnt); mid[b] = Math.sqrt(sM / cnt); high[b] = Math.sqrt(sH / cnt); }
    if (ocnt && o < nO) { eLow[o] = oL / ocnt; eAll[o] = oA / ocnt; }

    // Normalise waveform so the loudest bucket (sum of bands) is ~1
    let mx = 1e-9;
    for (let i = 0; i < nB; i++) { const s = low[i] + mid[i] + high[i]; if (s > mx) mx = s; }
    const g = 1 / mx;
    for (let i = 0; i < nB; i++) { low[i] *= g; mid[i] *= g; high[i] *= g; }

    // Onset (spectral-flux like) envelopes on log energy
    function flux(e) {
      const out = new Float32Array(e.length);
      let prev = Math.log(1 + 1e4 * e[0]);
      for (let i = 1; i < e.length; i++) {
        const v = Math.log(1 + 1e4 * e[i]);
        out[i] = Math.max(0, v - prev);
        prev = v;
      }
      // remove slowly varying mean (adaptive threshold)
      const w = 50, res = new Float32Array(e.length);
      let acc = 0;
      for (let i = 0; i < out.length; i++) {
        acc += out[i];
        if (i >= w) acc -= out[i - w];
        const m = acc / Math.min(i + 1, w);
        res[i] = Math.max(0, out[i] - m);
      }
      return res;
    }
    const envLow = flux(eLow), envAll = flux(eAll);
    const env = new Float32Array(nO);
    for (let i = 0; i < nO; i++) env[i] = envLow[i] + 0.6 * envAll[i];

    return { low, mid, high, rate, env, envLow, envRate: ofr };
  }

  function interp(arr, x) {
    const i = Math.floor(x);
    if (i < 0 || i + 1 >= arr.length) return 0;
    const f = x - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  }

  // ---------- tempo & beat grid ----------
  function smooth(e) {
    const o = new Float32Array(e.length);
    for (let i = 0; i < e.length; i++) o[i] = 0.25 * (e[i - 1] || 0) + 0.5 * e[i] + 0.25 * (e[i + 1] || 0);
    return o;
  }
  function detectTempo(env0, envLow0, fr) {
    const env = smooth(smooth(env0)), envLow = smooth(envLow0);
    const n = env.length;
    function score(bpm) {
      const P = 60 * fr / bpm;
      let s = 0;
      const lim = n - 2 * P - 2;
      for (let i = 0; i < lim; i++) {
        const e = env[i];
        if (e === 0) continue;
        s += e * (interp(env, i + P) + 0.5 * interp(env, i + 2 * P) + 0.75 * interp(env, i + 4 * P));
      }
      return s / Math.max(1, lim);
    }
    function prior(bpm) {
      const d = Math.log2(bpm / 118) / 0.55;
      return Math.exp(-0.5 * d * d);
    }
    let best = 120, bestS = -1;
    const scores = [];
    for (let bpm = 60; bpm <= 190; bpm += 0.5) {
      const s = score(bpm) * (0.6 + 0.4 * prior(bpm));
      scores.push([bpm, s]);
      if (s > bestS) { bestS = s; best = bpm; }
    }
    let fine = best, fineS = -1;
    for (let bpm = best - 0.7; bpm <= best + 0.7; bpm += 0.02) {
      const s = score(bpm);
      if (s > fineS) { fineS = s; fine = bpm; }
    }
    let bpm = Math.round(fine * 100) / 100;
    // Most produced music sits on an integer tempo: prefer it if it scores almost as well
    const ri = Math.round(fine);
    if (Math.abs(fine - ri) < 0.5 && score(ri) >= fineS * 0.97) bpm = ri;

    // confidence: peak vs mean
    let mean = 0; for (const [, s] of scores) mean += s; mean /= scores.length;
    const confidence = Math.max(0, Math.min(1, (bestS / (mean || 1e-9) - 1) / 2));

    // beat phase
    const P = 60 * fr / bpm;
    let bestPh = 0, bestPhS = -1;
    for (let ph = 0; ph < P; ph += 0.25) {
      let s = 0;
      for (let t = ph; t < n; t += P) s += interp(env, t) + 1.5 * interp(envLow, t);
      if (s > bestPhS) { bestPhS = s; bestPh = ph; }
    }
    // downbeat: which of the 4 beat positions has the strongest low onsets
    let bestO = 0, bestOS = -1;
    for (let off = 0; off < 4; off++) {
      let s = 0;
      for (let t = bestPh + off * P; t < n; t += 4 * P) {
        const r = Math.round(t);
        s += Math.max(envLow[r] || 0, envLow[r + 1] || 0, envLow[r - 1] || 0);
      }
      if (s > bestOS) { bestOS = s; bestO = off; }
    }
    if (bestPh > P - 1.5) bestPh -= P; // a phase just below one period is really ~0
    const firstBeat = Math.max(0, bestPh / fr);
    let downbeat = (bestPh + bestO * P) / fr;
    const barLen = 4 * 60 / bpm;
    while (downbeat - barLen >= -1e-6) downbeat -= barLen;
    return { bpm, firstBeat, downbeat, confidence };
  }

  // ---------- key detection (chroma + Krumhansl-Kessler) ----------
  const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function pearson(a, b) {
    let ma = 0, mb = 0;
    for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
    ma /= 12; mb /= 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return num / Math.sqrt(da * db || 1e-12);
  }

  function chromagram(mono, sr) {
    const factor = Math.max(1, Math.round(sr / 11025));
    const dsr = sr / factor;
    const dn = Math.floor(mono.length / factor);
    const ds = new Float32Array(dn);
    for (let i = 0; i < dn; i++) {
      let s = 0;
      for (let k = 0; k < factor; k++) s += mono[i * factor + k];
      ds[i] = s / factor;
    }
    const N = 8192;
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    // precompute bin -> pitch class mapping
    const binPc = new Int8Array(N / 2).fill(-1);
    const binW = new Float32Array(N / 2);
    for (let k = 1; k < N / 2; k++) {
      const f = k * dsr / N;
      if (f < 60 || f > 2200) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      const r = Math.round(midi);
      const dev = Math.abs(midi - r);
      if (dev > 0.4) continue;
      binPc[k] = ((r % 12) + 12) % 12;
      binW[k] = Math.cos(dev * Math.PI / 0.8); // favour bins near pitch centre
    }
    const totalFrames = Math.floor((dn - N) / (N / 2));
    const maxFrames = 360;
    const step = Math.max(1, Math.floor(totalFrames / maxFrames));
    const chroma = new Float64Array(12);
    const re = new Float32Array(N), im = new Float32Array(N);
    const fc = new Float64Array(12);
    for (let fIdx = 0; fIdx < totalFrames; fIdx += step) {
      const off = fIdx * (N / 2);
      let energy = 0;
      for (let i = 0; i < N; i++) { const v = ds[off + i] * win[i]; re[i] = v; im[i] = 0; energy += v * v; }
      if (energy < 1e-6) continue;
      fft(re, im);
      fc.fill(0);
      for (let k = 1; k < N / 2; k++) {
        const pc = binPc[k];
        if (pc < 0) continue;
        fc[pc] += Math.sqrt(re[k] * re[k] + im[k] * im[k]) * binW[k];
      }
      let mx = 0; for (let i = 0; i < 12; i++) if (fc[i] > mx) mx = fc[i];
      if (mx <= 0) continue;
      for (let i = 0; i < 12; i++) chroma[i] += fc[i] / mx;
    }
    return Array.from(chroma);
  }

  function detectKey(mono, sr) {
    const chroma = chromagram(mono, sr);
    const results = [];
    for (let pc = 0; pc < 12; pc++) {
      const rotMaj = [], rotMin = [];
      for (let i = 0; i < 12; i++) { rotMaj.push(KK_MAJOR[(i - pc + 12) % 12]); rotMin.push(KK_MINOR[(i - pc + 12) % 12]); }
      results.push({ pc, mode: 'major', r: pearson(chroma, rotMaj) });
      results.push({ pc, mode: 'minor', r: pearson(chroma, rotMin) });
    }
    results.sort((a, b) => b.r - a.r);
    const best = results[0], second = results[1];
    const confidence = Math.max(0, Math.min(1, (best.r - second.r) * 6 + best.r * 0.3));
    let mx = Math.max(...chroma) || 1;
    return { pc: best.pc, mode: best.mode, confidence, chroma: chroma.map(v => v / mx), ranking: results.slice(0, 4) };
  }

  function analyze(chs, sr) {
    const mono = toMono(chs);
    const bands = analyzeBands(mono, sr, 150);
    const tempo = detectTempo(bands.env, bands.envLow, bands.envRate);
    const key = detectKey(mono, sr);
    return {
      bands: { low: bands.low, mid: bands.mid, high: bands.high, rate: bands.rate },
      tempo, key
    };
  }

  // ---------- WSOLA time stretch ----------
  // alpha = output length / input length
  function wsola(chs, alpha) {
    const N = chs[0].length;
    const W = 2048, Hs = W / 2, Ha = Hs / alpha, tol = 384, L = 768;
    const outLen = Math.max(1, Math.round(N * alpha));
    const nch = chs.length;
    const out = [];
    for (let c = 0; c < nch; c++) out.push(new Float32Array(outLen + W));
    const wsum = new Float32Array(outLen + W);
    const win = new Float32Array(W);
    for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / W);
    const mono = toMono(chs);

    function corr(a, b, step) {
      let s = 0;
      for (let i = 0; i < L; i += step) s += mono[a + i] * mono[b + i];
      return s;
    }
    let prev = 0;
    for (let k = 0; ; k++) {
      const outPos = k * Hs;
      if (outPos >= outLen) break;
      const nominal = Math.round(k * Ha);
      let pos;
      if (k === 0) pos = 0;
      else {
        const target = prev + Hs; // natural continuation
        if (target + L >= N) pos = Math.min(Math.max(0, nominal), Math.max(0, N - W));
        else {
          let bestD = 0, bestC = -Infinity;
          const lo = Math.max(-tol, -nominal), hi = Math.min(tol, N - L - nominal - 1);
          for (let d = lo; d <= hi; d += 4) {
            const c = corr(nominal + d, target, 4);
            if (c > bestC) { bestC = c; bestD = d; }
          }
          const c0 = bestD;
          bestC = -Infinity;
          for (let d = Math.max(lo, c0 - 3); d <= Math.min(hi, c0 + 3); d++) {
            const c = corr(nominal + d, target, 2);
            if (c > bestC) { bestC = c; bestD = d; }
          }
          pos = nominal + bestD;
        }
      }
      if (pos < 0) pos = 0;
      for (let c = 0; c < nch; c++) {
        const src = chs[c], dst = out[c];
        for (let i = 0; i < W; i++) {
          const si = pos + i;
          if (si >= N) break;
          dst[outPos + i] += src[si] * win[i];
        }
      }
      for (let i = 0; i < W; i++) wsum[outPos + i] += win[i];
      prev = pos;
    }
    for (let c = 0; c < nch; c++) {
      const d = out[c];
      for (let i = 0; i < outLen; i++) { const w = wsum[i]; if (w > 1e-3) d[i] /= w; }
      out[c] = d.subarray(0, outLen).slice();
    }
    return out;
  }

  // Cubic (Hermite) resampling: reads input at `rate` samples per output sample
  function resample(chs, rate) {
    const N = chs[0].length;
    const outLen = Math.max(1, Math.floor((N - 1) / rate));
    return chs.map(src => {
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const x = i * rate;
        const j = Math.floor(x), f = x - j;
        const y0 = src[j - 1] !== undefined ? src[j - 1] : src[j];
        const y1 = src[j], y2 = src[j + 1] !== undefined ? src[j + 1] : y1;
        const y3 = src[j + 2] !== undefined ? src[j + 2] : y2;
        const c1 = 0.5 * (y2 - y0);
        const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
        const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        out[i] = ((c3 * f + c2) * f + c1) * f + y1;
      }
      return out;
    });
  }

  // tempo: speed factor (1.2 = 20% faster), semis: pitch shift,
  // keylock: keep original pitch when changing tempo.
  function processSegment(chs, tempo, semis, keylock) {
    const p = Math.pow(2, (semis || 0) / 12);
    const P = keylock ? p : tempo * p;      // final pitch ratio
    const alpha = P / tempo;                // stretch before resampling
    let out = chs;
    if (Math.abs(alpha - 1) > 1e-4) out = wsola(out, alpha);
    if (Math.abs(P - 1) > 1e-4) out = resample(out, P);
    return out;
  }

  // ---------- WAV ----------
  function encodeWAV(chs, sr) {
    const nch = chs.length, n = chs[0].length;
    const buf = new ArrayBuffer(44 + n * nch * 2);
    const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + n * nch * 2, true); ws(8, 'WAVE');
    ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, n * nch * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        let s = Math.max(-1, Math.min(1, chs[c][i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
      }
    }
    return buf;
  }

  return { toMono, fft, analyze, analyzeBands, detectTempo, detectKey, wsola, resample, processSegment, encodeWAV };
}

// ---------- Worker bridge ----------
const DSP = DSPLib();
const DSPWorker = (function () {
  let worker = null, seq = 0;
  const pending = new Map();
  try {
    const src = 'const DSP=(' + DSPLib.toString() + ')();\n' +
      'onmessage=function(e){const m=e.data;try{let r,tr=[];' +
      'if(m.type==="analyze"){r=DSP.analyze(m.chs,m.sr);tr=[r.bands.low.buffer,r.bands.mid.buffer,r.bands.high.buffer];}' +
      'else if(m.type==="process"){r=DSP.processSegment(m.chs,m.tempo,m.semis,m.keylock);tr=r.map(c=>c.buffer);}' +
      'postMessage({id:m.id,result:r},tr);}catch(err){postMessage({id:m.id,error:String(err&&err.message||err)});}};';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = e => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
    };
  } catch (err) {
    worker = null;
  }
  function call(msg) {
    if (!worker) {
      return new Promise((res, rej) => setTimeout(() => {
        try {
          res(msg.type === 'analyze' ? DSP.analyze(msg.chs, msg.sr) : DSP.processSegment(msg.chs, msg.tempo, msg.semis, msg.keylock));
        } catch (e) { rej(e); }
      }, 0));
    }
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage(Object.assign({ id }, msg));
    });
  }
  return {
    analyze: (chs, sr) => call({ type: 'analyze', chs, sr }),
    process: (chs, tempo, semis, keylock) => call({ type: 'process', chs, tempo, semis, keylock })
  };
})();
