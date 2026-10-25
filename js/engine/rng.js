// Seeded randomness. The engine never touches Math.random: same seed + same command log
// = same night. Each subsystem/patient gets its own named stream (fork) so that, e.g.,
// adding an order to room 3 can't change who walks into triage at 02:00.

export function hashString(str) {
  // xmur3
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

function sfc32(a, b, c, d) {
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.seed = String(seed);
    const s = this.seed;
    this._next = sfc32(hashString(s + '#a'), hashString(s + '#b'), hashString(s + '#c'), hashString(s + '#d'));
    for (let i = 0; i < 12; i++) this._next();
    this._spare = null;
  }
  fork(label) { return new Rng(this.seed + '/' + label); }
  next() { return this._next(); }
  range(a, b) { return a + (b - a) * this._next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  chance(p) { return this._next() < p; }
  pick(arr) { return arr[Math.floor(this._next() * arr.length)]; }
  weighted(pairs) { // [[value, weight], ...]
    let tot = 0; for (const [, w] of pairs) tot += w;
    let r = this._next() * tot;
    for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
    return pairs[pairs.length - 1][0];
  }
  normal(mu = 0, sd = 1) {
    if (this._spare !== null) { const z = this._spare; this._spare = null; return mu + sd * z; }
    let u, v, s;
    do { u = this._next() * 2 - 1; v = this._next() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    this._spare = v * m;
    return mu + sd * u * m;
  }
  lognormal(median = 1, sdLog = 0.5) { return median * Math.exp(this.normal(0, sdLog)); }
  gamma(shape, mean = 1) { // Marsaglia–Tsang, returns value with given mean
    let k = shape, boost = 1;
    if (k < 1) { boost = Math.pow(this._next(), 1 / k); k += 1; }
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = this.normal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = this._next();
      if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return (d * v * boost) * (mean / shape);
      }
    }
  }
  exp(mean) { return -Math.log(1 - this._next()) * mean; }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this._next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
}
