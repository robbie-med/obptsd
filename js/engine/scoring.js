// Scoring & debrief (SPEC §7). Outcomes, NTSV cesarean rate, process metrics, and the hidden
// truth laid next to what you were told.
import { deliveryNTSV } from './patient.js';
import { SD_MOVES, mmss, CRISIS_LABEL } from './emergency.js';

const H = 3600, MIN = 60;

// ACOG/SMFM OCC No.1 (2014): arrest of dilation needs >=6 cm, ROM, and >=4 h adequate ctx or >=6 h
// oxytocin with inadequate ctx and no change. Failed IOL: >=12-18 h of oxytocin after ROM in latent phase.
function csJustified(p, sim) {
  const o = p.outcome; if (!o || o.mode !== 'cs') return null;
  const ind = o.csInd;
  const sves = p.chart.sves.filter(s => s.t <= (p.flags.csDecisionT ?? o.t));
  const last = sves[sves.length - 1];
  const res = { ind, ok: true, why: '' };
  if (ind === 'arrest_dil') {
    if (!last || last.dil < 6) { res.ok = false; res.why = `Arrest of dilation called at ${last ? last.dil : '?'} cm (reported); requires ≥6 cm.`; }
    else {
      const sameSince = sves.filter(s => s.dil >= last.dil).map(s => s.t)[0];
      const hrs = ((p.flags.csDecisionT ?? o.t) - sameSince) / H;
      if (hrs < 4) { res.ok = false; res.why = `Only ${hrs.toFixed(1)} h without change at ${last.dil} cm by report (needs ≥4 h adequate or ≥6 h on pit).`; }
    }
  } else if (ind === 'failed_iol') {
    const pitH = (p.pitExposureSec || 0) / H;
    if (!p.chart.romKnown || pitH < 12) { res.ok = false; res.why = `Failed induction called after ${pitH.toFixed(1)} h of oxytocin${p.chart.romKnown ? '' : ' with intact membranes'} (OCC: ≥12–18 h after ROM).`; }
  } else if (ind === 'arrest_desc') {
    const pushH = p.pushStartT > 0 ? ((p.flags.csDecisionT ?? o.t) - p.pushStartT) / H : 0;
    const need = p.para === 0 ? 3 : 2;
    if (pushH < need) { res.ok = false; res.why = `Arrest of descent after ${pushH.toFixed(1)} h pushing (OCC: ≥${need} h${p.epidural.state === 'working' ? ', longer with epidural' : ''}).`; }
  } else if (ind === 'other' || ind == null) { res.ok = false; res.why = 'No indication documented.'; }
  else if (ind === 'request') { res.ok = true; res.why = 'Maternal request (counts toward NTSV).'; }
  else if (ind === 'cat3') {
    const T = p.T; // judged against the truth: was there fetal compromise?
    if (p.outcome.neo.bd < 6 && !p.flags.prolongedSeen) { res.why = 'Fetal reserve was actually fine (cord BD ' + p.outcome.neo.bd + ') — defensible if the strip looked bad.'; }
  }
  return res;
}

export function computeScore(sim) {
  const rows = [];
  let score = 100;
  const pen = [];
  const add = (p, pts, text) => { score -= pts; pen.push({ pid: p ? p.id : null, name: p ? p.name : 'Floor', pts, text }); };
  let ntsvTotal = 0, ntsvCS = 0;
  const ddi = [];
  for (const p of sim.patients) {
    const T = p.T, o = p.outcome;
    const row = { p, outcome: o, events: [], harms: p.harms || [] };
    if (o) {
      const neo = o.neo;
      if (deliveryNTSV(p) && o.mode !== 'home' && !o.pmcd) { ntsvTotal++; if (o.mode === 'cs') ntsvCS++; }
      if (!neo.liveborn) add(p, 40, 'Stillbirth');
      else {
        if (neo.death) add(p, 35, 'Neonatal death');
        if (neo.hie) add(p, 25, 'HIE / therapeutic hypothermia');
        else if (neo.pH < 7.0) add(p, 15, `Severe acidemia (pH ${neo.pH})`);
        else if (neo.pH < 7.1) add(p, 5, `Acidemia (pH ${neo.pH})`);
        if (neo.sepsis) add(p, 8, 'Early-onset sepsis');
        if (neo.notes.includes('Brachial plexus injury')) add(p, 5, 'Brachial plexus injury');
        if (neo.notes.includes('Humerus fracture')) add(p, 2, 'Humerus fracture');
        if (neo.nicu && p.gaDays >= 245 && !neo.hie && neo.pH >= 7.0) add(p, 3, 'NICU admission');
      }
      if (o.mode === 'home') add(p, 10, 'Unattended delivery after discharge/phone advice');
      if (o.mode === 'cs') {
        const j = csJustified(p, sim);
        row.csJust = j;
        if (j && !j.ok) add(p, 6, 'Cesarean criteria not met: ' + j.why);
        if (o.urgency === 'stat' && p.flags.incisionT != null) {
          const d = (p.flags.incisionT - p.flags.csDecisionT) / MIN;
          ddi.push(d); row.ddi = d;
          if (d > 30) add(p, 5, `Decision-to-incision ${d.toFixed(0)} min for a STAT section`);
        }
        if (p.flags.ga) row.events.push('General anesthesia');
      }
      const pp = T.pp;
      if (pp) {
        if (pp.qbl >= 1000) add(p, 4, `Postpartum hemorrhage (QBL ${Math.round(pp.qbl)} mL)`);
        if (p.flags.transfused) add(p, 6, `Transfused ${p.flags.transfused} u`);
        if (pp.hyst) add(p, 20, 'Hysterectomy');
        if (pp.qbl - pp.transfused > 4000) add(p, 30, 'Hemorrhagic shock');
      }
      if ((p.gbsTrue === 'pos' || p.gbs === 'unknown') && o.mode !== 'cs' && !p.gbsAdequate) add(p, 3, 'GBS prophylaxis inadequate (<4 h before delivery)');
      if (p.flags.iolStartT != null) row.iolToDelivery = (o.t - p.flags.iolStartT) / H;
    }
    // a baby that dies in utero and is never delivered on your shift is still a stillbirth on your shift
    if (!o && T.demise && !(p.crisis && p.crisis.deathT != null)) add(p, 40, `Intrauterine fetal death (${p.area === 'home' ? 'at home' : p.area === 'waiting' ? 'in the waiting room' : 'undelivered'})`);
    if (T.infect > 1) add(p, 4, 'Intraamniotic infection (Triple I)');
    if (T.eclampsiaCount) add(p, 15 * T.eclampsiaCount, `Eclampsia${p.meds.mag.on ? '' : ' (not on magnesium)'}`);
    if (T.stroke) add(p, 30, 'Stroke (sustained severe-range BP)');
    if (T.rupture) add(p, 20, 'Uterine rupture');
    if (T.flagMgResp) add(p, 12, 'Magnesium toxicity with respiratory depression');
    if (T.flagMgArrest) add(p, 30, 'Cardiac arrest from magnesium');
    for (const h of p.harms || []) {
      const pts = { anaphylaxis: 10, bronchospasm: 8, bronchospasm_mild: 3, methergine_htn: 8, oxytocin_bolus: 10, previa_bleed: 10, epidural_hematoma: 25, cardiac_arrest: 0 }[h.kind] ?? 5;
      if (pts) add(p, pts, 'Harm: ' + h.kind.replace(/_/g, ' '));
    }
    if (p.flags.firstSevereT != null) {
      const tt = p.flags.treatedT != null ? (p.flags.treatedT - p.flags.firstSevereT) / MIN : (sim.t - p.flags.firstSevereT) / MIN;
      row.bpTreat = tt;
      if (tt > 60) add(p, 6, `Severe-range BP untreated for ${tt.toFixed(0)} min (ACOG: within 30–60 min)`);
    }
    if (p.gaDays < 238 && o && !p.flags.steroidDoses) add(p, 4, 'Delivered <34 w without antenatal steroids');
    if (p.gaDays < 224 && o && !p.meds.mag.startT) add(p, 3, 'Delivered <32 w without Mg neuroprotection');
    if (p.flags.epiRequestT != null) {
      const w = ((p.flags.epiDoneT ?? sim.t) - p.flags.epiRequestT) / MIN;
      row.epiWait = w;
      if (w > 60 && !p.flags.natural) add(p, 1, `Waited ${w.toFixed(0)} min for an epidural`);
    }
    if (p.bounced) add(p, 6, 'Returned to triage after discharge');
    for (const c of p.flags.chain || []) add(p, 5, `Charge nurse called the backup OB over your head (${c.what})`);
    if (p.area === 'home' && !o && p.phoneAdvice !== 'come in') {
      if (T.laborOnset && T.dil >= 5) add(p, 4, 'Sent home / kept home in active labor');
      if (T.peSev > 0.7) add(p, 5, 'Severe preeclampsia sent home');
      if (T.bd > 10 && !T.demise) add(p, 15, 'Compromised fetus at home');
    }
    if (p.flags.rescheduled) row.events.push('Induction rescheduled');
    const sd = p.sd;
    if (sd && sd.endT != null) {
      const moves = sd.tries.filter(x => x.ok === true || x.ok === false).map(x => `${SD_MOVES[x.key].label}${x.by === 'nurse' ? ' (RN)' : x.by === 'backup' ? ' (backup OB)' : ''} ${x.ok ? '✓' : '✗'}`);
      row.events.push(`Shoulder dystocia: ${sd.zavanelli ? 'Zavanelli → STAT CS' : 'head-to-body ' + mmss(sd.hbdi)} · ${moves.join(', ')}`);
      if (sd.traction >= 2) add(p, 3, 'Repeated traction on the fetal head during shoulder dystocia');
      if (sd.backup) add(p, 4, 'Shoulder dystocia still undelivered when the backup OB walked in');
    }
    const a = p.crisis;
    if (a) {
      const bits = [`${CRISIS_LABEL[a.cause]} ${sim.clock(a.t0)}`];
      if (a.arrestT != null) bits.push(`arrest ${sim.clock(a.arrestT)} (${a.rhythm})`);
      if (a.roscT != null) bits.push(`ROSC after ${mmss(a.roscT - a.arrestT)}`);
      if (a.hystT != null && o && o.pmcd) bits.push(`hysterotomy: baby out ${mmss(o.t - a.arrestT)} into the arrest`);
      if (a.deathT != null) bits.push('maternal death');
      row.events.push(bits.join(' · '));
      // [AHA2015] judged on the response; AFE itself is neither predictable nor preventable (a magnesium
      // arrest is, and costs its own 30 points above)
      if (a.arrestT != null) {
        if (a.undeliveredAtArrest) {
          const end = o ? o.t : (a.roscT ?? a.deathT ?? sim.t);
          const d = (end - a.arrestT) / MIN;
          row.arrestToDelivery = o ? d : null;
          if (!o && a.roscT == null) add(p, 10, 'Never delivered during the maternal arrest (AHA: hysterotomy at 4 min, baby out by 5)');
          else if (o && o.t < (a.roscT ?? Infinity) && d > 5) add(p, Math.min(10, Math.round(d - 5) + 3), `Arrest-to-delivery ${d.toFixed(1)} min (AHA: baby out by 5)`);
          if (!a.lud && !(o && o.t - a.arrestT < 90)) add(p, 3, 'No left uterine displacement during CPR');
        }
        const epiLate = a.firstEpiT == null ? (a.roscT ?? a.deathT ?? sim.t) - a.arrestT > 5 * MIN : a.firstEpiT - a.arrestT > 5 * MIN;
        if (epiLate) add(p, 3, 'No IV epinephrine in the first 5 minutes of the arrest');
        if (a.badShock) add(p, 2, 'Shocked a non-shockable rhythm');
        if (a.cause === 'hem') add(p, 20, 'Cardiac arrest from hemorrhage');
        if (a.cause === 'mag' && (a.firstCaT == null || a.firstCaT - a.arrestT > 5 * MIN)) add(p, 5, 'No calcium gluconate in the first 5 minutes of a magnesium arrest');
      }
      if (a.deathT != null) add(p, 30, a.cause === 'afe' ? 'Maternal death (AFE kills even with perfect care)' : 'Maternal death');
    }
    rows.push(row);
  }
  const ntsvRate = ntsvTotal ? ntsvCS / ntsvTotal : null;
  if (ntsvTotal >= 3 && ntsvRate > 0.236) add(null, Math.min(20, Math.round((ntsvRate - 0.236) * 100 * 0.8)), `NTSV cesarean rate ${(ntsvRate * 100).toFixed(0)}% (Healthy People 2030 target 23.6%)`);
  const delivered = sim.patients.filter(p => p.outcome).length;
  score = Math.max(0, Math.round(score));
  const grade = score >= 92 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';
  return { score, grade, pen, rows, ntsvTotal, ntsvCS, ntsvRate, ddi, delivered };
}

export function ntsvNow(sim) {
  let tot = 0, cs = 0;
  for (const p of sim.patients) if (p.outcome && p.outcome.mode !== 'home' && !p.outcome.pmcd && deliveryNTSV(p)) { tot++; if (p.outcome.mode === 'cs') cs++; }
  return { tot, cs, rate: tot ? cs / tot : null };
}
