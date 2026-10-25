// Night setup: the day team's sign-out, the scheduled board, and the chaos timeline (SPEC §6).
// Arrivals are pre-drawn from their own stream, so the same seed brings the same people through
// the door no matter what you order.
import { makePatient, IOL_KEYS } from './patient.js';
import { makeNurse, sveString } from './nurses.js';
import { NURSE_NAMES } from './data.js';
import { clamp, fmtGA } from './util.js';

const MIN = 60, H = 3600;

const COMPLAINTS = [['ctx', 35], ['rom', 18], ['dfm', 11], ['bp', 12], ['bleed', 8], ['request', 7], ['preterm', 9]];

export function setupScenario(sim) {
  const mode = sim.mode;
  const r = sim.rng.fork('scenario');
  const used = new Set();
  sim.chargeName = r.pick(['Rhonda', 'Lupe', 'Theresa', 'Ken', 'Joyce']);
  used.add(sim.chargeName);
  if (mode === 'quick') sim.endT = 4 * H;
  if (mode === 'single' || mode === 'lab') sim.endT = mode === 'lab' ? 24 * H : 12 * H;

  // nurses
  let nid = 1;
  const mk = (shift, role) => { const n = makeNurse(r, 'n' + nid++, shift, used); n.role = role || 'floor'; return n; };
  const swapT = mode === 'quick' ? 2 * H : 4 * H;
  if (mode === 'night' || mode === 'quick') {
    sim.nurses.push(mk([0, 12 * H]), mk([0, 12 * H]), mk([-8 * H, swapT]), mk([-8 * H, swapT]));
    sim.nurses.push(mk([swapT, 12 * H]), mk([swapT, 12 * H]));
    const tri = mk([0, 12 * H], 'triage'); tri.label = 'triage ' + tri.label; sim.nurses.push(tri);
  } else {
    sim.nurses.push(mk([0, 24 * H]));
    const tri = mk([0, 24 * H], 'triage'); sim.nurses.push(tri);
  }
  for (const n of sim.nurses) n.onDuty = n.shiftStart <= 0;
  if (mode === 'night' || mode === 'quick') sim.at(swapT, () => shiftChange(sim, swapT), 'shift change');

  if (mode === 'lab') return setupLab(sim);
  if (mode === 'single') return setupSingle(sim, r);

  // ---------------- day team's patients
  const presets = mode === 'quick' ? ['h_cervidil', 'h_multip', 'h_preE_pit'] : ['h_cervidil', 'h_multip', 'h_preE_pit', 'h_sf_mag', 'h_tolac'];
  const signout = [];
  presets.forEach((key, i) => {
    const p = presetPatient(sim, key, r);
    sim.addPatient(p);
    sim.placeInRoom(p, sim.rooms[i]);
    p.admitT = -r.range(3, 10) * H;
    signout.push(signoutLine(sim, p, r));
  });
  sim.rooms[7].cleanUntil = 20 * MIN;

  // one patient already waiting in triage
  const tp = makePatient(sim, { kind: 'triage', sub: r.weighted(COMPLAINTS), arriveT: 0 });
  tp.arriveT = 0;
  sim.at(1, () => sim.arriveTriage(tp));

  // sign-out from the day doc (with the usual handoff losses)
  sim.at(2, () => sim.msg('Dr. Day (sign-out)', 'handoff', null, 'Sign-out:\n' + signout.join('\n') + `\nTriage has one. Inductions coming tonight. Good luck — it's a full moon.`, 1));

  // ---------------- the board: scheduled inductions & sections
  sim.boardSchedule = [];
  const iolTimes = mode === 'quick' ? [1 * H] : [1 * H, 4 * H, 8 * H];
  for (const t of iolTimes) {
    const sub = r.pick(IOL_KEYS.filter(k => k !== 'preE_sf'));
    sim.at(t, () => scheduledInductionArrives(sim, sub, t));
    sim.boardSchedule.push({ t, text: 'IOL — ' + sub.replace('elective39', 'elective 39w').replace('gdmA2', 'GDM A2').replace('iugr', 'FGR') });
  }
  const csTimes = mode === 'quick' ? [2 * H] : [2 * H, 11 * H];
  csTimes.forEach((t, i) => {
    const sub = i === 0 ? 'repeat' : r.pick(['breech', 'twins', 'repeat']);
    sim.at(Math.max(5, t - 45 * MIN), () => scheduledCSArrives(sim, sub, t));
    sim.boardSchedule.push({ t, text: sub === 'repeat' ? 'Repeat cesarean' : sub === 'twins' ? 'Cesarean — twins' : 'Cesarean — breech' });
  });

  // ---------------- chaos: walk-ins, phone calls, family
  const ar = sim.rng.fork('arrivals');
  const end = sim.endT;
  const lamWalk = mode === 'quick' ? 0.8 : 0.65, lamPhone = 0.45, lamFamily = 0.3;
  for (let t = ar.exp(H / lamWalk); t < end - 20 * MIN; t += ar.exp(H / lamWalk)) {
    const sub = ar.weighted(COMPLAINTS);
    const at = Math.round(t);
    sim.at(at, () => { const p = makePatient(sim, { kind: 'triage', sub, arriveT: at }); sim.addPatient(p); sim.arriveTriage(p); });
  }
  for (let t = ar.exp(H / lamPhone); t < end - 30 * MIN; t += ar.exp(H / lamPhone)) {
    const sub = ar.weighted([['ctx', 40], ['rom', 20], ['dfm', 15], ['bp', 15], ['bleed', 10]]);
    const at = Math.round(t);
    sim.at(at, () => phoneCall(sim, sub, at));
  }
  for (let t = ar.exp(H / lamFamily) + H; t < end - 30 * MIN; t += ar.exp(H / lamFamily)) {
    const kind = ar.weighted([['wantsCS', 40], ['epiEarly', 25], ['eat', 20], ['attending', 15]]);
    sim.at(Math.round(t), () => familyEvent(sim, kind));
  }
}

// --------------------------------------------------------------------------------------------
function presetPatient(sim, key, r) {
  let p;
  const T = () => p.T;
  if (key === 'h_cervidil') {
    p = makePatient(sim, { kind: 'iol', sub: r.pick(['elective39', 'postdates']), arriveT: -7 * H });
    p.para = 0; p.priorVag = 0; p.priorCS = 0; p.gravida = 1;
    T().dil = r.range(0.5, 1.5); T().R = r.range(0.3, 0.42); T().laborOnset = false; T().S = 0.05;
    p.meds.cervidil = { in: true, inT: -6 * H, outT: -1 }; T().cervE = 0.95;
    p.flags.iolStartT = -6 * H;
    p.plan = 'Cervidil in at 13:00. Pull at 01:00, then pit.';
    addSve(sim, p, -6.5 * H, { dil: Math.round(T().dil * 0.8), eff: 30, sta: -3 }, 'day RN');
  } else if (key === 'h_multip') {
    p = makePatient(sim, { kind: 'labor', sub: 'spont', arriveT: -4 * H });
    p.para = 2; p.priorVag = 2; p.priorCS = 0; p.gravida = 3; p.gbs = 'pos'; p.gbsTrue = 'pos';
    if (p.allergy.pcn === 'anaphylaxis') p.allergy = { pcn: 'none', list: [] };
    T().dil = r.range(5.8, 6.8); T().R = 0.9; T().laborOnset = true; T().S = 0.75; T().station = -1;
    T().rom = true; T().romT = -2 * H; T().fluid = 'clear'; p.chart.romKnown = true;
    p.meds.abx.push({ drug: 'penicillin', t: -2.5 * H, amt: 5, intervalH: 4 });
    p.meds.doses.push({ drug: 'penicillin', t: -2.5 * H, amt: 5, route: 'IV' });
    p.meds.sched = [{ drug: 'penicillin', amt: 2.5, route: 'IV', everyH: 4, abx: true, abxIntervalH: 4, max: 99, nextT: 1.5 * H, given: 0 }];
    p.flags.natural = true;
    p.plan = 'Multip, natural birth plan. GBS+ on PCN (last 16:30).';
    addSve(sim, p, -1 * H, { dil: Math.round(T().dil - 1.2), eff: 80, sta: -2 }, 'day RN');
  } else if (key === 'h_preE_pit') {
    p = makePatient(sim, { kind: 'iol', sub: 'preE', arriveT: -11 * H });
    p.para = 0; p.priorVag = 0; p.priorCS = 0; p.gravida = 1;
    T().dil = r.range(4.0, 5.0); T().R = 0.6; T().laborOnset = true; T().laborOnsetT = -2 * H; T().S = 0.45;
    T().rom = true; T().romT = -2 * H; p.chart.romKnown = true;
    p.meds.doses.push({ drug: 'misoprostol', t: -10 * H, amt: 25, route: 'PV' }, { drug: 'misoprostol', t: -6 * H, amt: 25, route: 'PV' });
    p.meds.pit = { rate: 10, protocol: { start: 2, inc: 2, intervalMin: 30, max: 20 }, lastTitrT: -20 * MIN, orderedRate: 10, startT: -4 * H };
    T().pitCe = 9.5; p.pitExposureSec = 4 * H;
    p.epidural = { state: 'working', reqT: -3.5 * H, workT: -3 * H };
    T().epiHypoT = -3 * H; T().epiHypoDepth = 0; T().epiFeverH = 3;
    p.flags.iolStartT = -10 * H;
    p.plan = 'PreE w/o SF, IOL. Pit per protocol, epidural working, AROM 17:00.';
    addSve(sim, p, -1.5 * H, { dil: Math.round(T().dil + 0.8), eff: 90, sta: -1 }, 'day RN');
    p.chart.labs.push({ key: 'pih', label: 'PIH labs', orderT: -11 * H, resultT: -10 * H, values: { plt: Math.round(T().plt), cr: +T().cr.toFixed(2), ast: Math.round(T().ast) }, text: `plt ${Math.round(T().plt)}, cr ${T().cr.toFixed(2)}, ast ${Math.round(T().ast)}` });
    p.flags.lastCbcT = -10 * H;
  } else if (key === 'h_sf_mag') {
    p = makePatient(sim, { kind: 'antepartum', sub: 'preE_sf_preterm', arriveT: -6 * H });
    p.meds.mag = { rate: 2, loadG: 4, loadStartT: -5 * H, loadEndT: -5 * H + 20 * MIN, on: true, startT: -5 * H };
    T().mgG = 4.3;
    p.meds.doses.push({ drug: 'betamethasone', t: -4.5 * H, amt: 12, route: 'IM' });
    p.flags.steroidDoses = 1; p.flags.steroidT = -4.5 * H;
    p.meds.sched = [{ drug: 'betamethasone', amt: 12, route: 'IM', everyH: 24, max: 1, nextT: 19.5 * H, given: 0 }];
    p.meds.doses.push({ drug: 'misoprostol', t: -2 * H, amt: 25, route: 'PV' });
    p.meds.sched.push({ drug: 'misoprostol', amt: 25, route: 'PV', everyH: 4, max: 5, hold: 'ripening', nextT: 2 * H, given: 1 });
    p.chart.problems.push('preE');
    p.flags.iolStartT = -2 * H;
    p.plan = `PreE w/ SF (BP) at ${fmtGA(p.gaDays)}, on Mg 2 g/h since 14:00, BMZ #1 14:30. Miso for IOL.`;
    p.chart.labs.push({ key: 'pih', label: 'PIH labs', orderT: -6 * H, resultT: -5 * H, values: { plt: Math.round(T().plt + 20), cr: +(T().cr - 0.1).toFixed(2), ast: Math.round(T().ast * 0.7) }, text: `plt ${Math.round(T().plt + 20)}, cr ${(T().cr - 0.1).toFixed(2)}, ast ${Math.round(T().ast * 0.7)}` });
    p.flags.lastCbcT = -5 * H;
    addSve(sim, p, -2 * H, { dil: Math.round(T().dil), eff: 40, sta: -3 }, 'day RN');
  } else if (key === 'h_tolac') {
    p = makePatient(sim, { kind: 'labor', sub: 'tolac', arriveT: -1 * H });
    p.priorCS = 1; p.para = 1; p.priorVag = 0; p.gravida = 2;
    if (!p.known.notes.some(n => n.includes('LTCS'))) p.known.notes.push('Prior LTCS x1 (breech), desires TOLAC');
    T().dil = r.range(3.6, 4.4); T().R = 0.75; T().laborOnset = true; T().S = 0.5; T().station = -2;
    p.plan = 'TOLAC, early labor. Consented. Wants epidural.';
    T().painLoad = 10;
    addSve(sim, p, -0.75 * H, { dil: 4, eff: 70, sta: -2 }, 'day RN');
  }
  p.status = T().laborOnset ? 'labor' : 'antepartum';
  p.gbsTrue = p.gbsTrue || (p.gbs === 'unknown' ? (r.chance(0.25) ? 'pos' : 'neg') : p.gbs);
  return p;
}

function addSve(sim, p, t, s, by) {
  p.chart.sves.push({ t, dil: s.dil, eff: s.eff, sta: s.sta, by, notes: [], trueDil: null, trueSta: null });
}

function signoutLine(sim, p, r) {
  const s = p.chart.sves[p.chart.sves.length - 1];
  const gp = `G${p.gravida}P${p.para}`;
  // handoff loss: day doc rounds up the last exam and forgets details
  let dilSaid = s ? s.dil : '?';
  if (s && r.chance(0.35)) dilSaid = s.dil + 1;
  let line = `${p.room}: ${p.name.split(' ')[0]}, ${p.age} ${gp} ${fmtGA(p.gaDays)} — ${p.plan || p.indication}`;
  if (s) line += ` Was ${dilSaid} cm${r.chance(0.5) ? '' : ` at ${sim.clock(s.t)}`}.`;
  if (p.dx.hellp && r.chance(0.5)) line += ' Labs were fine this morning.';
  return line;
}

// --------------------------------------------------------------------------------------------
function shiftChange(sim, t) {
  const leaving = sim.nurses.filter(n => n.onDuty && n.shiftEnd <= t);
  const arriving = sim.nurses.filter(n => !n.onDuty && n.shiftStart <= t);
  const r = sim.nrng;
  leaving.forEach((old, i) => {
    old.onDuty = false;
    const nw = arriving[i % arriving.length];
    nw.onDuty = true;
    for (const pid of old.patients.slice()) {
      const p = sim.byId[pid];
      if (!p) continue;
      old.patients = old.patients.filter(x => x !== pid);
      p.nurseId = nw.id; nw.patients.push(pid);
      const ns = p.ns; p.ns = null;
      // handoff losses
      if (p.meds.pit.protocol && r.chance(0.3)) {
        p.meds.pit.protocol = null;
        sim.page(p, `Just got report on ${p.name.split(' ')[0]}. She's on pit ${p.meds.pit.rate} — nobody mentioned a protocol. Keep it there?`, 1,
          [{ label: 'Pit per protocol', cmd: { type: 'order', pid: p.id, text: 'pit per protocol' } }], nw);
        sim.logTruth(p, 'Handoff loss: pit protocol dropped');
      }
      if (p.meds.sched && p.meds.sched.length && r.chance(0.18)) {
        const s = r.pick(p.meds.sched);
        s.lost = true;
        sim.logTruth(p, `Handoff loss: scheduled ${s.drug} dropped (nobody will give it)`);
      }
      if (!p.T.pp && p.area === 'ldr' && r.chance(0.5)) sim.after(r.range(10, 35) * MIN, () => sim.doSVE(p, 'nurse', 'handoff'));
      if (ns) p.ns = { ...ns, lastSveT: ns.lastSveT, completeFound: false };
    }
  });
  for (const n of arriving) n.onDuty = true;
  sim.charge(`Shift change: ${leaving.map(n => n.name).join(' & ')} out, ${arriving.map(n => `${n.name} (${n.label})`).join(' & ')} in.`, 0);
}

// --------------------------------------------------------------------------------------------
function scheduledInductionArrives(sim, sub, t) {
  const p = makePatient(sim, { kind: 'iol', sub, arriveT: t });
  sim.addPatient(p);
  p.gbsTrue = p.gbs === 'unknown' ? (p.T.rng.chance(0.25) ? 'pos' : 'neg') : p.gbs;
  p.area = 'waiting'; p.status = 'antepartum';
  sim.waiting.push(p.id);
  askInduction(sim, p, 0);
}
function askInduction(sim, p, n) {
  if (p.area !== 'waiting' || p.status === 'gone') return;
  const room = sim.freeRoom();
  sim.choiceMsg(`${sim.chargeName}, charge RN`, 'charge', p,
    `${n ? 'Still waiting: ' : ''}${p.name} is here for her ${sim.clock(p.arriveT)} induction — ${p.age}yo G${p.gravida}P${p.para} ${fmtGA(p.gaDays)}, ${p.indication.replace('IOL: ', '')}. ${room ? room.name + ' is open.' : 'No rooms right now.'}`,
    n >= 2 ? 2 : 1, ['Bring her back', 'Hold 2 hours', 'Reschedule to tomorrow'], (i) => {
      if (i === 0) {
        const rm = sim.freeRoom();
        if (!rm) { p.boarding = true; sim.charge(`No rooms — she'll come back as soon as one is cleaned.`, 0, [], p); return; }
        sim.placeInRoom(p, rm);
        p.boarding = false;
        sim.after(15 * MIN, () => {
          sim.doSVE(p, 'nurse', 'admission');
          const s = p.chart.sves[p.chart.sves.length - 1];
          sim.page(p, `${p.name.split(' ')[0]} is settled in ${p.room}. ${s ? 'SVE ' + sveString(s) + '.' : ''} Tracing looks good. What do you want to start?`, 1, [
            { label: 'Miso 25 PV q4h', cmd: { type: 'order', pid: p.id, text: 'miso 25 mcg PV q4h' } },
            { label: 'Cervidil', cmd: { type: 'order', pid: p.id, text: 'cervidil' } },
            { label: 'Foley bulb', cmd: { type: 'order', pid: p.id, text: 'foley bulb' } },
            { label: 'Pit per protocol', cmd: { type: 'order', pid: p.id, text: 'pit per protocol' } },
          ]);
        });
      } else if (i === 1) sim.after(2 * H, () => askInduction(sim, p, n + 1));
      else { p.status = 'gone'; p.area = 'gone'; p.flags.rescheduled = true; sim.waiting = sim.waiting.filter(x => x !== p.id); sim.sys(`${p.name}'s induction rescheduled.`, 0, p); }
    });
}

function scheduledCSArrives(sim, sub, t) {
  const p = makePatient(sim, { kind: 'cs_sched', sub, arriveT: t - 45 * MIN });
  sim.addPatient(p);
  p.gbsTrue = p.gbs;
  p.area = 'preop'; p.room = 'Pre-op'; p.status = 'antepartum';
  sim.charge(`${p.name} is in pre-op for her ${sim.clock(t)} ${p.indication.replace('Scheduled ', '')}. NPO since noon, consent signed.`, 0, [], p);
  const req = { urgency: 'routine', ind: sub === 'breech' ? 'malpres' : sub === 'twins' ? 'malpres' : 'repeat', reqT: t, phase: 'waiting', pid: p.id, notBefore: t, scheduled: true };
  p.csRequest = req;
  sim.csQueue.push(req);
}

// --------------------------------------------------------------------------------------------
function phoneCall(sim, sub, t) {
  const p = makePatient(sim, { kind: 'triage', sub, arriveT: t });
  sim.addPatient(p);
  p.gbsTrue = p.gbs === 'unknown' ? (p.T.rng.chance(0.25) ? 'pos' : 'neg') : p.gbs;
  p.area = 'home'; p.status = 'home'; p.dischargeT = t; p.phone = true;
  sim.stats.phoneCalls++;
  const T = p.T;
  const ga = Math.floor(p.gaDays / 7);
  const txt = {
    ctx: `${p.name}, G${p.gravida}P${p.para} at ${ga} weeks: contractions about every ${T.laborOnset ? (T.dil > 5 ? 3 : 5) : 8} minutes for ${T.laborOnset ? 2 : 5} hours, "${T.laborOnset ? 'they\'re getting really strong' : 'they come and go'}".`,
    rom: `${p.name}, ${ga} weeks: felt a gush ${T.rom ? 'and now it keeps trickling' : 'when she stood up, nothing since'}.`,
    dfm: `${p.name}, ${ga} weeks: hasn't felt the baby move much today.`,
    bp: `${p.name}, ${ga} weeks: headache that Tylenol didn't touch${p.dx.preE === 'severe' ? ', and she\'s seeing spots' : ''}.`,
    bleed: `${p.name}, ${ga} weeks: some ${p.dx.previa || T.abr > 0 ? 'bright red bleeding' : 'pink spotting with mucus'}.`,
  }[sub];
  sim.choiceMsg('Answering service', 'phone', p, `Phone call — ${txt}`, 1, ['Come in to triage', 'Stay home, call back if worse'], (i) => {
    if (i === 0) {
      p.phoneAdvice = 'come in';
      sim.after(sim.crng.range(25, 60) * MIN, () => { if (p.area === 'home' && !p.outcome) { p.phone = false; sim.arriveTriage(p); } });
    } else {
      p.phoneAdvice = 'stay home';
      sim.logTruth(p, 'Told to stay home by phone');
    }
  });
}

function familyEvent(sim, kind) {
  const r = sim.crng;
  const cands = sim.patients.filter(p => p.area === 'ldr' && !p.T.pp && p.status !== 'gone');
  if (!cands.length) return;
  const p = r.pick(cands);
  const first = p.name.split(' ')[0];
  if (kind === 'wantsCS' && p.admitT != null && sim.t - p.admitT > 3 * H) {
    sim.choiceMsg(`${first}'s ${r.pick(['husband', 'mother', 'partner'])}`, 'family', p,
      `(${p.room}) “She's been here ${Math.round((sim.t - p.admitT) / H)} hours. Why can't you just do a C-section and get it over with?”`, 1,
      ['Explain the plan — she can deliver vaginally', 'Offer a cesarean'], (i) => {
        if (i === 1) { p.flags.familyCS = true; sim.command({ type: 'order', pid: p.id, text: 'c-section routine maternal request' }, true); }
        else p.satisfaction = (p.satisfaction || 0) + 1;
      });
  } else if (kind === 'epiEarly' && p.epidural.state === 'none' && !p.flags.natural) {
    sim.choiceMsg(`${first} (${p.room})`, 'family', p, `“Someone told me I have to be 4 centimeters before I can get an epidural. Is that true? It hurts SO bad.”`, 1,
      ['No — you can have it now (order epidural)', 'Let\'s wait a bit longer'], (i) => {
        if (i === 0) sim.command({ type: 'order', pid: p.id, text: 'epidural' }, true);
        else { p.satisfaction = (p.satisfaction || 0) - 2; sim.logTruth(p, 'Epidural deferred on request (ACOG: maternal request is sufficient indication)'); }
      });
  } else if (kind === 'eat') {
    sim.choiceMsg(`${first}'s mother (${p.room})`, 'family', p, `“She hasn't eaten since this morning. Can she at least have some broth?”`, 0,
      ['Clear liquids are fine', 'Nothing by mouth'], (i) => { p.satisfaction = (p.satisfaction || 0) + (i === 0 ? 1 : -1); });
  } else if (kind === 'attending') {
    sim.choiceMsg('Attending (phone)', 'attending', null, `“Just checking in. Anything you need me for? How many are in labor?”`, 0, ['All under control', 'Come in, it\'s busy'], (i) => {
      if (i === 1) sim.charge('Attending says she\'ll come in — about 40 minutes out.', 0);
    });
  }
}

// --------------------------------------------------------------------------------------------
function setupSingle(sim, r) {
  const p = makePatient(sim, { kind: 'iol', sub: 'elective39', arriveT: 0 });
  p.para = 0; p.priorVag = 0; p.priorCS = 0; p.gravida = 1;
  p.T.dil = r.range(0.5, 1.5); p.T.R = r.range(0.15, 0.3);
  p.gbsTrue = p.gbs === 'unknown' ? 'neg' : p.gbs;
  sim.addPatient(p);
  sim.placeInRoom(p, sim.rooms[0]);
  p.status = 'antepartum';
  const n = sim.nurseOf(p);
  sim.at(2, () => sim.msg('Charge RN', 'charge', p, `Single-patient sandbox: ${p.name}, G1 ${fmtGA(p.gaDays)}, elective induction, cervix unfavorable. Nurse ${n.name} (${n.label}). It's yours.`, 1));
  sim.after(10 * MIN, () => { sim.doSVE(p, 'nurse', 'admission'); });
}

function setupLab(sim) {
  const p = makePatient(sim, { kind: 'labor', sub: 'spont', arriveT: 0 });
  p.T.dil = 5; p.T.laborOnset = true; p.T.S = 0.6; p.T.R = 0.9;
  p.gbsTrue = 'neg';
  sim.addPatient(p);
  p.area = 'ldr'; p.room = 'Lab'; sim.rooms[0].pid = p.id; p.mon.on = true;
  p.status = 'labor';
  p.labMode = true;
}
