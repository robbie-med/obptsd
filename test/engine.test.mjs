// Headless engine checks: determinism + physiology lands in plausible ranges.
// Run: node test/engine.test.mjs
import { Sim } from '../js/engine/sim.js';
import { parseOrder } from '../js/engine/orders.js';
import { analyzeStrip } from '../js/engine/monitor.js';

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
