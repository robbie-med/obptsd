// The floor (SPEC §3.4, §6, §8). Deterministic: integer 1-s ticks, seeded streams, every player input
// recorded in cmdLog with its tick so a night can be replayed exactly.
import { Rng } from './rng.js';
import { ROOMS, TRIAGE_BAYS, LABS } from './data.js';
import { clamp, fmtClockColon } from './util.js';
import { stepPatient, quietStep, sampleHistory, neonatalOutcome, startPostpartum, abxActive } from './physio.js';
import { analyzeStrip, annotate } from './monitor.js';
import { parseOrder } from './orders.js';
import { HANDLERS } from './drugs.js';
import { makeNurse, nurseExam, nurseTick, sveString, escalate } from './nurses.js';
import { setupScenario } from './scenario.js';
import { resetPatientIds } from './patient.js';
import { maybeShoulderDystocia, startAFE, startMagArrest, startHemArrest, realtimeEmergency, erng, AFE_AT_DELIVERY } from './emergency.js';

const MIN = 60, H = 3600;
export const START_CLOCK = 19 * H;

export class Sim {
  constructor(opts = {}) {
    this.opts = { seed: 'L&D', mode: 'night', teaching: false, blackCloud: false, ...opts };
    this.seed = String(this.opts.seed);
    this.mode = this.opts.mode;
    this.teaching = !!this.opts.teaching;
    // "black cloud": the resident everything happens to. Multiplies the rare emergencies.
    this.blackCloud = !!this.opts.blackCloud;
    this.rare = this.blackCloud ? { sd: 3, afe: 75 } : { sd: 1, afe: 1 };
    this.rng = new Rng(this.seed);
    this.nrng = this.rng.fork('nurses');
    this.orng = this.rng.fork('orders');
    this.brng = this.rng.fork('backup-ob'); // only moves when you ignore your pages: can't shift the chaos timeline
    this.lrng = this.rng.fork('labs');
    this.crng = this.rng.fork('chaos');
    this.t = 0;
    this.startClock = START_CLOCK;
    this.endT = 12 * H;
    this.patients = [];
    this.byId = {};
    this.rooms = ROOMS.map(name => ({ name, pid: null, cleanUntil: 0 }));
    this.bays = TRIAGE_BAYS.map(name => ({ name, pid: null }));
    this.waiting = [];
    this.nurses = [];
    this.ors = [{ name: 'OR 1', pid: null, busyUntil: 0, phase: null, cleanUntil: 0 }];
    this.anes = [{ name: 'Dr. Halvorsen (anesthesia)', short: 'Anesthesia', busyUntil: 0, task: null }];
    this.anesQueue = [];
    this.csQueue = [];
    this.timeline = [];
    this.msgs = [];
    this.nextMsgId = 1;
    this.nextOrderId = 1;
    this.cmdLog = [];
    this.choice = {};
    this.listeners = new Set();
    this.lastUrgentT = -1e9;
    this.backupCalled = false;
    this.ended = false;
    this.stats = { triageSeen: 0, homeDeliveries: 0, bounceBacks: 0, phoneCalls: 0 };
    this.floorLog = [];
    resetPatientIds();
    setupScenario(this);
    this.preroll(40 * MIN);
  }

  // The day team's patients arrive on the board with 40 min of strip already printed and a last
  // set of vitals from the day nurse. Runs before t = 0, so nothing pages and nothing is logged.
  preroll(sec) {
    const pts = this.patients.filter(p => p.admitT < 0 && p.mon.on);
    const vitalsT = pts.map(p => -p.mon.r.int(8, 25) * MIN);
    for (let t = -sec; t < 0; t++) {
      this.t = t;
      for (const p of pts) quietStep(p, this, 1);
      for (const [i, p] of pts.entries()) {
        if (t !== vitalsT[i]) continue;
        const T = p.T, r = p.mon.r;
        p.chart.vitals.push({
          t, by: 'day RN', sbp: Math.round(T.sbp + r.normal(0, 4)), dbp: Math.round(T.dbp + r.normal(0, 3)), hr: Math.round(T.hr + r.normal(0, 2)),
          rr: Math.round(T.rr), spo2: Math.round(clamp(T.spo2 + r.normal(0, 0.6), 50, 100)), temp: Math.round((T.temp + r.normal(0, 0.08)) * 10) / 10,
          ...(p.meds.mag.on || T.mg > 4 ? { reflex: T.reflex } : {}),
        });
      }
    }
    this.t = 0;
  }

  // -------------------------------------------------------------------- time
  clock(t = this.t) { return fmtClockColon(t, this.startClock); }
  after(sec, fn, label) { this.at(this.t + Math.max(1, Math.round(sec)), fn, label); }
  at(t, fn, label) {
    const ev = { t: Math.round(t), fn, label };
    // keep timeline sorted (stable for equal t)
    let i = this.timeline.length;
    while (i > 0 && this.timeline[i - 1].t > ev.t) i--;
    this.timeline.splice(i, 0, ev);
  }

  tick() {
    if (this.ended) return;
    this.t += 1;
    const t = this.t;
    while (this.timeline.length && this.timeline[0].t <= t) {
      const ev = this.timeline.shift();
      ev.fn();
    }
    for (const p of this.patients) {
      if (p.status === 'gone') continue;
      stepPatient(p, this, 1);
    }
    if (t % 60 === 0) {
      for (const p of this.patients) {
        if (p.status === 'gone') continue;
        if (p.mon.on) p.read = analyzeStrip(p, t, 600);
        sampleHistory(p, t);
        this.scheduledMeds(p);
        this.homeWatch(p);
        this.recoveryWatch(p);
      }
    }
    if (t % 30 === 0) {
      for (const p of this.patients) {
        if (p.status === 'gone' || !p.nurseId) continue;
        const n = this.nurseById(p.nurseId);
        if (n && n.onDuty) nurseTick(this, n, p);
      }
    }
    if (t % 10 === 0) this.resourceStep();
    if (t >= this.endT) { this.ended = true; this.emitUI('ended'); }
  }

  run(seconds) { for (let i = 0; i < seconds && !this.ended; i++) { this.applyReplay(); this.tick(); } }

  // replay support: commands recorded with their tick are re-applied before that tick
  loadReplay(log) { this.replayLog = log.slice(); this.replayIdx = 0; }
  applyReplay() {
    if (!this.replayLog) return;
    while (this.replayIdx < this.replayLog.length && this.replayLog[this.replayIdx].t <= this.t) {
      this.command(this.replayLog[this.replayIdx].cmd, true);
      this.replayIdx++;
    }
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emitUI(type, data) { for (const fn of this.listeners) fn(type, data); }

  // -------------------------------------------------------------------- lookup helpers
  nurseById(id) { return this.nurses.find(n => n.id === id); }
  nurseOf(p) { return p.nurseId ? this.nurseById(p.nurseId) : null; }
  realtimeEmergency() { return this.patients.some(p => p.status !== 'gone' && realtimeEmergency(p)); }
  activePatients() { return this.patients.filter(p => p.status !== 'gone'); }
  roomOf(p) { return this.rooms.find(r => r.pid === p.id); }

  // -------------------------------------------------------------------- messages
  msg(from, role, p, text, prio = 1, actions = [], extra = {}) {
    const m = { id: this.nextMsgId++, t: this.t, from, role, pid: p ? p.id : null, room: p ? p.room : null, text, prio, actions, read: false, ...extra };
    this.msgs.push(m);
    if (prio >= 3) this.lastUrgentT = this.t;
    this.emitUI('msg', m);
    return m;
  }
  page(p, text, prio = 1, actions = [], nurse = null) {
    const n = nurse || this.nurseOf(p);
    return this.msg(n ? `${n.name}, RN` : 'Nurse', 'nurse', p, text, prio, actions);
  }
  nurseSays(p, text, prio = 0) { return this.page(p, text, prio); }
  mdSays(p, text, prio = 1) { return this.msg('You (bedside)', 'md', p, text, prio); }
  charge(text, prio = 1, actions = [], p = null) { return this.msg(`${this.chargeName}, charge RN`, 'charge', p, text, prio, actions); }
  sys(text, prio = 0, p = null) { return this.msg('Unit', 'system', p, text, prio); }
  note(p, text) { annotate(p, this, text); p.chart.notes.push({ t: this.t, text }); }
  logTruth(p, text) { (p.truthLog || (p.truthLog = [])).push({ t: this.t, text }); }
  choiceMsg(from, role, p, text, prio, options, handler) {
    const m = this.msg(from, role, p, text, prio, options.map((o, i) => ({ label: o, cmd: { type: 'choice', mid: this.nextMsgId, idx: i } })));
    this.choice[m.id] = handler;
    return m;
  }

  // -------------------------------------------------------------------- commands (player input)
  command(cmd, fromReplay = false) {
    if (!fromReplay) {
      if (this.replayLog) return { ok: false, msg: 'Replay in progress — input disabled.' };
      this.cmdLog.push({ t: this.t, cmd });
    }
    this.markResponse(cmd);
    switch (cmd.type) {
      case 'order': return this.placeOrder(cmd.pid, cmd.text);
      case 'confirm': return this.confirmOrder(cmd.oid, cmd.level);
      case 'cancel': return this.cancelOrder(cmd.oid);
      case 'mdExam': return this.mdExam(cmd.pid);
      case 'choice': {
        const h = this.choice[cmd.mid];
        if (!h) return { ok: false };
        delete this.choice[cmd.mid];
        const m = this.msgs.find(x => x.id === cmd.mid); if (m) { m.resolved = true; m.chosen = cmd.idx; }
        h(cmd.idx);
        return { ok: true };
      }
      case 'lab': return this.labSet(cmd);
      case 'endShift': this.endT = this.t + 1; return { ok: true };
      default: return { ok: false, msg: 'Unknown command' };
    }
  }

  // anything you do for a patient counts as answering her nurse (nurses.js escalate)
  markResponse(cmd) {
    let pid = cmd.pid;
    if (cmd.oid != null) { const [, op] = this.findOrder(cmd.oid); if (op) pid = op.id; }
    if (cmd.mid != null) { const m = this.msgs.find(x => x.id === cmd.mid); if (m) pid = m.pid; }
    const p = pid != null ? this.byId[pid] : null;
    if (p) p.flags.mdT = this.t;
  }

  // Chain of command, top rung: the backup OB comes to see a patient you didn't answer about and does
  // the obvious thing. It won't be fast, and it goes in the record.
  backupOB(p, key, what) {
    const first = p.name.split(' ')[0];
    const doc = 'Dr. Osei';
    const askedT = this.t;
    (p.flags.chain || (p.flags.chain = [])).push({ t: this.t, key, what });
    this.logTruth(p, `Backup OB called over your head: ${what}`);
    this.charge(`I couldn't reach you, so I called ${doc} (backup OB) to see ${first} about her ${what}. Chain of command — it's going in my note.`, 2, [], p);
    this.after(Math.round(this.brng.range(12, 28)) * MIN, () => {
      if (p.status === 'gone' || (p.crisis && p.crisis.phase === 'dead')) return;
      if ((p.flags.mdT ?? -1e9) > askedT) { this.charge(`${doc} came by for ${first}, saw you'd put orders in, and left.`, 0, [], p); return; }
      const T = p.T, rd = p.read;
      const plan = {
        bp: ['labetalol 20 mg IV'], mag: ['stop mag', 'calcium gluconate 1 g IV'], sat: ['O2', 'vitals'], fever: ['ampicillin 2 g IV q6h', 'gentamicin 5 mg/kg IV q24h'],
        bleed: [p.dx.preE !== 'none' || p.dx.cHTN || p.dx.gHTN ? 'hemabate 250 mcg IM' : 'methergine 0.2 mg IM', 'TXA 1 g IV', ...(T.pp && T.pp.qbl > 1500 ? ['transfuse 2 units'] : [])],
        fhr: !p.outcome && rd && rd.currentFhr != null && rd.currentFhr < 110 ? ['c-section stat for prolonged decel'] : ['pit off'],
        lates: ['pit off', 'LR bolus 500'], decel: ['pit off'], vars: ['amnioinfusion'], flat: ['pit off'], tachy: ['pit off', 'terbutaline 0.25 mg SQ'],
        fhrtachy: ['vitals', 'acetaminophen 1 g PO'], lost: [p.chart.romKnown ? 'FSE' : 'bedside US'],
      }[key] || ['vitals'];
      const done = [];
      for (const text of plan) if (this.internalOrder(p, text)) done.push(text);
      this.msg(`${doc} (backup OB)`, 'attending', p, `Saw ${first}. ${done.length ? 'Ordered: ' + done.join(', ') + '.' : 'Nothing more to add right now.'} ${this.brng.pick(['Call me if you need me — and answer your pages.', 'Your nurse was right to call.', 'She needed someone at the bedside an hour ago.', 'I\'ll document. Come find me after.'])}`, 2);
    });
  }
  // an order placed by someone other than you (backup OB): no pushback, no pharmacy call, not in your command log
  internalOrder(p, text) {
    const o = parseOrder(text);
    const h = o.ok && HANDLERS[o.id];
    if (!h) return false;
    const prep = h.prepare(o, p, this);
    if (!prep.ok || prep.issues.some(i => i.hard)) return false;
    const order = { id: this.nextOrderId++, pid: p.id, t: this.t, text, label: prep.label + ' (backup OB)', status: 'new', prep, issues: [], parsedId: o.id, urgency: o.urgency, byBackup: true };
    p.chart.orders.push(order);
    this.executeOrder(order);
    return true;
  }

  placeOrder(pid, text) {
    const o = parseOrder(text);
    if (o.ok && o.id === 'backup') { this.callBackup(); return { ok: true, msg: 'Calling in backup team.' }; }
    const p = this.byId[pid];
    if (!p) return { ok: false, msg: 'Select a patient first.' };
    if (!o.ok) { this.msg('Unit clerk', 'system', p, o.error + ' Try e.g. “pit up 2”, “labetalol 20 mg IV”.', 1); return { ok: false, msg: o.error }; }
    const h = HANDLERS[o.id];
    if (!h) { this.msg('Unit clerk', 'system', p, `I don't know how to enter “${text}”.`, 1); return { ok: false }; }
    if (p.status === 'gone') return { ok: false, msg: 'Patient has left the floor.' };
    const prep = h.prepare(o, p, this);
    if (!prep.ok) { this.page(p, prep.err, 1); return { ok: false, msg: prep.err }; }
    const order = { id: this.nextOrderId++, pid, t: this.t, text, label: prep.label, status: 'new', prep, issues: prep.issues, parsedId: o.id, urgency: o.urgency };
    p.chart.orders.push(order);
    this.processOrder(order, 0);
    return { ok: true, msg: prep.label, order };
  }

  findOrder(oid) { for (const p of this.patients) { const o = p.chart.orders.find(x => x.id === oid); if (o) return [o, p]; } return [null, null]; }

  processOrder(order, level) {
    const p = this.byId[order.pid];
    const issues = order.issues;
    const hard = issues.find(i => i.hard);
    if (hard) {
      order.status = 'rejected';
      this.msg(hard.by === 'pharmacy' ? 'Pharmacy' : hard.by === 'anesthesia' ? 'Anesthesia' : (this.nurseOf(p)?.name || 'Nurse') + ', RN', hard.by, p,
        `Can't process “${order.label}”: ${hard.msg}`, 2);
      return;
    }
    if (level < 1) {
      const ph = issues.filter(i => i.by === 'pharmacy');
      if (ph.length) {
        order.status = 'held_pharmacy';
        this.msg('Pharmacy', 'pharmacy', p, `Calling about “${order.label}”: ${ph.map(i => i.msg).join(' ')}`, 2,
          [{ label: 'Override — dispense', cmd: { type: 'confirm', oid: order.id, level: 1 } }, { label: 'Cancel order', cmd: { type: 'cancel', oid: order.id } }], { oid: order.id });
        return;
      }
    }
    const nurse = this.nurseOf(p);
    if (level < 2 && nurse) {
      const ni = issues.filter(i => i.by === 'nurse');
      const caught = ni.filter(i => {
        const pc = i.sev >= 3 ? 0.35 + 0.65 * nurse.knowledge : i.sev === 2 ? 0.15 + 0.8 * nurse.knowledge : 0.1 + 0.6 * nurse.knowledge * nurse.chatty;
        return this.orng.chance(pc);
      });
      if (caught.length) {
        const sevMax = Math.max(...caught.map(i => i.sev));
        const pushes = this.orng.chance(sevMax >= 3 ? Math.max(0.6, nurse.assert) : nurse.assert);
        if (pushes) {
          order.status = 'held_nurse';
          this.msg(`${nurse.name}, RN`, 'nurse', p, `About “${order.label}” — ${caught.map(i => i.msg).join(' ')} Do you still want it?`, sevMax >= 3 ? 2 : 1,
            [{ label: 'Yes — give it', cmd: { type: 'confirm', oid: order.id, level: 2 } }, { label: 'Cancel', cmd: { type: 'cancel', oid: order.id } }], { oid: order.id });
          return;
        }
        this.page(p, `OK, doing “${order.label}”… (${caught[0].msg.replace(/[.!?]$/, '')})`, 0, [], nurse);
      }
    }
    this.executeOrder(order);
  }

  confirmOrder(oid, level = 2) {
    const [order] = this.findOrder(oid);
    if (!order || !order.status.startsWith('held')) return { ok: false };
    for (const m of this.msgs) if (m.oid === oid) m.resolved = true;
    order.overridden = true;
    this.processOrder(order, level);
    return { ok: true };
  }
  cancelOrder(oid) {
    const [order, p] = this.findOrder(oid);
    if (!order) return { ok: false };
    for (const m of this.msgs) if (m.oid === oid) m.resolved = true;
    if (order.status === 'pending') return { ok: false, msg: 'Already being done.' };
    order.status = 'cancelled';
    this.sys(`Cancelled: ${order.label}`, 0, p);
    return { ok: true };
  }

  executeOrder(order) {
    const p = this.byId[order.pid];
    const prep = order.prep;
    order.status = 'pending';
    const nurse = this.nurseOf(p);
    let [lo, hi] = prep.delay;
    if (prep.who === 'nurse' && nurse) { const load = nurse.patients.length; lo *= 1 + 0.25 * (load - 1); hi *= 1 + 0.35 * (load - 1); }
    if (order.urgency === 'stat') { lo *= 0.5; hi *= 0.5; }
    const delay = Math.round((lo + (hi - lo) * this.orng.next()) * MIN);
    const done = () => {
      if (order.status !== 'pending') return;
      if (p.status === 'gone') { order.status = 'cancelled'; return; }
      order.status = 'done'; order.doneT = this.t;
      prep.run();
      if (prep.who === 'nurse') p.chart.mar.push({ t: this.t, text: prep.label, by: nurse ? nurse.name : 'RN' });
      if (!/^Lab:|SVE|Vitals|Bedside|Admit|Discharge/.test(prep.label)) this.note(p, shortLabel(prep.label));
      if (order.overridden && order.issues.some(i => i.sev >= 2)) {
        p.overrides = (p.overrides || 0) + 1;
        this.logTruth(p, `Override: ${prep.label} (${order.issues.map(i => i.msg).join(' ')})`);
      }
    };
    if (delay <= 0) done(); else this.after(delay, done, 'order');
  }

  // -------------------------------------------------------------------- dosing API (drugs.js)
  addDose(p, d) {
    p.meds.doses.push({ ...d, t: this.t });
    if (d.drug === 'labetalol' || d.drug === 'hydralazine' || d.drug === 'nifedipine') {
      if (p.flags.firstSevereT != null && p.flags.treatedT == null) p.flags.treatedT = this.t;
    }
  }
  giveAbx(p, drug, amt, intervalH) {
    p.meds.abx.push({ drug, t: this.t, amt, intervalH });
    p.meds.doses.push({ drug, t: this.t, amt, route: 'IV' });
  }
  scheduleMed(p, s) { (p.meds.sched || (p.meds.sched = [])).push({ ...s, nextT: this.t + s.everyH * H, given: 0 }); }
  stopScheduled(p, drug) { if (p.meds.sched) p.meds.sched = p.meds.sched.filter(s => s.drug !== drug); }
  lastDose(p, drug) { for (let i = p.meds.doses.length - 1; i >= 0; i--) if (p.meds.doses[i].drug === drug) return p.meds.doses[i]; return null; }
  countDoses(p, drug) { return p.meds.doses.filter(d => d.drug === drug).length; }
  cumulativeDose(p, drug, hours, route) {
    return p.meds.doses.filter(d => d.drug === drug && this.t - d.t <= hours * H && (!route || d.route === route)).reduce((a, d) => a + d.amt, 0);
  }
  recentFluid(p, hours) { return p.meds.fluidsMl.filter(f => this.t - f.t <= hours * H).reduce((a, f) => a + f.ml, 0); }
  giveFluid(p, ml, byNurse = false) {
    p.meds.fluidsMl.push({ t: this.t, ml });
    p.T.netFluid += ml;
    if (byNurse) this.note(p, `LR ${ml} bolus`);
  }
  setPit(p, rate, why) {
    const pit = p.meds.pit;
    rate = Math.max(0, Math.round(rate * 2) / 2);
    if (rate > 0 && pit.rate === 0 && pit.startT == null) pit.startT = this.t;
    if (rate > 0 && p.flags.iolStartT == null) p.flags.iolStartT = this.t;
    pit.rate = rate;
    pit.lastTitrT = this.t;
    if (why !== 'order') this.note(p, rate ? `Pit ${rate}` : 'Pit off');
    (p.pitLog || (p.pitLog = [])).push({ t: this.t, rate, why });
  }
  startMag(p, load, rate) {
    const m = p.meds.mag;
    if (load) { m.loadG = load; m.loadStartT = this.t; m.loadEndT = this.t + 20 * MIN; }
    if (rate != null) { m.on = true; m.rate = rate; }
    if (!m.startT) m.startT = this.t;
  }
  stopMag(p) { const m = p.meds.mag; m.on = false; m.rate = 0; if (m.loadEndT > this.t) m.loadEndT = this.t; }
  placeCervidil(p) {
    const c = p.meds.cervidil; c.in = true; c.inT = this.t;
    if (p.flags.iolStartT == null) p.flags.iolStartT = this.t;
    if (p.priorCS) p.T.everMiso = true;
  }
  removeCervidil(p, why) { const c = p.meds.cervidil; if (!c.in) return; c.in = false; c.outT = this.t; this.note(p, 'Cervidil out'); }
  harm(p, kind, extra) {
    const T = p.T;
    (p.harms || (p.harms = [])).push({ t: this.t, kind });
    this.logTruth(p, 'HARM: ' + kind + (extra ? ' (' + extra + ')' : ''));
    if (kind === 'anaphylaxis') {
      T.anaph = 1;
      this.after(90, () => this.page(p, `She's covered in hives, wheezing, BP is ${Math.round(T.sbp)}/${Math.round(T.dbp)}! Reaction to the ${extra}!`, 3,
        [{ label: 'Epi 0.3 mg IM', cmd: { type: 'order', pid: p.id, text: 'epinephrine 0.3 mg IM' } }, { label: 'LR bolus 1 L', cmd: { type: 'order', pid: p.id, text: 'LR bolus 1 L' } }]));
    } else if (kind === 'bronchospasm' || kind === 'bronchospasm_mild') {
      T.bronch = Math.max(T.bronch, kind === 'bronchospasm' ? 1 : 0.4);
      this.after(240, () => this.page(p, `She's wheezing and short of breath — sat ${Math.round(T.spo2)}%.`, kind === 'bronchospasm' ? 3 : 2,
        [{ label: 'Albuterol neb', cmd: { type: 'order', pid: p.id, text: 'albuterol neb' } }, { label: 'O2', cmd: { type: 'order', pid: p.id, text: 'O2' } }]));
    } else if (kind === 'previa_bleed') {
      T.qblAntepartum += 450; T.abr = Math.max(T.abr, 0.35);
      this.page(p, `She's hemorrhaging — bright red blood everywhere!`, 3, [{ label: 'C-section STAT', cmd: { type: 'order', pid: p.id, text: 'c-section stat for bleeding' } }, { label: 'Bedside US', cmd: { type: 'order', pid: p.id, text: 'bedside US' } }]);
    } else if (kind === 'oxytocin_bolus') {
      this.after(240, () => this.page(p, `Her uterus is rock hard and not relaxing after that pit!`, 3, [{ label: 'Terbutaline', cmd: { type: 'order', pid: p.id, text: 'terbutaline 0.25 mg SQ' } }]));
    }
  }
  reposition(p, quiet = false) {
    p.T.cordPos = p.T.rng.lognormal(1, 0.45);
    p.T.epiHypoDepth *= 0.8;
    if (!quiet) this.note(p, 'Repositioned');
  }

  // -------------------------------------------------------------------- vitals, exams, labs
  takeVitals(p, ordered) {
    const T = p.T, n = this.nurseOf(p), r = this.nrng;
    if (!p.ns) p.ns = {};
    p.ns.lastVitalsT = this.t;
    const v = {
      t: this.t, by: n ? n.name : 'RN', sbp: Math.round(T.sbp + r.normal(0, 4)), dbp: Math.round(T.dbp + r.normal(0, 3)), hr: Math.round(T.hr + r.normal(0, 2)),
      rr: Math.round(T.rr), spo2: Math.round(clamp(T.spo2 + r.normal(0, 0.6), 50, 100)),
      temp: Math.round((T.temp + r.normal(0, 0.08)) * 10) / 10,
    };
    if (p.meds.mag.on || T.mg > 4) v.reflex = T.reflex;
    p.chart.vitals.push(v);
    const severe = v.sbp >= 160 || v.dbp >= 110;
    const ns = p.ns;
    if (severe) {
      if (p.flags.firstSevereT == null) p.flags.firstSevereT = this.t;
      const confirm = ns.severePending && this.t >= ns.severePending;
      if (confirm || (n && this.nrng.chance(n.alert * 0.6)) || ordered) {
        ns.severePending = null;
        if (this.t - (ns.lastBpPage || -1e9) > 12 * MIN) {
          ns.lastBpPage = this.t;
          escalate(this, n, p, 'bp', 'blood pressure', `BP ${v.sbp}/${v.dbp}${confirm ? ' on repeat' : ''}. ${p.flags.treatedT ? '' : 'She hasn\'t had anything for it.'}${T.peSev > 0.8 && this.nrng.chance(0.5) ? ' She says she has a headache.' : ''}`, 2,
            [{ label: 'Labetalol 20 IV', cmd: { type: 'order', pid: p.id, text: 'labetalol 20 mg IV' } }, { label: 'Hydralazine 5 IV', cmd: { type: 'order', pid: p.id, text: 'hydralazine 5 mg IV' } }, { label: 'Nifedipine 10 PO', cmd: { type: 'order', pid: p.id, text: 'nifedipine 10 mg PO' } }]);
        }
      } else if (!ns.severePending) ns.severePending = this.t + 15 * MIN;
    } else if (ns.severePending && this.t >= ns.severePending) ns.severePending = null;
    if (v.temp >= 38 && this.t - (ns.lastFeverPage || -1e9) > 2 * H) {
      ns.lastFeverPage = this.t;
      escalate(this, n, p, 'fever', 'fever', `Temp ${v.temp}, maternal HR ${v.hr}.`, v.temp >= 39 ? 3 : 2,
        [{ label: 'Amp + gent', cmd: { type: 'order', pid: p.id, text: 'ampicillin 2 g IV q6h' }, cmd2: { type: 'order', pid: p.id, text: 'gentamicin 5 mg/kg IV q24h' } },
         { label: 'Gent 5 mg/kg', cmd: { type: 'order', pid: p.id, text: 'gentamicin 5 mg/kg IV q24h' } },
         { label: 'Tylenol 1 g', cmd: { type: 'order', pid: p.id, text: 'acetaminophen 1 g PO' } }]);
    }
    if (v.reflex === 'absent' || v.rr < 12) {
      if (this.t - (ns.lastMagPage || -1e9) > 10 * MIN) {
        ns.lastMagPage = this.t;
        const wasOn = p.meds.mag.on;
        if (wasOn && n) { this.stopMag(p); this.note(p, 'Mag held by RN (toxicity)'); }
        const held = wasOn && n ? ' I stopped the mag per protocol.' : !p.meds.mag.on && p.meds.mag.startT != null ? ' Mag is already off.' : '';
        escalate(this, n, p, 'mag', 'magnesium toxicity', `${v.reflex === 'absent' ? 'I can\'t get any patellar reflexes' : ''}${v.rr < 12 ? (v.reflex === 'absent' ? ' and her' : 'Her') + ` resp rate is ${v.rr}` : ''}.${held}`, 3,
          [{ label: 'Stop mag', cmd: { type: 'order', pid: p.id, text: 'stop mag' } }, { label: 'Calcium gluconate 1 g', cmd: { type: 'order', pid: p.id, text: 'calcium gluconate 1 g IV' } }, { label: 'Mag level', cmd: { type: 'order', pid: p.id, text: 'mag level' } }]);
      }
    }
    if (v.spo2 < 93 && this.t - (ns.lastSatPage || -1e9) > 10 * MIN) {
      ns.lastSatPage = this.t;
      const o2 = !p.meds.o2 && n; if (o2) p.meds.o2 = true;
      const why = T.pulmEdema > 0.3 ? ' She sounds wet — crackles at the bases.' : T.pp && T.pp.qbl > 1500 ? ` She's pale and clammy.` : T.mgEff > 9 ? ' She\'s very drowsy.' : '';
      escalate(this, n, p, 'sat', 'oxygen saturation', `Her sat is ${v.spo2}%${o2 ? ' — I put her on a non-rebreather' : p.meds.o2 ? ' on oxygen' : ''}.${why}`, 3,
        [{ label: 'Vitals', cmd: { type: 'order', pid: p.id, text: 'vitals' } }, { label: 'Exam her', cmd: { type: 'mdExam', pid: p.id } }]);
    }
    if (ordered) this.page(p, `Vitals: BP ${v.sbp}/${v.dbp}, HR ${v.hr}, T ${v.temp}, RR ${v.rr}, sat ${v.spo2}%${v.reflex ? `, reflexes ${v.reflex}` : ''}.`, 0);
    return v;
  }
  lastVitals(p) { for (let i = p.chart.vitals.length - 1; i >= 0; i--) if (p.chart.vitals[i].sbp) return p.chart.vitals[i]; return null; }

  doSVE(p, who, reason) {
    const T = p.T;
    if (T.pp || p.status === 'gone' || p.area === 'or' || realtimeEmergency(p)) return;
    const n = this.nurseOf(p);
    if (!n) return;
    if (p.ns) p.ns.lastSveT = this.t;
    if (p.dx.previa && !p.known.previa) {
      const cautious = p.area === 'triage' && (p.sub === 'bleed') && this.nrng.chance(n.knowledge);
      if (cautious) { this.page(p, `She's bleeding — I'm holding off on a cervical exam until we know where the placenta is.`, 1, [{ label: 'Bedside US', cmd: { type: 'order', pid: p.id, text: 'bedside US' } }], n); return; }
      this.harm(p, 'previa_bleed'); return;
    }
    if (p.known.previa) return;
    const e = nurseExam(n, p, this.nrng, false);
    this.recordSVE(p, e, n.name, reason);
  }
  recordSVE(p, e, by, reason) {
    const T = p.T;
    const s = { t: this.t, dil: e.dil, eff: e.eff, sta: e.sta, by, notes: e.notes, trueDil: T.dil, trueSta: T.station };
    const prev = p.chart.sves.length ? p.chart.sves[p.chart.sves.length - 1] : null;
    p.chart.sves.push(s);
    if (T.rom) T.svesSinceRom++;
    this.note(p, 'SVE ' + sveString(s));
    const n = this.nurseOf(p);
    const first = p.name.split(' ')[0];
    if (e.notes.some(x => x.includes('CORD'))) {
      this.page(p, `I FEEL CORD! ${sveString(s)} — I'm holding the head up!`, 3, [{ label: 'C-section STAT', cmd: { type: 'order', pid: p.id, text: 'c-section stat cord prolapse' } }]);
      p.T.prolapseRelieved = true; p.known.prolapse = true;
      return s;
    }
    if (e.notes.some(x => x.includes('breech') || x.includes('not sure that'))) p.known.breechSuspected = true;
    if (by.startsWith('You')) {
      this.mdSays(p, `Your exam: ${sveString(s)}${e.notes.length ? ' — ' + e.notes.join(', ') : ''}.`, 1);
      return s;
    }
    if (p.area === 'triage') return s; // triage summary reports it
    if (s.dil >= 10) {
      if (p.flags.completePaged) return s;
      p.flags.completePaged = this.t;
      p.truePhaseKnown = 'second';
      this.page(p, `${first} is complete, ${s.sta >= 0 ? '+' + s.sta : s.sta} station${p.epidural.state === 'working' ? ', comfortable with her epidural' : ', feeling the urge'}. Push or labor down?`, 2,
        [{ label: 'Push', cmd: { type: 'order', pid: p.id, text: 'push' } }, { label: 'Labor down', cmd: { type: 'order', pid: p.id, text: 'labor down' } }], n);
      return s;
    }
    const changed = !prev || Math.abs(prev.dil - s.dil) >= 1 || reason === 'ordered';
    const chatty = n ? n.chatty : 0.5;
    if (changed || this.nrng.chance(chatty * 0.6)) {
      const extra = e.notes.length ? ` (${e.notes.join(', ')})` : '';
      const prog = prev ? (s.dil > prev.dil ? ` — up from ${prev.dil}` : s.dil === prev.dil ? ' — no change' : ` — hm, ${prev.dil} last time`) : '';
      this.page(p, `SVE ${sveString(s)}${prog}${extra}.`, e.notes.length && e.notes[0].includes('soft') ? 2 : 0, [], n);
    }
    return s;
  }
  mdExam(pid) {
    const p = this.byId[pid];
    if (!p || p.T.pp) return { ok: false, msg: 'Nothing to examine.' };
    if (p.area === 'or' || p.area === 'home' || p.area === 'offsite') return { ok: false, msg: 'She is not on the floor.' };
    if (p.mdExamBusyUntil > this.t) return { ok: false, msg: 'You are already examining her.' };
    p.mdExamBusyUntil = this.t + 4 * MIN;
    this.after(3 * MIN + 30, () => {
      if (p.dx.previa && !p.known.previa) { this.harm(p, 'previa_bleed'); return; }
      const e = nurseExam(null, p, this.nrng, true);
      this.recordSVE(p, e, 'You (MD)', 'md');
      if (p.ns) p.ns.lastSveT = this.t;
      if (p.T.prolapse) { p.known.prolapse = true; p.T.prolapseRelieved = true; }
      if (e.dil >= 10 && p.ns) p.ns.completeFound = true;
    });
    return { ok: true, msg: 'Walking to the room to examine her (≈4 min).' };
  }
  bedsideUS(p) {
    const T = p.T, r = this.nrng;
    if (p.T.pp) { this.mdSays(p, `Bedside US: ${T.pp.tone < 0.55 ? 'thickened endometrial stripe with clot' : 'thin stripe, no retained products'}.`); return; }
    const pres = p.dx.breech ? 'BREECH (frank)' : 'vertex' + (T.op ? ', looks OP' : '');
    if (p.dx.breech) { p.known.breech = true; p.known.breechSuspected = true; }
    if (p.dx.previa) p.known.previa = true;
    const efw = Math.round(T.efw * (1 + r.normal(0, 0.1)) / 50) * 50;
    const afi = p.dx.oligo || (T.rom && r.chance(0.5)) ? 'oligohydramnios (MVP 1.6 cm)' : p.dx.poly ? 'polyhydramnios' : 'normal fluid';
    const bpp = T.demise ? 'NO CARDIAC ACTIVITY' : T.bd > 10 ? 'BPP 2/8 — no breathing, no movement, poor tone' : T.bd > 7 ? 'BPP 6/8 (no breathing)' : 'BPP 8/8';
    const plac = p.dx.previa ? 'COMPLETE PREVIA' : T.abr > 0.3 && r.chance(0.3) ? 'possible retroplacental clot' : 'placenta fundal/posterior, clear of os';
    if (T.demise) this.logTruth(p, 'IUFD confirmed on US');
    this.mdSays(p, `Bedside US: ${pres}. EFW ~${efw} g. ${afi}. ${plac}. ${bpp}. FHR ${T.demise ? 0 : Math.round(T.fhr)}.`, T.demise || p.dx.breech || p.dx.previa ? 2 : 1);
  }
  romTest(p) {
    const pos = p.T.rom ? this.nrng.chance(0.95) : this.nrng.chance(0.05);
    p.chart.romResult = pos ? 'positive' : 'negative';
    if (pos) p.chart.romKnown = true;
    this.page(p, `SSE: ${pos ? 'pooling, nitrazine + , ROM test POSITIVE' : 'no pooling, ROM test negative'}${p.T.fluid === 'mec' && pos ? ', fluid is mec-stained' : ''}.`, 1);
  }
  orderLab(p, key) {
    const L = LABS[key];
    const tat = (L.tat[0] + (L.tat[1] - L.tat[0]) * this.lrng.next()) * MIN;
    const lab = { key, label: L.label, orderT: this.t, resultT: this.t + tat, values: null, text: 'pending' };
    p.chart.labs.push(lab);
    this.after(tat, () => {
      const T = p.T, r = this.lrng, vals = {};
      const crit = [];
      if (key === 'cbc' || key === 'pih') { vals.hgb = +(T.hgb + r.normal(0, 0.2)).toFixed(1); vals.plt = Math.round(T.plt + r.normal(0, 6)); vals.wbc = +(11 + (T.infect > 0.8 ? 7 : 0) + r.normal(0, 2)).toFixed(1); if (vals.plt < 100) crit.push(`plt ${vals.plt}`); }
      if (key === 'cmp' || key === 'pih') { vals.cr = +(T.cr + r.normal(0, 0.04)).toFixed(2); vals.ast = Math.round(T.ast + r.normal(0, 3)); vals.alt = Math.round(T.ast * 0.9 + r.normal(0, 3)); if (vals.cr >= 1.1) crit.push(`Cr ${vals.cr}`); if (vals.ast > 70) crit.push(`AST ${vals.ast}`); }
      if (key === 'pih') { vals.ldh = Math.round((p.dx.hellp ? 650 : 180) + r.normal(0, 40)); vals.uric = +(p.dx.preE !== 'none' ? 6.5 : 4.2 + r.normal(0, 0.4)).toFixed(1); }
      if (key === 'upc') { vals.upc = +(T.upc + r.normal(0, 0.03)).toFixed(2); if (vals.upc >= 0.3) crit.push(`UPC ${vals.upc}`); }
      if (key === 'ts') { vals.type = p.bloodType || (p.bloodType = r.pick(['O+', 'A+', 'B+', 'O-', 'AB+', 'A-'])); vals.ab = 'neg'; }
      if (key === 'fib') { vals.fib = Math.round(T.fib + r.normal(0, 10)); if (vals.fib < 200) crit.push(`fibrinogen ${vals.fib}`); }
      if (key === 'mglevel') { vals.mg = +(T.mg + r.normal(0, 0.15)).toFixed(1); if (vals.mg > 8) crit.push(`Mg ${vals.mg}`); }
      if (key === 'gbs') { const pos = p.gbsTrue === 'pos' ? r.chance(0.9) : r.chance(0.03); vals.gbs = pos ? 'POSITIVE' : 'negative'; p.gbs = pos ? 'pos' : 'neg'; }
      if (key === 'coag') { vals.inr = +(1.0 + (T.fib < 150 ? 0.5 : 0) + r.normal(0, 0.04)).toFixed(2); }
      lab.values = vals;
      lab.text = Object.entries(vals).map(([k, v]) => `${k} ${v}`).join(', ');
      if (key === 'cbc' || key === 'pih') p.flags.lastCbcT = this.t;
      this.msg('Lab', 'lab', p, `${L.label}: ${lab.text}`, crit.length ? 2 : 0);
      if (vals.plt != null) this.anesthesiaPlateletsBack(p, vals.plt);
      if (vals.cr >= 1.1 || vals.ast > 70 || vals.plt < 100 || vals.upc >= 0.3) { if (!p.chart.problems.includes('preE')) p.chart.problems.push('preE'); if (vals.cr >= 1.1 || vals.ast > 70 || vals.plt < 100) p.known.preE = 'severe'; else if (p.known.preE === 'none') p.known.preE = 'mild'; }
    });
  }
  labValue(p, field) {
    for (let i = p.chart.labs.length - 1; i >= 0; i--) { const l = p.chart.labs[i]; if (l.values && l.values[field] != null) return l.values[field]; }
    return null;
  }

  // -------------------------------------------------------------------- scheduled meds & watches
  scheduledMeds(p) {
    if (!p.meds.sched || !p.meds.sched.length) return;
    const n = this.nurseOf(p);
    for (const s of p.meds.sched.slice()) {
      if (this.t < s.nextT) continue;
      if (p.T.pp && (s.drug === 'misoprostol' || ['penicillin', 'ampicillin', 'cefazolin', 'clindamycin', 'vancomycin'].includes(s.drug) && s.everyH <= 4)) { this.stopScheduled(p, s.drug); continue; }
      if (s.lost) continue;
      s.nextT = this.t + s.everyH * H;
      if (s.hold === 'ripening') {
        const c10 = p.read ? p.read.ctxPer10 : 0;
        const aggressive = n && n.pit === 'aggressive';
        if (p.meds.pit.rate > 0 || (c10 >= 3 && !aggressive) || p.T.laborOnset && p.T.dil >= 4 && !aggressive) {
          this.page(p, `Held her ${s.drug === 'misoprostol' ? 'miso' : s.drug} — ${p.meds.pit.rate > 0 ? 'she\'s on pit' : c10 >= 3 ? `contracting ${c10.toFixed(0)} in 10` : 'she seems to be in labor'}.`, 0);
          s.given++; if (s.given >= s.max) this.stopScheduled(p, s.drug);
          continue;
        }
        this.doSVE(p, 'nurse', 'pre-dose');
      }
      if (s.abx) this.giveAbx(p, s.drug, s.amt, s.abxIntervalH);
      else this.addDose(p, { drug: s.drug, amt: s.amt, route: s.route, pp: !!p.T.pp });
      if (s.onGive) s.onGive();
      p.chart.mar.push({ t: this.t, text: `${s.drug} ${s.amt} ${s.route || ''} (scheduled)`, by: n ? n.name : 'RN' });
      s.given++;
      if (s.given >= s.max) this.stopScheduled(p, s.drug);
    }
  }
  homeWatch(p) {
    const T = p.T;
    if (p.area === 'waiting' && p.waitingForBay && !p.flags.waitEscalated && (T.dil >= 8 || T.abr > 0.3 || (T.station >= 1 && T.complete))) {
      p.flags.waitEscalated = true;
      this.charge(`The patient in the waiting room (${p.name}) is ${T.dil >= 9 ? 'saying she needs to push' : T.abr > 0.3 ? 'bleeding through her pants' : 'in a lot of pain, contracting hard'}. Triage is still full.`, 2,
        [{ label: 'Straight to an LDR', cmd: { type: 'order', pid: p.id, text: 'admit' } }], p);
    }
    if (p.area !== 'home') return;
    if (T.station >= 3 && T.complete && !p.outcome) {
      this.stats.homeDeliveries++;
      this.logTruth(p, 'Delivered at home / en route after discharge');
      this.deliver(p, 'home');
      this.charge(`EMS just called — ${p.name}, the patient discharged from triage at ${this.clock(p.dischargeT)}, delivered in the car. They're bringing her in.`, 2);
      return;
    }
    const back = (T.laborOnset && T.dil >= 6.5 && this.crng.chance(0.15)) || (T.rom && !p.chart.romKnown && T.laborOnset && this.crng.chance(0.03))
      || (T.peSev > 0.85 && this.crng.chance(0.02)) || (T.seizingUntil > 0 && this.t - T.seizingUntil < 600) || (T.abr > 0.4) || (T.infect > 1.2 && this.crng.chance(0.05));
    if (back && this.t - p.dischargeT > 30 * MIN) {
      this.stats.bounceBacks++;
      p.bounced = true;
      this.logTruth(p, 'Returned after discharge');
      this.arriveTriage(p, true);
    }
  }
  recoveryWatch(p) {
    if (!p.T.pp || p.status === 'gone') return;
    const pp = p.T.pp;
    const s = this.t - pp.t0;
    if (p.crisis) {
      // AFE survivors go to the ICU once stable and not pouring blood; until then they stay
      if (p.crisis.phase === 'stable' && pp.bleed < 3 && p.area !== 'or' && this.t - p.crisis.stableT > 20 * MIN) this.transferOut(p, 'to the ICU');
      return;
    }
    if (s > 2 * H && pp.bleed < 2.5 && (p.area === 'ldr' || p.area === 'pacu')) this.transferOut(p, p.area === 'pacu' ? 'from PACU to postpartum' : 'to postpartum');
  }

  // -------------------------------------------------------------------- patient flow
  addPatient(p) { this.patients.push(p); this.byId[p.id] = p; return p; }
  freeRoom() { return this.rooms.find(r => !r.pid && this.t >= r.cleanUntil); }
  freeBay() { return this.bays.find(b => !b.pid); }
  assignNurse(p, preferId) {
    const duty = this.nurses.filter(n => n.onDuty && n.role !== 'triage');
    let n = preferId ? duty.find(x => x.id === preferId) : null;
    if (!n) n = duty.slice().sort((a, b) => a.patients.length - b.patients.length || (a.id < b.id ? -1 : 1))[0];
    if (p.nurseId) { const old = this.nurseById(p.nurseId); if (old) old.patients = old.patients.filter(id => id !== p.id); }
    p.nurseId = n.id; n.patients.push(p.id);
    p.ns = null;
    return n;
  }
  placeInRoom(p, room) {
    if (p.room) this.vacate(p);
    room.pid = p.id; p.room = room.name; p.area = 'ldr';
    p.mon.on = true;
    p.admitT = p.admitT ?? this.t;
    this.assignNurse(p);
    this.waiting = this.waiting.filter(id => id !== p.id);
  }
  vacate(p, cleanMin = 30) {
    const r = this.rooms.find(x => x.pid === p.id);
    if (r) { r.pid = null; r.cleanUntil = this.t + cleanMin * MIN; }
    const b = this.bays.find(x => x.pid === p.id);
    if (b) b.pid = null;
    p.room = null;
  }
  arriveTriage(p, returning = false) {
    if (!this.byId[p.id]) this.addPatient(p);
    const bay = this.freeBay();
    p.status = p.status === 'gone' ? 'gone' : 'triage';
    if (!bay) {
      p.area = 'waiting'; p.room = null;
      if (!this.waiting.includes(p.id)) this.waiting.push(p.id);
      this.charge(`Triage is full — ${p.name} (${this.complaintText(p)}) is in the waiting room.`, 1, [], p);
      p.waitingForBay = true;
      return;
    }
    p.waitingForBay = false;
    this.waiting = this.waiting.filter(id => id !== p.id);
    bay.pid = p.id; p.room = bay.name; p.area = 'triage';
    p.triageT = this.t; p.mon.on = true;
    this.stats.triageSeen++;
    const tn = this.nurses.find(n => n.role === 'triage' && n.onDuty);
    if (p.nurseId) { const old = this.nurseById(p.nurseId); if (old) old.patients = old.patients.filter(id => id !== p.id); }
    p.nurseId = tn.id; tn.patients.push(p.id); p.ns = null;
    if (returning) this.charge(`${p.name} is back in triage${p.T.seizingUntil > 0 ? ' — EMS says she SEIZED at home' : ''}. ${this.complaintText(p)}.`, p.T.seizingUntil > 0 || p.T.abr > 0.4 ? 3 : 2, [], p);
    // triage nurse intake ~15-25 min
    this.after(this.nrng.range(12, 25) * MIN, () => this.triageSummary(p));
  }
  complaintText(p) {
    return ({ ctx: 'contractions', rom: 'leaking fluid', dfm: 'decreased fetal movement', bp: 'elevated BP / headache', bleed: 'vaginal bleeding', request: 'wants to be induced', preterm: 'preterm contractions' })[p.sub] || p.indication;
  }
  triageSummary(p) {
    if (p.area !== 'triage' || p.status === 'gone') return;
    const n = this.nurseOf(p);
    const v = this.takeVitals(p, false);
    const skipSve = p.sub === 'bleed' && this.nrng.chance(n.knowledge);
    let sve = null;
    if (!skipSve) { this.doSVE(p, 'nurse', 'triage'); sve = p.chart.sves.length ? p.chart.sves[p.chart.sves.length - 1] : null; if (sve && sve.t !== this.t) sve = null; }
    if (p.T.pp) return;
    const rd = analyzeStrip(p, this.t, 900);
    let strip = 'tracing ok';
    if (rd && rd.baseline) {
      const react = rd.accels.length >= 2 ? 'reactive' : rd.accels.length === 1 ? 'one accel' : 'no accels yet';
      strip = `baseline ${Math.round(rd.baseline / 5) * 5}, ${rd.variability != null && rd.variability <= 5 ? 'minimal variability' : 'moderate variability'}, ${react}${rd.decels.length ? `, ${rd.decels.length} decel${rd.decels.length > 1 ? 's' : ''}` : ''}, ctx ${rd.ctxPer10 >= 1 ? '~q' + Math.max(1, Math.round(10 / rd.ctxPer10)) + 'min' : 'occasional'}`;
    }
    const gp = `G${p.gravida}P${p.para}`;
    const text = `Triage: ${p.age}yo ${gp} at ${Math.floor(p.gaDays / 7)}+${p.gaDays % 7}, ${this.complaintText(p)}. ${sve ? 'SVE ' + sveString(sve) + '. ' : skipSve ? 'Held SVE (bleeding). ' : ''}BP ${v.sbp}/${v.dbp}. ${strip}.${p.known.notes.length ? ' Hx: ' + p.known.notes.join('; ') + '.' : ''} GBS ${p.gbs}.`;
    p.triageSummaryT = this.t;
    const tm = this.page(p, text, 1, [
      { label: 'Admit', cmd: { type: 'order', pid: p.id, text: 'admit' } }, { label: 'Discharge', cmd: { type: 'order', pid: p.id, text: 'discharge' } },
      { label: 'Walk 2 h', cmd: { type: 'order', pid: p.id, text: 'observe' } }, { label: 'ROM test', cmd: { type: 'order', pid: p.id, text: 'ROM test' } },
      { label: 'PIH labs', cmd: { type: 'order', pid: p.id, text: 'PIH labs' } }, { label: 'Bedside US', cmd: { type: 'order', pid: p.id, text: 'bedside US' } },
    ], n);
    tm.triage = true;
    if (p.sub === 'request' && !p.flags.requestAsked) {
      p.flags.requestAsked = true;
      this.after(4 * MIN, () => this.choiceMsg(`${p.name}`, 'family', p, `“I'm ${Math.floor(p.gaDays / 7)} weeks and I'm DONE. Can you just induce me tonight? My mom flew in.”`, 1,
        ['Admit for elective IOL (if a bed)', 'Schedule for later this week', 'Not tonight — go home'], (i) => {
          if (i === 0) this.command({ type: 'order', pid: p.id, text: 'admit' }, true);
          else { p.flags.requestOutcome = i === 1 ? 'scheduled' : 'declined'; if (p.area === 'triage') this.command({ type: 'order', pid: p.id, text: 'discharge' }, true); }
        }));
    }
  }
  resolveTriageMsgs(p) { for (const m of this.msgs) if (m.pid === p.id && m.triage) m.resolved = true; }
  admit(p) {
    this.resolveTriageMsgs(p);
    const room = this.freeRoom();
    p.status = p.T.laborOnset ? 'labor' : 'antepartum';
    if (!p.chart.problems.length && p.sub === 'bp') p.chart.problems.push('HTN');
    if (!room) {
      p.boarding = true;
      this.charge(`No LDRs open — ${p.name} will board in ${p.room || 'triage'} until a room is cleaned.`, 1, [], p);
      return;
    }
    const wasTriage = p.area === 'triage' || p.area === 'waiting';
    this.vacate(p, 0);
    this.placeInRoom(p, room);
    p.boarding = false;
    if (wasTriage) this.sys(`${p.name} admitted to ${room.name}.`, 0, p);
    this.pullWaitingIntoTriage();
  }
  pullWaitingIntoTriage() {
    for (const id of this.waiting.slice()) {
      const q = this.byId[id];
      if (q && q.waitingForBay && this.freeBay()) this.arriveTriage(q);
    }
  }
  discharge(p) {
    this.resolveTriageMsgs(p);
    this.vacate(p, 0);
    p.area = 'home'; p.mon.on = false; p.dischargeT = this.t; p.status = 'home';
    if (p.nurseId) { const n = this.nurseById(p.nurseId); if (n) n.patients = n.patients.filter(id => id !== p.id); p.nurseId = null; }
    this.sys(`${p.name} discharged home from triage.`, 0, p);
    this.pullWaitingIntoTriage();
  }
  observe(p) {
    p.flags.observing = true;
    this.after(2 * H, () => {
      if (p.area !== 'triage') return;
      p.flags.observing = false;
      this.triageSummary(p);
    });
  }
  transferOut(p, where) {
    this.vacate(p, 30);
    if (p.nurseId) { const n = this.nurseById(p.nurseId); if (n) n.patients = n.patients.filter(id => id !== p.id); }
    p.status = 'gone'; p.area = 'gone'; p.goneT = this.t; p.mon.on = false;
    this.sys(`${p.name} transferred ${where}.`, 0, p);
    this.moveBoarders();
  }
  moveBoarders() {
    for (const p of this.patients) if (p.boarding && this.freeRoom()) { this.admit(p); this.charge(`Moved ${p.name} into ${p.room}.`, 0, [], p); }
  }

  // -------------------------------------------------------------------- delivery
  startPushing(p) {
    if (p.pushing === 'pushing') return;
    p.pushing = 'pushing'; p.pushStartT = this.t;
    if (!p.T.complete) { this.logTruth(p, `Started pushing at ${p.T.dil.toFixed(1)} cm (not complete)`); p.T.fatigue = Math.min(0.85, p.T.fatigue + 0.2); }
  }
  deliver(p, mode, extra = {}) {
    if (p.outcome) return;
    if (mode === 'vaginal' && !extra.sdChecked && maybeShoulderDystocia(this, p, extra)) return;
    const T = p.T;
    T.zav = false;
    if (p.dx.breech && mode !== 'cs') extra.breechVaginal = true;
    const neo = neonatalOutcome(p, this, mode === 'cs' ? 'cs' : 'vaginal', extra);
    const gbsFirst = p.meds.abx.find(a => ['penicillin', 'ampicillin', 'cefazolin'].includes(a.drug) || (a.drug === 'clindamycin' && p.clindaSusc) || a.drug === 'vancomycin');
    p.gbsAdequate = !!gbsFirst && this.t - gbsFirst.t >= 4 * H;
    const secondStageH = p.completeT > 0 ? (this.t - p.completeT) / H : 0;
    p.outcome = { mode, t: this.t, neo, vacuum: !!extra.vacuum, secondStageH, pmcd: !!extra.pmcd, shoulder: !!extra.shoulder, csInd: p.csRequest ? p.csRequest.ind : null, urgency: p.csRequest ? p.csRequest.urgency : null };
    p.status = 'delivered';
    this.setPit(p, 0, 'delivery'); p.meds.pit.protocol = null;
    p.meds.ppOxy = true;
    if (p.meds.cervidil.in) this.removeCervidil(p);
    p.meds.foley.in = false;
    p.pushing = 'no';
    startPostpartum(p, this, mode === 'cs' ? 'cs' : 'vaginal', { secondStageH, vacuum: extra.vacuum, ga: extra.ga, shoulder: extra.shoulder });
    p.mon.on = false;
    this.logTruth(p, `Delivered (${mode}${extra.vacuum ? ', vacuum' : ''}): true BD ${T.bd.toFixed(1)}`);
    const where = extra.pmcd ? 'AT THE BEDSIDE' : mode === 'cs' ? 'in the OR' : mode === 'home' ? 'at home' : p.area === 'triage' ? 'IN TRIAGE' : '';
    const nt = neo.liveborn ? `Baby ${neo.sex}, ${neo.weight} g, Apgars ${neo.apgar1}/${neo.apgar5}${neo.notes.length ? '. ' + neo.notes.join('; ') : ''}.` : 'Stillborn.';
    this.msg(mode === 'cs' ? 'OR' : (this.nurseOf(p)?.name || 'RN') + ', RN', 'delivery', p, `Delivered ${where} at ${this.clock()} (${mode === 'cs' ? 'cesarean' : mode === 'home' ? 'precipitous, unattended' : 'vaginal' + (extra.vacuum ? ', vacuum' : '')}). ${nt}${neo.nicu ? ' NICU team taking baby.' : ''}`, neo.nicu || !neo.liveborn ? 2 : 1);
    if (neo.liveborn) this.after(15 * MIN, () => this.msg('Lab', 'lab', p, `Cord gas (arterial): pH ${neo.pH.toFixed(2)}, BD ${neo.bd}.`, neo.pH < 7.1 ? 2 : 0));
    if (mode !== 'cs' && mode !== 'home' && p.area === 'triage') { const room = this.freeRoom(); if (room) { this.vacate(p, 0); this.placeInRoom(p, room); } }
    if (p.area === 'ldr' || p.area === 'triage') p.status = 'recovery';
    if (!p.crisis && mode !== 'home') {
      const r = erng(p);
      if (r.chance(AFE_AT_DELIVERY * (mode === 'cs' ? 2 : 1) * (extra.vacuum ? 1.5 : 1) * this.rare.afe)) this.after(r.range(1, 20) * MIN, () => startAFE(this, p));
    }
  }
  vacuum(p) {
    const T = p.T, r = this.nrng;
    if (!T.complete || T.station < 2 || !T.rom || p.gaDays < 238 || p.dx.breech) {
      const why = !T.complete ? `she's not complete (you feel a ${Math.round(T.dil)}-cm rim)` : T.station < 2 ? `the head is only at ${Math.round(T.station)} station` : !T.rom ? 'membranes are intact' : p.dx.breech ? 'it\'s a breech' : 'she is too preterm';
      this.mdSays(p, `You examine before applying the vacuum: ${why}. Not a vacuum candidate.`, 1);
      return;
    }
    const pSucc = clamp(0.93 - (T.station < 3 ? 0.15 : 0) - (T.op ? 0.2 : 0) - (T.efw > 4000 ? 0.15 : 0) - 0.1 * T.fatigue, 0.3, 0.97);
    const ok = r.chance(pSucc);
    p.flags.vacuumT = this.t;
    this.mdSays(p, `Vacuum applied (Kiwi) at +${Math.round(T.station)}…`, 1);
    const dur = r.range(4, 14) * MIN;
    T.bd += 0.5;
    this.after(dur, () => {
      if (p.outcome) return;
      if (ok) { this.deliver(p, 'vaginal', { vacuum: true }); }
      else {
        T.bd += 1;
        this.mdSays(p, `Three pulls, two pop-offs, no descent — vacuum abandoned. Going to the OR.`, 2);
        p.flags.failedVacuum = true;
        this.requestCS(p, 'urgent', 'failed_ovd');
      }
    });
  }

  // -------------------------------------------------------------------- OR & anesthesia
  requestEpidural(p) {
    p.epidural.state = 'queued'; p.epidural.reqT = this.t;
    if (p.flags.epiRequestT == null) p.flags.epiRequestT = this.t;
    const needsPlt = (p.known.preE === 'severe' || p.dx.hellp && p.known.preE !== 'none') && !(p.flags.lastCbcT && this.t - p.flags.lastCbcT < 6 * H);
    if (needsPlt) {
      p.epidural.state = 'awaiting_plt';
      this.msg(this.anes[0].short, 'anesthesia', p, `I need a platelet count on her before I place anything. Sending a CBC.`, 1);
      this.orderLab(p, 'cbc');
      return;
    }
    const known = this.labValue(p, 'plt');
    if (known != null && known < 70) {
      p.epidural.state = 'none';
      this.msg(this.anes[0].short, 'anesthesia', p, `Platelets ${known} — no neuraxial. I can do a remifentanil PCA or IV fentanyl.`, 1);
      return;
    }
    this.anesQueue.push({ kind: 'epidural', pid: p.id, t: this.t });
    this.msg(this.anes[0].short, 'anesthesia', p, this.anes.every(a => a.busyUntil > this.t) ? `Got the epidural request. I'm tied up — ${this.anesBusyText()}.` : `On my way for the epidural.`, 0);
  }
  anesthesiaPlateletsBack(p, plt) {
    if (p.epidural.state !== 'awaiting_plt') return;
    if (plt < 70) { p.epidural.state = 'none'; this.msg(this.anes[0].short, 'anesthesia', p, `Platelets ${plt}. No epidural — too risky.`, 1); return; }
    p.epidural.state = 'queued';
    this.anesQueue.push({ kind: 'epidural', pid: p.id, t: this.t });
  }
  anesthesiaTreatHypotension(p) {
    const a = this.anes.find(x => x.busyUntil <= this.t);
    if (a && this.nrng.chance(0.75)) { this.addDose(p, { drug: 'phenylephrine', amt: 100, route: 'IV' }); this.note(p, 'Phenylephrine 100 (anesthesia)'); }
  }
  anesBusyText() {
    const a = this.anes[0];
    if (!a.task) return 'free';
    const p = this.byId[a.task.pid];
    if (a.task.kind === 'code') return `running a code in ${p ? p.room : '?'}`;
    return `${a.task.kind === 'cs' ? 'in the OR' : 'placing an epidural in ' + (p ? p.room : '?')}, ~${Math.max(1, Math.round((a.busyUntil - this.t) / 60))} min`;
  }
  requestCS(p, urgency, ind) {
    if (p.csRequest && ind !== 'pph_or') return;
    const req = { urgency, ind, reqT: this.t, phase: 'waiting', pid: p.id };
    if (ind === 'pph_or') { req.pp = true; }
    else p.csRequest = req;
    this.csQueue.push(req);
    p.flags.csDecisionT = p.flags.csDecisionT ?? this.t;
    if (!req.pp && p.meds.pit.rate > 0) this.setPit(p, 0, 'cs');
    const orBusy = this.ors.every(o => o.pid || o.cleanUntil > this.t);
    const txt = urgency === 'stat' ? `STAT section called for ${p.room || p.name}. ${orBusy ? 'OR is OCCUPIED — ' + this.orBusyText() + '.' : 'Opening the OR.'}` :
      urgency === 'urgent' ? `Urgent C-section for ${p.room || p.name} booked. ${orBusy ? 'OR busy: ' + this.orBusyText() + '.' : 'Next up.'}` : `${p.name} added to the OR board (scheduled).`;
    this.charge(txt, urgency === 'stat' ? 2 : 1, orBusy && urgency === 'stat' && !this.backupCalled ? [{ label: 'Call backup team', cmd: { type: 'order', pid: p.id, text: 'call backup' } }] : [], p);
    if (urgency !== 'routine') this.bumpScheduled();
  }
  bumpScheduled() {
    for (const q of this.csQueue) {
      if (q.urgency === 'routine' && q.phase === 'waiting' && !q.bumpedMsg) {
        const qp = this.byId[q.pid];
        if (qp && qp.kind === 'cs_sched') { q.bumpedMsg = true; this.charge(`Heads up: ${qp.name}'s scheduled ${qp.dx.twins ? 'twin' : 'repeat'} section is bumped. She's NPO and not thrilled.`, 0, [], qp); qp.flags.bumped = (qp.flags.bumped || 0) + 1; }
      }
    }
  }
  orBusyText() {
    return this.ors.map(o => o.pid ? `${o.name}: ${this.byId[o.pid].name} (${o.phase}${o.busyUntil > this.t ? ', ~' + Math.round((o.busyUntil - this.t) / 60) + ' min' : ''})` : o.cleanUntil > this.t ? `${o.name}: cleaning` : `${o.name}: free`).join('; ');
  }
  callBackup() {
    if (this.backupCalled) { this.charge('Backup team is already on the way / here.', 0); return; }
    this.backupCalled = true;
    this.charge('Calling in the backup OR team and second anesthesiologist — about 30 minutes out.', 1);
    this.after(30 * MIN, () => {
      this.ors.push({ name: 'OR 2', pid: null, busyUntil: 0, phase: null, cleanUntil: 0, backup: true });
      this.anes.push({ name: 'Dr. Mbeki (backup anesthesia)', short: 'Backup anesthesia', busyUntil: 0, task: null, backup: true });
      this.charge('Backup team is here — OR 2 is open.', 1);
    });
  }
  resourceStep() {
    const t = this.t;
    // anesthesia: CS first (by urgency), then epidurals
    const prio = { stat: 0, urgent: 1, routine: 2 };
    const waiting = this.csQueue.filter(q => q.phase === 'waiting' && (q.notBefore == null || t >= q.notBefore)).sort((a, b) => prio[a.urgency] - prio[b.urgency] || a.reqT - b.reqT);
    for (const q of waiting) {
      // a crash section doesn't wait for the cleaning crew to finish
      const or = this.ors.find(o => !o.pid && (t >= o.cleanUntil || q.urgency === 'stat'));
      if (!or) break;
      let a = this.anes.find(x => x.busyUntil <= t);
      if (!a && q.urgency === 'stat') {
        // pull anesthesia off an epidural in progress
        const e = this.anes.find(x => x.task && x.task.kind === 'epidural');
        if (e && !e.task.interrupted) { e.task.interrupted = true; e.busyUntil = Math.min(e.busyUntil, t + 3 * MIN); }
      }
      if (!a) continue;
      this.startCS(q, or, a);
    }
    for (const a of this.anes) {
      if (a.busyUntil > t) continue;
      if (a.task && a.task.kind === 'epidural') this.finishEpidural(a);
      if (a.task && a.task.kind === 'cs') continue;
      // don't start an epidural if a stat/urgent CS is waiting for an OR to free soon
      const urgentWaiting = this.csQueue.some(q => q.phase === 'waiting' && q.urgency !== 'routine');
      if (urgentWaiting && this.anes.filter(x => x.busyUntil <= t).length <= 1) continue;
      const idx = this.anesQueue.findIndex(e => e.kind === 'epidural');
      if (idx >= 0) {
        const e = this.anesQueue.splice(idx, 1)[0];
        const p = this.byId[e.pid];
        if (!p || p.T.pp || p.area === 'or' || p.status === 'gone') continue;
        p.epidural.state = 'placing';
        const dur = this.nrng.range(15, 28) * MIN;
        a.task = { kind: 'epidural', pid: p.id, start: t };
        a.busyUntil = t + dur;
        p.flags.epiStartT = t;
      }
    }
  }
  finishEpidural(a) {
    const p = this.byId[a.task.pid];
    const interrupted = a.task.interrupted;
    a.task = null;
    if (!p || p.T.pp || p.area === 'or') return;
    if (interrupted && this.nrng.chance(0.5)) { p.epidural.state = 'queued'; this.anesQueue.unshift({ kind: 'epidural', pid: p.id, t: this.t }); this.msg(this.anes[0].short, 'anesthesia', p, `Had to step out for the stat section — I'll come back to finish her epidural.`, 0); return; }
    const plt = p.T.plt;
    if (plt < 70 && this.nrng.chance(plt < 50 ? 0.06 : 0.01)) { (p.harms || (p.harms = [])).push({ t: this.t, kind: 'epidural_hematoma' }); this.logTruth(p, 'Epidural hematoma (true plt ' + Math.round(plt) + ')'); }
    p.flags.epiDoneT = this.t;
    this.note(p, 'Epidural placed');
    // working status flips after 10 min of dosing
    p.epidural.state = 'dosing';
    this.after(10 * MIN, () => { if (p.epidural.state === 'dosing') { p.epidural.state = 'working'; p.epidural.workT = this.t; } });
    this.page(p, `Epidural is in. She's ${this.nrng.chance(0.85) ? 'getting comfortable' : 'still feeling her left side'}.`, 0);
  }
  startCS(q, or, a) {
    const p = this.byId[q.pid];
    const t = this.t;
    if (!p || (p.outcome && !q.pp) || p.status === 'gone') { q.phase = 'done'; return; }
    q.phase = 'or';
    q.startT = t;
    or.pid = p.id; or.phase = 'prep';
    a.task = { kind: 'cs', pid: p.id }; a.busyUntil = 1e12;
    const wasRoom = p.area === 'ldr';
    if (wasRoom || p.area === 'triage') this.vacate(p, 30);
    p.area = 'or'; p.room = or.name;
    if (q.pp) {
      const dur = this.nrng.range(40, 80) * MIN;
      or.phase = 'hemorrhage surgery'; or.busyUntil = t + dur;
      this.charge(`${p.name} is back in ${or.name} for hemorrhage.`, 1, [], p);
      this.after(10 * MIN, () => { p.T.pp.returnOR = true; if (p.T.pp.qbl > 2500 && this.nrng.chance(0.35)) { p.T.pp.hyst = true; this.logTruth(p, 'Hysterectomy'); } });
      this.after(dur, () => this.endCase(or, a, p));
      return;
    }
    const epi = p.epidural.state === 'working' || p.epidural.state === 'dosing';
    const transfer = { stat: 4, urgent: 10, routine: 15 }[q.urgency] * MIN;
    let anesT, ga = false;
    if (epi) anesT = (q.urgency === 'stat' ? 3 : 10) * MIN;
    else if (q.urgency === 'stat') { anesT = 3 * MIN; ga = true; }
    else anesT = 10 * MIN;
    const incision = t + transfer + anesT;
    const repeat = p.priorCS > 0;
    const toDelivery = (q.urgency === 'stat' ? this.nrng.range(2, 4) : this.nrng.range(6, 12) + (repeat ? 3 : 0)) * MIN;
    q.incisionT = incision; q.ga = ga;
    p.flags.incisionT = incision; p.flags.ga = ga;
    const close = incision + toDelivery + this.nrng.range(35, 55) * MIN;
    or.busyUntil = close;
    this.charge(`${p.name} is going back to ${or.name}${ga ? ' — general anesthesia' : ''}. Incision in ~${Math.round((incision - t) / 60)} min.`, 0, [], p);
    this.at(incision, () => { or.phase = 'incision'; });
    this.at(incision + toDelivery, () => { or.phase = 'closing'; this.deliver(p, 'cs', { ga }); });
    this.at(close, () => this.endCase(or, a, p));
  }
  endCase(or, a, p) {
    or.pid = null; or.phase = null; or.cleanUntil = this.t + 20 * MIN;
    a.task = null; a.busyUntil = this.t;
    if (p.status !== 'gone') { p.area = 'pacu'; p.room = 'PACU'; }
    for (const q of this.csQueue) if (q.pid === p.id && q.phase === 'or') q.phase = 'done';
  }

  // -------------------------------------------------------------------- physio events
  emit(p, type, data) {
    const T = p.T;
    const offFloor = p.area === 'home' || p.area === 'offsite' || p.area === 'waiting';
    this.logTruth(p, type.toUpperCase());
    switch (type) {
      case 'crowning':
        if (p.area === 'or') return;
        if (offFloor) { if (p.area === 'home') this.homeWatch(p); else this.deliver(p, 'vaginal'); return; }
        this.deliver(p, 'vaginal');
        return;
      case 'urge_push':
        if (offFloor) return;
        this.page(p, `She's pushing on her own — can't stop her!`, 2, [{ label: 'Push', cmd: { type: 'order', pid: p.id, text: 'push' } }]);
        return;
      case 'complete':
        if (offFloor || p.area === 'or') return;
        if (p.epidural.state !== 'working' && p.ns) this.after(this.nrng.range(5, 20) * MIN, () => this.doSVE(p, 'nurse', 'pressure'));
        return;
      case 'srom':
        if (offFloor) return;
        this.after(this.nrng.range(1, 6) * MIN, () => {
          if (!p.chart.romKnown) { p.chart.romKnown = true; this.page(p, `Her water just broke — ${T.fluid === 'mec' ? 'thick meconium' : T.fluid === 'bloody' ? 'bloody fluid' : 'clear fluid'}.`, T.fluid === 'clear' ? 0 : 1); this.note(p, 'SROM ' + T.fluid); }
        });
        return;
      case 'prolapse':
        if (!offFloor && p.flags.lastAromT && this.t - p.flags.lastAromT < 600) this.mdSays(p, `You feel a pulsating loop of cord after the AROM!`, 3);
        if (p.area === 'waiting') this.after(this.nrng.range(2, 6) * MIN, () => { if (p.area === 'waiting') this.charge(`${p.name} in the WAITING ROOM says her water broke and something is hanging out!`, 3, [{ label: 'Straight to an LDR', cmd: { type: 'order', pid: p.id, text: 'admit' } }, { label: 'C-section STAT', cmd: { type: 'order', pid: p.id, text: 'c-section stat cord prolapse' } }], p); });
        return;
      case 'abruption':
        if (offFloor) return;
        this.after(this.nrng.range(3, 12) * MIN, () => this.page(p, `She's having bright red bleeding and constant pain — her belly feels hard.`, 3,
          [{ label: 'C-section STAT', cmd: { type: 'order', pid: p.id, text: 'c-section stat for abruption' } }, { label: 'Bedside US', cmd: { type: 'order', pid: p.id, text: 'bedside US' } }, { label: 'T&S, CBC, fib', cmd: { type: 'order', pid: p.id, text: 'fibrinogen' } }]));
        return;
      case 'rupture':
        if (offFloor) return;
        this.after(this.nrng.range(1, 4) * MIN, () => this.page(p, `She's screaming — says something tore. ${p.epidural.state === 'working' ? 'Breakthrough pain through the epidural. ' : ''}Station feels higher.`, 3,
          [{ label: 'C-section STAT', cmd: { type: 'order', pid: p.id, text: 'c-section stat for uterine rupture' } }]));
        return;
      case 'eclampsia':
        if (offFloor) return;
        this.page(p, `SHE'S SEIZING! Room ${p.room}!`, 3, [{ label: 'Mag 4 g load + 2 g/h', cmd: { type: 'order', pid: p.id, text: 'mag 4 g IV load then 2 g/h' } }, { label: 'Mag 2 g bolus', cmd: { type: 'order', pid: p.id, text: 'mag 2 g IV bolus' } }]);
        return;
      case 'stroke':
        if (offFloor) return;
        this.page(p, `She's slurring her words and can't move her right arm!`, 3);
        return;
      case 'mag_resp':
        if (offFloor) return;
        this.page(p, `She's really hard to wake up and her breathing is shallow!`, 3, [{ label: 'Stop mag', cmd: { type: 'order', pid: p.id, text: 'stop mag' } }, { label: 'Calcium gluconate', cmd: { type: 'order', pid: p.id, text: 'calcium gluconate 1 g IV' } }]);
        return;
      case 'afe':
        startAFE(this, p);
        return;
      case 'mag_arrest':
        startMagArrest(this, p);
        return;
      case 'hem_arrest':
        if (p.area === 'home' || p.area === 'offsite') return;
        startHemArrest(this, p);
        return;
      case 'foley_out':
        if (offFloor) return;
        this.page(p, `Her Foley bulb fell out.`, 1, [{ label: 'SVE', cmd: { type: 'order', pid: p.id, text: 'SVE' } }, { label: 'AROM', cmd: { type: 'order', pid: p.id, text: 'AROM' } }, { label: 'Pit protocol', cmd: { type: 'order', pid: p.id, text: 'pit per protocol' } }]);
        return;
      case 'shock':
        this.page(p, `She's pale, BP ${Math.round(T.sbp)}/${Math.round(T.dbp)}, HR ${Math.round(T.hr)}!`, 3,
          [{ label: 'Transfuse 2u', cmd: { type: 'order', pid: p.id, text: 'transfuse 2 units' } }, { label: 'MTP', cmd: { type: 'order', pid: p.id, text: 'massive transfusion' } }, { label: 'Return to OR', cmd: { type: 'order', pid: p.id, text: 'return to OR' } }]);
        return;
      default: return;
    }
  }

  transfuse(p, n) {
    const T = p.T;
    if (T.pp) { T.pp.transfused += n * 350; T.pp.lastTransfuse = this.t; }
    else T.qblAntepartum = Math.max(0, T.qblAntepartum - n * 350);
    T.hgb += n * 0.9;
    p.flags.transfused = (p.flags.transfused || 0) + n;
    this.note(p, `${n}u PRBC`);
  }

  // -------------------------------------------------------------------- tracing lab
  labSet(cmd) {
    const p = this.byId[cmd.pid] || this.patients[0];
    if (!p) return { ok: false };
    const T = p.T;
    if (cmd.key === 'pit') this.setPit(p, cmd.value, 'lab');
    else if (cmd.key === 'plac') T.plac = cmd.value;
    else if (cmd.key === 'bd') T.bd = cmd.value;
    else if (cmd.key === 'cordVuln') T.cordVuln = cmd.value;
    else if (cmd.key === 'rom') { if (cmd.value && !T.rom) { T.rom = true; T.romT = this.t; } }
    else if (cmd.key === 'map') T.sbp0 = cmd.value;
    else if (cmd.key === 'temp') T.temp0 = cmd.value;
    else if (cmd.key === 'labor') { T.laborOnset = !!cmd.value; if (cmd.value) T.S = Math.max(T.S, 0.6); }
    else if (cmd.key === 'dil') T.dil = cmd.value;
    else if (cmd.key === 'fse') p.devices.fse = !!cmd.value;
    else if (cmd.key === 'iupc') p.devices.iupc = !!cmd.value;
    else if (cmd.key === 'prolapse') T.prolapse = !!cmd.value;
    else if (cmd.key === 'epiHypo') { T.epiHypoT = this.t; T.epiHypoDepth = cmd.value; }
    return { ok: true };
  }
}

function shortLabel(s) {
  return s.replace(/\(.*?\)/g, '').replace(/ IV bolus| maintenance/g, '').slice(0, 34).trim();
}
