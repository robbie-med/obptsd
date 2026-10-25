// Headless engine checks: determinism + physiology lands in plausible ranges.
// Run: node test/engine.test.mjs
import { Sim } from '../js/engine/sim.js';
import { parseOrder } from '../js/engine/orders.js';
import { analyzeStrip } from '../js/engine/monitor.js';
import { startShoulder, startAFE } from '../js/engine/emergency.js';
import { computeScore } from '../js/engine/scoring.js';

let fails = 0, passes = 0;
function check(name, cond, info = '') {
  if (cond) { passes++; console.log('  ok  ', name, info); }
  else { fails++; console.log('  FAIL', name, info); }
}
const H = 3600;

function single(seed, setup) {
  const sim = new Sim({ seed, mode: 'single' });
  const p = sim.patients[0];
  setup && setup(sim, p);
  return [sim, p];
}
function hoursUntil(sim, p, pred, maxH) {
  const t0 = sim.t;
  while (sim.t - t0 < maxH * H && !pred()) sim.run(60);
  return (sim.t - t0) / H;
}
function median(a) { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

console.log('determinism');
{
  const a = new Sim({ seed: 'det', mode: 'night' }); a.run(3 * H);
  const b = new Sim({ seed: 'det', mode: 'night' }); b.run(3 * H);
  const sig = (s) => s.patients.map(p => p.T.dil.toFixed(6) + p.T.bd.toFixed(6) + p.mon.n4).join('|') + s.msgs.length;
  check('same seed => same night', sig(a) === sig(b));
  const c = new Sim({ seed: 'det2', mode: 'night' }); c.run(3 * H);
  check('different seed => different night', sig(a) !== sig(c));
  // replay: orders at the same ticks reproduce the night
  const d = new Sim({ seed: 'rep', mode: 'night' });
  d.run(600); d.command({ type: 'order', pid: d.patients[2].id, text: 'pit up 2' });
  d.run(1800); d.command({ type: 'order', pid: d.patients[1].id, text: 'epidural' });
  d.run(3600);
  const e = new Sim({ seed: 'rep', mode: 'night' }); e.loadReplay(d.cmdLog); e.run(600 + 1800 + 3600);
  check('replay reproduces', sig(d) === sig(e));
}

console.log('shift start: day-team strips already printed');
{
  const s = new Sim({ seed: 'start', mode: 'night' });
  const pts = s.patients.filter(p => p.area === 'ldr');
  const traced = pts.filter(p => {
    const m = p.mon, seen = Array.from(m.fhr.slice(0, m.n4)).filter(v => !isNaN(v)).length;
    return m.t0 <= -30 * 60 && seen / m.n4 > 0.8;
  });
  check('every LDR patient has >= 30 min of tracing at 19:00', pts.length >= 5 && traced.length === pts.length, `${traced.length}/${pts.length}`);
  check('and a set of vitals from the day nurse', pts.every(p => p.chart.vitals.length && p.chart.vitals[0].t < 0));
  check('nothing pages before the shift starts', s.msgs.length === 0 && s.t === 0);
}

console.log('parser');
{
  const t = (s) => parseOrder(s);
  let o = t('mag 4 g IV load then 2 g/h'); check('mag load/maint', o.id === 'magnesium' && o.qty.length === 2 && o.qty[1].per === 'h');
  o = t('PCN G 5 MU IV then 2.5 MU q4h'); check('PCN MU', o.id === 'penicillin' && o.qty[0].unit === 'MU' && o.freq.everyH === 4);
  o = t('pit 6 mU/min'); check('pit mU', o.id === 'oxytocin' && o.qty[0].unit === 'mU' && o.qty[0].value === 6);
  o = t('labetalol 20mg IV'); check('labetalol', o.id === 'labetalol' && o.route === 'IV' && o.qty[0].value === 20);
  o = t('c-section stat for prolonged decel'); check('cs stat', o.id === 'cs' && o.urgency === 'stat' && o.indication === 'cat3');
  o = t('miso 25 mcg PV q4h'); check('miso', o.id === 'misoprostol' && o.route === 'PV' && o.freq.everyH === 4);
  o = t('check mag level'); check('mag level not SVE', o.id === 'mglevel');
  o = t('vancomycin 20 mg/kg IV q8h'); check('vanc mg/kg', o.qty[0].unit === 'mg/kg');
}

console.log('labor curves (Zhang-like): G1 spontaneous labor from 4 cm, no interventions');
{
  const times = [], bds = [];
  for (let i = 0; i < 24; i++) {
    const [sim, p] = single('labor' + i, (sim, p) => {
      Object.assign(p.T, { dil: 4, R: 0.8, laborOnset: true, S: 0.55, station: -1.5 });
      p.status = 'labor'; p.flags.natural = true;
    });
    const h = hoursUntil(sim, p, () => p.T.complete, 30);
    times.push(h); bds.push(p.T.bd);
  }
  const m = median(times);
  check('median 4->10 cm in 3-9 h (Zhang P0 ~5.5 h)', m > 3 && m < 9, `median ${m.toFixed(1)} h, range ${Math.min(...times).toFixed(1)}–${Math.max(...times).toFixed(1)}`);
  check('fetal BD stays modest in normal labor', median(bds) < 7, `median BD ${median(bds).toFixed(1)}`);
}

console.log('unripe G1 on pit from the start: long latent phase');
{
  const res = [];
  for (let i = 0; i < 10; i++) {
    const [sim, p] = single('unripe' + i, (sim, p) => { Object.assign(p.T, { dil: 1, R: 0.15 }); p.nurseId = null; });
    sim.setPit(p, 10, 'test');
    sim.run(10 * H);
    res.push(p.T.dil);
  }
  check('median dilation after 10 h of pit < 5 cm', median(res) < 5, `median ${median(res).toFixed(1)} cm`);
  check('...but the cervix does move (> 1.5 cm)', median(res) > 1.5, `median ${median(res).toFixed(1)} cm`);
}

console.log('pit tachysystole -> recurrent lates without scripting');
{
  let tachy = 0, lateSeen = 0;
  for (let i = 0; i < 8; i++) {
    const [sim, p] = single('tachy' + i, (sim, p) => { Object.assign(p.T, { dil: 5, R: 0.8, laborOnset: true, S: 0.6, ec50: 4 }); p.nurseId = null; p.devices.iupc = true; });
    sim.setPit(p, 20, 'test');
    sim.run(2 * H);
    const rd = analyzeStrip(p, sim.t, 1200);
    if (p.T.ctxStarts.filter(t => t > sim.t - 1800).length / 3 > 5) tachy++;
    if (rd.decels.some(d => d.kind === 'late' || d.kind === 'prolonged')) lateSeen++;
  }
  check('pit 20 => tachysystole in most', tachy >= 5, `${tachy}/8`);
  check('late/prolonged decels appear', lateSeen >= 4, `${lateSeen}/8`);
}

console.log('IUGR fetus in labor accrues base deficit faster');
{
  const nl = [], ig = [];
  for (let i = 0; i < 8; i++) {
    for (const [plac, arr] of [[1.0, nl], [0.6, ig]]) {
      const [sim, p] = single('iugr' + i, (sim, p) => { Object.assign(p.T, { dil: 5, R: 0.8, laborOnset: true, S: 0.7, plac, bd: 2 }); p.nurseId = null; });
      sim.run(4 * H);
      arr.push(p.T.bd);
    }
  }
  check('IUGR BD > normal BD after 4 h', median(ig) > median(nl) + 2, `normal ${median(nl).toFixed(1)} vs IUGR ${median(ig).toFixed(1)}`);
}

console.log('magnesium PK');
{
  const [sim, p] = single('mag', (sim, p) => { p.weightKg = 85; p.nurseId = null; });
  sim.startMag(p, 4, 2);
  sim.run(1 * H); const at1 = p.T.mg;
  sim.run(5 * H); const at6 = p.T.mg;
  check('Mg 4 g + 2 g/h => 4.5-8 mg/dL at 1 h', at1 > 4.5 && at1 < 8, at1.toFixed(1));
  check('steady state 4.8-8.4 at 6 h (normal renal)', at6 > 4.8 && at6 < 8.4, at6.toFixed(1));
  const [sim2, q] = single('mag2', (sim, p) => { p.weightKg = 85; p.T.cr = 1.8; p.nurseId = null; });
  sim2.startMag(q, 4, 2); sim2.run(10 * H);
  check('renal impairment accumulates toward toxicity', q.T.mg > 9, q.T.mg.toFixed(1));
}

console.log('shoulder dystocia');
{
  const o = (t) => parseOrder(t).id;
  check('maneuver aliases', o('McRoberts') === 'mcroberts' && o('suprapubic pressure') === 'suprapubic' && o('deliver the posterior arm') === 'posterior'
    && o('woods screw') === 'rotational' && o('gaskin') === 'gaskin' && o('fundal pressure') === 'fundal' && o('fundal massage') === 'massage' && o('hands and knees') === 'reposition');
  const run = (seed, plan) => {
    const sim = new Sim({ seed, mode: 'single' });
    const p = sim.patients[0];
    Object.assign(p.T, { dil: 10, complete: true, station: 4, laborOnset: true, rom: true, deliveredFlag: true, efw: 4300 });
    startShoulder(sim, p, {});
    for (const t of plan) sim.command({ type: 'order', pid: p.id, text: t });
    sim.run(14 * 60);
    return p;
  };
  const none = [], helperr = [];
  for (let i = 0; i < 10; i++) {
    none.push(run('sd' + i, []));
    helperr.push(run('sd' + i, ['call for help', 'McRoberts', 'suprapubic pressure', 'deliver posterior arm']));
  }
  check('every dystocia ends in a birth within 14 min', [...none, ...helperr].every(p => p.outcome && p.outcome.mode === 'vaginal'));
  const hb = (arr) => median(arr.map(p => p.sd.hbdi));
  check('maneuvers shorten head-to-body interval', hb(helperr) < hb(none) - 60, `HELPERR ${hb(helperr)} s vs waiting ${hb(none)} s`);
  const pH = (arr) => median(arr.map(p => p.outcome.neo.pH));
  check('waiting costs pH', pH(none) < pH(helperr) - 0.03, `${pH(helperr)} vs ${pH(none)}`);
  const all = [...none, ...helperr].sort((a, b) => a.sd.hbdi - b.sd.hbdi);
  check('long intervals come out depressed', median(all.slice(-5).map(p => p.outcome.neo.apgar5)) < median(all.slice(0, 5).map(p => p.outcome.neo.apgar5)));
  const f = run('sdf', ['fundal pressure', 'yes']);
  check('fundal pressure gets nurse pushback or harm', f.chart.orders[0].status === 'held_nurse' || (f.harms || []).some(h => h.kind === 'fundal_pressure'));
}

console.log('amniotic fluid embolism / maternal arrest');
{
  const o = (t) => parseOrder(t).id;
  check('code aliases', o('perimortem c-section') === 'hysterotomy' && o('epinephrine 1 mg IV') === 'epinephrine' && o('LUD') === 'lud' && o('defibrillate') === 'defib'
    && o('cryo 10 units') === 'cryo' && parseOrder('cryo 10 units').units === 10 && o('massive transfusion') === 'transfuse');
  let arrests = 0, cuts = 0, fibLow = 0, quickDelivery = 0, roscResp = 0, roscNone = 0, epiHeld = 0;
  for (let i = 0; i < 10; i++) {
    for (const respond of [true, false]) {
      const sim = new Sim({ seed: 'afe' + i, mode: 'single' });
      const p = sim.patients[0];
      Object.assign(p.T, { dil: 6, laborOnset: true, rom: true, S: 0.7, R: 0.9 });
      startAFE(sim, p);
      let acted = false, cut = false;
      for (let k = 0; k < 6 * 40; k++) {
        sim.run(10);
        const a = p.crisis;
        if (respond && a.phase === 'arrest' && !acted) {
          acted = true;
          for (const t of ['LUD', 'epinephrine 1 mg IV']) sim.command({ type: 'order', pid: p.id, text: t });
        }
        if (respond && a.phase === 'arrest' && !cut && sim.t - a.arrestT >= 230) { cut = true; sim.command({ type: 'order', pid: p.id, text: 'resuscitative hysterotomy' }); }
      }
      const a = p.crisis;
      if (a.arrestT != null) {
        if (respond) arrests++;
        if (cut) cuts++;
        if (cut && p.outcome && p.outcome.t - a.arrestT < 6.5 * 60) quickDelivery++;
        if (respond && a.roscT != null) roscResp++;
        if (!respond && a.roscT != null) roscNone++;
        if (respond && p.chart.orders.some(x => /Epinephrine/.test(x.label) && x.status !== 'done')) epiHeld++;
      }
      if (p.T.fib < 200) fibLow++;
    }
  }
  check('most AFEs arrest', arrests >= 4, `${arrests}/10`);
  check('DIC: fibrinogen < 200 within 40 min', fibLow >= 15, `${fibLow}/20`);
  check('hysterotomy at 4 min delivers within ~6 min of arrest', cuts > 0 && quickDelivery === cuts, `${quickDelivery}/${cuts} (others had ROSC before 4 min)`);
  check('code epinephrine is not held by pharmacy', epiHeld === 0);
  check('LUD + epi + hysterotomy beats doing nothing', roscResp > roscNone, `ROSC ${roscResp} vs ${roscNone}`);
}

console.log('magnesium arrest');
{
  let roscCa = 0, roscNone = 0, held = 0, routed = 0, button = 0;
  for (let i = 0; i < 12; i++) {
    for (const respond of [true, false]) {
      const sim = new Sim({ seed: 'mgx' + i, mode: 'single' });
      const p = sim.patients[0];
      sim.startMag(p, 4, 2);
      sim.run(600);
      sim.emit(p, 'mag_arrest');
      if (p.crisis && p.crisis.cause === 'mag' && p.crisis.phase === 'arrest') routed++;
      if (sim.msgs.some(m => m.prio >= 3 && m.actions.some(a => /Calcium/.test(a.label)))) button++;
      if (respond) for (const t of ['calcium gluconate 1 g IV', 'stop mag', 'epinephrine 1 mg IV']) sim.command({ type: 'order', pid: p.id, text: t });
      sim.run(20 * 60);
      if (respond && p.chart.orders.some(x => /Calcium/.test(x.label) && x.status !== 'done')) held++;
      if (p.crisis.roscT != null) respond ? roscCa++ : roscNone++;
    }
  }
  check('mag_arrest runs through the code system', routed === 24 && button === 24, `${routed}/24 routed, ${button}/24 with a calcium button`);
  check('code calcium is not held', held === 0);
  check('calcium + stop mag beats doing nothing', roscCa > roscNone + 3, `ROSC ${roscCa}/12 vs ${roscNone}/12`);
}

console.log('black cloud');
{
  let sd = 0, afe = 0;
  for (const seed of ['bc1', 'bc2', 'bc3', 'bc4', 'bc5', 'bc6']) {
    const sim = new Sim({ seed, mode: 'night', blackCloud: true });
    sim.run(12 * H);
    sd += sim.patients.filter(p => p.sd).length; afe += sim.patients.filter(p => p.crisis).length;
    computeScore(sim);
  }
  check('black-cloud nights produce dystocias and AFEs', sd + afe >= 2, `${sd} SD, ${afe} AFE over 6 nights (no orders)`);
  const a = new Sim({ seed: 'bcrep', mode: 'night', blackCloud: true }); a.run(2 * H);
  a.command({ type: 'order', pid: a.patients[1].id, text: 'pit up 2' }); a.run(4 * H);
  const b = new Sim({ seed: 'bcrep', mode: 'night', blackCloud: true }); b.loadReplay(a.cmdLog); b.run(6 * H);
  const sig = (s) => s.patients.map(p => p.T.dil.toFixed(6) + p.T.bd.toFixed(6) + (p.crisis ? p.crisis.phase : '') + (p.sd ? p.sd.hbdi : '')).join('|') + s.msgs.length;
  check('black-cloud replay reproduces', sig(a) === sig(b));
}

console.log('full night smoke test');
{
  for (const seed of ['n1', 'n2', 'n3']) {
    const sim = new Sim({ seed, mode: 'night' });
    let urgent = 0; sim.on((ty, m) => { if (ty === 'msg' && m.prio >= 3) urgent++; });
    const t0 = Date.now(); sim.run(12 * H);
    check(`night ${seed} runs`, sim.ended, `${Date.now() - t0} ms, ${sim.patients.length} patients, ${sim.msgs.length} msgs, ${urgent} urgent`);
  }
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
