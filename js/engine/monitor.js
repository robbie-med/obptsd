// The paper strip (SPEC §4): what the monitor *shows*, which is not the same as what the fetus does.
// External Doppler loses contact, picks up the maternal pulse, double-counts slow rates;
// external toco only shows relative pressure; IUPC/FSE fix that once membranes are ruptured.
import { clamp } from './util.js';

const GROW = 4096;

function grow(arr, need) {
  if (need <= arr.length) return arr;
  const n = new Float32Array(Math.max(need, arr.length * 2));
  n.fill(NaN); n.set(arr);
  return n;
}

export function initMonitor(p, rng) {
  const r = rng.fork('monitor');
  p.mon = {
    r, on: false, t0: null,
    fhr: new Float32Array(GROW).fill(NaN), n4: 0,
    uc: new Float32Array(GROW).fill(NaN), mhr: new Float32Array(GROW).fill(NaN), tfhr: new Float32Array(GROW).fill(NaN), n1: 0,
    us: 'ok', usUntil: 0, smooth: NaN,
    tocoGain: clamp(1.0 - (p.bmi - 25) * 0.02, 0.25, 0.95) * r.range(0.6, 1.0), tocoOffset: r.range(8, 20), tocoSlip: false,
    notes: [],
  };
}

export function monitorTime(p, idx4) { return p.mon.t0 + idx4 / 4; }

// Called 4x per sim-second by physio with the true FHR.
export function pushSample(p, sim, ts, fhrTrue) {
  const m = p.mon, T = p.T, r = m.r;
  if (m.t0 === null) m.t0 = Math.floor(ts);
  const sub = Math.round((ts - Math.floor(ts)) * 4);
  const on = m.on && !(p.area === 'or' || p.area === 'offsite' || p.area === 'home' || p.area === 'waiting');
  // 1 Hz channels + Doppler state machine
  if (sub === 0) {
    m.uc = grow(m.uc, m.n1 + 1); m.mhr = grow(m.mhr, m.n1 + 1); m.tfhr = grow(m.tfhr, m.n1 + 1);
    let uc = NaN, mhr = NaN;
    if (on) {
      if (p.devices.iupc) uc = clamp(T.iup + r.normal(0, 0.8), 0, 100);
      else if (!m.tocoSlip) uc = clamp(m.tocoOffset + m.tocoGain * (T.iup - T.tone) + r.normal(0, 0.6), 0, 99);
      else uc = clamp(m.tocoOffset * 0.6 + r.normal(0, 0.5), 0, 99);
      if (p.devices.spo2) mhr = T.mhr + r.normal(0, 1.2);
      // toco slips (nurse fixes it)
      if (!p.devices.iupc) {
        if (!m.tocoSlip && r.chance((p.bmi > 40 ? 1.5 : 0.4) / 3600)) { m.tocoSlip = true; m.tocoFixAt = sim.t + r.range(60, 480); }
        if (m.tocoSlip && sim.t > m.tocoFixAt) { m.tocoSlip = false; m.tocoOffset = r.range(8, 20); m.tocoGain = clamp(1.0 - (p.bmi - 25) * 0.02, 0.25, 0.95) * r.range(0.6, 1.0); }
      }
      if (!p.devices.fse) dopplerState(p, sim);
    }
    m.uc[m.n1] = uc; m.mhr[m.n1] = mhr; m.tfhr[m.n1] = on || sim.teaching ? fhrTrue : NaN;
    m.n1++;
  }
  m.fhr = grow(m.fhr, m.n4 + 1);
  let v = NaN;
  if (on) {
    if (T.demise) v = p.devices.fse ? T.mhr + r.normal(0, 1) : (m.us === 'lost' ? NaN : T.mhr + r.normal(0, 1.5));
    else if (p.devices.fse) v = fhrTrue + r.normal(0, 0.6);
    else if (m.us === 'ok') {
      m.smooth = isNaN(m.smooth) ? fhrTrue : 0.55 * m.smooth + 0.45 * fhrTrue; // autocorrelation smoothing
      v = m.smooth;
      if (fhrTrue < 72 && r.chance(0.002)) { m.us = 'double'; m.usUntil = sim.t + r.range(20, 90); }
    } else if (m.us === 'mhr') v = T.mhr + r.normal(0, 1.5);
    else if (m.us === 'double') v = Math.min(235, fhrTrue * 2 + r.normal(0, 2));
    if (!isNaN(v) && !p.devices.fse && r.chance(0.0006)) v += r.pick([-1, 1]) * r.range(25, 60); // spike artifact
  }
  if (m.us !== 'ok') m.smooth = NaN;
  m.fhr[m.n4] = v;
  m.n4++;
}

function dopplerState(p, sim) {
  const m = p.mon, r = m.r, T = p.T;
  const pushing = p.pushing === 'pushing';
  if (m.us === 'ok') {
    let lossPerH = 0.8 + (p.bmi > 35 ? 1.5 : 0) + (p.bmi > 45 ? 3 : 0) + (pushing ? 7 : 0) + (T.station > 2 ? 2 : 0) + (sim.t < T.seizingUntil ? 200 : 0) + (p.T.pain > 7 ? 1 : 0);
    if (r.chance(lossPerH / 3600)) {
      const pickup = r.chance(0.1 + (pushing ? 0.3 : 0) + (p.bmi > 40 ? 0.08 : 0));
      m.us = pickup ? 'mhr' : 'lost';
      const nurse = sim.nurseOf(p);
      const notice = nurse ? (1.6 - nurse.alert) : 1;
      m.usUntil = sim.t + (pickup ? r.range(40, 240) * notice : r.range(20, 200) * notice);
    }
  } else if (sim.t >= m.usUntil) {
    m.us = 'ok';
  }
}

export function annotate(p, sim, text) {
  p.mon.notes.push({ t: sim.t, text });
}

// ------------------------------------------------------------------------------------------------
// Visual read of the displayed strip (what a nurse could see). No NICHD category is produced —
// only features. Used by nurse behaviour, never shown as a label in the UI.
export function analyzeStrip(p, endT, windowSec = 600) {
  const m = p.mon;
  if (m.t0 === null) return null;
  const end1 = Math.min(m.n1, Math.floor(endT - m.t0));
  const start1 = Math.max(0, end1 - windowSec);
  if (end1 - start1 < 60) return null;
  // 1-s FHR means
  const f = [];
  let lost = 0;
  for (let i = start1; i < end1; i++) {
    let s = 0, n = 0;
    for (let k = 0; k < 4; k++) { const v = m.fhr[i * 4 + k]; if (!isNaN(v)) { s += v; n++; } }
    if (n) f.push(s / n); else { f.push(NaN); lost++; }
  }
  const valid = f.filter(v => !isNaN(v));
  if (valid.length < 60) return { lossFrac: lost / f.length, baseline: null };
  // baseline: smoothed mode of 2-bpm histogram
  const hist = new Map();
  for (const v of valid) { const b = Math.round(v / 2) * 2; hist.set(b, (hist.get(b) || 0) + 1); }
  let best = null, bestN = -1;
  for (const [b] of hist) {
    let n = 0; for (let d = -4; d <= 4; d += 2) n += hist.get(b + d) || 0;
    if (n > bestN) { bestN = n; best = b; }
  }
  const baseline = best;
  // variability: median per-minute range of values within +-25 of baseline
  const ranges = [];
  for (let s = 0; s + 60 <= f.length; s += 60) {
    let lo = 1e9, hi = -1e9, n = 0;
    for (let i = s; i < s + 60; i++) { const v = f[i]; if (!isNaN(v) && Math.abs(v - baseline) < 25) { lo = Math.min(lo, v); hi = Math.max(hi, v); n++; } }
    if (n > 30) ranges.push(hi - lo);
  }
  ranges.sort((a, b) => a - b);
  const variability = ranges.length ? ranges[Math.floor(ranges.length / 2)] : null;
  // contractions on displayed UC
  const uc = Array.from(m.uc.subarray(start1, end1));
  const ucValid = uc.filter(v => !isNaN(v)).sort((a, b) => a - b);
  const ucBase = ucValid.length ? ucValid[Math.floor(ucValid.length * 0.2)] : 0;
  const ucPeak = ucValid.length ? ucValid[Math.floor(ucValid.length * 0.97)] : 0;
  // peaks with prominence (coupled contractions never fall back below a fixed threshold)
  const us = uc.map((v, i) => {
    let a = 0, n = 0;
    for (let k = Math.max(0, i - 4); k <= Math.min(uc.length - 1, i + 4); k++) if (!isNaN(uc[k])) { a += uc[k]; n++; }
    return n ? a / n : NaN;
  });
  const minProm = Math.max(4, 0.3 * (ucPeak - ucBase));
  const ctx = [];
  for (let i = 1; i < us.length - 1; i++) {
    const v = us[i];
    if (isNaN(v) || !(v >= us[i - 1] && v > us[i + 1])) continue;
    let lo = v, j = i;
    while (j > 0 && i - j < 150 && !isNaN(us[j - 1]) && us[j - 1] <= v) { j--; lo = Math.min(lo, us[j]); }
    let lo2 = v, k = i;
    while (k < us.length - 1 && k - i < 150 && !isNaN(us[k + 1]) && us[k + 1] <= v) { k++; lo2 = Math.min(lo2, us[k]); }
    const prom = v - Math.max(lo, lo2);
    if (prom < minProm || v < ucBase + 4) continue;
    if (ctx.length && i - ctx[ctx.length - 1].peak < 40) { if (v > ctx[ctx.length - 1].pv) { ctx[ctx.length - 1].peak = i; ctx[ctx.length - 1].pv = v; } continue; }
    ctx.push({ start: j, peak: i, end: k, amp: v - ucBase, pv: v });
  }
  // decels & accels on a 5-s smoothed series (beat-to-beat noise otherwise blurs onset timing)
  const fs = f.map((v, i) => {
    if (isNaN(v)) return NaN;
    let s = 0, n = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(f.length - 1, i + 2); k++) if (!isNaN(f[k])) { s += f[k]; n++; }
    return s / n;
  });
  const decels = [], accels = [];
  let run = null;
  for (let i = 0; i <= fs.length; i++) {
    const v = i < fs.length ? fs[i] : NaN;
    const below = !isNaN(v) && v < baseline - 10;
    if (below) {
      if (!run) run = { start: i, nadir: i, depth: baseline - v };
      if (baseline - v > run.depth) { run.depth = baseline - v; run.nadir = i; }
    } else if (run) {
      // find onset: walk back to where it left baseline - 3
      let on = run.start;
      while (on > 0 && !isNaN(fs[on - 1]) && fs[on - 1] < baseline - 4) on--;
      const dur = i - on;
      if ((run.depth >= 15 && i - run.start >= 15) || (run.depth >= 10 && i - run.start >= 30)) {
        const onsetToNadir = run.nadir - on;
        let near = null, bestD = 1e9;
        for (const c of ctx) { const d = Math.abs(c.peak - run.nadir); if (d < bestD) { bestD = d; near = c; } }
        let kind;
        if (dur >= 120 && run.depth >= 15) kind = 'prolonged';
        else if (onsetToNadir < 30) kind = 'variable';
        else if (near && run.nadir - near.peak > 12 && bestD < 90) kind = 'late';
        else if (near && bestD < 90) kind = 'early';
        else kind = 'variable';
        decels.push({ onset: on, nadir: run.nadir, end: i, depth: run.depth, dur, kind, withCtx: !!near && bestD < 90 });
      }
      run = null;
    }
  }
  let ar = null;
  for (let i = 0; i <= f.length; i++) {
    const v = i < f.length ? f[i] : NaN;
    const up = !isNaN(v) && v > baseline + 15;
    if (up && ar === null) ar = i;
    else if (!up && ar !== null) { if (i - ar >= 15) accels.push({ start: ar, dur: i - ar }); ar = null; }
  }
  const minFhr = Math.min(...valid);
  const last120 = f.slice(-120).filter(v => !isNaN(v));
  let match = 0, both = 0;
  for (let i = Math.max(0, f.length - 90); i < f.length; i++) {
    const mh = m.mhr[start1 + i];
    if (!isNaN(f[i]) && !isNaN(mh)) { both++; if (Math.abs(f[i] - mh) < 7) match++; }
  }
  const mhrMatchFrac = both >= 30 ? match / both : 0;
  const lowFrac120 = last120.length >= 60 ? last120.filter(v => v < 100).length / last120.length : null;
  const lastMin = f.slice(-60).filter(v => !isNaN(v));
  const currentFhr = lastMin.length ? lastMin.reduce((a, b) => a + b, 0) / lastMin.length : null;
  return {
    baseline, variability, accels, decels, ctx, ctxPer10: f.length >= 480 && ucValid.length >= 300 ? ctx.length * 600 / f.length : null, lossFrac: lost / f.length,
    minFhr, currentFhr, lowFrac120, mhrMatchFrac, windowSec: f.length,
  };
}
