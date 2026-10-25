// End-of-shift debrief (SPEC §7): score, then per patient the hidden truth next to what you were told.
import { computeScore } from '../engine/scoring.js';
import { deliveryNTSV } from '../engine/patient.js';
import { fmtGA } from '../engine/util.js';
import { sveString } from '../engine/nurses.js';

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NURSE_COLORS = ['#6db7ff', '#ffb37a', '#c4a0ff', '#7fe3d0', '#ff8fc7', '#c9d36a', '#ffd86b', '#9ad0ff'];

export function showDebrief(sim, ov, { onMenu, onReplay, onSame }) {
  const sc = computeScore(sim);
  const gradeColor = { A: '#4fe0a0', B: '#9be36a', C: '#f3b54a', D: '#ff9b5f', F: '#ff5f5f' }[sc.grade];
  const involved = sim.patients.filter(p => p.admitT != null || p.outcome || p.triageT != null || p.chart.orders.length);
  const byName = new Map();
  sim.nurses.forEach((n, i) => byName.set(n.name, { n, color: NURSE_COLORS[i % NURSE_COLORS.length] }));
  ov.innerHTML = `<div class="dlg">
    <h1>Shift over — ${sim.clock()}</h1>
    <p class="lead">Seed <b>${esc(sim.seed)}</b> · ${sim.mode} · ${sc.delivered} deliveries · ${sim.stats.triageSeen} triage visits · ${sim.stats.phoneCalls} phone calls</p>
    <div class="scorebig"><div class="grade" style="color:${gradeColor}">${sc.grade}</div><div><div class="num">${sc.score} pts</div>
      <div class="lead">NTSV cesarean rate: <b>${sc.ntsvTotal ? `${sc.ntsvCS}/${sc.ntsvTotal} (${Math.round(sc.ntsvRate * 100)}%)` : 'no NTSV deliveries'}</b>${sc.ddi.length ? ` · STAT decision-to-incision: ${sc.ddi.map(d => d.toFixed(0) + ' min').join(', ')}` : ''}</div></div></div>
    <div class="btnrow"><button id="dbReplay">Watch the replay</button><button id="dbSame">Play this seed again</button><button id="dbMenu" class="ghost">Menu</button></div>
    <h2>What cost you points</h2>
    ${sc.pen.length ? `<table class="pen">${sc.pen.map(x => `<tr><td>${esc(x.name)}</td><td>${esc(x.text)}</td><td class="pts">−${x.pts}</td></tr>`).join('')}</table>` : '<p>Nothing. A clean night.</p>'}
    <h2>Nurses tonight (the biases you were managing)</h2>
    <table class="pen">${sim.nurses.filter(n => n.patients.length || sim.patients.some(p => p.chart.sves.some(s => s.by === n.name))).map(n => `<tr><td><b style="color:${byName.get(n.name).color}">${esc(n.name)}</b> (${esc(n.label)}, ${n.years} y)</td><td>exam bias ${n.dilBias >= 0 ? '+' : ''}${n.dilBias.toFixed(1)} cm ±${n.dilNoise.toFixed(1)}, station ${n.staBias >= 0 ? '+' : ''}${n.staBias.toFixed(1)} · catches bad orders ${Math.round(n.knowledge * 100)}% · pit: ${n.pit}</td></tr>`).join('')}</table>
    <h2>Patients — truth vs report</h2>
    <div class="legend"><span><i style="background:#4fe0a0"></i>true dilation</span><span><i style="background:#4fe0a088"></i>true station (right axis)</span><span><i style="background:#ff5f5f"></i>fetal base deficit</span><span><i style="background:#f3b54a"></i>Pit mU/min</span><span>● reported SVE (nurse colour), ◆ your exam</span></div>
    <div id="dbCards"></div>
  </div>`;
  ov.classList.add('show');
  ov.scrollTop = 0;
  ov.querySelector('#dbReplay').onclick = () => { ov.classList.remove('show'); onReplay(); };
  ov.querySelector('#dbSame').onclick = () => { ov.classList.remove('show'); onSame(); };
  ov.querySelector('#dbMenu').onclick = () => onMenu();
  const box = ov.querySelector('#dbCards');
  for (const p of involved) {
    const row = sc.rows.find(r => r.p === p);
    const d = document.createElement('div');
    d.className = 'dcard';
    const o = p.outcome, T = p.T;
    const outcomeTxt = o ? `${o.mode === 'cs' ? `Cesarean (${o.urgency}, ${o.csInd})` : o.mode === 'home' ? 'Unattended delivery' : o.vacuum ? 'Vacuum delivery' : 'Spontaneous vaginal'} at ${sim.clock(o.t)} · ${o.neo.liveborn ? `pH ${o.neo.pH}, BD ${o.neo.bd}, Apgars ${o.neo.apgar1}/${o.neo.apgar5}${o.neo.nicu ? ', NICU' : ''}` : 'stillbirth'}`
      : p.flags.maternalDeath ? `Maternal death at ${sim.clock(p.flags.maternalDeath)}, undelivered` : p.area === 'home' ? 'At home' : p.flags.rescheduled ? 'Induction rescheduled' : 'Undelivered at end of shift';
    const outcomeLine = (o && p.flags.maternalDeath ? `Maternal death at ${sim.clock(p.flags.maternalDeath)} · ` : '') + (o && o.pmcd ? outcomeTxt.replace(/^Cesarean \([^)]*\)/, 'Resuscitative hysterotomy') : outcomeTxt);
    const pens = sc.pen.filter(x => x.pid === p.id);
    const hidden = [];
    hidden.push(`Placental reserve ${T.plac.toFixed(2)}${T.plac < 0.75 ? ' (poor)' : ''}`);
    hidden.push(`Oxytocin sensitivity EC50 ${T.ec50.toFixed(1)} mU/min${T.ec50 < 3.5 ? ' (very sensitive)' : T.ec50 > 9 ? ' (resistant)' : ''}`);
    if (T.nuchal) hidden.push('Nuchal cord');
    if (T.cpdCm != null) hidden.push(`CPD: dilation would arrest near ${T.cpdCm.toFixed(1)} cm`);
    if (T.cpdSta != null) hidden.push(`CPD: descent stops near ${T.cpdSta.toFixed(1)}`);
    if (T.opPersist && T.op) hidden.push('Persistent OP');
    if (p.dx.breech) hidden.push(`Breech${p.known.breech ? '' : ' — never diagnosed'}`);
    if (p.dx.previa) hidden.push(`Placenta previa${p.known.previa ? '' : ' — never diagnosed'}`);
    if (p.dx.hellp) hidden.push(`HELLP (true plt ${Math.round(T.plt)})`);
    if (T.infect > 1) hidden.push(`Intraamniotic infection (load ${T.infect.toFixed(1)})`);
    if (p.gbsTrue !== p.gbs) hidden.push(`GBS truly ${p.gbsTrue}`);
    hidden.push(`True EFW ${T.efw} g`);
    const told = p.chart.sves.filter(s => s.trueDil != null);
    const cmpRows = told.slice(-10).map(s => {
      const err = s.dil - s.trueDil;
      return `<tr><td>${sim.clock(s.t)}</td><td>${esc(s.by)}</td><td>${sveString(s)}</td><td>${s.trueDil.toFixed(1)} cm / ${s.trueSta.toFixed(1)}</td><td class="${Math.abs(err) >= 2 ? 'way' : Math.abs(err) >= 1 ? 'off' : ''}">${err >= 0 ? '+' : ''}${err.toFixed(1)}</td></tr>`;
    }).join('');
    d.innerHTML = `<h3>${esc(p.name)} <span class="lead">${p.age}yo G${p.gravida}P${p.para} ${fmtGA(p.gaDays)} · ${esc(p.indication)}${deliveryNTSV(p) ? ' · NTSV' : ''}</span></h3>
      <div>${esc(outcomeLine)}${row && row.iolToDelivery ? ` · induction→delivery ${row.iolToDelivery.toFixed(1)} h` : ''}${row && row.csJust ? ` · <span style="color:${row.csJust.ok ? 'var(--green)' : 'var(--red)'}">${row.csJust.ok ? 'CS criteria met' : 'CS criteria NOT met'}</span>` : ''}</div>
      ${row && row.events.length ? `<div class="lead">${row.events.map(esc).join(' · ')}</div>` : ''}
      <canvas></canvas>
      <div class="dgrid"><div><b>What was really going on</b><ul>${hidden.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        ${(p.truthLog || []).length ? `<b>Timeline</b><ul>${p.truthLog.slice(0, 18).map(x => `<li class="mono">${sim.clock(x.t)} ${esc(x.text)}</li>`).join('')}</ul>` : ''}</div>
        <div>${cmpRows ? `<b>What you were told vs truth</b><table class="cmp"><tr><td>time</td><td>by</td><td>reported</td><td>true</td><td>Δcm</td></tr>${cmpRows}</table>` : ''}
        ${pens.length ? `<b>Penalties</b><ul>${pens.map(x => `<li>${esc(x.text)} (−${x.pts})</li>`).join('')}</ul>` : ''}
        ${row && row.bpTreat != null ? `<div>Severe BP → first antihypertensive: ${row.bpTreat.toFixed(0)} min</div>` : ''}
        ${row && row.epiWait != null ? `<div>Epidural request → placed: ${row.epiWait.toFixed(0)} min</div>` : ''}</div></div>`;
    box.appendChild(d);
    requestAnimationFrame(() => drawTimeline(d.querySelector('canvas'), sim, p, byName));
  }
}

function drawTimeline(cv, sim, p, byName) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, Hh = cv.clientHeight;
  cv.width = W * dpr; cv.height = Hh * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const h = p.hist;
  if (!h.t.length) { g.fillStyle = '#5c6b7b'; g.fillText('No time on the floor.', 10, 20); return; }
  const t0 = Math.min(h.t[0], ...p.chart.sves.map(s => s.t)), t1 = Math.max(h.t[h.t.length - 1], p.outcome ? p.outcome.t : 0);
  const L = 34, R = W - 34, top = 10, bot = Hh - 22;
  const x = (t) => L + (t - t0) / Math.max(1, t1 - t0) * (R - L);
  const yD = (d) => bot - d / 10 * (bot - top);
  const yS = (s) => bot - (s + 4) / 9 * (bot - top);
  const yB = (b) => bot - Math.min(24, b) / 24 * (bot - top);
  // grid
  g.strokeStyle = '#1d2935'; g.lineWidth = 1; g.font = '10px ui-monospace, monospace'; g.fillStyle = '#5c6b7b';
  for (let d = 0; d <= 10; d += 2) { g.beginPath(); g.moveTo(L, yD(d)); g.lineTo(R, yD(d)); g.stroke(); g.fillText(d + 'cm', 2, yD(d) + 3); }
  const hourStep = 3600;
  for (let t = Math.ceil((t0 + sim.startClock) / hourStep) * hourStep - sim.startClock; t <= t1; t += hourStep) {
    g.beginPath(); g.moveTo(x(t), top); g.lineTo(x(t), bot); g.stroke(); g.fillText(sim.clock(t), x(t) - 14, Hh - 6);
  }
  // acidemia line BD 12
  g.strokeStyle = '#ff5f5f44'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(L, yB(12)); g.lineTo(R, yB(12)); g.stroke(); g.setLineDash([]);
  g.fillStyle = '#ff5f5f99'; g.fillText('BD 12', R + 2, yB(12) + 3);
  // pit area
  g.fillStyle = '#f3b54a33'; g.beginPath(); g.moveTo(x(h.t[0]), bot);
  for (let i = 0; i < h.t.length; i++) g.lineTo(x(h.t[i]), bot - Math.min(30, h.pit[i]) / 30 * (bot - top) * 0.45);
  g.lineTo(x(h.t[h.t.length - 1]), bot); g.closePath(); g.fill();
  const plot = (arr, yf, color, w = 1.6) => { g.strokeStyle = color; g.lineWidth = w; g.beginPath(); for (let i = 0; i < h.t.length; i++) { const X = x(h.t[i]), Y = yf(arr[i]); i ? g.lineTo(X, Y) : g.moveTo(X, Y); } g.stroke(); };
  plot(h.sta, yS, '#4fe0a088', 1);
  plot(h.dil, yD, '#4fe0a0', 2);
  plot(h.bd, yB, '#ff5f5f', 1.5);
  // SVE dots
  for (const s of p.chart.sves) {
    if (s.t < t0) continue;
    const isMd = s.by.startsWith('You');
    const c = isMd ? '#ffffff' : (byName.get(s.by)?.color || '#8494a5');
    g.fillStyle = c;
    const X = x(s.t), Y = yD(s.dil);
    g.beginPath();
    if (isMd) { g.moveTo(X, Y - 5); g.lineTo(X + 5, Y); g.lineTo(X, Y + 5); g.lineTo(X - 5, Y); g.closePath(); }
    else g.arc(X, Y, 3.5, 0, Math.PI * 2);
    g.fill();
  }
  // delivery marker
  if (p.outcome) { g.strokeStyle = '#ffd86b'; g.lineWidth = 2; g.beginPath(); g.moveTo(x(p.outcome.t), top); g.lineTo(x(p.outcome.t), bot); g.stroke(); g.fillStyle = '#ffd86b'; g.fillText(p.outcome.mode === 'cs' ? 'CS' : 'delivery', x(p.outcome.t) + 3, top + 10); }
  g.fillStyle = '#5c6b7b'; g.fillText('station', R + 2, yS(0) + 3);
}
