// A crude autoplayer that answers pages for whole nights, to exercise order/OR/anesthesia/delivery
// paths end-to-end and catch crashes. Not a good doctor. Run: node test/bot.test.mjs [nights]
import { Sim } from '../js/engine/sim.js';
import { computeScore } from '../js/engine/scoring.js';

const H = 3600;
const nights = +(process.argv[2] || 4);
let crashes = 0;

function play(seed, mode) {
  const sim = new Sim({ seed, mode });
  const r = sim.rng.fork('bot');
  const seen = new Set();
  const step = () => {
    for (const m of sim.msgs) {
      if (seen.has(m.id) || m.resolved) continue;
      seen.add(m.id);
      if (!m.actions || !m.actions.length) continue;
      const labels = m.actions.map(a => a.label);
      let pick = null;
      const find = (re) => m.actions.find(a => re.test(a.label));
      if (m.role === 'pharmacy') pick = r.chance(0.3) ? find(/Override/) : find(/Cancel/);
      else if (/Do you still want it/.test(m.text)) pick = r.chance(0.4) ? find(/Yes/) : find(/Cancel/);
      else if (m.role === 'phone') pick = m.actions[r.chance(0.7) ? 0 : 1];
      else if (m.role === 'family' || m.role === 'attending') pick = m.actions[r.int(0, m.actions.length - 1)];
      else if (m.role === 'charge') pick = find(/Bring her back|Straight|Call backup/) || null;
      else if (/Triage:/.test(m.text)) {
        const p = sim.byId[m.pid];
        const sve = p && p.chart.sves[p.chart.sves.length - 1];
        pick = sve && sve.dil >= 4 ? find(/Admit/) : r.chance(0.3) ? find(/PIH|ROM|US/) : find(/Discharge|Walk/);
      }
      else if (/complete/.test(m.text)) pick = find(/^Push/);
      else if (/down in the/.test(m.text)) pick = r.chance(0.5) ? find(/C-section/) : find(/SVE|Terb/);
      else pick = m.actions[0];
      if (pick) {
        const res = sim.command(pick.cmd);
        if (pick.cmd2) sim.command(pick.cmd2);
      }
    }
    // a few free-text orders to hit the parser/handlers
    for (const p of sim.patients) {
      if (p.area !== 'ldr' || p.outcome || r.chance(0.97)) continue;
      const pool = ['pit per protocol', 'miso 25 mcg PV q4h', 'cervidil', 'AROM', 'IUPC', 'FSE', 'epidural', 'LR bolus 500', 'reposition',
        'PCN G 5 MU IV then 2.5 MU q4h', 'labetalol 20 mg IV', 'mag 4 g IV load then 2 g/h', 'CBC', 'PIH labs', 'bedside US', 'SVE',
        'fentanyl 100 mcg IV', 'terbutaline 0.25 mg SQ', 'pit up 2', 'pit down 2', 'amnioinfusion', 'methergine 0.2 mg IM', 'miso 800 mcg PR',
        'vacuum', 'c-section urgent for arrest of dilation', 'ampicillin 2 g IV q6h', 'gentamicin 5 mg/kg IV q24h', 'betamethasone 12 mg IM', 'stop mag'];
      sim.command({ type: 'order', pid: p.id, text: r.pick(pool) });
    }
    for (const p of sim.patients) if (p.outcome && p.T.pp && p.T.pp.qbl > 900 && r.chance(0.2)) sim.command({ type: 'order', pid: p.id, text: r.pick(['TXA 1 g IV', 'hemabate 250 mcg IM', 'fundal massage', 'transfuse 2 units', 'return to OR']) });
  };
  while (!sim.ended) { sim.run(120); step(); }
  return sim;
}

for (let i = 0; i < nights; i++) {
  const seed = 'bot-' + i;
  for (const mode of ['night', 'quick']) {
    try {
      const t0 = Date.now();
      const sim = play(seed, mode);
      const sc = computeScore(sim);
      const del = sim.patients.filter(p => p.outcome);
      const cs = del.filter(p => p.outcome.mode === 'cs').length;
      console.log(`${mode} ${seed}: ${Date.now() - t0} ms · ${sim.patients.length} pts · ${del.length} deliveries (${cs} CS) · score ${sc.score} ${sc.grade} · ${sim.cmdLog.length} cmds · pen ${sc.pen.length}`);
      // replay must reproduce exactly
      const re = new Sim({ seed, mode }); re.loadReplay(sim.cmdLog);
      while (!re.ended) re.run(600);
      const sig = (s) => s.patients.map(p => p.T.dil.toFixed(5) + ':' + p.T.bd.toFixed(5) + ':' + (p.outcome ? p.outcome.t : '-')).join('|');
      if (sig(re) !== sig(sim)) { console.log('  REPLAY MISMATCH'); crashes++; }
    } catch (e) {
      crashes++;
      console.log(`${mode} ${seed}: CRASH`, e.stack);
    }
  }
}
process.exit(crashes ? 1 : 0);
