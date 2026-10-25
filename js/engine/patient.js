// Patient generation from distributions (SPEC §3.5). Produces the public chart and the hidden truth.
import { FIRST_NAMES, LAST_NAMES } from './data.js';
import { clamp } from './util.js';
import { initTruth } from './physio.js';
import { initMonitor } from './monitor.js';

let _nextId = 1;
export function resetPatientIds() { _nextId = 1; }

// Induction indications with GA windows and baseline risk tweaks.
const IOL_INDICATIONS = {
  elective39: { label: 'Elective IOL 39w (ARRIVE)', ga: [273, 279] },
  postdates: { label: 'Late-term 41w', ga: [287, 291] },
  gHTN: { label: 'Gestational hypertension', ga: [259, 266] },
  preE: { label: 'Preeclampsia without severe features', ga: [259, 266] },
  preE_sf: { label: 'Preeclampsia with severe features', ga: [238, 258] },
  gdmA2: { label: 'GDM A2', ga: [273, 276] },
  iugr: { label: 'FGR (EFW <10th %ile)', ga: [259, 268] },
  prom: { label: 'Term PROM, not in labor', ga: [261, 288] },
  oligo: { label: 'Oligohydramnios', ga: [252, 275] },
  cholestasis: { label: 'Intrahepatic cholestasis', ga: [252, 260] },
  tolac: { label: 'TOLAC, IOL 39w', ga: [273, 280] },
  cHTN: { label: 'Chronic hypertension', ga: [266, 273] },
};
export const IOL_KEYS = Object.keys(IOL_INDICATIONS);

function baseDemographics(rng, opts = {}) {
  const age = clamp(Math.round(rng.normal(29, 5.5)), 16, 45);
  const para = opts.para ?? rng.weighted([[0, 42], [1, 33], [2, 15], [3, 7], [5, 3]]);
  const gravida = para + 1 + (rng.chance(0.25) ? 1 : 0);
  const priorCS = opts.priorCS ?? (para > 0 && rng.chance(0.18) ? 1 : 0);
  const priorVag = Math.max(0, para - priorCS);
  const bmi = clamp(rng.lognormal(31, 0.2), 20, 62);
  const heightM = clamp(rng.normal(1.63, 0.07), 1.45, 1.85);
  const weightKg = Math.round(bmi * heightM * heightM);
  const pcn = rng.weighted([['none', 90], ['rash', 7], ['anaphylaxis', 3]]);
  return {
    name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
    age, gravida, para, priorCS, priorVag, bmi: Math.round(bmi * 10) / 10, weightKg,
    allergy: { pcn, list: pcn === 'none' ? (rng.chance(0.12) ? ['sulfa'] : []) : ['penicillin (' + pcn + ')'] },
    asthma: rng.chance(0.08),
    gbs: rng.weighted([['neg', 70], ['pos', 24], ['unknown', 6]]),
    clindaSusc: rng.chance(0.55),
  };
}

function emptyDx() {
  return { gdm: false, cHTN: false, gHTN: false, preE: 'none', hellp: false, iugr: false, pprom: false,
    breech: false, macrosomia: false, oligo: false, poly: false, cholestasis: false, previa: false, twins: false };
}

// spec.kind: 'labor' | 'iol' | 'cs_sched' | 'triage' ; spec.sub = indication/complaint key
export function makePatient(sim, spec) {
  const id = 'p' + (_nextId++);
  const rng = sim.rng.fork('patient/' + id);
  const kind = spec.kind;
  const sub = spec.sub;
  const opts = {};
  if (sub === 'tolac') { opts.priorCS = 1; opts.para = rng.chance(0.6) ? 1 : 2; }
  if (sub === 'elective39' || sub === 'postdates') opts.para = rng.weighted([[0, 60], [1, 30], [2, 10]]);
  if (sub === 'repeat') { opts.priorCS = 1; opts.para = rng.chance(0.7) ? 1 : 2; }
  const d = baseDemographics(rng, opts);
  if (sub === 'tolac') d.priorVag = rng.chance(0.3) ? 1 : 0;
  const dx = emptyDx();
  let gaDays = clamp(Math.round(rng.normal(275, 7)), 259, 293);
  let indication = '';
  // known = what's charted; hidden flags stay only in dx
  const known = { gbs: d.gbs, preE: 'none', notes: [] };

  if (kind === 'iol' || kind === 'iol_waiting') {
    const ind = IOL_INDICATIONS[sub] || IOL_INDICATIONS.elective39;
    gaDays = rng.int(ind.ga[0], ind.ga[1]);
    indication = 'IOL: ' + ind.label;
    if (sub === 'gHTN') dx.gHTN = true;
    if (sub === 'preE') dx.preE = 'mild';
    if (sub === 'preE_sf') { dx.preE = 'severe'; dx.hellp = rng.chance(0.25); }
    if (sub === 'gdmA2') { dx.gdm = true; dx.macrosomia = rng.chance(0.25); }
    if (sub === 'iugr') dx.iugr = true;
    if (sub === 'prom') { /* ROM set in truth */ }
    if (sub === 'oligo') dx.oligo = true;
    if (sub === 'cholestasis') dx.cholestasis = true;
    if (sub === 'cHTN') { dx.cHTN = true; if (rng.chance(0.2)) dx.preE = 'mild'; }
    known.preE = dx.preE;
  } else if (kind === 'labor') {
    gaDays = clamp(Math.round(rng.normal(274, 8)), 259, 293);
    indication = sub === 'tolac' ? 'TOLAC in spontaneous labor' : 'Spontaneous labor';
    if (rng.chance(0.08)) dx.gdm = true;
  } else if (kind === 'cs_sched') {
    gaDays = rng.int(273, 277);
    if (sub === 'breech') { dx.breech = true; indication = 'Scheduled primary CS: breech'; }
    else if (sub === 'twins') { dx.twins = true; gaDays = rng.int(259, 266); indication = 'Scheduled CS: di/di twins, twin A breech'; }
    else { indication = 'Scheduled repeat cesarean'; }
  } else if (kind === 'antepartum') {
    if (sub === 'preE_sf_preterm') {
      gaDays = rng.int(224, 236); dx.preE = 'severe'; dx.hellp = rng.chance(0.3);
      indication = 'Preeclampsia w/ severe features, preterm, on Mg; IOL';
      known.preE = 'severe';
    } else if (sub === 'pprom') {
      gaDays = rng.int(231, 240); dx.pprom = true;
      indication = 'PPROM, latency antibiotics';
    }
  } else if (kind === 'triage') {
    indication = 'Triage';
    if (sub === 'preterm') gaDays = rng.int(224, 245);
    if (sub === 'bp') { gaDays = rng.int(245, 275); const r = rng.next(); dx.preE = r < 0.45 ? 'none' : r < 0.75 ? 'mild' : 'severe'; dx.gHTN = true; if (dx.preE === 'severe') dx.hellp = rng.chance(0.3); }
    if (sub === 'bleed' && rng.chance(0.08)) dx.previa = true;
    if (sub === 'dfm' && rng.chance(0.12)) dx.iugr = true;
  }

  // Hidden truths that the chart may not know.
  if (!dx.breech && kind !== 'cs_sched' && rng.chance(0.03)) dx.breech = true; // undiagnosed breech
  if (!dx.macrosomia && !dx.iugr && rng.chance(0.06)) dx.macrosomia = true;
  if (dx.gdm && rng.chance(0.15)) dx.poly = true;
  if (kind === 'iol' && sub === 'iugr') known.notes.push('EFW 8th %ile, UA dopplers normal');
  if (dx.cholestasis) known.notes.push('Bile acids 46');
  if (dx.macrosomia && rng.chance(0.5)) known.notes.push('EFW >4000 g on last US');
  if (dx.gdm) known.notes.push(sub === 'gdmA2' ? 'GDM on insulin' : 'GDM diet-controlled');
  if (d.asthma) known.notes.push('Asthma (albuterol PRN)');
  if (d.priorCS) known.notes.push(`Prior LTCS x${d.priorCS}` + (sub === 'tolac' ? ', desires TOLAC' : ''));
  if (dx.twins) known.notes.push('Di/di twins');
  if (dx.breech && kind === 'cs_sched') known.notes.push('Breech confirmed on US today');

  const p = {
    id, kind, sub, ...d, dx, known, gaDays, indication,
    status: 'prelabor', area: 'offsite', room: null, arriveT: spec.arriveT ?? 0,
    nurseId: null,
    chart: { sves: [], vitals: [], labs: [], mar: [], orders: [], notes: [], problems: [] },
    meds: {
      pit: { rate: 0, protocol: null, lastTitrT: -1e9, orderedRate: 0 },
      mag: { rate: 0, loadG: 0, loadEndT: -1, on: false },
      doses: [], abx: [], fluidsMl: [], cervidil: { in: false, inT: -1, outT: -1 },
      foley: { in: false, inT: -1 }, ppOxy: false, o2: false,
    },
    devices: { iupc: false, fse: false, spo2: true, amnioinf: false, amnioinfT: -1 },
    epidural: { state: 'none', reqT: -1, workT: -1 },
    pushing: 'no', pushStartT: -1, completeT: -1,
    outcome: null, flags: {}, hist: { t: [], dil: [], sta: [], bd: [], ox: [], pit: [], sbp: [], temp: [], mg: [] },
    mdExamBusyUntil: -1,
  };
  p.gbsTrue = d.gbs === 'unknown' ? (rng.chance(0.25) ? 'pos' : 'neg') : d.gbs;
  initTruth(p, rng, spec);
  initMonitor(p, rng);
  return p;
}

export function deliveryNTSV(p) {
  return p.para === 0 && p.gaDays + 0 >= 259 && !p.dx.twins && !p.dx.breech;
}
