export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const MIN = 60;
export const HOUR = 3600;

// Normalised one-compartment absorption/elimination curve (Bateman), peak scaled to 1.
// tPeakMin / tHalfMin in minutes. Shapes are cached: this is called per second per dose.
const _bCache = new Map();
export function bateman(tSinceSec, tPeakMin, tHalfMin) {
  if (tSinceSec < 0) return 0;
  const key = tPeakMin + ':' + tHalfMin;
  let c = _bCache.get(key);
  if (!c) {
    const ke = Math.LN2 / (tHalfMin * 60);
    const tp = tPeakMin * 60;
    const tpeak = (ka) => Math.log(ka / ke) / (ka - ke); // decreasing in ka
    let lo = Math.log(ke * 1.000001), hi = Math.log(5);
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (tpeak(Math.exp(mid)) > tp) lo = mid; else hi = mid;
    }
    const ka = Math.exp((lo + hi) / 2);
    const peak = Math.exp(-ke * tp) - Math.exp(-ka * tp);
    c = { ke, ka, peak };
    _bCache.set(key, c);
  }
  const v = (Math.exp(-c.ke * tSinceSec) - Math.exp(-c.ka * tSinceSec)) / c.peak;
  return v > 0 ? v : 0;
}

export function fmtClock(simT, startSec) {
  const s = Math.floor(startSec + simT) % 86400;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return String(h).padStart(2, '0') + String(m).padStart(2, '0');
}
export function fmtClockColon(simT, startSec) {
  const c = fmtClock(simT, startSec);
  return c.slice(0, 2) + ':' + c.slice(2);
}
export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
export function fmtGA(days) {
  return `${Math.floor(days / 7)}+${days % 7}`;
}
export function roundTo(x, step) { return Math.round(x / step) * step; }
