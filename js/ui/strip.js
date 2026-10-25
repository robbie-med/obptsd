// Paper strip renderer: US paper (FHR 30–240 bpm, UA 0–100), 3 cm/min, printed annotations.
// Draws only what the monitor recorded (p.mon), never the hidden truth — unless teaching mode.
import { fmtClockColon } from '../engine/util.js';

const PX_PER_CM = 96 / 2.54; // CSS px per cm
const GRID_MINOR = '#f4bfb6', GRID_MAJOR = '#e58b7f', GRID_MIN = '#d76a5f', INK = '#151515', MHR = '#2f6fd0', TRUE = '#d6338a';

export function drawStrip(canvas, sim, p, view) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, Hh = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(Hh * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hh * dpr); }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#fbf7ee'; g.fillRect(0, 0, W, Hh);
  const left = 34;
  const plotW = W - left - 6;
  const pxPerMin = view.window === 'paper' ? 3 * PX_PER_CM : plotW / view.window;
  const winSec = (plotW / pxPerMin) * 60;
  const endT = view.live ? sim.t : view.endT;
  const startT = endT - winSec;
  view.winSec = winSec;
  // layout
  const fTop = 8, fH = Math.round((Hh - 34) * 0.66), gap = 22, uTop = fTop + fH + gap, uH = Hh - uTop - 8;
  const yF = (bpm) => fTop + (240 - bpm) / 210 * fH;
  const yU = (mm) => uTop + (100 - mm) / 100 * uH;
  const xT = (t) => left + (t - startT) / 60 * pxPerMin;

  // FHR band 110-160
  g.fillStyle = '#f6e9de'; g.fillRect(left, yF(160), plotW, yF(110) - yF(160));
  // horizontal grid
  g.lineWidth = 1;
  for (let b = 30; b <= 240; b += 10) {
    g.strokeStyle = b % 30 === 0 ? GRID_MAJOR : GRID_MINOR;
    line(g, left, yF(b), left + plotW, yF(b));
  }
  for (let m = 0; m <= 100; m += 10) {
    g.strokeStyle = m % 50 === 0 ? GRID_MAJOR : GRID_MINOR;
    line(g, left, yU(m), left + plotW, yU(m));
  }
  // vertical grid: 10 s minor (if room), 1 min major, 10 min heavier
  const t0 = Math.floor(startT / 10) * 10;
  const showMinor = pxPerMin / 6 >= 5;
  for (let t = t0; t <= endT; t += 10) {
    const x = xT(t);
    if (x < left) continue;
    const isMin = Math.round(t) % 60 === 0;
    if (!isMin && !showMinor) continue;
    const abs = Math.round(t + sim.startClock);
    g.strokeStyle = !isMin ? GRID_MINOR : abs % 600 === 0 ? GRID_MIN : GRID_MAJOR;
    g.lineWidth = isMin && abs % 600 === 0 ? 1.4 : 1;
    line(g, x, fTop, x, fTop + fH); line(g, x, uTop, x, uTop + uH);
  }
  // scale labels
  g.fillStyle = '#b5584d'; g.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  g.textAlign = 'right';
  for (let b = 60; b <= 240; b += 30) g.fillText(String(b), left - 4, yF(b) + 3);
  for (let m = 0; m <= 100; m += 25) g.fillText(String(m), left - 4, yU(m) + 3);
  g.save(); g.translate(10, fTop + fH / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText('FHR bpm', 0, 0); g.restore();
  g.save(); g.translate(10, uTop + uH / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText(p.devices.iupc ? 'UA mmHg' : 'TOCO', 0, 0); g.restore();
  // time labels in the gap
  g.textAlign = 'left'; g.fillStyle = '#8b4038';
  const labelEvery = pxPerMin >= 90 ? 60 : pxPerMin >= 30 ? 300 : 600;
  for (let t = Math.ceil((startT + sim.startClock) / labelEvery) * labelEvery - sim.startClock; t <= endT; t += labelEvery) {
    const x = xT(t);
    if (x < left + 2) continue;
    g.fillText(fmtClockColon(t, sim.startClock), x + 2, fTop + fH + 14);
  }
  g.fillStyle = '#b5584d'; g.textAlign = 'left';
  g.fillText(view.window === 'paper' ? '3 cm/min' : `${view.window} min window`, left + 4, fTop + 11);

  const m = p.mon;
  if (m.t0 === null) return;
  // toco / IUPC (1 Hz)
  g.strokeStyle = INK; g.lineWidth = 1.2;
  trace1(g, m.uc, m.n1, m.t0, startT, endT, xT, yU, 1);
  // MHR (1 Hz) — printed in blue like many monitors
  g.strokeStyle = MHR; g.lineWidth = 1; g.setLineDash([3, 2]);
  trace1(g, m.mhr, m.n1, m.t0, startT, endT, xT, (v) => yF(Math.max(30, Math.min(240, v))), 1);
  g.setLineDash([]);
  // teaching: true FHR (1 Hz)
  if (view.teaching) {
    g.strokeStyle = TRUE; g.globalAlpha = 0.55; g.lineWidth = 1;
    trace1(g, m.tfhr, m.n1, m.t0, startT, endT, xT, (v) => yF(Math.max(30, Math.min(240, v))), 1);
    g.globalAlpha = 1;
  }
  // FHR (4 Hz)
  g.strokeStyle = INK; g.lineWidth = 1.25;
  trace1(g, m.fhr, m.n4, m.t0, startT, endT, xT, (v) => yF(Math.max(30, Math.min(240, v))), 4);

  // printed annotations
  g.font = '10.5px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  g.textAlign = 'left';
  let lastX = -1e9, row = 0;
  for (const n of m.notes) {
    if (n.t < startT - 120 || n.t > endT) continue;
    const x = xT(n.t);
    row = x - lastX < 90 ? (row + 1) % 3 : 0;
    lastX = x;
    const y = fTop + fH - 6 - row * 12;
    g.strokeStyle = '#6a4a8a'; g.lineWidth = 1;
    line(g, x, y + 3, x, fTop + fH);
    g.fillStyle = '#4a2f6a';
    g.fillText(n.text, x + 2, y);
  }
  // off-monitor shading
  if (!m.on || p.area === 'or') {
    g.fillStyle = '#00000012'; g.fillRect(xT(sim.t) - 2, fTop, 4, uTop + uH - fTop);
  }
  // live cursor
  if (view.live) { g.strokeStyle = '#2a8a5a'; g.lineWidth = 1; line(g, xT(endT), fTop, xT(endT), uTop + uH); }
}

function line(g, x1, y1, x2, y2) { g.beginPath(); g.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5); g.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5); g.stroke(); }

function trace1(g, arr, n, t0, startT, endT, xT, yv, hz) {
  const i0 = Math.max(0, Math.floor((startT - t0) * hz));
  const i1 = Math.min(n - 1, Math.ceil((endT - t0) * hz));
  if (i1 <= i0) return;
  // decimate to ~1 point per px
  const pxSpan = xT(t0 + i1 / hz) - xT(t0 + i0 / hz);
  const step = Math.max(1, Math.floor((i1 - i0) / Math.max(1, pxSpan * 1.5)));
  g.beginPath();
  let pen = false, prev = NaN;
  for (let i = i0; i <= i1; i += step) {
    let v = arr[i];
    if (step > 1) { // min/max envelope would be nicer; mean is fine for overview
      let s = 0, c = 0; for (let k = 0; k < step && i + k <= i1; k++) { const w = arr[i + k]; if (!isNaN(w)) { s += w; c++; } }
      v = c ? s / c : NaN;
    }
    const x = xT(t0 + i / hz);
    if (isNaN(v)) { pen = false; prev = v; continue; }
    const y = yv(v);
    // a jump of >40 bpm between adjacent samples is a pen lift on real paper (artifact / channel switch)
    if (!pen || Math.abs(v - prev) > 40) g.moveTo(x, y); else g.lineTo(x, y);
    pen = true; prev = v;
  }
  g.stroke();
}

// Small board strip: last 10 min FHR (60–200) and toco shading.
export function drawMini(canvas, sim, p) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 300, Hh = canvas.clientHeight || 38;
  if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hh * dpr); }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#0a1117'; g.fillRect(0, 0, W, Hh);
  const m = p.mon;
  if (m.t0 === null) return;
  const win = 600, endT = sim.t, startT = endT - win;
  const xT = (t) => (t - startT) / win * W;
  const uH = Hh * 0.35;
  const yF = (b) => (200 - Math.max(60, Math.min(200, b))) / 140 * (Hh - uH - 2) + 1;
  const yU = (v) => Hh - (Math.max(0, Math.min(100, v)) / 100) * uH;
  g.fillStyle = '#1a2a22'; g.fillRect(0, yF(160), W, yF(110) - yF(160));
  // toco area
  g.fillStyle = '#3c5368';
  const i0 = Math.max(0, Math.floor(startT - m.t0)), i1 = m.n1 - 1;
  g.beginPath(); g.moveTo(0, Hh);
  for (let i = i0; i <= i1; i += 2) { const v = m.uc[i]; g.lineTo(xT(m.t0 + i), isNaN(v) ? Hh : yU(v)); }
  g.lineTo(W, Hh); g.closePath(); g.fill();
  // FHR
  g.strokeStyle = '#4fe0a0'; g.lineWidth = 1;
  g.beginPath();
  let pen = false;
  const j0 = Math.max(0, Math.floor((startT - m.t0) * 4)), j1 = m.n4 - 1;
  for (let j = j0; j <= j1; j += 4) {
    const v = m.fhr[j];
    if (isNaN(v)) { pen = false; continue; }
    const x = xT(m.t0 + j / 4), y = yF(v);
    if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
  }
  g.stroke();
}
