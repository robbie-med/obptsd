// Hidden physiology (SPEC §3). One call to stepPatient() = 1 sim-second.
// Everything the player sees is derived from this through noisy channels (monitor.js, nurses.js).
//
// Model sketch
//  Uterus   : contraction "phase accumulator" driven by f10 (contractions/10 min) =
//             spontaneous drive S + oxytocin Emax(effect-site conc) + prostaglandins + AROM ...
//             so Pit tachysystole needs no scripting.
//  Cervix   : dilation rate = Zhang median rate for that cm x individual factor x contraction
//             adequacy (MVU) x ripeness gate (<6 cm) x position x CPD. Ripeness R is a latent
//             Bishop-like variable raised by prostaglandins/Foley/contraction work.
//  Fetus    : oxygenation ox = placental function x uteroplacental flow (falls with IUP and
//             maternal MAP) x cord flow; ox < 0.55 accrues base deficit (BD). FHR is built from
//             baseline + chemoreflex (late) + head compression (early) + baroreflex (variable)
//             + accelerations + a noise process whose amplitude falls as BD rises.
import { ZHANG_HOURS_PER_CM } from './data.js';
import { clamp, bateman } from './util.js';
import { pushSample } from './monitor.js';

const H = 3600;

export function initTruth(p, rng, spec) {
  const kind = p.kind, sub = p.sub, dx = p.dx;
  const T = {};
  p.T = T;
  T.rng = rng.fork('physio');
  const r = T.rng;
  const multip = p.para > 0 && p.priorVag > 0;

  // ---- cervix
  let dil = 0.5, R = 0.25, onset = false, S = 0.05, prodromal = 0.6;
  if (kind === 'iol' || kind === 'iol_waiting') {
    const favorable = r.chance(multip ? 0.45 : 0.2);
    dil = favorable ? r.range(2, 3.5) : r.range(0, 1.8);
    R = favorable ? r.range(0.42, 0.62) : r.range(0.08, 0.36);
  } else if (kind === 'labor') {
    const active = r.chance(0.55);
    dil = active ? r.range(5, 7.5) : r.range(3, 5);
    R = r.range(0.65, 0.95); onset = true; S = active ? r.range(0.65, 0.9) : r.range(0.4, 0.6);
  } else if (kind === 'cs_sched') {
    dil = r.range(0, 1.5); R = r.range(0.1, 0.4);
  } else if (kind === 'antepartum') {
    dil = r.range(0, 1.5); R = r.range(0.08, 0.3);
  } else if (kind === 'triage') {
    if (sub === 'ctx') {
      const x = r.next();
      if (x < 0.55) { dil = r.range(1, 2.5); R = r.range(0.35, 0.6); prodromal = r.range(1.5, 3); }
      else if (x < 0.85) { dil = r.range(3, 4.5); R = r.range(0.6, 0.8); onset = true; S = r.range(0.35, 0.5); }
      else { dil = r.range(5, 8); R = r.range(0.75, 0.95); onset = true; S = r.range(0.7, 0.9); }
    } else if (sub === 'preterm') {
      if (r.chance(0.3)) { dil = r.range(2, 4); R = r.range(0.5, 0.75); onset = true; S = r.range(0.35, 0.55); }
      else { dil = r.range(0, 1.5); R = r.range(0.15, 0.4); prodromal = r.range(1.5, 3.5); }
    } else if (sub === 'bleed' && r.chance(0.5) && !dx.previa) {
      dil = r.range(2, 4); R = r.range(0.55, 0.8); onset = true; S = r.range(0.3, 0.5);
    } else {
      dil = r.range(0, 2.5); R = r.range(0.2, 0.55);
    }
  }
  if (multip) R = Math.min(1, R + 0.05);
  T.dil = dil; T.R = R; T.laborOnset = onset; T.S = S; T.prodromal = prodromal;
  T.laborOnsetT = onset ? (spec.arriveT ?? 0) - r.range(1, 6) * H : -1;
  T.foleyOutAt = 99; T.everMiso = false;
  T.indiv = r.lognormal(1.0, 0.42);
  T.wob = 0;
  T.op = r.chance(0.15); T.opPersist = r.chance(0.3);
  T.cpdCm = null; T.cpdSta = null;
  if (dx.macrosomia ? r.chance(0.3) : r.chance(0.03)) {
    if (r.chance(0.6)) T.cpdCm = r.range(6.2, 9.2); else T.cpdSta = r.range(-0.5, 1.5);
  }
  T.staOffset = r.normal(0, 0.4) - (dx.macrosomia ? 0.5 : 0) - (multip ? 0.5 : 0);
  T.station = stationTarget(T.dil, multip) + T.staOffset - 0.3;
  T.station = clamp(T.station, -3, 1);
  T.complete = T.dil >= 10;

  // ---- membranes
  T.rom = false; T.romT = -1; T.fluid = 'clear';
  if (sub === 'prom' || dx.pprom || (sub === 'rom' && r.chance(0.6)) || (kind === 'labor' && r.chance(0.3))) {
    T.rom = true; T.romT = (spec.arriveT ?? 0) - r.range(0.5, 6) * H;
    if (r.chance(0.12)) T.fluid = 'mec';
  }
  if (sub === 'rom' && T.rom && r.chance(0.35) && !onset) { onset = true; T.laborOnset = true; T.S = r.range(0.3, 0.5); T.dil = Math.max(T.dil, r.range(2.5, 4)); }
  if (p.gaDays >= 287 && r.chance(0.2)) T.fluid = T.rom ? 'mec' : T.fluid;
  T.mecLatent = r.chance(p.gaDays >= 287 ? 0.25 : 0.1);

  // ---- uterus
  T.ctx = []; T.ctxStarts = []; T.recentCtx = []; T.ctxPhase = r.next(); T.ctxThresh = 1; T.lastCtxStart = -1e9; T.lastCtxDur = 60;
  T.tone0 = r.range(7, 13); T.iup = T.tone0; T.mvu = 0;
  T.pitCe = 0; T.ec50 = r.lognormal(5, 0.55); T.misoSens = r.lognormal(1, 0.4);
  T.cervE = 0; T.aromF = 0; T.abr = 0; T.abrT = -1; T.rupture = false; T.prolapse = false; T.prolapseRelieved = false;
  if (sub === 'bleed' && !dx.previa && r.chance(0.18)) { T.abr = r.range(0.1, 0.25); T.abrT = spec.arriveT ?? 0; }
  T.tetanic = 0;

  // ---- fetus
  let plac = r.normal(1.0, 0.06);
  if (dx.iugr) plac = r.range(0.55, 0.75);
  else if (dx.preE === 'severe') plac = r.range(0.62, 0.85);
  else if (dx.preE === 'mild') plac = r.range(0.75, 0.92);
  else if (dx.cHTN || dx.gHTN) plac = r.range(0.82, 0.97);
  if (p.gaDays >= 287) plac -= r.range(0.02, 0.1);
  if (sub === 'dfm' && dx.iugr) plac = r.range(0.45, 0.6);
  if (r.chance(0.04)) plac = r.range(0.62, 0.75); // occult poor reserve: nobody knows
  T.plac = clamp(plac, 0.35, 1.15);
  T.fragility = dx.iugr ? 1.5 : p.gaDays < 245 ? 1.2 : 1.0;
  T.bd = r.range(1.5, 3.5) + (T.plac < 0.65 ? r.range(1, 4) : 0);
  T.ox = Math.min(1, T.plac); T.oxRef = Math.min(0.9, T.ox); T.oxEnv = T.ox; T.resp = 0;
  T.sleep = r.chance(0.65) ? 1 : 0; T.sleepUntil = r.range(5, 30) * 60;
  const gaW = p.gaDays / 7;
  T.B0 = 150 - 1.0 * (gaW - 28) + r.normal(0, 7);
  T.A0 = clamp(r.normal(4.6, 0.9), 2.8, 7);
  T.bOU = 0; T.ou1 = 0; T.ou2 = 0; T.chemo = 0; T.baro = 0; T.accel = null; T.cord = null;
  T.nuchal = r.chance(0.25);
  T.cordVuln = r.lognormal(0.05, 0.5) * (T.nuchal ? 1.8 : 1) * (dx.oligo ? 2 : 1);
  T.cordPos = r.lognormal(1, 0.4);
  const efwMean = 3400 + (gaW - 39.5) * 180 + (dx.gdm ? 250 : 0);
  T.efw = Math.round(dx.iugr ? r.normal(efwMean * 0.78, 150) : dx.macrosomia ? r.normal(4300, 250) : r.normal(efwMean, 380));
  T.sex = r.chance(0.5) ? 'girl' : 'boy';
  T.demise = false; T.fhr = T.B0; T.mhr = 85;
  T.twinB = dx.twins;

  // ---- mother
  T.sbp0 = r.normal(114, 9); T.dbp0 = r.normal(70, 7);
  if (dx.cHTN) { T.sbp0 += 24; T.dbp0 += 18; }
  if (dx.gHTN) { T.sbp0 += 22; T.dbp0 += 16; }
  T.peSev = dx.preE === 'severe' ? r.range(0.75, 1.0) : dx.preE === 'mild' ? r.range(0.25, 0.45) : 0;
  T.peTarget = T.peSev + (dx.preE !== 'none' ? r.range(0, 0.25) : 0);
  if (dx.preE === 'mild' && r.chance(0.25)) T.peTarget = r.range(0.75, 1.0); // progresses to severe tonight
  T.bpOU = 0; T.dbpOU = 0;
  T.hydSens = r.lognormal(1, 0.35); T.labSens = r.lognormal(1, 0.3);
  T.hr0 = r.normal(84, 8); T.temp0 = r.normal(36.8, 0.2); T.spo2 = 98.5; T.rr = 16;
  T.sbp = T.sbp0; T.dbp = T.dbp0; T.map = (T.sbp0 + 2 * T.dbp0) / 3; T.hr = T.hr0; T.temp = T.temp0;
  T.plt = dx.hellp ? r.range(95, 140) : r.normal(225, 50);
  T.ast = dx.hellp ? r.range(80, 160) : r.normal(22, 6);
  T.cr = dx.preE === 'severe' ? r.range(0.7, 1.4) : r.normal(0.6, 0.1);
  T.upc = dx.preE !== 'none' ? r.range(0.35, 3.5) : r.range(0.05, 0.2);
  T.hgb = r.normal(11.8, 1.0); T.fib = r.normal(450, 80);
  T.mgG = 0; T.mg = 1.9; T.caE = 0;
  T.infect = 0; T.susc = r.lognormal(0.4, 0.8); T.svesSinceRom = 0;
  if (dx.pprom) T.infect = r.range(0, 0.5);
  T.epiFeverH = 0; T.epiHypo = 0; T.epiHypoT = -1; T.epiHypoDepth = 0;
  T.anaph = 0; T.bronch = 0; T.pulmEdema = 0; T.netFluid = 0; T.methSpike = 0;
  T.severeBpSec = 0; T.stroke = false; T.eclampsiaCount = 0; T.seizingUntil = -1;
  T.fatigue = 0; T.pushIndiv = r.lognormal(1, 0.45);
  T.pain = 0; T.prevNoise = 0;
  T.qblAntepartum = 0;
  T.pp = null;
}

export function stationTarget(dil, multip) {
  // first-stage descent: nullips engage earlier; multips stay high until late
  if (multip) return dil < 7 ? -2.3 + dil * 0.12 : -1.5 + (dil - 7) * 0.6;
  return dil < 4 ? -2.2 + dil * 0.2 : -1.4 + (dil - 4) * 0.32;
}

// ---------------------------------------------------------------------------------------------
// Drug effect channels (normalised effect-site curves). Doses live in p.meds.doses.
const PK = {
  labetalol_iv: [10, 200], labetalol_po: [90, 360], hydralazine: [20, 180], nifedipine: [40, 240],
  nifedipine_sl: [8, 120], terbutaline: [15, 60], fentanyl: [5, 45], nalbuphine: [15, 120],
  acetaminophen: [60, 240], phenylephrine: [1.5, 6], ephedrine: [4, 20], calcium: [8, 60],
  methergine: [15, 180], hemabate: [15, 90], txa: [10, 150], miso_pv: [90, 240], miso_po: [30, 90],
  miso_bucc: [35, 150], miso_pr: [45, 180], oxy_im: [5, 40], epinephrine: [3, 15],
};

function effects(p, t) {
  const E = { lab: 0, hyd: 0, nif: 0, terb: 0, opioid: 0, acet: 0, pressor: 0, ca: 0, meth: 0, hema: 0,
    txa: 0, miso: 0, misoPP: 0, oxyIM: 0, epi: 0, fluid: 0, nifSL: 0 };
  const doses = p.meds.doses;
  for (let i = doses.length - 1; i >= 0; i--) {
    const d = doses[i];
    const dt = t - d.t;
    if (dt > 14 * H) continue;
    switch (d.drug) {
      case 'labetalol': E.lab += d.amt * bateman(dt, ...(d.route === 'PO' ? PK.labetalol_po : PK.labetalol_iv)) * (d.route === 'PO' ? 0.35 : 1); break;
      case 'hydralazine': E.hyd += d.amt * bateman(dt, ...PK.hydralazine); break;
      case 'nifedipine': if (d.route === 'SL') E.nifSL += d.amt * bateman(dt, ...PK.nifedipine_sl); else E.nif += d.amt * bateman(dt, ...PK.nifedipine); break;
      case 'terbutaline': E.terb += (d.amt / 0.25) * bateman(dt, ...PK.terbutaline); break;
      case 'fentanyl': E.opioid += (d.amt / 100) * bateman(dt, ...PK.fentanyl); break;
      case 'nalbuphine': E.opioid += (d.amt / 10) * bateman(dt, ...PK.nalbuphine); break;
      case 'acetaminophen': E.acet += Math.min(1, d.amt / 1000) * bateman(dt, ...PK.acetaminophen); break;
      case 'phenylephrine': E.pressor += (d.amt / 100) * bateman(dt, ...PK.phenylephrine); break;
      case 'ephedrine': E.pressor += (d.amt / 10) * bateman(dt, ...PK.ephedrine); break;
      case 'calcium': E.ca += Math.min(1.5, d.amt / 1) * bateman(dt, ...PK.calcium); break;
      case 'methergine': E.meth += (d.amt / 0.2) * bateman(dt, ...PK.methergine); break;
      case 'hemabate': E.hema += (d.amt / 250) * bateman(dt, ...PK.hemabate); break;
      case 'txa': E.txa = Math.max(E.txa, bateman(dt, ...PK.txa)); break;
      case 'epinephrine': E.epi += (d.amt / 0.3) * bateman(dt, ...PK.epinephrine); break;
      case 'oxytocin_im': E.oxyIM += (d.amt / 10) * bateman(dt, ...PK.oxy_im); break;
      case 'misoprostol': {
        const k = d.route === 'PV' ? PK.miso_pv : d.route === 'PO' ? PK.miso_po : d.route === 'PR' ? PK.miso_pr : PK.miso_bucc;
        const e = Math.pow(d.amt / 25, 0.75) * bateman(dt, ...k) * (d.route === 'PO' ? 0.7 : 1);
        if (d.pp) E.misoPP += e; else E.miso += e;
        break;
      }
    }
  }
  for (const f of p.meds.fluidsMl) {
    const dt = t - f.t;
    if (dt >= 0 && dt < 3 * H) E.fluid += (f.ml / 1000) * Math.exp(-dt / 2400) * Math.min(1, dt / 900);
  }
  return E;
}

// ---------------------------------------------------------------------------------------------
export function stepPatient(p, sim, dt = 1) {
  const T = p.T;
  if (p.status === 'gone') return;
  const t = sim.t;
  // drug effect-site curves move slowly: refresh every 10 s, or at once when something new is given
  if (!T._E || t - T._Et >= 10 || p.meds.doses.length !== T._En || p.meds.fluidsMl.length !== T._Fn) {
    T._E = effects(p, t); T._Et = t; T._En = p.meds.doses.length; T._Fn = p.meds.fluidsMl.length;
  }
  const E = T._E;
  if (T.pp) { postpartumStep(p, sim, E, t, dt); maternalStep(p, sim, E, t, dt); return; }
  uterusStep(p, sim, E, t, dt);
  laborStep(p, sim, E, t, dt);
  maternalStep(p, sim, E, t, dt);
  fetalStep(p, sim, E, t, dt);
  hazardStep(p, sim, E, t, dt);
}

function hill(x, ec50, n) { if (x <= 0) return 0; const a = Math.pow(x, n); return a / (a + Math.pow(ec50, n)); }

function ctxShape(u) {
  if (u <= 0 || u >= 1) return 0;
  if (u < 0.45) { const s = Math.sin((Math.PI / 2) * (u / 0.45)); return s * s; }
  const c = Math.cos((Math.PI / 2) * ((u - 0.45) / 0.55)); return c * c;
}

function uterusStep(p, sim, E, t, dt) {
  const T = p.T, r = T.rng;
  // oxytocin effect site: tau 15 min -> ~steady state by 40 min
  T.pitCe += (p.meds.pit.rate - T.pitCe) * dt / (15 * 60);
  const multip = p.para > 0;
  let ec50 = T.ec50 * (T.laborOnset ? 0.6 : 1) * (T.R < 0.4 ? 1.35 : 1) * (multip ? 0.85 : 1) * (p.gaDays < 252 ? 1.4 : 1);
  const hp = hill(T.pitCe, ec50, 1.8);
  const cervIn = p.meds.cervidil.in;
  T.cervE += ((cervIn ? 1 : 0) - T.cervE) * dt / ((cervIn ? 45 : 20) * 60);
  if (T.rupture) { T.S *= 0.999; }

  let spont = T.laborOnset ? T.S * 5 : T.prodromal * (0.5 + 0.5 * Math.min(1, T.R));
  let f10 = spont + 6.2 * hp + 3.2 * Math.min(2.2, E.miso) * T.misoSens + 1.6 * T.cervE * T.misoSens
    + T.aromF + 4 * T.abr + 7 * Math.min(1, E.oxyIM) + 2.5 * Math.min(1, E.misoPP);
  f10 *= (1 - 0.75 * Math.min(1, E.terb)) * (T.mg > 4 ? 0.92 : 1);
  if (p.epidural.state === 'working' && t - p.epidural.workT < 1800) f10 *= 0.88;
  if (T.rupture) f10 *= 0.15;
  f10 = clamp(f10, 0, 9.5);
  T.f10drive = f10;

  let ampMean = (T.laborOnset ? 22 + 38 * T.S : 18 + 6 * T.prodromal) + 26 * hp + 14 * Math.min(1.2, E.miso + T.cervE * 0.5);
  if (T.abr > 0) ampMean *= (1 - 0.45 * T.abr);
  ampMean = clamp(ampMean, 10, 90);
  let tone = T.tone0 + 13 * hill(T.pitCe, 3 * ec50, 2.5) + 22 * T.abr + 6 * Math.max(0, E.miso - 1.4)
    + 45 * Math.min(1, E.oxyIM);
  if (T.rupture) tone = 5;
  T.tone = clamp(tone, 3, 70);

  // contraction trigger: phase accumulator against a gamma threshold (regularity rises in labor)
  T.ctxPhase += (f10 / 600) * dt;
  const sinceLast = t - T.lastCtxStart;
  if (T.ctxPhase >= T.ctxThresh && sinceLast >= T.lastCtxDur + 8) {
    const dur = clamp(r.normal(68, 11) + (T.laborOnset ? 8 : -12) - (f10 > 5.5 ? 6 : 0), 35, 130);
    const amp = ampMean * (0.78 + 0.44 * r.next());
    const c = { t0: t, dur, amp, pushes: null, cord: null };
    T.ctx.push(c); T.recentCtx.push(c);
    T.ctxStarts.push(t);
    T.lastCtxStart = t; T.lastCtxDur = dur;
    T.ctxPhase = 0;
    const shape = T.laborOnset ? (T.dil >= 6 ? 9 : 5) : 2.2;
    T.ctxThresh = r.gamma(shape, 1);
    onContractionStart(p, sim, T.ctx[T.ctx.length - 1]);
  }
  while (T.ctxStarts.length && T.ctxStarts[0] < t - 1800) T.ctxStarts.shift();

  let iup = T.tone;
  let mvu = 0;
  for (let i = T.ctx.length - 1; i >= 0; i--) {
    const c = T.ctx[i];
    const u = (t - c.t0) / c.dur;
    if (u >= 1) { T.ctx.splice(i, 1); continue; }
    iup += c.amp * ctxShape(u);
    if (c.pushes) {
      for (const ps of c.pushes) {
        const v = (t - ps.t0) / ps.dur;
        if (v > 0 && v < 1) iup += ps.amp * Math.sin(Math.PI * v);
      }
    }
  }
  // MVU proxy: peak amplitude of contractions started within last 10 min
  for (const c of T.recentCtx) if (c.t0 >= t - 600) mvu += c.amp;
  while (T.recentCtx.length && T.recentCtx[0].t0 < t - 1800) T.recentCtx.shift();
  if (p.meds.pit.rate > 0) p.pitExposureSec = (p.pitExposureSec || 0) + dt;
  T.mvu = mvu;
  // maternal breathing / movement on the pressure
  T.prevNoise = T.prevNoise * 0.9 + r.normal(0, 0.35);
  T.iup = Math.max(0, iup + T.prevNoise);
}

function onContractionStart(p, sim, c) {
  const T = p.T, r = T.rng;
  // pushing efforts
  if (p.pushing === 'pushing' && T.complete) {
    const effort = (1 - T.fatigue) * (p.epidural.state === 'working' ? 0.8 : 1);
    c.pushes = [];
    const n = r.int(2, 4);
    for (let k = 0; k < n; k++) c.pushes.push({ t0: c.t0 + c.dur * 0.18 + k * 14, dur: 11, amp: r.range(35, 65) * effort });
  }
  // stochastic cord compression (variable decels), worse with ROM/oligo/nuchal/pushing
  if (!T.prolapse) {
    let pr = T.cordVuln * T.cordPos * (T.rom ? 2.4 : 1) * (p.pushing === 'pushing' ? 2.2 : 1) * (T.station >= 1 ? 1.4 : 1);
    if (p.devices.amnioinf && sim.t - p.devices.amnioinfT > 1800) pr *= 0.35;
    if (r.chance(clamp(pr, 0, 0.9))) {
      const sev = r.next();
      c.cord = { on: r.range(0.12, 0.32), off: r.range(0.62, 0.9), cmin: sev < 0.55 ? r.range(0.45, 0.75) : sev < 0.9 ? r.range(0.2, 0.45) : r.range(0.06, 0.2) };
    }
  }
}

function laborStep(p, sim, E, t, dt) {
  const T = p.T, r = T.rng;
  const multip = p.para > 0 && p.priorVag > 0;
  const mvu = T.mvu;
  const a = clamp((1 - Math.exp(-mvu / 150)) / 0.736, 0, 1.3);
  T.adequacy = a;

  // onset & spontaneous drive
  if (!T.laborOnset) {
    const gaW = p.gaDays / 7;
    const base = gaW < 37 ? 0.0015 : gaW < 39 ? 0.003 : gaW < 40 ? 0.007 : gaW < 41 ? 0.012 : 0.02;
    let h = base * (0.3 + T.R) * (T.rom ? 5 : 1);
    if (p.dx.pprom) h *= 0.6;
    if (r.chance(h * dt / H) || (T.dil >= 4.5 && a > 0.55)) {
      T.laborOnset = true; T.laborOnsetT = t; sim.emit(p, 'labor_onset');
    }
  }
  const sTarget = T.laborOnset ? clamp(0.45 + 0.055 * T.dil, 0, 1) : 0.03;
  T.S += (sTarget - T.S) * dt / (2.5 * H);

  // slow wobble in labor efficiency (plateaus and spurts)
  T.wob += (-T.wob * dt / (45 * 60)) + Math.sqrt(2 * dt / (45 * 60)) * 0.35 * r.normal();

  if (!T.complete) {
    const key = p.para === 0 || p.priorVag === 0 ? 'P0' : p.priorVag === 1 ? 'P1' : 'P2';
    const idx = Math.min(9, Math.floor(T.dil));
    const rmed = 1 / ZHANG_HOURS_PER_CM[key][idx];
    const gR = T.dil < 6 ? Math.pow(clamp((T.R - 0.12) / 0.5, 0.04, 1), 1.2) : 1;
    const posF = T.op ? 0.75 : 1;
    const cpdF = T.cpdCm != null && T.dil >= T.cpdCm ? 0.015 : 1;
    const chorioF = T.infect > 1 ? 0.85 : 1;
    const romF = T.rom && T.dil < 6 ? 1.12 : 1;
    let rate = rmed * T.indiv * Math.exp(T.wob) * a * gR * posF * cpdF * chorioF * romF;
    if (p.meds.foley.in && T.dil < 3.6) rate += 0.32 * (0.6 + 0.4 * a);
    T.dilRate = rate;
    T.dil = Math.min(10, T.dil + rate * dt / H);
    if (p.meds.foley.in && T.dil >= T.foleyOutAt) {
      p.meds.foley.in = false; sim.emit(p, 'foley_out');
    }
    if (T.dil >= 10) { T.complete = true; p.completeT = t; sim.emit(p, 'complete'); }
  }
  // ripening (per hour rates)
  let dR = 0.003 + 0.05 * Math.min(2, E.miso) + 0.028 * T.cervE + (p.meds.foley.in ? 0.02 : 0)
    + 0.04 * a * (T.laborOnset ? 1 : 0.7);
  if (T.dil >= 6) dR += 0.2;
  T.R = Math.min(1, T.R + dR * dt / H);

  // station
  if (!T.complete) {
    let tgt = stationTarget(T.dil, multip) + T.staOffset;
    if (T.cpdSta != null) tgt = Math.min(tgt, T.cpdSta);
    if (tgt > T.station) T.station += Math.min(tgt - T.station, 0.6 * dt / H);
  } else {
    const epi = p.epidural.state === 'working';
    const posF = T.op ? 0.55 : 1;
    let rateSt;
    if (p.pushing === 'pushing') {
      const med = multip ? 6.5 : epi ? 2.4 : 3.6;
      rateSt = med * T.pushIndiv * (1 - 0.8 * T.fatigue) * Math.max(0.3, a) * posF;
      T.fatigue = Math.min(0.85, T.fatigue + (0.12 + (T.temp > 38 ? 0.05 : 0)) * dt / H);
    } else {
      rateSt = (multip ? 1.6 : 0.6) * Math.max(0.3, a) * posF * (epi ? 0.8 : 1.2);
    }
    if (T.cpdSta != null && T.station >= T.cpdSta) rateSt *= 0.02;
    if (T.cpdCm != null) rateSt *= 0.3;
    T.station = Math.min(5, T.station + rateSt * dt / H);
    // urge to push without an epidural
    if (p.pushing === 'no' && !epi && T.station >= 1 && r.chance(dt / 600)) {
      p.pushing = 'pushing'; p.pushStartT = t; sim.emit(p, 'urge_push');
    }
    if (T.station >= 4 && !T.deliveredFlag) { T.deliveredFlag = true; sim.emit(p, 'crowning'); }
  }
  if (T.op && !T.opPersist && T.laborOnset && r.chance(0.35 * dt / H * (T.dil > 6 ? 2 : 1))) T.op = false;

  // phase label (truth)
  p.truePhase = T.complete ? 'second' : !T.laborOnset ? 'prelabor' : T.dil < 6 ? 'latent' : 'active';
}

function maternalStep(p, sim, E, t, dt) {
  const T = p.T, r = T.rng;
  const dx = p.dx;
  // preeclampsia severity drift
  if (dx.preE !== 'none' || dx.gHTN) {
    T.peSev += (T.peTarget - T.peSev) * dt / (5 * H);
    if (dx.preE !== 'none' && r.chance(0.04 * dt / H)) T.peTarget = Math.min(1.1, T.peTarget + r.range(0.05, 0.25));
  }
  T.bpOU += -T.bpOU * dt / 1200 + Math.sqrt(2 * dt / 1200) * (dx.preE !== 'none' ? 9 : 5) * r.normal();
  T.dbpOU += -T.dbpOU * dt / 1200 + Math.sqrt(2 * dt / 1200) * 4 * r.normal();

  // epidural & analgesia
  const epi = p.epidural.state === 'working';
  if (epi && T.epiHypoT < 0 && t - p.epidural.workT < 30) {
    T.epiHypoT = p.epidural.workT;
    T.epiHypoDepth = r.chance(0.28) ? r.range(18, 42) : r.range(0, 8);
  }
  if (T.epiHypoT >= 0) {
    const s = t - T.epiHypoT;
    const shape = s < 600 ? s / 600 : Math.exp(-(s - 600) / 2400);
    T.epiHypo = T.epiHypoDepth * shape * Math.max(0, 1 - 0.7 * E.fluid) ;
  }
  if (epi) T.epiFeverH += dt / H;
  const ctxNorm = clamp((T.iup - T.tone) / 60, 0, 1.5);
  const rawPain = T.pp ? 2 : (T.laborOnset ? 3 + 6 * ctxNorm + 1.5 * (T.dil / 10) : 1 + 4 * ctxNorm);
  T.pain = epi ? Math.min(rawPain, 1.5) : rawPain * (1 - 0.35 * Math.min(1, E.opioid));
  if (!epi && !T.pp) T.painLoad = (T.painLoad || 0) * Math.exp(-dt / 1800) + (T.pain > 6 ? dt / 60 : 0);

  // BP
  const labDrop = 52 * (E.lab / (E.lab + 55)) * T.labSens;
  const hydDrop = 58 * (E.hyd / (E.hyd + 9)) * T.hydSens;
  const nifDrop = 45 * (E.nif / (E.nif + 14)) + 75 * (E.nifSL / (E.nifSL + 10));
  const pressor = 22 * Math.min(1.5, E.pressor) + 25 * Math.min(1, E.epi);
  const anaphDrop = 55 * T.anaph;
  const hemDrop = shockDrop(p);
  const painUp = epi ? 0 : 10 * ctxNorm + (T.pain > 6 ? 6 : 0);
  T.methSpike = 38 * Math.min(1.3, E.meth) * (dx.preE !== 'none' || dx.cHTN || dx.gHTN ? 1.5 : 0.35);
  const seizure = t < T.seizingUntil ? 35 : 0;
  const drop = labDrop + hydDrop + nifDrop + T.epiHypo + anaphDrop + hemDrop;
  T.sbp = T.sbp0 + 50 * T.peSev + T.bpOU - drop + pressor + painUp + T.methSpike + seizure - (T.pp ? 4 : 0);
  T.dbp = T.dbp0 + 32 * T.peSev + T.dbpOU + 0.4 * T.bpOU - 0.62 * drop + 0.5 * pressor + 0.5 * painUp + 0.6 * T.methSpike;
  T.sbp = clamp(T.sbp, 45, 250); T.dbp = clamp(T.dbp, 25, 150);
  T.map = (T.sbp + 2 * T.dbp) / 3;

  // magnesium PK: Vd ~1.25 L/kg; elimination ~0.57/h scaled by renal function [ACOG-PB222 levels 4.8-8.4]
  const mgm = p.meds.mag;
  let mgIn = 0;
  if (mgm.loadG > 0 && t < mgm.loadEndT) mgIn += mgm.loadG / ((mgm.loadEndT - mgm.loadStartT) / H);
  if (mgm.on) mgIn += mgm.rate;
  const renal = clamp(0.75 / T.cr, 0.15, 1.3);
  T.mgG += (mgIn - T.mgG * 0.45 * renal) * dt / H;
  T.mgG = Math.max(0, T.mgG);
  T.mg = 1.9 + (T.mgG * 1000) / (1.25 * p.weightKg * 10);
  const mgEff = T.mg - 3 * Math.min(1, E.ca);
  T.mgEff = mgEff;
  T.reflex = mgEff < 7 ? '2+' : mgEff < 9.6 ? '1+' : 'absent';

  // infection (Triple I) — SVEs after ROM, IUPC, hours of ROM, GBS without prophylaxis
  if (T.rom && !T.pp) {
    const hrsRom = (t - T.romT) / H;
    const gbsUnproph = p.gbsTrue === 'pos' && !abxActive(p, t, 'gbs') ? 0.04 : 0;
    let rate = T.susc * (0.025 + 0.02 * T.svesSinceRom + (p.devices.iupc ? 0.03 : 0) + gbsUnproph) * (1 + hrsRom / 12);
    if (abxActive(p, t, 'broad')) rate = -0.35 * T.infect;
    else if (abxActive(p, t, 'gbs')) rate *= 0.6;
    T.infect = Math.max(0, T.infect + rate * dt / H);
  } else if (T.pp && abxActive(p, t, 'broad')) T.infect = Math.max(0, T.infect - 0.3 * T.infect * dt / H);
  const infFever = T.infect > 1 ? Math.min(2.2, 0.9 * (T.infect - 1) + 0.5) : 0;
  const epiFever = T.epiFeverH > 4 ? Math.min(0.8, 0.06 * (T.epiFeverH - 4)) : 0;
  const tRaw = T.temp0 + infFever + epiFever;
  T.temp = tRaw - Math.min(tRaw - 37, 0.9) * Math.min(1, E.acet) * (tRaw > 37 ? 1 : 0);

  // HR
  const fever = Math.max(0, T.temp - 37);
  T.hr = T.hr0 + 10 * fever + 28 * Math.min(1.2, E.terb) + 12 * Math.min(1, E.hyd / 10) - 10 * Math.min(1, E.lab / 40)
    + 8 * ctxNorm * (epi ? 0.3 : 1) + (p.pushing === 'pushing' && T.iup > 50 ? 18 : 0) + shockHR(p) + 30 * T.anaph + 25 * Math.min(1, E.epi)
    + (t < T.seizingUntil ? 40 : 0);
  T.hr = clamp(T.hr, 35, 190);

  // respiration & oxygenation
  if (T.bronch > 0) T.bronch = Math.max(0, T.bronch - dt / 2400);
  if (T.anaph > 0 && E.epi > 0.3) T.anaph = Math.max(0, T.anaph - dt / 300);
  if (dx.preE === 'severe' && T.netFluid > 2200 && T.pulmEdema < 1) T.pulmEdema = Math.min(1, T.pulmEdema + dt / 3600);
  T.netFluid = Math.max(0, T.netFluid - 120 * dt / H); // urine + insensible
  const magResp = mgEff > 12 ? (mgEff - 12) * 3.5 : 0;
  T.rr = clamp(17 + (T.pain > 6 ? 3 : 0) + 6 * T.bronch - magResp + r.normal(0, 0.4), 0, 40);
  T.spo2 = clamp(98.5 - 12 * T.pulmEdema - 13 * T.bronch - 10 * T.anaph - (magResp > 0 ? magResp * 1.6 : 0)
    - (t < T.seizingUntil ? 25 : 0) - shockSpo2(p) + (p.meds.o2 ? 1.5 : 0), 55, 100);

  // HELLP evolves
  if (dx.hellp) { T.plt = Math.max(18, T.plt - 5 * dt / H); T.ast += 6 * dt / H; }
  if (dx.preE === 'severe') T.cr += 0.01 * dt / H;
  if (T.abr > 0 && !T.pp) T.qblAntepartum += (T.abr * 3) * dt / 60;

  // MHR channel
  T.mhr = T.hr + 2 * Math.sin(t / 7) ;
}

function shockDrop(p) {
  const T = p.T; const loss = (T.pp ? T.pp.qbl - T.pp.transfused : 0) + T.qblAntepartum;
  return loss > 1200 ? Math.min(70, (loss - 1200) * 0.035) : 0;
}
function shockHR(p) {
  const T = p.T; const loss = (T.pp ? T.pp.qbl - T.pp.transfused : 0) + T.qblAntepartum;
  return loss > 800 ? Math.min(60, (loss - 800) * 0.04) : 0;
}
function shockSpo2(p) {
  const T = p.T; const loss = (T.pp ? T.pp.qbl - T.pp.transfused : 0) + T.qblAntepartum;
  return loss > 2500 ? Math.min(15, (loss - 2500) * 0.01) : 0;
}

// Antibiotic coverage windows from administered doses.
export function abxActive(p, t, kind) {
  const drugs = p.meds.abx.filter(a => t - a.t >= 0 && t - a.t < a.intervalH * H * 1.1);
  const has = (id) => drugs.some(a => a.drug === id);
  if (kind === 'gbs') return has('penicillin') || has('ampicillin') || has('cefazolin') || (has('clindamycin') && p.clindaSusc) || has('vancomycin');
  if (kind === 'broad') return (has('ampicillin') || has('cefazolin') || has('clindamycin') || has('vancomycin')) && has('gentamicin');
  return false;
}

function fetalStep(p, sim, E, t, dt) {
  const T = p.T, r = T.rng;
  if (T.demise) { T.fhr = NaN; for (let k = 0; k < 4; k++) pushSample(p, sim, t + k * 0.25, NaN); return; }
  // uteroplacental flow
  const mapF = T.map >= 72 ? 1 : clamp(1 - (72 - T.map) * 0.022, 0.25, 1);
  const U = clamp(1 - Math.max(0, T.iup - 20) / 100, 0.08, 1) * mapF * (1 - 0.8 * T.abr) * (T.rupture ? 0.15 : 1);
  // cord flow
  let C = 1;
  const cur = T.ctx.length ? T.ctx[T.ctx.length - 1] : null;
  if (cur && cur.cord) {
    const u = (t - cur.t0) / cur.dur;
    const rampOn = (u - cur.cord.on) * cur.dur / 7, rampOff = (cur.cord.off - u) * cur.dur / 7;
    const m = clamp(Math.min(rampOn, rampOff), 0, 1);
    C = 1 - (1 - cur.cord.cmin) * m;
  }
  if (T.prolapse) C = Math.min(C, T.prolapseRelieved ? 0.55 : 0.14 + 0.06 * Math.sin(t / 30));
  T.C = C;
  const matO2 = T.spo2 >= 95 ? 1 : clamp(1 - (95 - T.spo2) * 0.028, 0.25, 1);
  const supply = T.plac * U * C * matO2 * (p.meds.o2 ? 1.02 : 1);
  const demand = 1 + 0.09 * Math.max(0, T.temp - 37.3);
  const oxT = supply / demand;
  T.ox += (oxT - T.ox) * dt / 40;
  T.oxRef += (Math.min(0.9, T.ox) - T.oxRef) * dt / 1800;
  // acid-base: anaerobic below threshold, slow clearance above it. The threshold tracks the fetus's
  // chronic oxygenation (growth-restricted fetuses adapt at rest but tolerate contractions poorly).
  const anaer = Math.min(0.58, 0.92 * T.plac + 0.04);
  if (T.ox < anaer) T.bd += 0.014 * T.fragility * (anaer - T.ox) * dt;
  else T.bd -= (T.bd - 2) * 0.00029 * dt;
  if (p.pushing === 'pushing') T.bd += 0.6 * dt / H; // physiologic second-stage acidosis
  if (C < 0.6) T.resp = Math.min(1, T.resp + 0.004 * (0.6 - C) * dt); else T.resp -= T.resp * dt / 600;
  if (T.bd > 26) { T.demise = true; sim.emit(p, 'demise'); return; }

  // sleep cycles
  if (t >= T.sleepUntil) { T.sleep = 1 - T.sleep; T.sleepUntil = t + (T.sleep ? r.range(25, 55) : r.range(15, 35)) * 60; }

  // reflex components
  // chemoreflex fires on falls below the between-contraction oxygen level (upper envelope), so
  // recurrent lates ride on a preserved baseline instead of dragging it down
  T.oxEnv = Math.max(T.ox, T.oxEnv - (T.oxEnv - T.ox) * dt / 600);
  const thr = Math.min(0.78, 0.85 * T.plac, T.oxEnv - 0.06);
  // soft threshold + slow vagal response => gradual-onset (>=30 s) late decelerations
  const stim = 0.05 * Math.log1p(Math.exp((thr - T.ox) / 0.05));
  T.chemo += (stim - T.chemo) * dt / 22;
  T.baro += ((1 - C) - T.baro) * dt / 2.5;
  const engaged = clamp((T.dil - 3) / 4, 0, 1) * clamp((T.station + 2) / 3, 0, 1);
  const head = 0.32 * Math.max(0, T.iup - T.tone - 15) * engaged;
  const shoulder = (C < 0.98 && C > 0.7) ? 11 * (1 - Math.abs(C - 0.84) / 0.14) : 0;

  // baseline
  const fever = Math.max(0, T.temp - 37.2);
  let hypox = T.bd < 6 ? 0 : T.bd < 12 ? 22 * (T.bd - 6) / 6 : 22;
  let B = T.B0 + 11 * fever + (T.infect > 1 ? 12 : 0) + 12 * Math.min(1, E.terb) + hypox - 4 * clamp((T.mg - 4) / 3, 0, 1) - 3 * Math.min(1, E.opioid);
  if (T.bd > 13) B -= (T.bd - 13) * 6;
  if (T.ox < 0.32 && T.bd > 10) B -= (0.32 - T.ox) * 120;
  T.bOU += -T.bOU * dt / 600 + Math.sqrt(2 * dt / 600) * 2.2 * r.normal();
  B += T.bOU;
  T.baseline = B;

  // variability amplitude: falls as base deficit rises
  const bdF = T.bd < 8 ? 1 : T.bd < 13 ? 1 - 0.75 * (T.bd - 8) / 5 : Math.max(0.06, 0.25 - 0.06 * (T.bd - 13));
  const acute = T.chemo > 0.05 && T.bd < 8 ? 1 + 0.7 * Math.min(1, T.chemo * 5) : 1;
  let A = T.A0 * (T.sleep ? 1 : 0.42) * (1 - 0.6 * Math.min(1, E.opioid)) * (1 - 0.25 * clamp((T.mg - 4) / 3, 0, 1))
    * bdF * acute * (p.gaDays < 210 ? 0.7 : 1);
  T.varAmp = A;

  // accelerations (well-oxygenated, awake fetus)
  if (!T.accel && T.sleep && T.bd < 7.5 && T.ox > 0.7 && r.chance(0.0026 * dt)) {
    const big = p.gaDays >= 224;
    T.accel = { t0: t, dur: r.range(15, 45), amp: big ? r.range(15, 28) : r.range(10, 16) };
  }
  if (T.vasT && t - T.vasT < 2 && !T.accel && T.bd < 9 && T.ox > 0.55) { T.accel = { t0: t, dur: r.range(20, 50), amp: r.range(15, 30) }; }

  for (let k = 0; k < 4; k++) {
    const ts = t + k * 0.25;
    T.ou1 += -T.ou1 * 0.25 / 0.8 + Math.sqrt(2 * 0.25 / 0.8) * r.normal();
    T.ou2 += -T.ou2 * 0.25 / 8 + Math.sqrt(2 * 0.25 / 8) * r.normal();
    let acc = 0;
    if (T.accel) {
      const v = (ts - T.accel.t0) / T.accel.dur;
      if (v >= 1) T.accel = null; else acc = T.accel.amp * Math.sin(Math.PI * v) ** 2 * (v < 0.3 ? 1 : 1);
    }
    let f = B + acc - 112 * T.chemo - head - 88 * T.baro + shoulder + A * (0.5 * T.ou1 + 0.9 * T.ou2);
    f = clamp(f, 45, 215);
    T.fhr = f;
    pushSample(p, sim, ts, f);
  }
}

function hazardStep(p, sim, E, t, dt) {
  const T = p.T, r = T.rng, dx = p.dx;
  // spontaneous ROM
  if (!T.rom) {
    const h = T.laborOnset ? 0.04 + 0.035 * T.dil : 0.002;
    if (r.chance(h * dt / H)) doROM(p, sim, false);
  }
  // abruption (HTN disease, tachysystole)
  if (T.abr === 0) {
    let h = 0.00015 + (dx.preE === 'severe' ? 0.0012 : dx.preE === 'mild' ? 0.0005 : 0) + (dx.cHTN ? 0.0004 : 0) + (T.f10drive > 6.5 ? 0.0008 : 0) + (E.oxyIM > 0.3 ? 0.01 : 0);
    if (r.chance(h * dt / H)) { T.abr = r.range(0.15, 0.5); T.abrT = t; sim.emit(p, 'abruption'); }
  } else if (!T.pp) {
    T.abr = Math.min(0.95, T.abr + (r.chance(0.3) ? 0.02 : 0.005) * dt / 600);
  }
  // uterine rupture — TOLAC; oxytocin dose & prostaglandins multiply [ACOG-PB205]
  if (p.priorCS > 0 && !T.rupture && T.laborOnset) {
    let h = 0.0006 * (1 + 0.12 * p.meds.pit.rate) * (T.everMiso ? 12 : 1) * (T.f10drive > 6 ? 2.5 : 1) * (E.oxyIM > 0.3 ? 20 : 1);
    if (r.chance(h * dt / H)) { T.rupture = true; T.station = Math.max(-3, T.station - 2); sim.emit(p, 'rupture'); }
  } else if (!T.rupture && E.oxyIM > 0.5 && r.chance(0.0004 * dt)) { T.rupture = true; sim.emit(p, 'rupture'); }
  // eclampsia [ACOG-PB222]: Mg >= 4.8 mg/dL roughly halves risk
  if (dx.preE !== 'none' || dx.gHTN) {
    let h = 0.0004 * (T.peSev > 0.7 ? 3 : 0.6) * (T.sbp >= 160 ? 2.5 : 1) * (T.mgEff >= 4.8 ? 0.4 : 1);
    if (t > T.seizingUntil + 600 && r.chance(h * dt / H)) {
      T.seizingUntil = t + r.range(60, 100); T.eclampsiaCount++; sim.emit(p, 'eclampsia');
    }
  }
  // severe-range BP exposure and stroke
  if (T.sbp >= 160 || T.dbp >= 110) {
    T.severeBpSec += dt;
    if (T.severeBpSec > 3600 && r.chance(0.0015 * (T.sbp >= 180 ? 4 : 1) * dt / H) && !T.stroke) { T.stroke = true; sim.emit(p, 'stroke'); }
  } else T.severeBpSec = Math.max(0, T.severeBpSec - dt * 0.5);
  // mag toxicity milestones
  if (T.mgEff >= 12 && !T.flagMgResp) { T.flagMgResp = true; sim.emit(p, 'mag_resp'); }
  if (T.mgEff >= 22 && !T.flagMgArrest) { T.flagMgArrest = true; sim.emit(p, 'mag_arrest'); }
  if (T.infect > 1 && !T.flagFever) { T.flagFever = true; }
}

export function doROM(p, sim, artificial) {
  const T = p.T, r = T.rng;
  if (T.rom) return;
  T.rom = true; T.romT = sim.t;
  T.svesSinceRom = 0;
  if (T.mecLatent || (p.gaDays >= 287 && r.chance(0.2))) T.fluid = 'mec';
  if (T.abr > 0.2) T.fluid = 'bloody';
  T.aromF = artificial ? 0.7 : 0.4;
  if (T.laborOnset) T.S = Math.min(1, T.S + 0.08);
  // cord prolapse: unengaged head / malpresentation / polyhydramnios
  let pr = 0.001;
  if (T.station <= -3) pr = 0.08; else if (T.station <= -2) pr = 0.03;
  if (p.dx.breech) pr += 0.04; if (p.dx.poly) pr *= 2;
  if (r.chance(pr)) { T.prolapse = true; sim.emit(p, 'prolapse'); }
  sim.emit(p, artificial ? 'arom' : 'srom');
}

// ---------------------------------------------------------------------------------------------
// Delivery and postpartum
export function neonatalOutcome(p, sim, mode, extra = {}) {
  const T = p.T, r = T.rng;
  if (T.demise) return { liveborn: false, pH: null, bd: T.bd, apgar1: 0, apgar5: 0, nicu: false, hie: false, death: true, sex: T.sex, weight: T.efw, notes: ['Stillbirth'] };
  const pH = clamp(7.31 - 0.019 * (T.bd - 3) - 0.11 * T.resp + r.normal(0, 0.018), 6.6, 7.42);
  const notes = [];
  let a5 = 9;
  if (pH < 7.12) a5 -= (7.12 - pH) * 18;
  if (T.bd > 12) a5 -= (T.bd - 12) * 0.4;
  const gaW = p.gaDays / 7;
  if (gaW < 34) a5 -= (34 - gaW) * 0.6;
  if (T.mg > 6) a5 -= 0.7;
  if (T._E && T._E.opioid > 0.3) { a5 -= 1.2 * Math.min(1, T._E.opioid); notes.push('Opioid-related respiratory depression'); }
  if (mode === 'cs' && extra.ga) a5 -= 0.3;
  let shoulder = false;
  if (mode !== 'cs') {
    const sdRisk = T.efw > 4500 ? 0.12 : T.efw > 4000 ? 0.05 : 0.01;
    shoulder = r.chance(sdRisk * (p.dx.gdm ? 1.8 : 1) * (extra.vacuum ? 1.6 : 1));
    if (shoulder) { a5 -= r.range(0, 2); notes.push('Shoulder dystocia'); T.bd += r.range(1, 4); }
  }
  if (extra.breechVaginal) { a5 -= r.range(0, 4); notes.push('Vaginal breech delivery'); }
  a5 = Math.round(clamp(a5 + r.normal(0, 0.5), 0, 10));
  const a1 = Math.round(clamp(a5 - r.range(0.5, 3), 0, 9));
  const sepsisRisk = T.infect > 1 ? 0.12 : T.infect > 0.5 ? 0.03 : 0.005;
  const gbsRisk = (p.gbsTrue === 'pos' && !p.gbsAdequate) ? 0.02 : 0;
  const sepsis = r.chance(sepsisRisk + gbsRisk);
  if (sepsis) notes.push('Early-onset sepsis');
  const hie = pH < 7.0 && T.bd >= 12 && r.chance(a5 <= 5 ? 0.6 : 0.2);
  if (hie) notes.push('HIE — therapeutic hypothermia');
  const death = T.bd > 20 && r.chance(0.35);
  if (T.fluid === 'mec' && a5 < 7) notes.push('Meconium, non-vigorous');
  const nicu = gaW < 35 || a5 < 7 || pH < 7.05 || T.bd >= 12 || sepsis || hie || (shoulder && r.chance(0.3)) || (T.efw < 2000);
  if (extra.brachial || (shoulder && r.chance(0.12))) notes.push('Brachial plexus injury');
  return { liveborn: true, pH: Math.round(pH * 100) / 100, bd: Math.round(T.bd * 10) / 10, apgar1: a1, apgar5: a5, nicu, hie, death, sepsis, shoulder, sex: T.sex, weight: T.efw, notes };
}

export function startPostpartum(p, sim, mode, extra = {}) {
  const T = p.T, r = T.rng;
  const pitHours = (p.pitExposureSec || 0) / H;
  const laborHours = T.laborOnsetT >= 0 ? (sim.t - T.laborOnsetT) / H : 0;
  let risk = 0;
  if (pitHours > 12) risk += 0.12; if (pitHours > 24) risk += 0.08;
  if (T.infect > 1) risk += 0.15;
  if (T.mg > 4) risk += 0.07;
  if (T.efw > 4000 || p.dx.poly || p.dx.twins) risk += 0.12;
  if (p.para >= 4) risk += 0.08;
  if (laborHours > 20) risk += 0.08;
  if (extra.secondStageH > 3) risk += 0.08;
  if (T.abr > 0.3) risk += 0.12;
  if (extra.ga) risk += 0.1;
  const atony = r.chance(0.04 + risk);
  T.pp = {
    mode, t0: sim.t, tone: mode === 'cs' ? 0.7 : 0.6,
    toneBase: atony ? r.range(0.3, 0.55) : r.range(0.72, 0.92),
    qbl: mode === 'cs' ? r.range(300, 500) : r.range(100, 250),
    lac: mode === 'cs' ? 0 : r.range(0, 3) * (extra.vacuum ? 1.8 : 1),
    transfused: 0, atony, surgicalBleed: mode === 'cs' ? r.range(2, 8) : 0,
    massage: -1, bakri: false, returnOR: false, hyst: false,
  };
}

function postpartumStep(p, sim, E, t, dt) {
  const T = p.T, pp = T.pp;
  const s = t - pp.t0;
  let target = pp.toneBase + (p.meds.ppOxy ? 0.18 : 0) + 0.2 * Math.min(1, E.meth) + 0.2 * Math.min(1, E.hema) + 0.13 * Math.min(1, E.misoPP)
    + 0.15 * Math.min(1, E.oxyIM) + (t - pp.massage < 300 ? 0.1 : 0) + (pp.bakri ? 0.35 : 0) + (pp.returnOR ? 0.5 : 0);
  if (T.mg > 5) target -= 0.04;
  target = clamp(target, 0.05, 0.99);
  pp.tone += (target - pp.tone) * dt / 240;
  let bleed = 520 * Math.pow(1 - pp.tone, 2.3) + pp.lac * Math.exp(-s / 1800) + pp.surgicalBleed * Math.exp(-s / 900);
  if (T.fib < 200 || pp.qbl > 2000) bleed *= 1.3;
  if (E.txa > 0.2) bleed *= 0.78;
  if (pp.hyst) bleed = 0.5;
  pp.bleed = bleed;
  pp.qbl += bleed * dt / 60;
  T.hgb = Math.max(3, T.hgb - (bleed * dt / 60) / 500 * 0.5 * 2 + (pp.lastTransfuse && t - pp.lastTransfuse < 1800 ? 0.0006 * dt : 0));
  if (pp.qbl > 1500) T.fib = Math.max(80, T.fib - 0.02 * bleed * dt / 60);
  if (pp.qbl >= 1000 && !pp.flagPPH) { pp.flagPPH = true; sim.emit(p, 'pph'); }
  if (pp.qbl - pp.transfused > 3800 && !pp.flagShock) { pp.flagShock = true; sim.emit(p, 'shock'); }
}

export function sampleHistory(p, t) {
  const T = p.T, h = p.hist;
  h.t.push(t); h.dil.push(T.dil); h.sta.push(T.station); h.bd.push(T.bd); h.ox.push(T.ox);
  h.pit.push(p.meds.pit.rate); h.sbp.push(T.sbp); h.temp.push(T.temp); h.mg.push(T.mg);
}
