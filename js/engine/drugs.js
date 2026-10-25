// Drug/action database: interpretation of a parsed order, validation against real parameters
// (SPEC §5; data shape after antibiotiX's routes/doses/intervals), and execution.
// Each handler: prepare(o, p, sim) -> { ok, err?, label, issues[], run(), delay:[minLo,minHi], who }
// issue: { by: 'pharmacy'|'nurse'|'anesthesia'|'attending', hard, sev (1-3), msg }
import { clamp } from './util.js';
import { doROM } from './physio.js';

const MIN = 60;

function qtyOf(o, units) {
  return o.qty.find(q => !units || units.includes(q.unit));
}
function num(o, i = 0) { return o.qty[i] ? o.qty[i].value : null; }
function pharm(msg, hard = false) { return { by: 'pharmacy', hard, sev: 2, msg }; }
function nurse(msg, sev = 2) { return { by: 'nurse', hard: false, sev, msg }; }
function hardNurse(msg) { return { by: 'nurse', hard: true, sev: 3, msg }; }
function delivered(p) { return !!p.T.pp; }
function hasHTN(p) { return p.known.preE !== 'none' || p.dx.cHTN || p.dx.gHTN || p.chart.problems.includes('preE'); }
function knownAsthma(p) { return p.asthma; } // asthma is on the problem list
function lastSve(sim, p) { return p.chart.sves.length ? p.chart.sves[p.chart.sves.length - 1] : null; }
function ctxPer10(p) { return p.read && p.read.ctxPer10 != null ? p.read.ctxPer10 : null; }
function gaW(p) { return p.gaDays / 7; }
function toMg(q, p) {
  if (!q) return null;
  if (q.unit === 'g') return q.value * 1000;
  if (q.unit === 'mcg') return q.value / 1000;
  if (q.unit === 'mg/kg') return q.value * p.weightKg;
  return q.value;
}
function toMcg(q) {
  if (!q) return null;
  if (q.unit === 'mg') return q.value * 1000;
  if (q.unit === 'g') return q.value * 1e6;
  return q.value;
}
function fmtTime(sim, t) { return sim.clock(t); }

// pyxis/premixed meds are fast; pharmacy-verified first doses slower
const PYXIS = [3, 7], PHARM = [10, 22], NURSE_TASK = [1, 4], MD_PROC = [3, 7];

function bolusDrug(def) {
  // def: { drug, unit:'mg'|'mcg', routes, defRoute, typical:[lo,hi], softMax, hardMax, minIntervalMin, label, extraIssues(p,sim,amt,route), onRun(p,sim,amt,route) , delay }
  return {
    prepare(o, p, sim) {
      if (o.stop) return { ok: false, err: `${def.label} is a one-time dose — nothing to stop.` };
      let amt;
      const q = o.qty[0];
      if (def.unit === 'mcg') amt = q ? toMcg(q) : def.default;
      else amt = q ? toMg(q, p) : def.default;
      if (amt == null) return { ok: false, err: `${def.label}: dose?` };
      if (def.unit === 'mcg' && q && !q.unit && q.value < 5 && def.default >= 50) amt = q.value * 1000; // "0.2" etc.
      if (def.unit === 'mg' && q && !q.unit && def.gramsIfSmall && q.value <= 4) amt = q.value * 1000;
      const route = o.route || def.defRoute;
      const lim = (def.routeLimits && def.routeLimits[route]) || def;
      const issues = [];
      if (!def.routes.includes(route)) issues.push(pharm(`${def.label} ${route} is not a route we dispense. Usual: ${def.routes.join('/')}.`, !def.softRoutes?.includes(route)));
      if (amt > lim.hardMax) issues.push(pharm(`${def.label} ${amt} ${def.unit} ${route} exceeds the maximum single dose (${lim.softMax} ${def.unit}). Please clarify.`, true));
      else if (amt > lim.softMax) issues.push(pharm(`${def.label} ${amt} ${def.unit} ${route} is above the usual maximum (${lim.softMax} ${def.unit}).`));
      else if (amt < lim.typical[0] * 0.5) issues.push(pharm(`${def.label} ${amt} ${def.unit} is below the usual dose (${lim.typical[0]}–${lim.typical[1]} ${def.unit}).`));
      const last = sim.lastDose(p, def.drug);
      if (def.minIntervalMin && last && sim.t - last.t < def.minIntervalMin * MIN) {
        issues.push(nurse(`Last ${def.label} was ${Math.round((sim.t - last.t) / 60)} min ago (at ${fmtTime(sim, last.t)}).`, 1));
      }
      if (def.extraIssues) issues.push(...def.extraIssues(p, sim, amt, route, o));
      return {
        ok: true, label: `${def.label} ${amt >= 1 ? +amt.toFixed(2) : amt} ${def.unit} ${route}`, issues,
        delay: def.delay || PYXIS, who: 'nurse',
        run: () => {
          sim.addDose(p, { drug: def.drug, amt: def.unit === 'mcg' ? amt : amt, route, pp: delivered(p) });
          if (def.onRun) def.onRun(p, sim, amt, route);
        },
      };
    },
  };
}

function abxDrug(def) {
  // def: { drug, label, loadDefault(mg), maintDefault, intervalH, max, gbs:true }
  return {
    prepare(o, p, sim) {
      if (o.stop) return { ok: true, label: `Stop ${def.label}`, issues: [], delay: NURSE_TASK, who: 'nurse', run: () => sim.stopScheduled(p, def.drug) };
      let doses = o.qty.map(q => {
        if (def.drug === 'penicillin') {
          if (q.unit === 'MU' || (!q.unit && q.value <= 10)) return q.value;
          if (q.unit === 'units' && q.value >= 1e5) return q.value / 1e6;
          return q.value;
        }
        let mg = toMg(q, p);
        if (!q.unit && q.value <= 4 && def.gramsIfSmall) mg = q.value * 1000;
        return mg;
      }).filter(v => v != null);
      const load = doses[0] ?? def.loadDefault;
      const maint = doses[1] ?? (o.then ? def.maintDefault : load);
      let everyH = o.freq && o.freq.everyH ? o.freq.everyH : def.intervalH;
      if (o.freq && o.freq.once) everyH = null;
      const u = def.drug === 'penicillin' ? 'MU' : 'mg';
      const issues = [];
      const route = o.route || 'IV';
      if (route !== 'IV' && !(def.oral && route === 'PO')) issues.push(pharm(`${def.label} must be given IV.`, false));
      if (load > def.hardMax) issues.push(pharm(`${def.label} ${load} ${u} exceeds the maximum dose (${def.max} ${u}).`, true));
      else if (load > def.max) issues.push(pharm(`${def.label} ${load} ${u} is above the usual dose (max ${def.max} ${u}).`));
      if (everyH && everyH < def.minIntervalH) issues.push(pharm(`${def.label} q${everyH}h is more frequent than recommended (q${def.intervalH}h).`));
      // allergy checks: pharmacy always sees the allergy band
      const pcn = p.allergy.pcn;
      if (def.betaLactam && pcn === 'anaphylaxis') {
        issues.push(pharm(`ALLERGY ALERT: penicillin — anaphylaxis. ${def.label} ${def.drug === 'cefazolin' ? 'is not recommended for high-risk allergy (ACOG: clindamycin if susceptible, else vancomycin).' : 'is contraindicated.'}`));
        issues.push(nurse(`She has an anaphylaxis allergy to penicillin.`, 3));
      } else if ((def.drug === 'penicillin' || def.drug === 'ampicillin') && pcn === 'rash') {
        issues.push(pharm(`ALLERGY ALERT: penicillin (rash). Consider cefazolin.`));
      }
      if (def.drug === 'clindamycin' && p.gbs === 'pos' && p.known.clindaResult === 'R') issues.push(pharm(`GBS isolate is RESISTANT to clindamycin.`));
      if (def.gbs && p.gbs === 'neg' && !(p.T.infect > 1 && p.chart.vitals.some(v => v.temp >= 38)) && !p.dx.pprom && gaW(p) >= 37 && def.drug !== 'cefazolin') {
        issues.push(nurse(`She's GBS negative — is this for something else?`, 1));
      }
      if (def.renal && sim.labValue(p, 'cr') > 1.1) issues.push(nurse(`Her creatinine is ${sim.labValue(p, 'cr').toFixed(1)}.`, 1));
      const label = `${def.label} ${+load.toFixed(2)} ${u} ${route}` + (everyH ? (maint !== load ? ` then ${+maint.toFixed(2)} ${u}` : '') + ` q${everyH}h` : ' once');
      return {
        ok: true, label, issues, delay: def.fast ? PYXIS : PHARM, who: 'nurse',
        run: () => {
          sim.giveAbx(p, def.drug, load, def.intervalH);
          if (everyH) sim.scheduleMed(p, { drug: def.drug, amt: maint, route, everyH, abx: true, abxIntervalH: everyH, max: def.maxDoses || 99 });
          if (def.betaLactam && pcn === 'anaphylaxis' && p.T.rng.chance(def.drug === 'cefazolin' ? 0.08 : 0.6)) sim.harm(p, 'anaphylaxis', def.label);
          else if (def.betaLactam && pcn === 'rash' && def.drug !== 'cefazolin' && p.T.rng.chance(0.5)) sim.nurseSays(p, `She's breaking out in hives after the ${def.label}.`, 2);
        },
      };
    },
  };
}

export const HANDLERS = {
  oxytocin: {
    prepare(o, p, sim) {
      const pit = p.meds.pit;
      const unitsQ = o.qty.find(q => q.unit === 'units');
      const isPP = delivered(p) || unitsQ || o.route === 'IM' || /\bin (500|1000|1 ?l|a liter)/.test(o.text);
      if (isPP) {
        const issues = [];
        if (!delivered(p)) {
          issues.push(nurse(`She hasn't delivered! ${unitsQ ? unitsQ.value + ' units' : 'A postpartum dose'} of pit now would clamp her uterus down.`, 3));
          issues.push(pharm(`Oxytocin ${unitsQ ? unitsQ.value + ' units' : ''} ${o.route || ''} is a postpartum dose; patient is undelivered.`));
        }
        if (o.stop) return { ok: true, label: 'Stop postpartum oxytocin', issues: [], delay: NURSE_TASK, who: 'nurse', run: () => { p.meds.ppOxy = false; } };
        const im = o.route === 'IM';
        const u = unitsQ ? unitsQ.value : im ? 10 : 30;
        if (u > 80) issues.push(pharm(`Oxytocin ${u} units exceeds the usual postpartum dose.`, u > 100));
        return {
          ok: true, label: im ? `Oxytocin ${u} units IM` : `Oxytocin ${u} units in 500–1000 mL IV, run in`, issues, delay: [1, 3], who: 'nurse',
          run: () => {
            if (im || !delivered(p)) sim.addDose(p, { drug: 'oxytocin_im', amt: u, route: im ? 'IM' : 'IV', pp: delivered(p) });
            if (!im && delivered(p)) { p.meds.ppOxy = true; sim.addDose(p, { drug: 'oxytocin_im', amt: Math.min(10, u / 3), route: 'IV', pp: true }); }
            if (!delivered(p)) sim.harm(p, 'oxytocin_bolus');
          },
        };
      }
      let newRate = null, protocol = null, label;
      const n = num(o);
      if (o.stop) { newRate = 0; label = 'Pit OFF'; }
      else if (o.protocol || (!o.qty.length && !o.up && !o.down && !o.half)) {
        const high = o.highDose;
        protocol = high ? { start: 6, inc: 6, intervalMin: 30, max: 40 } : { start: 2, inc: 2, intervalMin: 30, max: 20 };
        const nums = o.qty.map(q => q.value);
        if (nums[0] != null) protocol.start = nums[0];
        if (nums[1] != null) protocol.inc = nums[1];
        if (o.freq && o.freq.everyH) protocol.intervalMin = Math.round(o.freq.everyH * 60);
        const mx = /max(?:imum)?\s*(?:of\s*)?(\d+)/.exec(o.text); if (mx) protocol.max = +mx[1];
        newRate = pit.rate > 0 ? pit.rate : protocol.start;
        label = `Pit per ${high ? 'high' : 'low'}-dose protocol: start ${protocol.start}, ↑${protocol.inc} q${protocol.intervalMin} min, max ${protocol.max} mU/min`;
      } else if (o.half) { newRate = Math.round(pit.rate / 2 * 2) / 2; label = `Pit ↓ to ${newRate} mU/min (half)`; }
      else if (o.up) { newRate = o.toAbs && n != null ? n : pit.rate + (n ?? 2); label = `Pit ↑ to ${newRate} mU/min`; }
      else if (o.down) { newRate = o.toAbs && n != null ? n : Math.max(0, pit.rate - (n ?? 2)); label = `Pit ↓ to ${newRate} mU/min`; }
      else { newRate = n; label = `Pit ${newRate} mU/min`; }
      const issues = [];
      if (newRate > 40) issues.push(pharm(`Oxytocin ${newRate} mU/min exceeds the maximum infusion rate.`, true));
      else if (newRate > 20 && !(protocol && o.highDose)) issues.push(pharm(`Oxytocin ${newRate} mU/min is above our low-dose protocol max (20 mU/min).`));
      const increasing = newRate > pit.rate;
      if (increasing) {
        const lastMiso = sim.lastDose(p, 'misoprostol');
        if (lastMiso && sim.t - lastMiso.t < 4 * 3600) issues.push(nurse(`She got miso at ${fmtTime(sim, lastMiso.t)} — that's under 4 hours. Protocol says wait before pit.`, 2));
        if (p.meds.cervidil.in) issues.push(nurse(`Cervidil is still in. Pull it 30 min before pit?`, 2));
        else if (p.meds.cervidil.outT > 0 && sim.t - p.meds.cervidil.outT < 1800) issues.push(nurse(`Cervidil only came out ${Math.round((sim.t - p.meds.cervidil.outT) / 60)} min ago.`, 1));
        const c10 = ctxPer10(p);
        if (c10 != null && c10 > 5) issues.push(nurse(`She's already contracting ${c10.toFixed(0)} in 10 minutes.`, 2));
        const rd = p.read;
        if (rd && rd.decels && rd.decels.filter(d => d.kind === 'late' || d.kind === 'prolonged').length >= 2) issues.push(nurse(`I've been seeing decels that look late to me — I'm not comfortable turning her up.`, 2));
        if (p.priorCS && o.highDose) issues.push(nurse(`High-dose pit on a TOLAC?`, 2));
        if (p.dx.previa && p.known.previa) issues.push(nurse(`She has a previa.`, 3));
      }
      return {
        ok: true, label, issues, delay: [1, 3], who: 'nurse',
        run: () => {
          if (protocol) p.meds.pit.protocol = protocol;
          if (newRate === 0) p.meds.pit.protocol = null;
          else if (!protocol && (o.up || o.down || o.half || n != null)) { /* manual rate keeps protocol if any */ }
          sim.setPit(p, newRate, 'order');
        },
      };
    },
  },

  misoprostol: {
    prepare(o, p, sim) {
      if (o.stop) return { ok: true, label: 'Discontinue misoprostol', issues: [], delay: NURSE_TASK, who: 'nurse', run: () => sim.stopScheduled(p, 'misoprostol') };
      const q = o.qty[0];
      let mcg = q ? toMcg(q) : (delivered(p) ? 800 : 25);
      const pp = delivered(p);
      let route = o.route || (pp ? 'PR' : 'PV');
      if (route === 'SL') route = 'BUCCAL';
      const everyH = o.freq && o.freq.everyH ? o.freq.everyH : (!pp ? (route === 'PO' ? 2 : 4) : null);
      const issues = [];
      if (pp) {
        if (mcg > 1000) issues.push(pharm(`Misoprostol ${mcg} mcg exceeds 1000 mcg.`, mcg > 1200));
        if (mcg < 400) issues.push(pharm(`Misoprostol ${mcg} mcg is low for hemorrhage (600–1000 mcg).`));
      } else {
        if (mcg > 200) issues.push(pharm(`Misoprostol ${mcg} mcg in an UNDELIVERED patient? Ripening dose is 25–50 mcg.`, true));
        else if (mcg > 50) { issues.push(pharm(`Misoprostol ${mcg} mcg exceeds ripening dose (25 mcg PV q4h or 25–50 mcg PO).`)); issues.push(nurse(`${mcg} mcg of miso? That's a hemorrhage dose.`, 3)); }
        if (p.priorCS) { issues.push(nurse(`She's a TOLAC — we don't give prostaglandins with a uterine scar.`, 3)); issues.push(pharm(`Misoprostol with prior cesarean: contraindicated for cervical ripening (ACOG PB 205).`)); }
        if (p.meds.pit.rate > 0) issues.push(nurse(`She's on pit right now.`, 2));
        const last = sim.lastDose(p, 'misoprostol');
        if (last && sim.t - last.t < (last.route === 'PO' ? 2 : 3.5) * 3600) issues.push(nurse(`Last miso was ${Math.round((sim.t - last.t) / 60)} min ago.`, 2));
        const c10 = ctxPer10(p);
        if (c10 != null && c10 >= 3.5) issues.push(nurse(`She's contracting ${c10.toFixed(0)} in 10 — normally we'd hold.`, 2));
        if (p.known.previa) issues.push(nurse(`She has a previa.`, 3));
      }
      return {
        ok: true, label: `Misoprostol ${mcg} mcg ${route}` + (everyH ? ` q${everyH}h (hold for ≥3 ctx/10 min or active labor)` : ''), issues, delay: PYXIS, who: 'nurse',
        run: () => {
          sim.addDose(p, { drug: 'misoprostol', amt: mcg, route, pp });
          if (!pp) p.T.everMiso = p.T.everMiso || p.priorCS > 0;
          if (!pp && everyH) sim.scheduleMed(p, { drug: 'misoprostol', amt: mcg, route, everyH, max: 6, hold: 'ripening' });
        },
      };
    },
  },

  cervidil: {
    prepare(o, p, sim) {
      const cv = p.meds.cervidil;
      if (o.stop) {
        if (!cv.in) return { ok: false, err: 'There is no Cervidil in.' };
        return { ok: true, label: 'Remove Cervidil', issues: [], delay: NURSE_TASK, who: 'nurse', run: () => sim.removeCervidil(p, 'order') };
      }
      const issues = [];
      if (cv.in) return { ok: false, err: 'Cervidil is already in.' };
      if (delivered(p)) return { ok: false, err: 'She has delivered.' };
      if (p.priorCS) { issues.push(nurse(`Prostaglandins in a TOLAC?`, 3)); issues.push(pharm(`Dinoprostone with prior cesarean: avoid (ACOG PB 205).`)); }
      if (p.meds.pit.rate > 0) issues.push(nurse(`She's on pit.`, 2));
      const c10 = ctxPer10(p); if (c10 != null && c10 >= 3.5) issues.push(nurse(`She's contracting ${c10.toFixed(0)} in 10.`, 2));
      const lm = sim.lastDose(p, 'misoprostol'); if (lm && sim.t - lm.t < 4 * 3600) issues.push(nurse(`She had miso ${Math.round((sim.t - lm.t) / 60)} min ago.`, 2));
      return { ok: true, label: 'Dinoprostone 10 mg vaginal insert (Cervidil), remove at 12 h', issues, delay: PYXIS, who: 'nurse', run: () => sim.placeCervidil(p) };
    },
  },

  foley: {
    prepare(o, p, sim) {
      if (o.stop) {
        if (!p.meds.foley.in) return { ok: false, err: 'No Foley bulb in.' };
        return { ok: true, label: 'Remove cervical Foley', issues: [], delay: NURSE_TASK, who: 'nurse', run: () => { p.meds.foley.in = false; sim.note(p, 'Foley bulb removed'); } };
      }
      if (p.meds.foley.in) return { ok: false, err: 'Foley bulb is already in.' };
      if (delivered(p)) return { ok: false, err: 'She has delivered.' };
      const issues = [];
      const s = lastSve(sim, p);
      if (s && s.dil >= 4) issues.push(nurse(`She was ${s.dil} cm on the last check — bulb won't do much.`, 1));
      if (p.known.previa) issues.push(nurse(`She has a previa!`, 3));
      return {
        ok: true, label: 'Cervical Foley balloon (you place it, 60 mL)', issues, delay: MD_PROC, who: 'md',
        run: () => {
          if (p.T.dil < 0.8 && p.T.rng.chance(0.5)) { sim.mdSays(p, `Couldn't get the bulb through — she's closed and posterior. Try again after some ripening.`); return; }
          if (p.dx.previa) { sim.harm(p, 'previa_bleed'); }
          p.meds.foley.in = true; p.meds.foley.inT = sim.t;
          p.T.foleyOutAt = Math.max(p.T.dil + 0.6, p.T.rng.range(3, 4.2));
          sim.note(p, 'Foley bulb placed');
        },
      };
    },
  },

  magnesium: {
    prepare(o, p, sim) {
      const mg = p.meds.mag;
      if (o.stop) return { ok: true, label: 'Magnesium OFF', issues: [], delay: NURSE_TASK, who: 'nurse', run: () => sim.stopMag(p) };
      const gq = o.qty.filter(q => q.unit === 'g' || q.unit == null || q.unit === 'mg');
      let load = null, rate = null;
      for (const q of gq) {
        const g = q.unit === 'mg' ? q.value / 1000 : q.value;
        if (q.per === 'h') rate = g;
        else if (load == null && (o.load || o.then || g >= 4) && rate == null) load = g;
        else if (rate == null) rate = g;
      }
      if (load == null && rate == null) { load = 4; rate = 2; }
      if (load != null && rate == null && o.then) rate = 2;
      const issues = [];
      if (load != null) {
        if (load > 8) issues.push(pharm(`Magnesium ${load} g bolus is a dangerous dose (load is 4–6 g). Please clarify.`, true));
        else if (load > 6) issues.push(pharm(`Magnesium load ${load} g exceeds 6 g.`));
      }
      if (rate != null) {
        if (rate > 4) issues.push(pharm(`Magnesium ${rate} g/h exceeds the maximum maintenance rate. Please clarify.`, true));
        else if (rate > 3) issues.push(pharm(`Magnesium ${rate} g/h is above the usual 1–2 g/h (up to 3 with high BMI).`));
      }
      const cr = sim.labValue(p, 'cr');
      if (cr != null && cr >= 1.1 && rate >= 2) issues.push(nurse(`Her creatinine came back ${cr.toFixed(1)} — still ${rate} g/h?`, 2));
      if (!hasHTN(p) && gaW(p) >= 32 && !p.chart.problems.includes('preE')) issues.push(nurse(`What's the mag for? She's not pre-e and she's past 32 weeks.`, 1));
      if (mg.on && load != null) issues.push(nurse(`She's already on mag — another bolus?`, 2));
      const label = [load != null ? `Mg sulfate ${load} g IV over 20 min` : null, rate != null ? `${rate} g/h maintenance` : null].filter(Boolean).join(', then ');
      return { ok: true, label, issues, delay: [4, 10], who: 'nurse', run: () => sim.startMag(p, load, rate) };
    },
  },

  labetalol: bolusDrug({
    drug: 'labetalol', label: 'Labetalol', unit: 'mg', routes: ['IV', 'PO'], defRoute: 'IV', typical: [20, 80], softMax: 80, hardMax: 120, default: 20, minIntervalMin: 10,
    routeLimits: { PO: { typical: [100, 800], softMax: 800, hardMax: 1200 } },
    extraIssues(p, sim, amt, route) {
      const out = [];
      if (knownAsthma(p)) out.push(nurse(`She has asthma — labetalol?`, 2));
      const v = sim.lastVitals(p);
      if (v && v.hr < 60) out.push(nurse(`Her heart rate is ${v.hr}.`, 2));
      if (v && v.sbp < 140 && v.dbp < 90) out.push(nurse(`Her last BP was ${v.sbp}/${v.dbp}.`, 2));
      const cum = sim.cumulativeDose(p, 'labetalol', 24, 'IV');
      if (route === 'IV' && cum + amt > 300) out.push(pharm(`Cumulative IV labetalol would exceed 300 mg.`));
      return out;
    },
    onRun(p, sim) { if (p.asthma && p.T.rng.chance(0.35)) sim.harm(p, 'bronchospasm_mild'); },
  }),
  hydralazine: bolusDrug({
    drug: 'hydralazine', label: 'Hydralazine', unit: 'mg', routes: ['IV', 'IM'], defRoute: 'IV', typical: [5, 10], softMax: 10, hardMax: 20, default: 5, minIntervalMin: 20,
    extraIssues(p, sim) {
      const out = []; const v = sim.lastVitals(p);
      if (v && v.sbp < 140 && v.dbp < 90) out.push(nurse(`Her last BP was ${v.sbp}/${v.dbp}.`, 2));
      if (sim.cumulativeDose(p, 'hydralazine', 6) >= 30) out.push(pharm(`Cumulative hydralazine ≥30 mg — consider another agent.`));
      return out;
    },
  }),
  nifedipine: bolusDrug({
    drug: 'nifedipine', label: 'Nifedipine IR', unit: 'mg', routes: ['PO'], softRoutes: ['SL'], defRoute: 'PO', typical: [10, 20], softMax: 20, hardMax: 30, default: 10, minIntervalMin: 20,
    extraIssues(p, sim, amt, route) {
      const out = [];
      if (route === 'SL') out.push(nurse(`Sublingual? I've seen that drop people like a rock.`, 2));
      const v = sim.lastVitals(p); if (v && v.sbp < 140 && v.dbp < 90) out.push(nurse(`Her last BP was ${v.sbp}/${v.dbp}.`, 2));
      return out;
    },
  }),
  terbutaline: bolusDrug({
    drug: 'terbutaline', label: 'Terbutaline', unit: 'mg', routes: ['SQ', 'IV'], defRoute: 'SQ', typical: [0.25, 0.25], softMax: 0.25, hardMax: 0.5, default: 0.25, minIntervalMin: 20,
    extraIssues(p, sim) {
      const out = []; const v = sim.lastVitals(p);
      if (v && v.hr >= 120) out.push(nurse(`Her heart rate is already ${v.hr}.`, 2));
      if (delivered(p)) out.push(nurse(`She's delivered — terb for what?`, 2));
      return out;
    },
  }),
  penicillin: abxDrug({ drug: 'penicillin', label: 'Penicillin G', loadDefault: 5, maintDefault: 2.5, intervalH: 4, minIntervalH: 3.5, max: 5, hardMax: 10, gbs: true, betaLactam: true }),
  ampicillin: abxDrug({ drug: 'ampicillin', label: 'Ampicillin', loadDefault: 2000, maintDefault: 1000, intervalH: 4, minIntervalH: 3.5, max: 2000, hardMax: 3000, gbs: true, betaLactam: true, gramsIfSmall: true }),
  cefazolin: abxDrug({ drug: 'cefazolin', label: 'Cefazolin', loadDefault: 2000, maintDefault: 1000, intervalH: 8, minIntervalH: 6, max: 3000, hardMax: 4000, gbs: true, betaLactam: true, gramsIfSmall: true }),
  clindamycin: abxDrug({ drug: 'clindamycin', label: 'Clindamycin', loadDefault: 900, maintDefault: 900, intervalH: 8, minIntervalH: 6, max: 900, hardMax: 1200, gbs: true }),
  vancomycin: abxDrug({ drug: 'vancomycin', label: 'Vancomycin', loadDefault: 1500, maintDefault: 1500, intervalH: 8, minIntervalH: 8, max: 2000, hardMax: 3000, gbs: true, renal: true, gramsIfSmall: true }),
  gentamicin: abxDrug({ drug: 'gentamicin', label: 'Gentamicin', loadDefault: 400, maintDefault: 400, intervalH: 24, minIntervalH: 8, max: 600, hardMax: 900, renal: true }),
  azithromycin: abxDrug({ drug: 'azithromycin', label: 'Azithromycin', loadDefault: 1000, maintDefault: 1000, intervalH: 24, minIntervalH: 24, max: 1000, hardMax: 2000, oral: true, maxDoses: 1, gramsIfSmall: true, fast: true }),

  betamethasone: {
    prepare(o, p, sim) {
      const q = o.qty[0];
      const mg = q ? toMg(q, p) : 12;
      const issues = [];
      if (mg !== 12) issues.push(pharm(`Betamethasone dose is 12 mg IM q24h x2.`, mg > 24));
      if (o.route && o.route !== 'IM') issues.push(pharm(`Betamethasone is given IM.`));
      if (gaW(p) >= 37) issues.push(pharm(`Antenatal steroids are not indicated at ${Math.floor(gaW(p))} weeks.`));
      else if (gaW(p) >= 34) issues.push(nurse(`She's late preterm — does she meet ALPS criteria? Sugars${p.dx.gdm ? ' (she has GDM)' : ''}?`, 1));
      if ((p.flags.steroidDoses || 0) >= 2) issues.push(pharm(`She has completed a course of betamethasone.`));
      return {
        ok: true, label: 'Betamethasone 12 mg IM q24h x2', issues, delay: PHARM, who: 'nurse',
        run: () => {
          sim.addDose(p, { drug: 'betamethasone', amt: 12, route: 'IM' });
          p.flags.steroidDoses = (p.flags.steroidDoses || 0) + 1; p.flags.steroidT = p.flags.steroidT ?? sim.t;
          if (p.flags.steroidDoses < 2) sim.scheduleMed(p, { drug: 'betamethasone', amt: 12, route: 'IM', everyH: 24, max: 1, onGive: () => { p.flags.steroidDoses++; } });
        },
      };
    },
  },
  fentanyl: bolusDrug({
    drug: 'fentanyl', label: 'Fentanyl', unit: 'mcg', routes: ['IV'], defRoute: 'IV', typical: [50, 100], softMax: 100, hardMax: 250, default: 100, minIntervalMin: 60,
    extraIssues(p, sim) { return opioidIssues(p, sim); },
  }),
  nalbuphine: bolusDrug({
    drug: 'nalbuphine', label: 'Nalbuphine', unit: 'mg', routes: ['IV', 'IM'], defRoute: 'IV', typical: [5, 10], softMax: 20, hardMax: 30, default: 10, minIntervalMin: 120,
    extraIssues(p, sim) { return opioidIssues(p, sim); },
  }),
  acetaminophen: bolusDrug({
    drug: 'acetaminophen', label: 'Acetaminophen', unit: 'mg', routes: ['PO', 'IV', 'PR'], defRoute: 'PO', typical: [650, 1000], softMax: 1000, hardMax: 1300, default: 1000, minIntervalMin: 240, gramsIfSmall: true,
    extraIssues(p, sim, amt) { return sim.cumulativeDose(p, 'acetaminophen', 24) + amt > 4000 ? [pharm('Exceeds 4 g acetaminophen per 24 h.', true)] : []; },
  }),
  txa: bolusDrug({
    drug: 'txa', label: 'Tranexamic acid', unit: 'mg', routes: ['IV'], defRoute: 'IV', typical: [1000, 1000], softMax: 1000, hardMax: 2000, default: 1000, minIntervalMin: 30, gramsIfSmall: true,
    extraIssues(p, sim) {
      const out = [];
      if (!delivered(p)) out.push(nurse(`She hasn't delivered — TXA now?`, 2));
      if (sim.cumulativeDose(p, 'txa', 24) >= 2000) out.push(pharm('Maximum 2 doses of TXA.', true));
      if (delivered(p) && sim.t - p.T.pp.t0 > 3 * 3600) out.push(pharm('TXA benefit is within 3 h of birth (WOMAN trial).'));
      return out;
    },
  }),
  methergine: bolusDrug({
    drug: 'methergine', label: 'Methylergonovine', unit: 'mg', routes: ['IM'], softRoutes: ['IV'], defRoute: 'IM', typical: [0.2, 0.2], softMax: 0.2, hardMax: 0.4, default: 0.2, minIntervalMin: 120,
    extraIssues(p, sim) {
      const out = [];
      if (hasHTN(p)) { out.push(pharm(`Methylergonovine is CONTRAINDICATED in hypertension/preeclampsia.`)); out.push(nurse(`She's hypertensive — no Methergine!`, 3)); }
      if (!delivered(p)) { out.push(nurse(`She hasn't delivered!`, 3)); out.push(pharm(`Uterotonic in an undelivered patient.`, true)); }
      return out;
    },
    onRun(p, sim) { if (hasHTN(p) || p.dx.preE !== 'none') sim.harm(p, 'methergine_htn'); },
  }),
  hemabate: bolusDrug({
    drug: 'hemabate', label: 'Carboprost', unit: 'mcg', routes: ['IM'], softRoutes: [], defRoute: 'IM', typical: [250, 250], softMax: 250, hardMax: 500, default: 250, minIntervalMin: 15,
    extraIssues(p, sim) {
      const out = [];
      if (knownAsthma(p)) { out.push(pharm(`Carboprost is contraindicated in asthma.`)); out.push(nurse(`She's asthmatic — Hemabate will close her airway.`, 3)); }
      if (!delivered(p)) { out.push(nurse(`She hasn't delivered!`, 3)); out.push(pharm(`Uterotonic in an undelivered patient.`, true)); }
      if (sim.countDoses(p, 'hemabate') >= 8) out.push(pharm(`Maximum 8 doses (2 mg) of carboprost.`, true));
      return out;
    },
    onRun(p, sim) { if (p.asthma) sim.harm(p, 'bronchospasm'); },
  }),
  calcium: bolusDrug({ drug: 'calcium', label: 'Calcium gluconate', unit: 'mg', routes: ['IV'], defRoute: 'IV', typical: [1000, 1000], softMax: 3000, hardMax: 6000, default: 1000, gramsIfSmall: true,
    extraIssues(p) { return p.meds.mag.on || p.T.mg > 4 ? [] : [nurse(`She's not on mag — calcium for what?`, 1)]; } }),
  phenylephrine: bolusDrug({ drug: 'phenylephrine', label: 'Phenylephrine', unit: 'mcg', routes: ['IV'], defRoute: 'IV', typical: [50, 200], softMax: 200, hardMax: 1000, default: 100 }),
  ephedrine: bolusDrug({ drug: 'ephedrine', label: 'Ephedrine', unit: 'mg', routes: ['IV'], defRoute: 'IV', typical: [5, 10], softMax: 25, hardMax: 50, default: 10 }),
  epinephrine: bolusDrug({ drug: 'epinephrine', label: 'Epinephrine', unit: 'mg', routes: ['IM', 'IV'], defRoute: 'IM', typical: [0.3, 0.5], softMax: 0.5, hardMax: 1, default: 0.3,
    extraIssues(p, sim, amt, route) { return route === 'IV' && amt >= 0.3 ? [pharm('Epinephrine IV bolus ≥0.3 mg outside of a code — did you mean IM?')] : []; } }),
  albuterol: bolusDrug({ drug: 'albuterol', label: 'Albuterol neb', unit: 'mg', routes: ['NEB'], softRoutes: ['PO', 'IV'], defRoute: 'NEB', typical: [2.5, 5], softMax: 5, hardMax: 10, default: 2.5,
    onRun(p) { p.T.bronch = Math.max(0, p.T.bronch - 0.5); } }),
  fluids: {
    prepare(o, p, sim) {
      const q = o.qty[0];
      let ml = q ? (q.unit === 'L' ? q.value * 1000 : q.value <= 3 && !q.unit ? q.value * 1000 : q.value) : 500;
      const issues = [];
      if (ml > 2000) issues.push(pharm(`${ml} mL bolus? Usual 500–1000 mL.`, ml > 4000));
      if (p.known.preE === 'severe' && sim.recentFluid(p, 6) + ml > 1500) issues.push(nurse(`She's severe pre-e — we've given ${sim.recentFluid(p, 6)} mL already. Careful with her lungs.`, 2));
      return { ok: true, label: `LR ${ml} mL IV bolus`, issues, delay: [1, 3], who: 'nurse', run: () => sim.giveFluid(p, ml) };
    },
  },

  // ---------------- actions
  sve: {
    prepare(o, p, sim) {
      if (delivered(p)) return { ok: false, err: 'She has delivered.' };
      const issues = [];
      if (p.known.previa) issues.push(nurse(`She has a previa — no digital exams!`, 3));
      const s = lastSve(sim, p);
      if (s && sim.t - s.t < 20 * 60) issues.push(nurse(`I checked her ${Math.round((sim.t - s.t) / 60)} minutes ago.`, 1));
      if (p.T.rom && p.chart.sves.filter(x => x.t > p.T.romT).length >= 6) issues.push(nurse(`That's a lot of checks since her water broke.`, 1));
      return { ok: true, label: 'Nurse SVE', issues, delay: [2, 8], who: 'nurse', run: () => sim.doSVE(p, 'nurse', 'ordered') };
    },
  },
  arom: {
    prepare(o, p, sim) {
      if (delivered(p)) return { ok: false, err: 'She has delivered.' };
      if (p.chart.romKnown) return { ok: false, err: 'Membranes are already ruptured.' };
      const issues = [];
      const s = lastSve(sim, p);
      if (s && s.sta <= -3) issues.push(nurse(`Head was ${s.sta} on my last check — still ballotable. Cord prolapse risk.`, 2));
      if (p.known.previa) issues.push(nurse(`Previa!`, 3));
      if (p.dx.breech && p.known.breech) issues.push(nurse(`She's breech.`, 3));
      return {
        ok: true, label: 'AROM (you)', issues, delay: MD_PROC, who: 'md',
        run: () => {
          if (p.T.rom) { p.chart.romKnown = true; sim.mdSays(p, `No forebag — she's already ruptured. ${p.T.fluid === 'mec' ? 'Meconium-stained fluid.' : 'Clear fluid on the pad.'}`); return; }
          if (p.T.dil < 1.2) { sim.mdSays(p, `Can't reach the membranes — she's closed. AROM not done.`); return; }
          p.flags.lastAromT = sim.t;
          doROM(p, sim, true);
          p.chart.romKnown = true;
          sim.mdSays(p, `AROM done — ${p.T.fluid === 'mec' ? 'thick meconium' : p.T.fluid === 'bloody' ? 'bloody fluid' : 'clear fluid'}.`);
          sim.note(p, 'AROM ' + (p.T.fluid === 'mec' ? 'MSF' : p.T.fluid === 'bloody' ? 'bloody' : 'clear'));
        },
      };
    },
  },
  iupc: {
    prepare(o, p, sim) {
      if (o.stop) return { ok: true, label: 'Remove IUPC', issues: [], delay: NURSE_TASK, who: 'nurse', run: () => { p.devices.iupc = false; p.devices.amnioinf = false; } };
      if (p.devices.iupc) return { ok: false, err: 'IUPC already in.' };
      if (delivered(p)) return { ok: false, err: 'She has delivered.' };
      const issues = [];
      if (p.known.previa) issues.push(nurse(`Previa.`, 3));
      return { ok: true, label: 'Place IUPC', issues, delay: [3, 8], who: 'nurse', run: () => {
        if (!p.T.rom) { sim.nurseSays(p, `Membranes are intact — I can't place an IUPC.`, 1); return; }
        p.devices.iupc = true; sim.note(p, 'IUPC placed'); sim.nurseSays(p, `IUPC is in and zeroed.`, 0);
      } };
    },
  },
  fse: {
    prepare(o, p, sim) {
      if (o.stop) return { ok: true, label: 'Remove FSE', issues: [], delay: NURSE_TASK, who: 'nurse', run: () => { p.devices.fse = false; } };
      if (p.devices.fse) return { ok: false, err: 'FSE already on.' };
      if (delivered(p)) return { ok: false, err: 'She has delivered.' };
      const issues = [];
      if (p.known.breech) issues.push(nurse(`She's breech.`, 2));
      return { ok: true, label: 'Place fetal scalp electrode', issues, delay: [3, 8], who: 'nurse', run: () => {
        if (!p.T.rom) { sim.nurseSays(p, `Her membranes are intact — can't place a scalp lead.`, 1); return; }
        if (p.T.dil < 2) { sim.nurseSays(p, `She's not dilated enough to get the FSE on.`, 1); return; }
        if (p.dx.breech) { sim.nurseSays(p, `Um — that didn't feel like a head. I think she's breech.`, 2); p.known.breechSuspected = true; return; }
        p.devices.fse = true; sim.note(p, 'FSE placed'); sim.nurseSays(p, `Scalp lead is on.`, 0);
      } };
    },
  },
  amnioinfusion: {
    prepare(o, p, sim) {
      if (o.stop) return { ok: true, label: 'Stop amnioinfusion', issues: [], delay: NURSE_TASK, who: 'nurse', run: () => { p.devices.amnioinf = false; } };
      if (!p.devices.iupc) return { ok: false, err: 'Needs an IUPC first.' };
      return { ok: true, label: 'Amnioinfusion NS 250 mL bolus then 120 mL/h', issues: [], delay: [3, 6], who: 'nurse', run: () => { p.devices.amnioinf = true; p.devices.amnioinfT = sim.t; sim.note(p, 'Amnioinfusion'); } };
    },
  },
  reposition: {
    prepare(o, p, sim) {
      return { ok: true, label: 'Position change', issues: [], delay: [1, 3], who: 'nurse', run: () => sim.reposition(p) };
    },
  },
  o2: {
    prepare(o, p, sim) {
      return { ok: true, label: o.stop ? 'O2 off' : 'O2 10 L non-rebreather', issues: [], delay: [1, 2], who: 'nurse', run: () => { p.meds.o2 = !o.stop; sim.note(p, o.stop ? 'O2 off' : 'O2 on'); } };
    },
  },
  epidural: {
    prepare(o, p, sim) {
      if (o.stop) return { ok: false, err: 'Ask anesthesia directly to pull it — not supported.' };
      if (p.epidural.state !== 'none') return { ok: false, err: `Epidural is already ${p.epidural.state}.` };
      if (delivered(p)) return { ok: false, err: 'She has delivered.' };
      return { ok: true, label: 'Anesthesia: labor epidural', issues: [], delay: [0, 0], who: 'anesthesia', run: () => sim.requestEpidural(p) };
    },
  },
  push: {
    prepare(o, p, sim) {
      if (!p.T.complete && !(lastSve(sim, p) && lastSve(sim, p).dil >= 10)) {
        const s = lastSve(sim, p);
        return { ok: true, label: 'Start pushing', issues: [nurse(`She isn't complete — last check was ${s ? s.dil + ' cm' : 'a while ago'}.`, 3)], delay: [1, 2], who: 'nurse', run: () => sim.startPushing(p) };
      }
      return { ok: true, label: 'Start pushing', issues: [], delay: [1, 3], who: 'nurse', run: () => sim.startPushing(p) };
    },
  },
  labordown: { prepare(o, p, sim) { return { ok: true, label: 'Labor down (passive descent)', issues: [], delay: [1, 2], who: 'nurse', run: () => { p.pushing = 'labor_down'; sim.note(p, 'Laboring down'); } }; } },
  stoppush: { prepare(o, p, sim) { return { ok: true, label: 'Stop pushing', issues: [], delay: [1, 2], who: 'nurse', run: () => { p.pushing = p.T.complete ? 'labor_down' : 'no'; sim.note(p, 'Stopped pushing'); } }; } },
  cs: {
    prepare(o, p, sim) {
      if (delivered(p)) return { ok: false, err: 'She has delivered.' };
      if (p.csRequest) return { ok: false, err: `Cesarean already booked (${p.csRequest.urgency}).` };
      const urgency = o.urgency || (o.indication === 'repeat' || o.indication === 'request' || o.indication === 'malpres' ? 'routine' : 'urgent');
      const ind = o.indication || 'other';
      return { ok: true, label: `Cesarean — ${urgency.toUpperCase()} (${ind})`, issues: [], delay: [0, 0], who: 'md', run: () => sim.requestCS(p, urgency, ind) };
    },
  },
  vacuum: {
    prepare(o, p, sim) {
      if (delivered(p)) return { ok: false, err: 'She has delivered.' };
      return { ok: true, label: 'Operative vaginal delivery (vacuum)', issues: [], delay: [2, 5], who: 'md', run: () => sim.vacuum(p) };
    },
  },
  us: { prepare(o, p, sim) { return { ok: true, label: 'Bedside ultrasound (you)', issues: [], delay: [3, 6], who: 'md', run: () => sim.bedsideUS(p) }; } },
  vitals: { prepare(o, p, sim) { return { ok: true, label: 'Vitals now', issues: [], delay: [1, 4], who: 'nurse', run: () => sim.takeVitals(p, true) }; } },
  nst: { prepare(o, p, sim) { return { ok: true, label: o.stop ? 'Off monitor' : 'Continuous EFM / NST', issues: [], delay: [1, 3], who: 'nurse', run: () => { p.mon.on = !o.stop; sim.note(p, o.stop ? 'Off monitor' : 'On monitor'); } }; } },
  romtest: { prepare(o, p, sim) { return { ok: true, label: 'Sterile speculum exam + ROM test', issues: [], delay: [5, 12], who: 'nurse', run: () => sim.romTest(p) }; } },
  admit: {
    prepare(o, p, sim) {
      if (p.area !== 'triage' && p.area !== 'waiting') return { ok: false, err: 'She is not in triage.' };
      return { ok: true, label: 'Admit to L&D', issues: [], delay: [0, 0], who: 'md', run: () => sim.admit(p) };
    },
  },
  discharge: {
    prepare(o, p, sim) {
      if (p.area !== 'triage') return { ok: false, err: 'Only triage patients can be discharged from here.' };
      const issues = [];
      const s = lastSve(sim, p);
      if (s && s.dil >= 5) issues.push(nurse(`She's ${s.dil} cm — you want to send her home?`, 2));
      const v = sim.lastVitals(p);
      if (v && (v.sbp >= 160 || v.dbp >= 110)) issues.push(nurse(`Her BP was ${v.sbp}/${v.dbp}!`, 3));
      if (p.chart.romResult === 'positive') issues.push(nurse(`Her ROM test was positive.`, 2));
      return { ok: true, label: 'Discharge home with labor precautions', issues, delay: [0, 0], who: 'md', run: () => sim.discharge(p) };
    },
  },
  observe: { prepare(o, p, sim) { return { ok: true, label: 'Walk 2 h, recheck', issues: [], delay: [0, 0], who: 'nurse', run: () => sim.observe(p) }; } },
  vas: { prepare(o, p, sim) { return { ok: true, label: 'Vibroacoustic / scalp stimulation', issues: [], delay: [1, 3], who: 'nurse', run: () => { p.T.vasT = sim.t + 1; sim.note(p, 'VAS'); } }; } },
  massage: {
    prepare(o, p, sim) {
      if (!delivered(p)) return { ok: false, err: 'She has not delivered.' };
      return { ok: true, label: 'Fundal massage', issues: [], delay: [0, 1], who: 'nurse', run: () => { p.T.pp.massage = sim.t; sim.note(p, 'Fundal massage'); } };
    },
  },
  bakri: {
    prepare(o, p, sim) {
      if (!delivered(p)) return { ok: false, err: 'She has not delivered.' };
      if (p.T.pp.mode === 'cs') return { ok: false, err: 'After a cesarean this would be done in the OR — order "return to OR".' };
      return { ok: true, label: 'Intrauterine balloon tamponade (you)', issues: [], delay: [5, 10], who: 'md', run: () => { p.T.pp.bakri = true; sim.note(p, 'Bakri placed'); } };
    },
  },
  transfuse: {
    prepare(o, p, sim) {
      const n = clamp(o.units || 2, 1, 10);
      const issues = [];
      if (!p.chart.labs.some(l => l.key === 'ts' && l.resultT <= sim.t)) issues.push(nurse(`No type and screen back — emergency-release O-neg?`, 1));
      return { ok: true, label: `Transfuse ${n} units PRBC`, issues, delay: [10, 20], who: 'nurse', run: () => sim.transfuse(p, n) };
    },
  },
  returnor: {
    prepare(o, p, sim) {
      if (!delivered(p)) return { ok: false, err: 'She has not delivered.' };
      return { ok: true, label: 'Return to OR for hemorrhage', issues: [], delay: [0, 0], who: 'md', run: () => sim.requestCS(p, 'stat', 'pph_or') };
    },
  },
  elevate: {
    prepare(o, p, sim) {
      return { ok: true, label: 'Manual elevation of presenting part', issues: [], delay: [0, 1], who: 'nurse', run: () => {
        if (p.T.prolapse) { p.T.prolapseRelieved = true; sim.nurseSays(p, `I've got my hand up, holding the head off the cord. I'm not letting go.`, 2); }
        else sim.nurseSays(p, `I don't feel any cord.`, 1);
      } };
    },
  },
  labs: { prepare() { return { ok: false, err: 'Which labs? e.g. CBC, PIH labs, UPC, type and screen, fibrinogen, mag level.' }; } },
};
for (const key of ['cbc', 'cmp', 'pih', 'upc', 'ts', 'fib', 'mglevel', 'gbs', 'coag']) {
  HANDLERS[key] = { prepare(o, p, sim) { return { ok: true, label: 'Lab: ' + key.toUpperCase(), issues: [], delay: [2, 5], who: 'nurse', run: () => sim.orderLab(p, key) }; } };
}

function opioidIssues(p, sim) {
  const out = [];
  const s = lastSve(sim, p);
  if (s && s.dil >= 8) out.push(nurse(`She's ${s.dil} cm — baby might come out sleepy.`, 2));
  if (p.epidural.state === 'working') out.push(nurse(`Her epidural is working.`, 1));
  if (delivered(p)) return [];
  return out;
}
