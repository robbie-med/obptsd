// Procedural room sound (UI only, Web Audio, no samples). The Doppler plays what the monitor is
// hearing — the same sample the paper prints — never the hidden truth: if the transducer slips onto
// mom's pulse you hear mom's rate, if it loses the baby you hear static. Nothing here reads p.T.
let ac = null, master = null, noiseBuf = null;
let nextBeat = 0, lastPid = null;

function ctx() {
  if (!ac) {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    master = ac.createGain(); master.gain.value = 0.9; master.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 1, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

// one "whoosh" of the Doppler: band-passed noise with a fast attack, plus a soft low thud
function whoosh(t, gain, freq, dur) {
  const src = ac.createBufferSource(); src.buffer = noiseBuf;
  const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.6;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g).connect(master);
  src.start(t, Math.random() * 0.8, dur + 0.05);
  const o = ac.createOscillator(), og = ac.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(48, t + dur);
  og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(gain * 1.6, t + 0.01); og.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.9);
  o.connect(og).connect(master); o.start(t); o.stop(t + dur + 0.02);
}
function beat(t, bpm) {
  // a quick gallop: two components per beat, spreading out as the rate falls
  const sp = Math.min(0.14, 18 / bpm);
  whoosh(t, 0.2, 520, 0.075);
  whoosh(t + sp, 0.11, 380, 0.09);
}
function hiss(t, dur) {
  const src = ac.createBufferSource(); src.buffer = noiseBuf;
  const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
  const g = ac.createGain(); g.gain.value = 0.015;
  src.connect(hp).connect(g).connect(master); src.start(t, Math.random() * 0.5, dur);
}
function blip(t, f, dur, gain = 0.05, type = 'sine') {
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.value = f;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
}

// Walking into a room: the monitor's chirp, and the pump's triple beep if something is infusing.
export function enterRoom(sim, p) {
  try {
    ctx();
    const t = ac.currentTime + 0.05;
    blip(t, 1046, 0.09); blip(t + 0.13, 1318, 0.12);
    const pumping = p.meds && ((p.meds.pit && p.meds.pit.rate > 0) || (p.meds.mag && p.meds.mag.on));
    if (pumping) [0, 0.16, 0.32].forEach(d => blip(t + 0.7 + d, 2093, 0.07, 0.025, 'square'));
    const v = sim.lastVitals(p);
    if (v && (v.sbp < 90 || v.sbp >= 160 || v.hr > 120 || v.spo2 < 93)) [0, 0.25].forEach(d => blip(t + 1.4 + d, 740, 0.18, 0.04, 'triangle')); // the vitals monitor alarming
  } catch { /* no audio */ }
}

// Called every animation frame while the FHR audio toggle is on.
export function dopplerTick(sim, p, running) {
  if (!p || !running || !p.mon || !p.mon.on) { nextBeat = 0; return; }
  try {
    ctx();
    const now = ac.currentTime;
    if (p.id !== lastPid) { lastPid = p.id; nextBeat = now + 0.4; }
    if (nextBeat < now) nextBeat = now + 0.05;
    while (nextBeat < now + 0.12) {
      const m = p.mon;
      const v = m.n4 ? m.fhr[m.n4 - 1] : NaN;
      if (!(v > 30)) { hiss(nextBeat, 0.45); nextBeat += 0.5; continue; }
      beat(nextBeat, v);
      nextBeat += 60 / Math.min(240, Math.max(40, v));
    }
  } catch { /* no audio */ }
}

export function stopAll() { nextBeat = 0; lastPid = null; }
