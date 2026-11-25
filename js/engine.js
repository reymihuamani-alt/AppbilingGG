/* Audio engine: time-line maths, segment processing cache, offline render, playback. */
const Engine = (function () {
  const SR = 44100;
  const cache = new Map();

  // Mix time-line. All "mix" times are seconds from start of the rendered clip.
  function timeline(st) {
    const A = st.tracks.A, B = st.tracks.B;
    const t = st.trans;
    const sync = t.sync;
    const mixBpm = sync === 'toB' ? B.bpm : A.bpm;
    const tA = sync === 'toB' ? B.bpm / A.bpm : 1;
    const tB = sync === 'toA' ? A.bpm / B.bpm : 1;
    const beat = 60 / mixBpm;
    const L = t.bars * 4 * beat, Pr = t.preBars * 4 * beat, Po = t.postBars * 4 * beat;
    const total = Pr + L + Po;
    return {
      mixBpm, tA, tB, beat, L, Pr, Po, total,
      aStart: st.deck.A.point - Pr * tA,   // A source time at mix 0
      bStart: st.deck.B.point - Pr * tB,
      srcA: u => st.deck.A.point + (u - Pr) * tA,
      srcB: u => st.deck.B.point + (u - Pr) * tB
    };
  }

  function sliceBuffer(track, from, to) {
    const sr = track.sr;
    const a = Math.max(0, Math.floor(from * sr)), b = Math.min(track.channels[0].length, Math.ceil(to * sr));
    if (b <= a) return null;
    return track.channels.map(c => c.slice(a, b));
  }

  // Returns {chs, sr, offset} : processed audio and its mix start time
  async function processedSegment(st, deck, tl) {
    const tr = st.tracks[deck], d = st.deck[deck];
    const tempo = deck === 'A' ? tl.tA : tl.tB;
    const start = deck === 'A' ? tl.aStart : tl.bStart;
    const srcFrom = Math.max(0, start), srcTo = Math.min(tr.duration, start + tl.total * tempo + 0.05);
    const key = [tr.id, srcFrom.toFixed(4), srcTo.toFixed(4), tempo.toFixed(5), d.semis, d.keylock].join('|');
    if (cache.has(key)) return cache.get(key);
    let p;
    const offset = (srcFrom - start) / tempo;
    const raw = sliceBuffer(tr, srcFrom, srcTo);
    if (!raw) p = Promise.resolve(null);
    else if (Math.abs(tempo - 1) < 1e-5 && !d.semis) p = Promise.resolve({ chs: raw, sr: tr.sr, offset });
    else p = DSPWorker.process(raw, tempo, d.semis, d.keylock).then(chs => ({ chs, sr: tr.sr, offset }));
    cache.set(key, p);
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    return p;
  }

  let impulseCache = null;
  function impulse(ctx, size) {
    const len = Math.floor(ctx.sampleRate * (0.6 + size * 3.4));
    const key = len;
    if (impulseCache && impulseCache.key === key) {
      const b = ctx.createBuffer(2, len, ctx.sampleRate);
      b.copyToChannel(impulseCache.l, 0); b.copyToChannel(impulseCache.r, 1);
      return b;
    }
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        lp = lp * 0.6 + rnd() * 0.4; // slightly darker tail
        d[i] = lp * Math.pow(1 - t, 2.2) * (i < 40 ? i / 40 : 1);
      }
    }
    impulseCache = { key, l: b.getChannelData(0).slice(), r: b.getChannelData(1).slice() };
    return b;
  }

  function automate(param, laneId, pts, tl, mapFn) {
    const f = mapFn || Automation.map[laneId];
    const n = Math.max(16, Math.min(4000, Math.ceil(tl.L * 120)));
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = f(Automation.evalLane(pts, i / (n - 1)));
    param.setValueAtTime(curve[0], 0);
    param.setValueCurveAtTime(curve, tl.Pr, tl.L);
  }

  function buildDeck(ctx, st, deck, seg, tl, master) {
    if (!seg) return;
    const lanes = st.lanes[deck];
    const buf = ctx.createBuffer(seg.chs.length, seg.chs[0].length, seg.sr);
    seg.chs.forEach((c, i) => buf.copyToChannel(c, i));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    automate(src.playbackRate, 'speed', lanes.speed, tl);

    const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 250;
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.55;
    const high = ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 3200;
    automate(low.gain, 'low', lanes.low, tl);
    automate(mid.gain, 'mid', lanes.mid, tl);
    automate(high.gain, 'high', lanes.high, tl);
    // second shelf stage for deeper "kills"
    const low2 = ctx.createBiquadFilter(); low2.type = 'lowshelf'; low2.frequency.value = 180;
    automate(low2.gain, 'low', lanes.low, tl, v => Math.min(0, Automation.eqDb(v)));

    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = st.trans.filterRes;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = st.trans.filterRes;
    automate(hp.frequency, 'filter', lanes.filter, tl, Automation.hpFreq);
    automate(lp.frequency, 'filter', lanes.filter, tl, Automation.lpFreq);

    const vol = ctx.createGain();
    automate(vol.gain, 'vol', lanes.vol, tl);
    const trim = ctx.createGain(); trim.gain.value = Math.pow(10, (st.deck[deck].gain || 0) / 20);

    src.connect(trim).connect(low).connect(low2).connect(mid).connect(high).connect(hp).connect(lp).connect(vol).connect(master);

    // Echo (post-fader send), tempo-synced feedback delay
    const echoSend = ctx.createGain();
    automate(echoSend.gain, 'echo', lanes.echo, tl);
    const delay = ctx.createDelay(4);
    delay.delayTime.value = Math.min(3.9, tl.beat * st.trans.echoBeats);
    const fb = ctx.createGain(); fb.gain.value = st.trans.echoFb;
    const echoTone = ctx.createBiquadFilter(); echoTone.type = 'bandpass'; echoTone.frequency.value = 1400; echoTone.Q.value = 0.45;
    vol.connect(echoSend).connect(delay);
    delay.connect(echoTone).connect(fb).connect(delay);
    echoTone.connect(master);

    // Reverb send
    const revSend = ctx.createGain();
    automate(revSend.gain, 'reverb', lanes.reverb, tl);
    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, st.trans.reverbSize);
    const revHp = ctx.createBiquadFilter(); revHp.type = 'highpass'; revHp.frequency.value = 220;
    vol.connect(revSend).connect(revHp).connect(conv).connect(master);

    src.start(Math.max(0, seg.offset));
  }

  async function render(st) {
    const tl = timeline(st);
    const [segA, segB] = await Promise.all([processedSegment(st, 'A', tl), processedSegment(st, 'B', tl)]);
    const len = Math.ceil(tl.total * SR);
    const ctx = new OfflineAudioContext(2, len, SR);
    const master = ctx.createGain(); master.gain.value = Math.pow(10, st.trans.masterDb / 20);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -3; comp.knee.value = 2; comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.12;
    master.connect(comp).connect(ctx.destination);
    buildDeck(ctx, st, 'A', segA, tl, master);
    buildDeck(ctx, st, 'B', segB, tl, master);
    const buffer = await ctx.startRendering();
    return { buffer, tl };
  }

  // ---- realtime playback of rendered buffer ----
  let actx = null, srcNode = null, analyser = null, t0 = 0, off0 = 0, playing = false, onEnd = null;
  function ctx() {
    if (!actx) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = actx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.75;
      analyser.connect(actx.destination);
    }
    return actx;
  }
  function play(buffer, from, loop, endCb) {
    stop(true);
    const c = ctx();
    if (c.state === 'suspended') c.resume();
    srcNode = c.createBufferSource();
    srcNode.buffer = buffer;
    if (loop) { srcNode.loop = true; srcNode.loopStart = 0; srcNode.loopEnd = buffer.duration; }
    srcNode.connect(analyser);
    from = Math.max(0, Math.min(from, buffer.duration - 0.01));
    srcNode.start(0, from);
    t0 = c.currentTime; off0 = from; playing = true; onEnd = endCb;
    const me = srcNode;
    srcNode.onended = () => { if (srcNode === me) { playing = false; srcNode = null; onEnd && onEnd(); } };
  }
  function stop(silent) {
    if (srcNode) { const s = srcNode; srcNode = null; try { s.onended = null; s.stop(); } catch (e) { } }
    playing = false;
  }
  function position(dur) {
    if (!playing || !actx) return null;
    let p = off0 + (actx.currentTime - t0);
    if (dur) p = p % dur;
    return p;
  }

  return {
    SR, timeline, render, play, stop, position, ctx,
    isPlaying: () => playing,
    analyser: () => analyser,
    clearCache: () => cache.clear()
  };
})();
