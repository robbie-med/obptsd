// The floor as a place. Everyone who works here is a dot on a 2D plan that walks a waypoint graph in
// game seconds: you, the nurses, the charge nurse, anesthesia, the backup OB. Bedside work happens
// only when someone is at the bedside, so how long an order takes falls out of where people are and
// what else they're doing (SPEC §3.2: you manage what the nurses do, not what you wish they did).
//
// Nurses run a small utility scheduler: every task has a priority, an age and a travel cost; the best
// one wins and a much more urgent one preempts. Medications are drawn up in the med room. A nurse
// stuck elsewhere hands a STAT med to whichever colleague can get it there sooner, and experienced
// nurses grab what they expect to need on the way to a bad strip or a bleed.
//
// Deterministic: positions advance with sim.tick(), randomness comes from sim.frng (its own stream),
// and nothing here reads the wall clock.

const MIN = 60;
export const WALK = 1.3, HURRY = 2.1, RUN = 3.2; // m/s

// ------------------------------------------------------------------------------------- the plan
// Meters. L&D runs east-west along a corridor at y = 20; the OB ED (triage) is its own wing to the west,
// through a badge door and a public hallway.
const N = {};
const E = [];
function node(id, x, y, extra = {}) { N[id] = { id, x, y, ...extra }; return id; }
function edge(a, b, extra = 0) { E.push([a, b, extra]); }

// L&D corridor
const CX = [0, 5, 14, 19, 23, 32, 41, 48, 56, 64];
CX.forEach(x => node('c' + x, x, 20));
for (let i = 0; i < CX.length - 1; i++) edge('c' + CX[i], 'c' + CX[i + 1]);
// rooms off the corridor: [place, corridor x, side(-1 north/+1 south), depth]
export const ROOMS_LAYOUT = [
  ['LDR 1', 5, -1], ['LDR 2', 14, -1], ['LDR 3', 23, -1], ['LDR 4', 32, -1],
  ['LDR 5', 5, 1], ['LDR 6', 14, 1], ['LDR 7', 23, 1], ['LDR 8', 32, 1],
  ['Med room', 41, -1], ['Report room', 41, 1],
  ['OR 1', 56, -1], ['OR 2', 64, -1], ['PACU', 56, 1], ['Call room', 64, 1],
];
for (const [name, x, side] of ROOMS_LAYOUT) {
  node('d:' + name, x, 20 + side * 4);
  node(name, x, 20 + side * 10, { place: true });
  edge('c' + x, 'd:' + name); edge('d:' + name, name);
}
node('Station', 19, 20, { place: true }); // island in the corridor; c19 is its spot
edge('Station', 'c19');
node('Unit doors', 48, 20, { place: true }); edge('Unit doors', 'c48');
// hallway to the OB ED (badge door each end)
node('hall', -8, 20); node('hallW', -16, 20);
edge('c0', 'hall', 4); edge('hall', 'hallW'); // badge reader at the L&D end
// OB ED wing
const OX = [-20, -27, -34, -41];
OX.forEach(x => node('o' + x, x, 20));
edge('hallW', 'o-20', 4); // and at the OB ED end
for (let i = 0; i < OX.length - 1; i++) edge('o' + OX[i], 'o' + OX[i + 1]);
export const OBED_LAYOUT = [['Triage A', -41, -1], ['Triage B', -34, -1], ['Triage C', -27, -1], ['Waiting', -34, 1], ['OB ED station', -20, -1], ['Entrance', -41, 1]];
for (const [name, x, side] of OBED_LAYOUT) {
  node('d:' + name, x, 20 + side * 4);
  node(name, x, 20 + side * 9, { place: true });
  edge('o' + x, 'd:' + name); edge('d:' + name, name);
}

// all-pairs shortest paths (Floyd-Warshall over ~70 nodes, once per page load)
const IDS = Object.keys(N);
const IX = Object.fromEntries(IDS.map((id, i) => [id, i]));
const n = IDS.length;
const D = Array.from({ length: n }, () => new Float64Array(n).fill(Infinity));
const NX = Array.from({ length: n }, () => new Int16Array(n).fill(-1));
for (let i = 0; i < n; i++) { D[i][i] = 0; NX[i][i] = i; }
for (const [a, b, extra] of E) {
  const i = IX[a], j = IX[b];
  const d = Math.hypot(N[a].x - N[b].x, N[a].y - N[b].y) + extra;
  D[i][j] = D[j][i] = d; NX[i][j] = j; NX[j][i] = i;
}
for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) { const dik = D[i][k]; if (dik === Infinity) continue; for (let j = 0; j < n; j++) { const v = dik + D[k][j]; if (v < D[i][j]) { D[i][j] = v; NX[i][j] = NX[i][k]; } } }
function route(a, b) { const out = []; let i = IX[a]; const j = IX[b]; if (NX[i][j] < 0) return out; while (i !== j) { i = NX[i][j]; out.push(IDS[i]); } return out; }
function dist(a, b) { return D[IX[a]][IX[b]]; }

export const PLAN = { nodes: N, edges: E, rooms: ROOMS_LAYOUT, obed: OBED_LAYOUT, bounds: { x0: -46, x1: 69, y0: 6, y1: 34 } };

// where a patient physically is
export function placeOf(p) {
  if (!p || p.status === 'gone') return null;
  if (p.area === 'waiting') return 'Waiting';
  if (p.room && N[p.room]) return p.room;
  if (p.area === 'or') return 'OR 1';
  return null;
}

// ------------------------------------------------------------------------------------- agents
function mkAgent(id, kind, name, place) {
  const nd = N[place];
  return { id, kind, name, x: nd.x, y: nd.y, px: nd.x, py: nd.y, at: place, from: place, path: [], speed: WALK,
    task: null, queue: [], home: place, carrying: [], doing: '', present: true };
}

export class Floor {
  constructor(sim) {
    this.sim = sim;
    this.agents = [];
    this.byId = {};
    this.seq = 1;
    this.md = this.add(mkAgent('md', 'md', 'You', 'Report room'));
    this.md.manual = null;
    this.charge = this.add(mkAgent('charge', 'charge', sim.chargeName || 'Charge', 'Station'));
    this.anes = this.add(mkAgent('anes', 'anes', 'Anesthesia', 'Call room'));
    for (const nu of sim.nurses) this.addNurse(nu);
  }
  add(a) { this.agents.push(a); this.byId[a.id] = a; return a; }
  addNurse(nu) {
    if (this.byId[nu.id]) return this.byId[nu.id];
    const home = nu.role === 'triage' ? 'OB ED station' : 'Station';
    let start = home;
    // the day team's nurses are with their patients when the night opens
    const p = nu.patients.length ? this.sim.byId[nu.patients[0]] : null;
    if (p && placeOf(p) && nu.role !== 'triage') start = placeOf(p);
    const a = this.add(mkAgent(nu.id, 'nurse', nu.name, start));
    a.home = home; a.nurse = nu; a.present = !!nu.onDuty;
    return a;
  }
  agentOf(nurse) { return nurse ? this.byId[nurse.id] || this.addNurse(nurse) : null; }

  // ----------------------------------------------------------------------------- movement
  // distance in meters from where the agent is now to a place (via the better end of the edge it's on)
  distTo(a, place) {
    if (!N[place]) return 0;
    if (!a.path.length) return dist(a.at, place) + Math.hypot(a.x - N[a.at].x, a.y - N[a.at].y);
    const next = a.path[0];
    const viaNext = Math.hypot(a.x - N[next].x, a.y - N[next].y) + dist(next, place);
    const viaFrom = Math.hypot(a.x - N[a.from].x, a.y - N[a.from].y) + dist(a.from, place);
    return Math.min(viaNext, viaFrom);
  }
  eta(a, place, speed = a.speed) { return this.distTo(a, place) / speed; }
  goTo(a, place, speed = WALK) {
    if (!N[place]) return;
    a.speed = speed;
    if (a.path.length) {
      const next = a.path[0];
      const viaNext = Math.hypot(a.x - N[next].x, a.y - N[next].y) + dist(next, place);
      const viaFrom = Math.hypot(a.x - N[a.from].x, a.y - N[a.from].y) + dist(a.from, place);
      a.path = viaNext <= viaFrom ? [next, ...route(next, place)] : [a.from, ...route(a.from, place)];
      if (a.path.length > 1 && a.path[0] === a.path[1]) a.path.shift();
    } else {
      if (a.at === place) return;
      a.from = a.at;
      a.path = route(a.at, place);
    }
    a.dest = place;
  }
  arrived(a, place) { return !a.path.length && a.at === place; }
  stepMove(a) {
    a.px = a.x; a.py = a.y;
    let budget = a.speed;
    while (budget > 0 && a.path.length) {
      const nd = N[a.path[0]];
      const d = Math.hypot(nd.x - a.x, nd.y - a.y);
      if (d <= budget) { a.x = nd.x; a.y = nd.y; a.at = nd.id; a.from = nd.id; a.path.shift(); budget -= d; }
      else { a.x += (nd.x - a.x) / d * budget; a.y += (nd.y - a.y) / d * budget; budget = 0; }
    }
  }

  // ----------------------------------------------------------------------------- tasks
  // task: { key, kind, pid, prio, steps: [{ place, dur, label, run? }], i, left, created, speed }
  task(o) { return { i: 0, left: null, created: this.sim.t, id: this.seq++, ...o }; }
  hasTask(a, key) { return (a.task && a.task.key === key) || a.queue.some(t => t.key === key); }
  give(a, t) {
    if (t.key && this.hasTask(a, t.key)) return null;
    a.queue.push(t);
    return t;
  }
  speedFor(prio) { return prio >= 8 ? RUN : prio >= 6 ? HURRY : WALK; }
  score(a, t) {
    const st = t.steps[t.i];
    const travel = st && st.place ? this.distTo(a, st.place) / WALK : 0;
    return t.prio * 100 + (this.sim.t - t.created) / 12 - travel / 3; // waiting 20 min ≈ one priority level
  }
  pick(a) {
    if (!a.queue.length) return null;
    let best = 0, bs = -Infinity;
    a.queue.forEach((t, i) => { const s = this.score(a, t); if (s > bs) { bs = s; best = i; } });
    return a.queue.splice(best, 1)[0];
  }
  runTask(a) {
    const sim = this.sim;
    // preemption: something three priority levels hotter interrupts (a half-done step starts over)
    if (a.task && a.queue.length) {
      let hi = -1;
      a.queue.forEach((t, i) => { if (t.prio >= a.task.prio + 3 && (hi < 0 || t.prio > a.queue[hi].prio)) hi = i; });
      if (hi >= 0) { const hot = a.queue.splice(hi, 1)[0]; a.task.left = null; a.queue.push(a.task); a.task = hot; }
    }
    if (!a.task) a.task = this.pick(a);
    const t = a.task;
    if (!t) { this.idle(a); return; }
    if (t.cancel && t.cancel()) { a.task = null; return; }
    const st = t.steps[t.i];
    if (!st) { a.task = null; return; }
    const place = typeof st.place === 'function' ? st.place() : st.place;
    if (!place) { a.task = null; return; } // the patient left the floor
    if (!this.arrived(a, place)) {
      if (a.dest !== place || !a.path.length) this.goTo(a, place, t.speed || this.speedFor(t.prio));
      a.doing = st.walkLabel || `→ ${place}`;
      return;
    }
    if (t.left == null) t.left = Math.max(0, Math.round(st.dur || 0));
    a.doing = st.label || '';
    if (t.left > 0) { t.left--; return; }
    if (st.run) st.run(a);
    t.i++; t.left = null;
    if (t.i >= t.steps.length) { a.task = null; if (t.done) t.done(a); }
  }
  // with nothing to do: drift home to chart, or look in on a patient now and then
  idle(a) {
    const sim = this.sim;
    if (a.kind !== 'nurse') { if (!this.arrived(a, a.home) && a.dest !== a.home) this.goTo(a, a.home, WALK); a.doing = a.at === a.home ? (a.kind === 'charge' ? 'running the board' : '') : ''; return; }
    const nu = a.nurse;
    if (nu && nu.patients.length && sim.t % 60 === 0) {
      // a pushing patient has her nurse at the bedside; laboring, fresh postpartum and magnesium patients
      // get a lot of her time; a quiet antepartum gets a look every half hour or so
      const pts = nu.patients.map(id => sim.byId[id]).filter(p => p && placeOf(p) && placeOf(p) !== 'Waiting' && p.area !== 'or' && !(p.crisis && p.crisis.phase === 'dead'));
      const need = (p) => p.pushing === 'pushing' ? 1 : (p.T.pp && sim.t - p.T.pp.t0 < 2 * 3600) || p.meds.mag.on || (p.T.laborOnset && !p.T.pp && p.epidural.state !== 'working') ? 0.14 : p.T.laborOnset && !p.T.pp ? 0.07 : 0.03;
      const pushing = pts.find(p => p.pushing === 'pushing');
      const p = pushing || pts.find(q => sim.frng.chance(need(q)));
      if (p) {
        const label = p.pushing === 'pushing' ? 'pushing with ' : p.T.pp ? 'recovering ' : p.T.laborOnset && p.epidural.state !== 'working' ? 'labor support · ' : 'with ';
        this.give(a, this.task({ key: 'round:' + p.id, kind: 'round', pid: p.id, prio: p.pushing === 'pushing' ? 2 : 1,
          cancel: () => p.status === 'gone' || !placeOf(p) || (p.crisis && p.crisis.phase === 'dead'),
          steps: [{ place: () => placeOf(p), dur: p.pushing === 'pushing' ? 600 : sim.frng.range(240, 900), label: label + p.name.split(' ')[0] }] }));
        return;
      }
    }
    if (!this.arrived(a, a.home) && a.dest !== a.home) this.goTo(a, a.home, WALK);
    if (this.arrived(a, a.home)) { a.doing = 'charting'; a.carrying.length = 0; } else a.doing = '';
  }

  // ----------------------------------------------------------------------------- per tick
  tick() {
    const sim = this.sim;
    for (const a of this.agents) {
      if (a.kind === 'nurse') {
        a.present = !!a.nurse.onDuty;
        if (!a.present) { a.queue.length = 0; a.task = null; if (a.at !== 'Entrance' || a.path.length) { if (a.dest !== 'Entrance') this.goTo(a, 'Entrance', WALK); this.stepMove(a); a.leaving = true; } continue; }
        if (a.leaving) { a.leaving = false; const nd = N['Report room']; a.x = a.px = nd.x; a.y = a.py = nd.y; a.at = a.from = 'Report room'; a.path = []; }
        this.runTask(a);
      } else if (a.kind === 'md') this.mdTick(a);
      else if (a.kind === 'anes') this.anesTick(a);
      else if (a.kind === 'backup') this.backupTick(a);
      else this.runTask(a);
      this.stepMove(a);
    }
  }
  mdTick(a) {
    // you walk where you click; queued bedside work (your exams, procedures) runs in order after that
    if (a.manual) {
      if (this.arrived(a, a.manual)) { a.manual = null; a.doing = ''; }
      else { if (a.dest !== a.manual || !a.path.length) this.goTo(a, a.manual, a.manualSpeed || WALK); a.doing = `→ ${a.manual}`; return; }
    }
    if (!a.task && a.queue.length) a.task = a.queue.shift(); // FIFO: your own to-do list
    if (a.task) this.runTask(a); else a.doing = '';
  }
  anesTick(a) {
    const sim = this.sim, an = sim.anes[0];
    const tk = an && an.task;
    let place = 'Call room', label = '';
    if (tk && tk.pid) {
      const p = sim.byId[tk.pid];
      place = placeOf(p) || 'Call room';
      label = tk.kind === 'epidural' ? 'epidural' : tk.kind === 'cs' ? 'cesarean' : tk.kind === 'code' ? 'CODE' : tk.kind;
    }
    if (!this.arrived(a, place) && a.dest !== place) this.goTo(a, place, tk && tk.kind === 'code' ? RUN : tk ? HURRY : WALK);
    a.doing = label;
  }
  backupTick(a) {
    if (a.task) this.runTask(a);
    else if (!this.arrived(a, 'Entrance')) { if (a.dest !== 'Entrance') this.goTo(a, 'Entrance', WALK); }
    else a.present = false;
  }

  // ----------------------------------------------------------------------------- API used by the sim
  // You: walk somewhere (a command, so it's logged and replayed)
  walk(place, speed = WALK) {
    if (!N[place] || !N[place].place) return { ok: false, msg: `No such place: ${place}` };
    this.md.manual = place; this.md.manualSpeed = speed;
    return { ok: true, msg: this.arrived(this.md, place) ? `You're in ${place}.` : `Walking to ${place} (~${Math.round(this.eta(this.md, place, speed))} s).` };
  }
  mdHere(p) { const pl = placeOf(p); return !!pl && this.arrived(this.md, pl); }
  mdEta(p) { const pl = placeOf(p); return pl ? this.eta(this.md, pl, RUN) : 0; }
  // your bedside work: walk there, then do it
  mdTask(p, label, dur, run, prio = 5) {
    const t = this.task({ key: null, kind: 'md', pid: p.id, prio, speed: prio >= 8 ? RUN : HURRY,
      steps: [{ place: () => placeOf(p), dur, label, walkLabel: `→ ${p.room || 'her'} (${label})`, run }] });
    this.md.queue.push(t);
    return Math.round(this.eta(this.md, placeOf(p) || this.md.at, t.speed) + (this.md.queue.length > 1 ? 60 : 0) + dur);
  }
  // emergencies: you hear the overhead and run (anything you were walking to can wait)
  summonMd(p, why) {
    const pl = placeOf(p);
    if (!pl) return;
    if (!this.arrived(this.md, pl)) { this.md.manual = pl; this.md.manualSpeed = RUN; }
    this.md.alert = why;
  }
  // all hands: free nurses and the charge nurse run to the room and stay while it lasts
  allHands(p, until, max = 3) {
    const sim = this.sim, pl = placeOf(p);
    if (!pl) return;
    const own = this.agentOf(sim.nurseOf(p));
    const crew = [own, this.charge, ...this.agents.filter(a => a.kind === 'nurse' && a.present && a !== own && a.nurse.role !== 'triage')
      .sort((x, y) => this.distTo(x, pl) - this.distTo(y, pl))].filter(Boolean).slice(0, max + 1);
    for (const a of crew) {
      if (a.task && a.task.key === 'emerg:' + p.id) continue;
      if (a.task) { a.task.left = null; a.queue.push(a.task); a.task = null; }
      a.task = this.task({ key: 'emerg:' + p.id, kind: 'emerg', pid: p.id, prio: 9, speed: RUN, cancel: () => !until(),
        steps: [{ place: () => placeOf(p), dur: 1e9, label: 'EMERGENCY' }] });
    }
  }
  // a nurse's bedside job (vitals, exam, titration, resus...). Deduplicated by key.
  // `grab`: drugs she'll pick up on the way if the med room costs her under ~25 m of detour.
  bedside(nurse, p, key, prio, dur, label, run, grab = []) {
    const a = this.agentOf(nurse);
    const pl = placeOf(p);
    if (!a || !a.present || !pl || pl === 'Waiting' || p.area === 'or') { run && run(null); return null; }
    if (this.hasTask(a, key + ':' + p.id)) return null;
    const steps = [];
    const need = grab.filter(d => !a.carrying.includes(d));
    if (need.length && this.distTo(a, 'Med room') + dist('Med room', pl) - this.distTo(a, pl) < 25)
      steps.push({ place: 'Med room', dur: 25, label: `grabbing ${need.join(', ')}`, run: (ag) => ag.carrying.push(...need) });
    steps.push({ place: () => placeOf(p), dur, label: `${label} · ${p.name.split(' ')[0]}`, run });
    return this.give(a, this.task({ key: key + ':' + p.id, kind: key, pid: p.id, prio, speed: this.speedFor(prio),
      cancel: () => p.status === 'gone' || !placeOf(p) || placeOf(p) === 'Waiting' || (p.crisis && p.crisis.phase === 'dead'), steps }));
  }
  pending(nurse, p, key) { const a = this.agentOf(nurse); return !!a && this.hasTask(a, key + ':' + p.id); }

  // An order a nurse carries out. Medications go through the med room unless she's already carrying
  // them; a STAT med goes to whoever can get it to the bedside first. Returns { nurse, eta }.
  // seconds until agent a could have this order done at the bedside (busy time is a rough guess)
  etaOrder(a, order, p, draw = 90) {
    const pl = placeOf(p), prio = order.prio || 4, drug = order.drug;
    if (!pl) return 0;
    const busy = a.task && a.task.prio >= prio ? (a.task.kind === 'emerg' ? 900 : 150) : 0;
    const queued = a.queue.filter(t => t.prio >= prio).length * 120;
    const via = drug && !a.carrying.includes(drug) ? (this.distTo(a, 'Med room') + dist('Med room', pl)) / this.speedFor(prio) + draw : this.distTo(a, pl) / this.speedFor(prio);
    return busy + queued + via;
  }
  estimate(order, p) {
    const a = this.agentOf(this.sim.nurseOf(p));
    return a ? Math.round(this.etaOrder(a, order, p) + 45) : 0;
  }
  nurseOrder(order, p, run) {
    const sim = this.sim;
    const own = sim.nurseOf(p);
    const a0 = this.agentOf(own);
    const pl = placeOf(p);
    if (!a0 || !pl || !a0.present) return null;
    const drug = order.drug;
    const stat = order.urgency === 'stat' || order.prio >= 7;
    const prio = order.prio || (stat ? 7 : 4);
    const r = sim.frng;
    const draw = drug ? Math.round(r.range(...(order.infusion ? [120, 240] : /IV/.test(order.prep.label) ? [60, 120] : [40, 90]))) : 0;
    const doDur = Math.round(r.range(...(order.taskSec || [30, 90])));
    const carrying = (a) => drug && a.carrying.includes(drug);
    const mk = (a) => {
      const steps = [];
      if (drug && !carrying(a)) steps.push({ place: 'Med room', dur: draw, label: `pulling ${order.label.split(' ')[0]} for ${p.name.split(' ')[0]}`, run: (ag) => ag.carrying.push(drug) });
      steps.push({ place: () => placeOf(p), dur: doDur, label: order.label.length > 28 ? order.label.slice(0, 27) + '…' : order.label, run: (ag) => { if (drug) ag.carrying.splice(ag.carrying.indexOf(drug), 1); run(ag); } });
      return this.task({ key: 'order:' + order.id, kind: 'order', pid: p.id, prio, cancel: () => order.status !== 'pending' || p.status === 'gone', steps });
    };
    const etaVia = (a) => this.etaOrder(a, order, p, draw);
    let who = a0, eta = etaVia(a0);
    if (prio >= 6 && drug) {
      // ask around: the charge nurse or a nurse who's only charting / rounding
      for (const b of [this.charge, ...this.agents.filter(x => x.kind === 'nurse' && x.present && x !== a0 && x.nurse.role === a0.nurse.role)]) {
        if (b.task && b.task.prio >= 5) continue;
        const e = etaVia(b);
        if (e + 60 < eta) { who = b; eta = e; }
      }
      if (who !== a0) sim.page(p, `${a0.task && a0.task.kind === 'emerg' ? `I'm stuck in ${a0.task.pid && sim.byId[a0.task.pid] ? sim.byId[a0.task.pid].room : 'another room'}` : `I'm tied up`} — ${who.name} is grabbing the ${order.label.split(' ')[0].toLowerCase()} for ${p.name.split(' ')[0]}.`, 0, [], own);
    }
    this.give(who, mk(who));
    return { agent: who, eta: Math.round(eta + doDur) };
  }

  // the backup OB walks in from the entrance and sees the patient
  backupVisit(p, onArrive, label) {
    let a = this.byId.backup;
    if (!a) a = this.add(mkAgent('backup', 'backup', 'Dr. Osei', 'Entrance'));
    if (!a.present) { const nd = N.Entrance; a.x = a.px = nd.x; a.y = a.py = nd.y; a.at = a.from = 'Entrance'; a.path = []; a.present = true; }
    a.queue.push(this.task({ key: null, kind: 'backup', pid: p.id, prio: 6, steps: [{ place: () => placeOf(p), dur: 240, label, run: onArrive }] }));
    if (!a.task) a.task = a.queue.shift();
  }

  // a snapshot for the UI: positions, previous positions (for interpolation), what each is doing
  view() {
    return this.agents.filter(a => a.present).map(a => ({ id: a.id, kind: a.kind, name: a.name, x: a.x, y: a.y, px: a.px, py: a.py, doing: a.doing,
      prio: a.task ? a.task.prio : 0, carrying: a.carrying.slice(), arch: a.nurse ? a.nurse.arch : null, triage: a.nurse ? a.nurse.role === 'triage' : false }));
  }
}
