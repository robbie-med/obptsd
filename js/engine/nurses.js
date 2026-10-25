// Nurses (SPEC §3.2): persistent bias + noise, their own judgement, and their own way of telling you.
// You manage what the nurses tell you, not what is actually happening.
import { NURSE_ARCHETYPES, NURSE_NAMES } from './data.js';
import { clamp, roundTo } from './util.js';

const MIN = 60, H = 3600;

export function makeNurse(rng, id, shift, usedNames) {
  const arch = rng.pick(NURSE_ARCHETYPES);
  let name;
  do { name = rng.pick(NURSE_NAMES); } while (usedNames.has(name));
  usedNames.add(name);
  return {
    id, name, arch: arch.key, label: arch.label,
    dilBias: arch.dilBias + rng.normal(0, 0.2), dilNoise: arch.dilNoise * rng.range(0.85, 1.15),
    staBias: arch.staBias + rng.normal(0, 0.25), effBias: rng.normal(0, 8),
    halfCm: rng.chance(arch.key === 'veteran' ? 0.1 : 0.35),
    knowledge: clamp(arch.knowledge + rng.normal(0, 0.05), 0.1, 0.99), assert: clamp(arch.assert + rng.normal(0, 0.05), 0.05, 0.99),
    alert: clamp(arch.alert + rng.normal(0, 0.05), 0.2, 0.99), pit: arch.pit, chatty: arch.chatty,
    years: rng.int(arch.years[0], arch.years[1]),
    shiftStart: shift[0], shiftEnd: shift[1], patients: [], onDuty: false,
  };
}

// A nurse's cervical exam of the hidden cervix.
export function nurseExam(nurse, p, rng, md = false) {
  const T = p.T;
  const bias = md ? 0 : nurse.dilBias;
  const sd = md ? 0.35 : nurse.dilNoise;
  // bias shrinks near complete: everyone recognises 10
  const nearComplete = T.dil >= 9.6;
  let dil = T.dil + bias * (T.dil > 8 ? 0.4 : 1) + rng.normal(0, sd * (T.dil > 8 ? 0.6 : 1));
  if (nearComplete && rng.chance(0.75)) dil = 10;
  dil = clamp(dil, 0, 10);
  dil = !md && !nurse.halfCm ? Math.round(dil) : roundTo(dil, 0.5);
  if (T.dil < 0.6 && dil <= 0.5) dil = 0; // "closed"
  if (dil === 10 && T.dil < 9.3) dil = 9; // nobody calls a 9-cm cervix complete... usually
  const effTrue = clamp(30 + 70 * T.R + 4 * T.dil - (p.para > 0 ? 15 * (1 - T.dil / 6) : 0), 0, 100);
  let eff = roundTo(clamp(effTrue + (md ? 0 : nurse.effBias) + rng.normal(0, md ? 6 : 10), 0, 100), 10);
  if (dil >= 7) eff = Math.max(eff, 90);
  let sta = T.station + (md ? 0 : nurse.staBias) + rng.normal(0, md ? 0.4 : 0.6);
  sta = clamp(Math.round(sta), -3, 3);
  const notes = [];
  if (p.dx.breech) {
    const catches = md ? 0.85 : 0.35 + 0.5 * nurse.knowledge;
    if (rng.chance(catches)) notes.push(md ? 'presenting part is breech' : 'presenting part feels soft — not sure that\'s a head');
  }
  if (T.prolapse) notes.push('PULSATING CORD in the vagina');
  if (T.rom) {
    if (!p.chart.romKnown && rng.chance(0.7)) { p.chart.romKnown = true; notes.push('membranes ruptured'); }
  }
  if (T.complete && T.station >= 2 && rng.chance(0.4)) notes.push('head is right there');
  if (T.op && md && rng.chance(0.6)) notes.push('OP');
  return { dil, eff, sta, notes };
}

export function sveString(s) {
  const d = s.dil === 0 ? 'closed' : s.dil >= 10 ? 'C' : String(s.dil);
  return `${d}/${s.eff}/${s.sta > 0 ? '+' + s.sta : s.sta}`;
}

// ------------------------------------------------------------------------------------------------
// Per-patient nurse behaviour, called every 30 s for each patient on the floor.
export function nurseTick(sim, nurse, p) {
  const ns = p.ns || (p.ns = { lastVitalsT: -1e9, lastSveT: p.chart.sves.length ? p.chart.sves[p.chart.sves.length - 1].t : -1e9,
    lastTracingPage: -1e9, lastLatePage: -1e9, lastVarPage: -1e9, lastFlatPage: -1e9, lastTachyPage: -1e9, lastPainPage: -1e9,
    lastBpPage: -1e9, severePending: null, lastPushUpdate: -1e9, lastBleedPage: -1e9, resusT: -1e9, lostCount: 0, lastLostReq: -1e9 });
  const t = sim.t, T = p.T, r = sim.nrng;
  if (p.area === 'or' || p.area === 'offsite' || p.area === 'home' || p.status === 'gone') return;
  if ((p.sd && p.sd.active) || (p.afe && ['collapse', 'arrest'].includes(p.afe.phase))) return; // everyone's hands are busy

  // ---- vitals
  const dx = p.dx;
  let vInt = 60 * MIN;
  if (p.meds.mag.on) vInt = 30 * MIN;
  if (p.known.preE === 'severe' || dx.gHTN || p.known.preE === 'mild') vInt = Math.min(vInt, p.known.preE === 'severe' ? 15 * MIN : 30 * MIN);
  if (T.pp && t - T.pp.t0 < 2 * H) vInt = 15 * MIN;
  if (p.area === 'triage') vInt = 30 * MIN;
  if (ns.severePending && t >= ns.severePending) vInt = 0;
  if (t - ns.lastVitalsT >= vInt) sim.takeVitals(p, false);

  if (T.pp) { postpartumNursing(sim, nurse, p, ns); return; }

  // ---- read the strip (sim refreshes p.read every 60 s)
  const rd = p.read;
  const onMon = p.mon.on;
  if (onMon && rd && rd.baseline != null) tracingWatch(sim, nurse, p, ns, rd);
  if (onMon && rd && rd.lossFrac > 0.4 && t - ns.lastLostReq > 40 * MIN && !p.devices.fse) {
    ns.lostCount++;
    if (ns.lostCount >= 3) {
      ns.lastLostReq = t; ns.lostCount = 0;
      const canFse = p.chart.romKnown;
      sim.page(p, `I keep losing the heart rate on ${p.name.split(' ')[0]}. ${canFse ? 'Can I put a scalp lead on?' : 'She\'s intact so I can\'t do a scalp lead.'}`, 1,
        canFse ? [{ label: 'FSE', cmd: { type: 'order', pid: p.id, text: 'FSE' } }] : [], nurse);
    }
  }

  // ---- pit titration per protocol
  const pit = p.meds.pit;
  if (pit.protocol && pit.rate > 0 && rd) pitTitrate(sim, nurse, p, ns, rd);
  // tachysystole response even without a protocol
  if (pit.rate > 0 && rd && rd.ctxPer10 != null && rd.ctxPer10 > 5.4 && t - (ns.lastTachyAct || -1e9) > 20 * MIN) {
    ns.lastTachyAct = t;
    if (nurse.pit === 'cautious' || (nurse.pit === 'standard' && r.chance(0.7))) {
      const nr = nurse.pit === 'cautious' ? Math.floor(pit.rate / 2) : Math.max(0, pit.rate - (pit.protocol?.inc || 2));
      sim.setPit(p, nr, 'nurse');
      sim.page(p, `She's contracting ${rd.ctxPer10.toFixed(0)} in 10 — I turned the pit down to ${nr}.`, 1, [], nurse);
    } else if (r.chance(0.5)) {
      sim.page(p, `She's contracting about ${rd.ctxPer10.toFixed(0)} in 10 on pit ${pit.rate}. Want me to do anything?`, 1,
        [{ label: 'Pit down', cmd: { type: 'order', pid: p.id, text: 'pit down' } }, { label: 'Pit off', cmd: { type: 'order', pid: p.id, text: 'pit off' } }, { label: 'Terb', cmd: { type: 'order', pid: p.id, text: 'terbutaline 0.25 mg SQ' } }], nurse);
    }
  }
  // Cervidil out for tachysystole / 12 h
  if (p.meds.cervidil.in) {
    if (t - p.meds.cervidil.inT >= 12 * H) { sim.removeCervidil(p, '12 h'); sim.page(p, `Cervidil is out — it's been 12 hours.`, 1, [], nurse); }
    else if (rd && rd.ctxPer10 != null && rd.ctxPer10 > 5 && nurse.pit !== 'aggressive') { sim.removeCervidil(p, 'tachysystole'); sim.page(p, `Pulled her Cervidil — she was contracting ${rd.ctxPer10.toFixed(0)} in 10.`, 1, [], nurse); }
  }

  // ---- cervical exams on the nurse's own schedule
  const active = p.chart.sves.length && p.chart.sves[p.chart.sves.length - 1].dil >= 6;
  let sveInt = p.truePhaseKnown === 'second' ? 1e9 : active ? 2 * H : T.laborOnset ? 3.5 * H : 1e9;
  if (p.area === 'triage') sveInt = 1e9;
  const pressure = !T.complete ? (T.dil >= 9 || T.station >= 1) && p.epidural.state !== 'working' : false;
  if (pressure && !ns.pressureSaid && r.chance(0.2)) { ns.pressureSaid = true; sim.nurseSays(p, `She says she feels a lot of pressure.`, 1); sveInt = 0; }
  if (t - ns.lastSveT >= sveInt && !T.complete) sim.doSVE(p, 'nurse', 'routine');
  if (T.complete && p.pushing === 'no' && !p.flags.completePaged && t - ns.lastSveT > (p.epidural.state === 'working' ? 75 : 30) * MIN) sim.doSVE(p, 'nurse', 'routine');
  // nobody answered "push or labor down?": after an hour she starts pushing per unit routine
  if (p.flags.completePaged && p.pushing === 'no' && t - p.flags.completePaged > 60 * MIN && T.complete) {
    sim.startPushing(p);
    sim.page(p, `Nobody got back to me, so I started ${p.name.split(' ')[0]} pushing.`, 1, [], nurse);
  }

  // ---- pain / epidural requests
  if (T.laborOnset && p.epidural.state === 'none' && !p.flags.natural && (T.painLoad || 0) > 15 && t - ns.lastPainPage > 45 * MIN) {
    ns.lastPainPage = t;
    const n = (ns.painAsks = (ns.painAsks || 0) + 1);
    sim.page(p, n === 1 ? `${p.name.split(' ')[0]} is asking for an epidural.` : `She's really hurting — still waiting on that epidural${n > 2 ? ', she\'s crying' : ''}.`, n > 2 ? 2 : 1,
      [{ label: 'Order epidural', cmd: { type: 'order', pid: p.id, text: 'epidural' } }, { label: 'Fentanyl 100', cmd: { type: 'order', pid: p.id, text: 'fentanyl 100 mcg IV' } }], nurse);
    p.flags.epiRequestT = p.flags.epiRequestT ?? t;
  }
  if (T.laborOnset && p.flags.natural && (T.painLoad || 0) > 25 && t - ns.lastPainPage > 90 * MIN && r.chance(0.5)) {
    ns.lastPainPage = t;
    sim.page(p, `She wanted to go natural but she's asking if there's anything for the pain.`, 1,
      [{ label: 'Nubain 10', cmd: { type: 'order', pid: p.id, text: 'nubain 10 mg IV' } }, { label: 'Epidural', cmd: { type: 'order', pid: p.id, text: 'epidural' } }], nurse);
  }

  // ---- pushing updates
  if (p.pushing === 'pushing' && p.pushStartT > 0) {
    const ph = (t - p.pushStartT) / H;
    if (ph >= 1 && t - ns.lastPushUpdate > H) {
      ns.lastPushUpdate = t;
      const sta = clamp(Math.round(T.station + nurse.staBias + r.normal(0, 0.5)), -1, 4);
      sim.page(p, `She's been pushing ${Math.floor(ph)} h${ph >= 2 ? ` — head is about +${Math.max(0, sta)}` : ', making some progress'}.${T.op && r.chance(0.3) ? ' I think baby might be OP.' : ''}`, ph >= 3 ? 2 : 1,
        ph >= 2 ? [{ label: 'Vacuum', cmd: { type: 'order', pid: p.id, text: 'vacuum' } }, { label: 'C-section', cmd: { type: 'order', pid: p.id, text: 'c-section urgent for arrest of descent' } }] : [], nurse);
    }
  }
}

function tracingWatch(sim, nurse, p, ns, rd) {
  const t = sim.t, r = sim.nrng, T = p.T;
  const first = p.name.split(' ')[0];
  const recent = rd.decels.filter(d => d.end >= rd.windowSec - 240);
  const prolonged = rd.decels.find(d => (d.kind === 'prolonged' && d.end >= rd.windowSec - 60) || (d.end >= rd.windowSec - 2 && d.dur >= 100));
  const brady = rd.lowFrac120 != null && rd.lowFrac120 > 0.85 && rd.lossFrac < 0.5;
  if ((prolonged || brady) && rd.mhrMatchFrac > 0.7 && r.chance(0.35 + 0.6 * nurse.knowledge)) {
    // the FHR line is sitting on top of mom's pulse: she fixes the transducer instead of calling
    p.mon.us = 'ok'; p.mon.usUntil = t;
    if (r.chance(nurse.chatty)) sim.nurseSays(p, `Heart rate dropped out — the US was picking up mom's pulse. Repositioned the transducer.`, 0);
    return;
  }
  const ongoing = rd.currentFhr != null && rd.currentFhr < 110;
  if (prolonged && !ongoing && !brady) {
    if (t - (ns.lastRecoveredPage || -1e9) > 20 * MIN && r.chance(0.3 + 0.7 * nurse.alert)) {
      ns.lastRecoveredPage = t;
      sim.page(p, `She had a decel down to the ${Math.floor(Math.max(40, rd.baseline - prolonged.depth) / 10) * 10}s for about ${Math.max(1, Math.round(prolonged.dur / 60))} min — back to baseline now. I repositioned her.`, 2,
        [{ label: 'SVE (you)', cmd: { type: 'mdExam', pid: p.id } }, { label: 'Pit off', cmd: { type: 'order', pid: p.id, text: 'pit off' } }], nurse);
      sim.reposition(p, true);
    }
    return;
  }
  if ((prolonged || brady) && t - ns.lastTracingPage > 8 * MIN) {
    ns.lastTracingPage = t;
    const hr = Math.round(rd.currentFhr ?? rd.minFhr);
    sim.page(p, `${first}'s baby is down in the ${Math.floor(hr / 10) * 10}s${prolonged ? ` for ${Math.round(prolonged.dur / 60 * 10) / 10} min` : ''}! I'm ${resusText(nurse)}.`, 3,
      [{ label: 'C-section STAT', cmd: { type: 'order', pid: p.id, text: 'c-section stat for prolonged decel' } },
       { label: 'SVE (you)', cmd: { type: 'mdExam', pid: p.id } }, { label: 'Terb', cmd: { type: 'order', pid: p.id, text: 'terbutaline 0.25 mg SQ' } }], nurse);
    intrauterineResus(sim, nurse, p);
    return;
  }
  const lates = rd.decels.filter(d => d.kind === 'late').length;
  const vars = rd.decels.filter(d => d.kind === 'variable' && d.depth >= 30).length;
  if (lates >= 2 && t - ns.lastLatePage > 30 * MIN && r.chance(nurse.alert)) {
    ns.lastLatePage = t;
    const mis = r.chance((1 - nurse.knowledge) * 0.6);
    const what = mis ? r.pick(['some variables', 'a couple of decels, maybe early', 'some dips with contractions']) : 'decels after her contractions — they look late to me';
    sim.page(p, `Room ${p.room.replace('LDR ', '')}: she's having ${what}. Baseline ${Math.round(rd.baseline / 5) * 5}.`, 2,
      [{ label: 'Pit off', cmd: { type: 'order', pid: p.id, text: 'pit off' } }, { label: 'Reposition', cmd: { type: 'order', pid: p.id, text: 'reposition' } }, { label: 'Bolus', cmd: { type: 'order', pid: p.id, text: 'LR bolus 500' } }], nurse);
    if (nurse.pit === 'cautious' && p.meds.pit.rate > 0) { sim.setPit(p, Math.floor(p.meds.pit.rate / 2), 'nurse'); sim.nurseSays(p, `I cut her pit in half.`, 1); }
    sim.reposition(p, true);
  } else if (vars >= 3 && t - ns.lastVarPage > 40 * MIN && r.chance(nurse.alert * 0.8)) {
    ns.lastVarPage = t;
    sim.page(p, `She's having recurrent variables, some down ${Math.round(Math.max(...rd.decels.map(d => d.depth)) / 10) * 10} beats.`, 2,
      [{ label: 'Reposition', cmd: { type: 'order', pid: p.id, text: 'reposition' } }, { label: 'Amnioinfusion', cmd: { type: 'order', pid: p.id, text: 'amnioinfusion' } }], nurse);
    sim.reposition(p, true);
  }
  if (rd.variability != null && rd.variability <= 5 && rd.accels.length === 0) {
    ns.flatSince = ns.flatSince ?? t;
    if (t - ns.flatSince > 35 * MIN && t - ns.lastFlatPage > 60 * MIN && r.chance(nurse.alert * 0.7)) {
      ns.lastFlatPage = t;
      sim.page(p, `Her variability has looked minimal for a while${rd.decels.length ? ', with some decels' : ''}.`, 2,
        [{ label: 'Scalp stim', cmd: { type: 'order', pid: p.id, text: 'VAS' } }], nurse);
    }
  } else ns.flatSince = null;
  if (rd.baseline > 165 && t - ns.lastTachyPage > 60 * MIN && r.chance(nurse.alert * 0.6)) {
    ns.lastTachyPage = t;
    sim.page(p, `Baby's baseline is up around ${Math.round(rd.baseline / 5) * 5}.`, 1, [{ label: 'Vitals', cmd: { type: 'order', pid: p.id, text: 'vitals' } }], nurse);
  }
  // maternal pickup: a sharp nurse notices the FHR tracking the MHR line
  if (p.mon.us === 'mhr' && r.chance(nurse.alert * 0.15)) {
    p.mon.us = 'ok';
    if (r.chance(nurse.chatty)) sim.nurseSays(p, `Fixed the US — it was picking up mom's pulse.`, 0);
  }
}

function resusText(nurse) {
  const acts = ['repositioning her'];
  if (nurse.knowledge > 0.5) acts.push('turning off pit');
  if (nurse.knowledge > 0.6) acts.push('bolusing');
  if (nurse.knowledge > 0.7) acts.push('checking her');
  return acts.join(', ');
}

function intrauterineResus(sim, nurse, p) {
  const t = sim.t;
  if (t - p.ns.resusT < 10 * MIN) return;
  p.ns.resusT = t;
  sim.reposition(p, true);
  if (nurse.knowledge > 0.5 && p.meds.pit.rate > 0) sim.setPit(p, 0, 'nurse');
  if (nurse.knowledge > 0.6) sim.giveFluid(p, 500, true);
  if (nurse.knowledge > 0.45) p.meds.o2 = true;
  if (nurse.knowledge > 0.7 && !p.T.pp) sim.after(3 * MIN, () => sim.doSVE(p, 'nurse', 'decel'));
  if (p.epidural.state === 'working' && p.T.epiHypo > 10) sim.anesthesiaTreatHypotension(p);
}

function pitTitrate(sim, nurse, p, ns, rd) {
  const pit = p.meds.pit, pr = pit.protocol, t = sim.t;
  if (t - pit.lastTitrT < pr.intervalMin * MIN || rd.ctxPer10 == null) return;
  const c10 = rd.ctxPer10;
  const lates = rd.decels.filter(d => d.kind === 'late' || d.kind === 'prolonged').length;
  const bigVars = rd.decels.filter(d => d.kind === 'variable' && d.depth > 40).length;
  const adequate = p.devices.iupc ? p.T.mvu >= 200 : c10 >= 3;
  let nr = pit.rate;
  if (nurse.pit === 'cautious') {
    if (c10 > 5 || lates >= 1 || bigVars >= 2) nr = Math.floor(pit.rate / 2);
    else if (!adequate) nr = pit.rate + pr.inc;
  } else if (nurse.pit === 'standard') {
    if (c10 > 5) nr = pit.rate - pr.inc;
    else if (lates >= 2) nr = pit.rate;
    else if (!adequate || c10 < 3) nr = pit.rate + pr.inc;
  } else {
    if (c10 > 6.5 || lates >= 3) nr = pit.rate - pr.inc;
    else if (c10 < 4.5) nr = pit.rate + pr.inc;
  }
  nr = clamp(nr, 0, pr.max);
  pit.lastTitrT = t;
  if (nr !== pit.rate) {
    sim.setPit(p, nr, 'protocol');
    if (nr < pit.rate || sim.nrng.chance(nurse.chatty * 0.4)) sim.nurseSays(p, `Pit ${nr > pit.rate ? 'up' : 'down'} to ${nr}.`, 0);
  }
  if (nr >= pr.max && !ns.maxSaid) { ns.maxSaid = true; sim.page(p, `She's maxed out on pit at ${pr.max}.`, 1, [], nurse); }
}

function postpartumNursing(sim, nurse, p, ns) {
  const t = sim.t, pp = p.T.pp, r = sim.nrng;
  if (t - pp.t0 > 2.5 * H && pp.bleed < 2) return;
  if (t - (ns.lastQblT || pp.t0) >= 15 * MIN) {
    ns.lastQblT = t;
    const q = Math.round(pp.qbl / 25) * 25;
    p.chart.vitals.push({ t, qbl: q, by: nurse.name, fundus: pp.tone > 0.7 ? 'firm' : pp.tone > 0.5 ? 'boggy, firms with massage' : 'boggy' });
    const thresh = pp.mode === 'cs' ? 1000 : 500;
    const worse = q - (ns.lastBleedQbl || 0) >= 250 || pp.bleed > 25;
    if ((q >= thresh || pp.bleed > 25) && worse && t - ns.lastBleedPage > 12 * MIN) {
      ns.lastBleedPage = t; ns.lastBleedQbl = q;
      const urgent = q >= 1000 || pp.bleed > 40;
      if (nurse.knowledge > 0.4) pp.massage = t;
      if (!p.meds.ppOxy) p.meds.ppOxy = true;
      sim.page(p, `${p.name.split(' ')[0]} is bleeding — QBL ${q} mL, fundus ${pp.tone > 0.6 ? 'firms up then relaxes' : 'boggy'}. ${pp.bleed > 30 ? 'It\'s pouring.' : ''}`, urgent ? 3 : 2, [
        { label: 'TXA 1 g', cmd: { type: 'order', pid: p.id, text: 'TXA 1 g IV' } },
        { label: 'Methergine', cmd: { type: 'order', pid: p.id, text: 'methergine 0.2 mg IM' } },
        { label: 'Hemabate', cmd: { type: 'order', pid: p.id, text: 'hemabate 250 mcg IM' } },
        { label: 'Miso 800 PR', cmd: { type: 'order', pid: p.id, text: 'miso 800 mcg PR' } },
      ], nurse);
    }
  }
}
