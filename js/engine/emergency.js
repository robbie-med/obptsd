// Emergencies that run in real time (SPEC §6): shoulder dystocia, and maternal crises (amniotic fluid
// embolism, magnesium toxicity) that can end in cardiac arrest. State lives on the patient (p.sd,
// p.crisis with a .cause); physio.js reads it to drive the mother and the fetus, sim.js routes vaginal
// births and the maneuver/code orders here.
// Literature anchors are listed in data.js ([ACOG-PB178], [Hoffman2011], [Gherman1997], [Bruner1998],
// [Leung2011], [AHA2015], [SMFM-AFE2016]).
import { clamp } from './util.js';

const MIN = 60;

// Per-patient stream for emergencies, separate from the physiology stream so that a shoulder
// dystocia roll can't shift every later contraction.
export function erng(p) { return p.T.erng || (p.T.erng = p.T.rng.fork('emergency')); }
export function inArrest(p) { return !!(p.crisis && p.crisis.phase === 'arrest'); }
export function realtimeEmergency(p) {
  return !!((p.sd && p.sd.active) || (p.crisis && ['prodrome', 'collapse', 'arrest'].includes(p.crisis.phase)));
}
export function mmss(sec) { sec = Math.max(0, Math.floor(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }

// ============================================================================ shoulder dystocia
// base = success on a first attempt at average difficulty. [Gherman1997] McRoberts alone ~42%;
// [Hoffman2011] posterior arm 84%, rotational ~66-72%; [Bruner1998] all-fours 83%.
export const SD_MOVES = {
  mcroberts: { label: 'McRoberts', dur: 30, base: 0.42 },
  suprapubic: { label: 'Suprapubic pressure', dur: 30, base: 0.3 },
  posterior: { label: 'Posterior arm', dur: 75, base: 0.84, internal: true },
  rotational: { label: 'Rubin / Woods screw', dur: 60, base: 0.66, internal: true },
  gaskin: { label: 'All fours (Gaskin)', dur: 60, base: 0.83 },
  episiotomy: { label: 'Episiotomy', dur: 30, base: 0 },
  traction: { label: 'Traction on the head', dur: 15, base: 0.1 },
  fundal: { label: 'Fundal pressure', dur: 20, base: 0.03 },
  zavanelli: { label: 'Zavanelli (cephalic replacement)', dur: 120, base: 0.85 },
};
const SD_FAIL = {
  mcroberts: 'Legs are back — still stuck.',
  suprapubic: 'Pushing down above the pubic bone… shoulder isn\'t budging.',
  posterior: 'You can\'t get to the posterior arm — her hand\'s up behind the head.',
  rotational: 'You can\'t get the shoulders to turn.',
  gaskin: 'She\'s on all fours — gentle traction, nothing.',
  traction: 'You pull harder. Nothing moves except the baby\'s neck.',
  fundal: 'Someone leans on the fundus. The shoulder jams in harder.',
  zavanelli: 'You can\'t get the head back in.',
};

export function shoulderRisk(p, extra = {}) {
  const T = p.T;
  let r = T.efw > 4500 ? 0.12 : T.efw > 4000 ? 0.05 : 0.01;
  if (p.dx.gdm) r *= 1.8;
  if (extra.vacuum) r *= 1.6;
  return r;
}

// Called by sim.deliver for a vaginal birth on the floor. True = the shoulders stuck and the birth waits.
export function maybeShoulderDystocia(sim, p, extra) {
  if (p.dx.breech || p.sd || !(p.area === 'ldr' || p.area === 'triage')) return false;
  if (!erng(p).chance(Math.min(0.6, shoulderRisk(p, extra) * sim.rare.sd))) return false;
  startShoulder(sim, p, extra);
  return true;
}

export function sdActions(p) {
  const A = (label, text) => ({ label, cmd: { type: 'order', pid: p.id, text } });
  return [A('McRoberts', 'McRoberts'), A('Suprapubic', 'suprapubic pressure'), A('Posterior arm', 'deliver posterior arm'),
    A('Rubin / Woods', 'woods screw'), A('All fours', 'gaskin all fours'), A('Call for help', 'call for help')];
}

export function startShoulder(sim, p, extra = {}) {
  const T = p.T, r = erng(p);
  const k = r.lognormal(1, 0.35) * (T.efw > 4500 ? 1.4 : T.efw > 4000 ? 1.15 : 1);
  p.sd = { t0: sim.t, active: true, k, extra, tries: [], busyUntil: sim.t, help: false, helpT: null, mdHere: false,
    brachial: 0.08, epis: false, fundal: 0, traction: 0, internal: 0, backup: false };
  T.sdActive = true;
  p.mon.on = false; // the head is out: no more tracing
  p.pushing = 'no';
  sim.logTruth(p, `Shoulder dystocia (difficulty ×${k.toFixed(2)}, EFW ${T.efw} g)`);
  sim.page(p, `SHOULDER DYSTOCIA in ${p.room}! Head's out and pulling back — turtle sign. I need you NOW!`, 3, sdActions(p));
  const callout = (min) => sim.after(60, () => {
    if (!p.sd.active) return;
    sim.page(p, `Head out ${min} minute${min > 1 ? 's' : ''}.`, min >= 4 ? 2 : 1);
    callout(min + 1);
  });
  callout(1);
  const n = sim.nurseOf(p);
  if (n && r.chance(0.3 + 0.6 * n.knowledge)) sim.after(10, () => { if (p.sd.active && !p.sd.help) callHelp(sim, p, true); });
  // nobody gives an order: the nurse does the first thing herself
  sim.after(60, () => {
    if (p.sd.active && !p.sd.tries.length) { sim.page(p, `I'm putting her legs back — McRoberts!`, 2); queueMove(sim, p, 'mcroberts', 'nurse'); }
  });
  sim.after(9 * MIN, () => backupOB(sim, p));
}

export function callHelp(sim, p, auto = false) {
  const sd = p.sd;
  if (!sd || !sd.active) return { ok: false, msg: 'Help with what?' };
  if (sd.help) return { ok: false, msg: 'Help is already on the way.' };
  sd.help = true; sd.helpT = sim.t + 60;
  sim.page(p, auto ? `I hit the emergency button — charge, NICU and the backup OB are coming.` : `Calling for help — charge, NICU and the backup OB are coming.`, 1);
  sim.after(60, () => { if (p.sd.active) sim.charge(`Extra hands and NICU are in ${p.room}. Someone's calling out times.`, 1, [], p); });
  sim.after(5 * MIN, () => backupOB(sim, p));
  return { ok: true, msg: 'Help called.' };
}

function backupOB(sim, p) {
  const sd = p.sd;
  if (!sd || !sd.active || sd.backup) return;
  sd.backup = true;
  sim.msg('Dr. Osei (backup OB)', 'attending', p, `I'm here. Let me in — I'm going for the posterior arm.`, 2);
  queueMove(sim, p, 'posterior', 'backup');
}

export function queueMove(sim, p, key, by = 'md') {
  const sd = p.sd, M = SD_MOVES[key];
  if (!sd || !sd.active) return { ok: false, msg: 'There is no shoulder dystocia.' };
  const pending = sd.tries.filter(x => x.ok == null);
  if (pending.some(x => x.key === key)) return { ok: false, msg: `${M.label} is already under way.` };
  if (pending.length >= 3) return { ok: false, msg: 'Three maneuvers are already lined up.' };
  const r = erng(p);
  let start = Math.max(sim.t, sd.busyUntil);
  if (by === 'md' && !sd.mdHere) { sd.mdHere = true; start += 20; } // you have to get into the room
  const helped = sd.helpT != null && start >= sd.helpT;
  const extra = key === 'gaskin' && p.epidural.state === 'working' ? 45 : 0; // flipping a numb woman
  const dur = Math.round((M.dur + extra) * (helped ? 0.8 : 1) * r.range(0.85, 1.25));
  sd.busyUntil = start + dur;
  const tr = { key, by, start, end: start + dur, ok: null };
  sd.tries.push(tr);
  sim.at(start + dur, () => resolveMove(sim, p, tr));
  return { ok: true, msg: start > sim.t + 1 ? `${M.label} — after the current maneuver.` : M.label };
}

function resolveMove(sim, p, tr) {
  const sd = p.sd;
  if (!sd.active) { tr.ok = 'moot'; return; }
  const r = erng(p), M = SD_MOVES[tr.key];
  const failedBefore = sd.tries.filter(x => x.key === tr.key && x !== tr && x.ok === false).length;
  let pr = M.base;
  if (tr.key === 'suprapubic' && sd.tries.some(x => x.key === 'mcroberts' && x.ok === false)) pr = 0.55;
  if (M.internal && sd.epis) pr += 0.06;
  if (tr.key === 'gaskin' && p.epidural.state === 'working') pr *= 0.6;
  pr = clamp(pr * Math.pow(0.5, failedBefore) / sd.k, 0.02, 0.97);
  if (M.internal) sd.internal++;
  if (tr.key === 'traction') { sd.traction++; sd.brachial += 0.18; }
  if (tr.key === 'fundal') { sd.fundal++; sd.brachial += 0.25; sim.harm(p, 'fundal_pressure'); }
  if (tr.key === 'episiotomy') {
    tr.ok = false; sd.epis = true;
    sim.mdSays(p, 'Episiotomy cut. More room for your hand — but the shoulder is still stuck behind the pubic bone.', 1);
    return;
  }
  tr.ok = tr.forced || r.chance(pr);
  if (!tr.ok) {
    sim.page(p, `${M.label}: ${SD_FAIL[tr.key]} (${mmss(sim.t - sd.t0)})`, 2, sdActions(p));
    if (tr.by === 'backup') { const q = queueMove(sim, p, 'posterior', 'backup'); if (q.ok) sd.tries[sd.tries.length - 1].forced = true; }
    return;
  }
  if (tr.key === 'zavanelli') {
    sd.active = false; sd.endT = sim.t; sd.zavanelli = true;
    const T = p.T;
    T.sdActive = false; T.zav = true; T.station = 0; T.deliveredFlag = true;
    p.mon.on = true;
    sim.logTruth(p, 'Zavanelli: head replaced');
    sim.mdSays(p, `Head flexed and pushed back up. Terbutaline in, going to the OR — STAT.`, 3);
    sim.addDose(p, { drug: 'terbutaline', amt: 0.25, route: 'SQ' });
    sim.requestCS(p, 'stat', 'shoulder');
    return;
  }
  finishShoulder(sim, p, tr);
}

function finishShoulder(sim, p, tr) {
  const sd = p.sd, r = erng(p), M = SD_MOVES[tr.key];
  sd.active = false; sd.endT = sim.t; sd.hbdi = sim.t - sd.t0; sd.by = tr.key;
  p.T.sdActive = false;
  const brachial = r.chance(clamp(sd.brachial + 0.01 * sd.hbdi / 60, 0, 0.8));
  const humerus = tr.key === 'posterior' && r.chance(0.12);
  const clavicle = !humerus && r.chance(0.08);
  sim.logTruth(p, `Shoulders delivered (${M.label}) — head-to-body ${mmss(sd.hbdi)}`);
  sim.page(p, `${M.label} — the shoulder's out, baby's delivered! Head-to-body ${mmss(sd.hbdi)}. Baby's ${sd.hbdi > 240 ? 'blue and floppy' : sd.hbdi > 120 ? 'dusky' : 'pink-ish and mad'}.`, 2);
  sim.deliver(p, 'vaginal', { ...sd.extra, sdChecked: true, shoulder: true, hbdiSec: sd.hbdi, brachial, humerus, clavicle, peds: sd.help });
  const pp = p.T.pp;
  if (pp) {
    // the hands that went in and the episiotomy extend into the sphincter; the uterus that's been fighting is tired
    if (sd.internal || sd.epis) { pp.lac += r.range(1, 3); if (r.chance(0.25)) sim.logTruth(p, '4th-degree laceration'); }
    if (r.chance(0.25)) pp.toneBase = Math.max(0.3, pp.toneBase - 0.2);
  }
}

// ============================================================================ maternal crises
// AFE: real incidence ~2-6 per 100,000 births [SMFM-AFE2016], call it 1 in 25,000. These two hazards add
// up to ~1 in 1,700 births on this floor (~15x real life, measured over simulated nights), so it exists in
// the game at all; "black cloud" multiplies again. Onset: sudden hypoxia, hypotension, arrest, DIC.
export const AFE_PER_LABOR_HOUR = 9e-5;  // laboring with ruptured membranes (~2.6 h per birth on this floor)
export const AFE_AT_DELIVERY = 2.5e-4;   // onset within ~20 min of birth (x2 for cesarean)
export const CRISIS_LABEL = { afe: 'AFE', mag: 'Magnesium arrest' };

export function codeActions(p) {
  const A = (label, text) => ({ label, cmd: { type: 'order', pid: p.id, text } });
  const pregnant = !p.outcome && p.gaDays >= 140;
  const mag = p.crisis && p.crisis.cause === 'mag';
  return [...(mag ? [A('Calcium gluconate 1 g', 'calcium gluconate 1 g IV'), A('Stop mag', 'stop mag')] : []), A('Epi 1 mg IV', 'epinephrine 1 mg IV'),
    ...(pregnant ? [A('Left uterine displacement', 'LUD'), A('Resuscitative hysterotomy', 'resuscitative hysterotomy')] : []),
    A('Shock', 'defibrillate'), A('Intubate', 'intubate'), ...(mag ? [] : [A('MTP', 'massive transfusion')])];
}

function newCrisis(sim, p, cause, o) {
  p.crisis = { cause, t0: sim.t, phase: o.phase, sev: o.sev, willArrest: o.willArrest, rhythm: o.rhythm, lud: false, codeT: null, teamT: null,
    anesT: null, anes: null, intubated: false, shocks: 0, badShock: 0, shocked: false, cycles: 0, arrestT: null, roscT: null, deathT: null,
    hystT: null, lastCheck: null, firstEpiT: null, firstCaT: null, dicT0: null, dicRate: 0, undeliveredAtArrest: false };
  return p.crisis;
}

export function startAFE(sim, p) {
  if (p.crisis || p.status === 'gone' || !['ldr', 'triage', 'or', 'pacu'].includes(p.area)) return;
  const r = erng(p);
  newCrisis(sim, p, 'afe', { phase: 'prodrome', sev: r.range(0.7, 1.4), willArrest: r.chance(0.7), rhythm: r.weighted([['PEA', 0.55], ['VF', 0.25], ['asystole', 0.2]]) });
  sim.logTruth(p, 'AMNIOTIC FLUID EMBOLISM');
  const first = p.name.split(' ')[0];
  const text = `${first} suddenly says something is wrong — "I feel like I'm going to die." She can't catch her breath and keeps pulling at her gown.`;
  if (p.area === 'or') sim.msg(sim.anes[0].short, 'anesthesia', p, `${first} just told me she feels like she's dying. She's agitated, coughing, sat drifting.`, 2);
  else sim.page(p, text, 2, [{ label: 'O₂ NRB', cmd: { type: 'order', pid: p.id, text: 'O2' } }, { label: 'Vitals', cmd: { type: 'order', pid: p.id, text: 'vitals' } }]);
  sim.after(r.range(30, 90), () => collapse(sim, p));
}

function afeAtony(p) { if (p.T.pp) p.T.pp.toneBase = Math.min(p.T.pp.toneBase, 0.4); }

function collapse(sim, p) {
  const a = p.crisis, r = erng(p);
  if (a.phase !== 'prodrome') return;
  a.phase = 'collapse'; a.collapseT = sim.t;
  a.dicT0 = sim.t; a.dicRate = r.range(6, 12) * a.sev; // mg/dL fibrinogen per minute, for ~40 min
  afeAtony(p);
  sim.after(5, () => {
    const T = p.T;
    const fetal = !p.outcome && p.mon.on ? ' Baby\'s heart rate is dropping.' : p.T.pp ? ' She\'s oozing from her IV sites.' : '';
    sim.page(p, `${p.name.split(' ')[0]} is GRAY and gasping — sat ${Math.round(T.spo2)}%, BP ${Math.round(T.sbp)}/${Math.round(T.dbp)}!${fetal}`, 3,
      [{ label: 'Code blue', cmd: { type: 'order', pid: p.id, text: 'code blue' } }, { label: 'O₂ NRB', cmd: { type: 'order', pid: p.id, text: 'O2' } },
       { label: 'Phenylephrine 100', cmd: { type: 'order', pid: p.id, text: 'phenylephrine 100 mcg IV' } },
       ...(!p.outcome ? [{ label: 'C-section STAT', cmd: { type: 'order', pid: p.id, text: 'c-section stat for maternal collapse' } }] : [])]);
  });
  if (a.willArrest) sim.after(r.range(60, 180), () => arrest(sim, p));
  else sim.after(r.range(20, 40) * MIN, () => { if (a.phase === 'collapse') { a.phase = 'stable'; a.stableT = sim.t; sim.logTruth(p, 'AFE: stabilized without arrest'); } });
}

// Hypermagnesemia stops the heart in diastole: bradycardia and heart block into asystole/PEA. Calcium is the
// antidote; with the infusion still running the level keeps climbing [ACOG-PB222].
export function startMagArrest(sim, p) {
  if (p.status === 'gone' || !['ldr', 'triage', 'or', 'pacu'].includes(p.area)) return;
  if (p.crisis && ['prodrome', 'collapse', 'arrest', 'dead'].includes(p.crisis.phase)) return;
  // a survivor of an earlier crisis gets a new one; the earlier record is replaced (rare enough)
  const r = erng(p);
  newCrisis(sim, p, 'mag', { phase: 'collapse', sev: 1, willArrest: true, rhythm: r.chance(0.55) ? 'asystole' : 'PEA' });
  p.crisis.collapseT = sim.t;
  sim.logTruth(p, `MAGNESIUM ARREST (Mg ${p.T.mg.toFixed(1)} mg/dL)`);
  arrest(sim, p);
}

function arrest(sim, p) {
  const a = p.crisis, r = erng(p);
  if (a.phase !== 'collapse') return;
  a.phase = 'arrest'; a.arrestT = sim.t;
  a.undeliveredAtArrest = !p.outcome && p.gaDays >= 140;
  (p.harms || (p.harms = [])).push({ t: sim.t, kind: 'cardiac_arrest' });
  sim.logTruth(p, `CARDIAC ARREST (${a.rhythm})`);
  sim.page(p, `SHE'S UNRESPONSIVE — NO PULSE! Starting compressions! CODE BLUE ${p.room}!`, 3, codeActions(p));
  sim.after(15, () => { if (inArrest(p)) callCode(sim, p, true); });
  sim.after(r.range(40, 60), () => {
    if (!inArrest(p)) return;
    a.lastCheck = { t: sim.t, rhythm: a.rhythm };
    sim.page(p, `Pads on. ${a.rhythm === 'VF' ? 'It\'s V-FIB — shockable!' : a.rhythm === 'PEA' ? 'Organized rhythm, no pulse — PEA.' : 'Flat line. Asystole.'}`, 3, codeActions(p));
  });
  sim.after(120, () => rhythmCheck(sim, p));
  if (a.undeliveredAtArrest) sim.after(4 * MIN, () => {
    if (inArrest(p) && !p.outcome && a.hystT == null) sim.charge(`FOUR MINUTES. The hysterotomy kit is open on the bed — are you cutting?`, 3, [{ label: 'Resuscitative hysterotomy', cmd: { type: 'order', pid: p.id, text: 'resuscitative hysterotomy' } }], p);
  });
}

export function callCode(sim, p, auto = false) {
  const a = p.crisis;
  if (!a || !['collapse', 'arrest'].includes(a.phase)) return { ok: false, msg: 'She has a pulse and she is talking to you.' };
  if (a.codeT != null) return { ok: false, msg: 'The code is already called.' };
  a.codeT = sim.t;
  const r = erng(p);
  sim.sys(`Overhead: “CODE BLUE, LABOR AND DELIVERY, ${String(p.room).toUpperCase()}.”${auto ? ' (her nurse hit the button)' : ''}`, 2, p);
  a.teamT = sim.t + Math.round(r.range(150, 240));
  sim.at(a.teamT, () => { if (['collapse', 'arrest'].includes(a.phase)) sim.charge(`Code team is here — ICU, RT, pharmacy. RT is bagging her.`, 1, [], p); });
  // anesthesia: already in the room if this is the OR, pulled off an epidural, or stuck in another case
  const here = sim.anes.find(x => x.task && x.task.pid === p.id && x.task.kind === 'cs');
  const free = sim.anes.find(x => x.busyUntil <= sim.t);
  const epi = sim.anes.find(x => x.task && x.task.kind === 'epidural');
  const claim = (an) => { an.task = { kind: 'code', pid: p.id }; an.busyUntil = 1e12; a.anes = an; };
  if (here) { a.anesT = sim.t; }
  else if (free || epi) {
    const an = free || epi;
    a.anesT = sim.t + Math.round(r.range(60, 120));
    if (free) claim(an);
    else {
      // the epidural is abandoned mid-placement; resourceStep closes it out within ~10 s of busyUntil
      an.task.interrupted = true; an.busyUntil = sim.t + 30;
      sim.at(sim.t + 45, () => { if (!an.task && an.busyUntil <= sim.t && ['collapse', 'arrest'].includes(a.phase)) claim(an); });
    }
    sim.msg(an.short, 'anesthesia', p, free ? `Running.` : `Dropping the epidural — coming.`, 1);
  } else {
    sim.msg(sim.anes[0].short, 'anesthesia', p, `I'm in the OR and can't leave this patient. Code team's airway person will be there.`, 2);
  }
  return { ok: true, msg: 'Code called.' };
}

function releaseAnes(sim, p) {
  const a = p.crisis;
  if (a.anes && a.anes.task && a.anes.task.kind === 'code') { a.anes.task = null; a.anes.busyUntil = sim.t; }
  a.anes = null;
}
function teamHere(sim, a) { return a.teamT != null && sim.t >= a.teamT; }
function airwayHere(sim, a) { return teamHere(sim, a) || (a.anesT != null && sim.t >= a.anesT); }

function rhythmCheck(sim, p) {
  const a = p.crisis, r = erng(p);
  if (a.phase !== 'arrest') return;
  a.cycles++;
  const t = sim.t, el = (t - a.arrestT) / MIN;
  const pregnant = !p.outcome && p.gaDays >= 140;
  const epi = sim.lastDose(p, 'epinephrine');
  const epiRecent = epi && epi.route === 'IV' && t - epi.t < 5 * MIN;
  // [AHA2015] aortocaval compression: LUD helps while pregnant; delivery helps a lot more
  let pr = 0.05 + (epiRecent ? 0.06 : 0) + (pregnant ? (a.lud ? 0 : -0.04) : 0.2) + (teamHere(sim, a) ? 0.04 : 0) + (a.intubated ? 0.03 : 0);
  if (a.rhythm === 'VF') pr += a.shocked ? 0.18 : -0.03;
  if (a.rhythm === 'asystole') pr -= 0.03;
  if (a.cause === 'mag') {
    const ca = sim.lastDose(p, 'calcium');
    pr += (ca && ca.t >= a.arrestT ? 0.25 : -0.03) + (p.meds.mag.on ? -0.05 : 0.03);
  }
  pr = clamp(pr / a.sev * (el > 20 ? 0.5 : 1), 0.01, 0.6);
  a.shocked = false;
  if (r.chance(pr)) { rosc(sim, p); return; }
  if (el >= 30) { death(sim, p); return; }
  if (a.rhythm === 'VF' && r.chance(0.25)) a.rhythm = 'PEA';
  else if (a.rhythm === 'PEA' && r.chance(0.12)) a.rhythm = r.chance(0.5) ? 'VF' : 'asystole';
  a.lastCheck = { t, rhythm: a.rhythm };
  sim.page(p, `Rhythm check (${mmss(t - a.arrestT)}): ${a.rhythm === 'VF' ? 'V-FIB — shockable!' : a.rhythm === 'PEA' ? 'PEA, no pulse' : 'asystole'}. Back on the chest, switching compressors.`, 2, codeActions(p));
  sim.after(120, () => rhythmCheck(sim, p));
}

function rosc(sim, p) {
  const a = p.crisis;
  a.phase = 'rosc'; a.roscT = sim.t;
  sim.logTruth(p, `ROSC after ${mmss(sim.t - a.arrestT)}`);
  releaseAnes(sim, p);
  sim.page(p, `I'VE GOT A PULSE! ROSC at ${mmss(sim.t - a.arrestT)}. BP is soft, sat in the 80s.${!p.outcome && p.gaDays >= 140 ? ' She\'s still pregnant.' : ''}`, 3,
    [{ label: 'Phenylephrine 100', cmd: { type: 'order', pid: p.id, text: 'phenylephrine 100 mcg IV' } }, { label: 'MTP', cmd: { type: 'order', pid: p.id, text: 'massive transfusion' } },
     { label: 'Cryo 10 u', cmd: { type: 'order', pid: p.id, text: 'cryo 10 units' } }, { label: 'Fibrinogen', cmd: { type: 'order', pid: p.id, text: 'fibrinogen' } }]);
  if (a.hystT != null && p.area !== 'or') sim.requestCS(p, 'stat', 'pph_or');
  sim.after(erng(p).range(45, 75) * MIN, () => { if (a.phase === 'rosc') { a.phase = 'stable'; a.stableT = sim.t; } });
}

function death(sim, p) {
  const a = p.crisis;
  a.phase = 'dead'; a.deathT = sim.t;
  p.flags.maternalDeath = sim.t;
  releaseAnes(sim, p);
  sim.setPit(p, 0, 'death'); sim.stopMag(p);
  if (!p.outcome) p.T.demise = true;
  sim.logTruth(p, 'Maternal death');
  sim.page(p, `Thirty minutes. The team looks at you. Time of death ${sim.clock()}.`, 3);
  sim.after(20 * MIN, () => sim.charge(`${p.name}'s family is in ${p.room}. The chaplain is with them. I've got someone covering her nurse's other patients.`, 1, [], p));
  sim.after(90 * MIN, () => { if (p.status !== 'gone') sim.transferOut(p, 'off the unit'); });
}

export function hysterotomy(sim, p) {
  const a = p.crisis;
  a.hystT = sim.t;
  const dur = Math.round(erng(p).range(...(p.area === 'or' ? [30, 60] : [60, 110])));
  sim.mdSays(p, `Scalpel. Vertical skin incision, through the uterus — ${p.area === 'or' ? 'she\'s already prepped' : 'right there on the bed, compressions still going'}.`, 3);
  sim.after(dur, () => {
    if (p.outcome) return;
    if (!p.csRequest) p.csRequest = { urgency: 'stat', ind: 'arrest', reqT: a.hystT, phase: 'done', pid: p.id };
    p.flags.csDecisionT = p.flags.csDecisionT ?? a.hystT;
    p.flags.incisionT = a.hystT + 20;
    sim.deliver(p, 'cs', { pmcd: true });
    if (p.T.pp) { p.T.pp.surgicalBleed = 14; afeAtony(p); }
    sim.mdSays(p, `Baby out ${a.arrestT != null ? mmss(sim.t - a.arrestT) + ' into the arrest' : ''} — handed to NICU. Uterus is open, packing it. Keep pushing on the chest.`, 2);
  });
}
