// UI shell. Reads sim state for display and sends player input only through sim.command(),
// so every night is replayable from (seed, command log).
import { enterRoom, dopplerTick, stopAll as stopSound } from './sound.js';
import { drawFloor, roomAt, setHover } from './floormap.js';
import { landingHTML } from './landing.js';
import { Sim } from '../engine/sim.js';
import { parseOrder, describeParsed, ORDER_HINTS } from '../engine/orders.js';
import { sveString } from '../engine/nurses.js';
import { fmtDur, fmtGA, clamp } from '../engine/util.js';
import { CS_INDICATIONS } from '../engine/data.js';
import { ntsvNow } from '../engine/scoring.js';
import { drawStrip, drawMini } from './strip.js';
import { showDebrief } from './debrief.js';
import { realtimeEmergency, SD_MOVES, mmss, CRISIS_LABEL } from '../engine/emergency.js';

const $ = (s) => document.querySelector(s);
const H = 3600, MIN = 60;
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ui = {
  sim: null, selId: null, speed: 0, view: { window: 'paper', live: true, endT: 0, teaching: false },
  tab: 'overview', filter: 'all', msgNodes: new Map(), lastMsgCount: 0, skipFromMsg: 0, lastUrgentSeen: -1,
  lastRender: 0, carry: 0, replay: false, acted: new Set(), audio: null, ended: false, history: [], lastAlarm: 0,
  phone: null,
};

// ------------------------------------------------------------------------ boot / menu
function loadHistory() { try { return JSON.parse(localStorage.getItem('obfloor.history') || '[]'); } catch { return []; } }
function saveHistory(h) { try { localStorage.setItem('obfloor.history', JSON.stringify(h.slice(-20))); } catch { /* storage unavailable */ } }

function loadPrefs() { try { return JSON.parse(localStorage.getItem('obfloor.prefs') || '{}'); } catch { return {}; } }
function savePrefs(p) { try { localStorage.setItem('obfloor.prefs', JSON.stringify(p)); } catch { /* storage unavailable */ } }

// The front page (landing.js) doubles as the menu: Step in starts a night, the in-game Menu button
// brings it back with Resume / Replay / Import.
function showMenu(first = false) {
  const hist = loadHistory();
  const last = hist[hist.length - 1];
  const lp = $('#landing');
  const prefs = loadPrefs();
  const seed = ui.sim && !first ? ui.sim.seed : randomSeed();
  lp.innerHTML = landingHTML({ seed: esc(seed), last, canResume: !!(ui.sim && !ui.ended && !first), hasSim: !!ui.sim && !first, prefs });
  lp.classList.remove('hidden');
  lp.scrollTop = 0;
  document.body.classList.add('lp-open');
  const read = () => ({
    mode: (lp.querySelector('input[name=lpMode]:checked') || {}).value || 'night',
    cloud: $('#cloudIn').checked, teach: $('#teachIn').checked, autoslow: $('#autoslowIn').checked,
    sound: $('#soundIn').checked, fhr: $('#fhrIn').checked,
  });
  const apply = () => {
    const p = read(); savePrefs(p);
    $('#autoslow').checked = p.autoslow; $('#sound').checked = p.sound; $('#fhrAudio').checked = p.fhr;
    return p;
  };
  lp.querySelectorAll('input').forEach(el => el.addEventListener('change', apply));
  const close = () => { lp.classList.add('hidden'); lp.innerHTML = ''; document.body.classList.remove('lp-open'); };
  $('#rndSeed').onclick = () => { $('#seedIn').value = randomSeed(); };
  $('#startBtn').onclick = () => {
    const p = apply(); close();
    newGame({ mode: p.mode, seed: $('#seedIn') ? $('#seedIn').value.trim() || randomSeed() : seed, teaching: p.teach, blackCloud: p.cloud });
  };
  $('#seedIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#startBtn').click(); });
  if ($('#resumeBtn')) $('#resumeBtn').onclick = () => { apply(); close(); };
  if ($('#replayBtn')) $('#replayBtn').onclick = () => { apply(); close(); newGame({ mode: last.mode, seed: last.seed, replay: last.log, blackCloud: !!last.blackCloud }); };
  if ($('#exportBtn')) $('#exportBtn').onclick = exportNight;
  $('#importIn').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(txt => { try { const j = JSON.parse(txt); apply(); close(); newGame({ mode: j.mode, seed: j.seed, replay: j.log, blackCloud: !!j.blackCloud }); } catch { alert('Not a replay file.'); } });
  };
  apply();
  if (first) setSpeed(0);
}
function randomSeed() {
  const w = ['full-moon', 'nightshift', 'triage', 'pitocin', 'magnesium', 'stat', 'labor', 'crowning', 'nuchal', 'bishop', 'zhang', 'apgar'];
  return w[Math.floor(Math.random() * w.length)] + '-' + Math.floor(Math.random() * 9000 + 1000);
}
function exportNight() {
  const s = ui.sim;
  const blob = new Blob([JSON.stringify({ seed: s.seed, mode: s.mode, blackCloud: s.blackCloud, log: s.cmdLog, endedAt: s.t }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `ld-night-${s.seed}.json`; a.click();
}

function newGame({ mode, seed, teaching = false, replay = null, blackCloud = false }) {
  document.querySelectorAll('.labpanel').forEach(x => x.remove());
  ui.sim = new Sim({ seed, mode, teaching, blackCloud });
  ui.replay = !!replay;
  if (replay) ui.sim.loadReplay(replay);
  ui.view.teaching = teaching; $('#teach').checked = teaching;
  ui.selId = null; ui.msgNodes.clear(); $('#feed').innerHTML = ''; $('#bedsideLog').innerHTML = ''; ui.acted.clear();
  phoneReset(); stopSound();
  ui.ended = false; ui.lastUrgentSeen = -1; ui.view.live = true;
  ui.sim.on((type, m) => {
    if (type === 'msg') onMsg(m);
    if (type === 'ended') endShift();
  });
  const first = ui.sim.patients.find(p => p.area === 'ldr') || ui.sim.patients[0];
  if (first) select(first.id);
  setSpeed(mode === 'lab' ? 1 : 0);
  renderAll();
  if (mode === 'lab') renderLab();
}

function endShift() {
  if (ui.ended) return;
  ui.ended = true; setSpeed(0);
  const s = ui.sim;
  if (!ui.replay) { const h = loadHistory(); h.push({ seed: s.seed, mode: s.mode, blackCloud: s.blackCloud, log: s.cmdLog, t: Date.now() }); saveHistory(h); }
  showDebrief(s, $('#overlay'), { onMenu: () => showMenu(), onReplay: () => newGame({ mode: s.mode, seed: s.seed, replay: s.cmdLog, blackCloud: s.blackCloud }), onSame: () => newGame({ mode: s.mode, seed: s.seed, blackCloud: s.blackCloud }) });
}

// ------------------------------------------------------------------------ loop
function setSpeed(sp) {
  ui.speed = sp;
  if (sp === 'skip') ui.skipFromMsg = ui.sim ? ui.sim.nextMsgId : 0;
  document.querySelectorAll('#speed button').forEach(b => b.classList.toggle('on', String(b.dataset.speed) === String(sp)));
}
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const s = ui.sim;
  // emergencies are played in real time: no fast-forwarding through a dystocia
  const fast = () => ui.speed === 'skip' || ui.speed > 1;
  if (s && !ui.ended && fast() && s.realtimeEmergency()) setSpeed(1);
  if (s && !ui.ended && ui.speed) {
    let n;
    if (ui.speed === 'skip') n = 900; // ~54,000x; stops on the next page
    else { ui.carry += dt * ui.speed; n = Math.floor(ui.carry); ui.carry -= n; }
    n = Math.min(n, 1500);
    for (let i = 0; i < n && !s.ended; i++) {
      s.applyReplay();
      s.tick();
      if (ui.speed === 'skip' && s.msgs.length && s.msgs[s.msgs.length - 1].id >= ui.skipFromMsg && s.msgs[s.msgs.length - 1].prio >= 1) { setSpeed(0); break; }
      if (s.lastUrgentT === s.t && $('#autoslow').checked && fast()) { setSpeed(1); break; }
      if (fast() && s.realtimeEmergency()) { setSpeed(1); break; }
    }
  }
  if (s && s.floor) {
    // the room you walk into chirps at you; you hear the Doppler of the room you're standing in,
    // or (quietly, from the central monitor) the patient you have selected
    const md = s.floor.md;
    const here = !md.path.length ? s.patients.find(q => q.status !== 'gone' && q.room === md.at && q.area !== 'or') : null;
    const audio = $('#fhrAudio').checked && !ui.ended;
    if (here && ui.lastRoom !== md.at && audio) enterRoom(s, here);
    ui.lastRoom = md.path.length ? null : md.at;
    dopplerTick(s, here || s.byId[ui.selId], audio && !!ui.speed, here ? 1 : 0.3);
  }
  if (s && !ui.ended && ui.speed && now - ui.lastAlarm > 2000 && s.realtimeEmergency()) { ui.lastAlarm = now; alarm(); }
  if (s) {
    const p = s.byId[ui.selId];
    if (p) drawStrip($('#strip'), s, p, ui.view);
    if (!$('#floorWrap').classList.contains('collapsed')) drawFloor($('#floor'), s, ui, ui.speed && ui.speed !== 'skip' && ui.speed <= 10 ? clamp(ui.carry, 0, 1) : 1);
    if (now - ui.lastRender > 250) { ui.lastRender = now; renderAll(); }
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------------ messages
function onMsg(m) {
  if (!isPhoneMsg(m)) { bedsideLine(m); if (m.prio >= 3) { banner(m); beep(2); } return; }
  const node = msgNode(m);
  $('#feed').prepend(node);
  ui.msgNodes.set(m.id, node);
  applyFilter(node, m);
  if (m.pid && m.pid === ui.selId && !phoneLocked() && ui.phone.open) m.read = true;
  if (m.prio >= 3) {
    const ep = m.pid && ui.sim.byId[m.pid];
    if (!(ep && realtimeEmergency(ep))) banner(m); // the emergency bar is already shouting about her
    beep(2);
  } else if (m.prio === 2) beep(1);
}
function msgNode(m) {
  const d = document.createElement('div');
  d.className = `msg p${m.prio} role-${m.role} secure${m.read ? '' : ' unread'}`;
  const s = ui.sim;
  d.innerHTML = `<div class="mh"><span class="lockline">🔒 Alert from ${esc(m.from.replace(/,.*$/, ''))}</span><span class="from">${esc(m.from)}</span>${m.room ? `<span class="rm" data-pid="${m.pid}">${esc(m.room)}</span>` : ''}<span class="time">${s.clock(m.t)}</span></div>
    <div class="mt">${esc(m.text)}</div>
    ${m.actions && m.actions.length ? `<div class="ma">${m.actions.map((a, i) => `<button data-i="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}`;
  d.querySelectorAll('.ma button').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    const a = m.actions[+b.dataset.i];
    if (ui.replay || phoneLocked()) return;
    if (a.cmd.type === 'mdExam') { const r = ui.sim.command(a.cmd); feedback(r); }
    else { const r = ui.sim.command(a.cmd); if (a.cmd2) ui.sim.command(a.cmd2); if (a.cmd.type === 'order') feedback(r); }
    b.disabled = true;
    if (['confirm', 'cancel', 'choice'].includes(a.cmd.type)) d.querySelectorAll('.ma button').forEach(x => x.disabled = true);
  });
  const rm = d.querySelector('.rm');
  if (rm) rm.onclick = (e) => { e.stopPropagation(); select(m.pid); };
  d.onclick = () => { if (phoneLocked()) return; m.read = true; d.classList.remove('unread'); if (m.pid) select(m.pid); };
  return d;
}
function applyFilter(node, m) {
  const f = ui.filter;
  const show = f === 'all' || (f === 'urgent' && m.prio >= 2) || (f === 'pt' && m.pid === ui.selId);
  node.classList.toggle('hidden', !show);
}
function refreshFeed() {
  const s = ui.sim;
  for (let i = s.msgs.length - 1, k = 0; i >= 0 && k < 250; i--, k++) {
    const m = s.msgs[i], node = ui.msgNodes.get(m.id);
    if (!node) continue;
    if (m.resolved) node.classList.add('resolved');
    if (m.read) node.classList.remove('unread');
    applyFilter(node, m);
  }
}
let bannerTimer = null;
function banner(m) {
  const b = $('#banner');
  b.textContent = isPhoneMsg(m) && phoneLocked() ? `🔒 SecureChat: alert from ${m.from} — log in to read` : `${m.room ? m.room + ' — ' : ''}${m.text}`;
  b.classList.remove('hidden');
  b.onclick = () => { if (m.pid && !(isPhoneMsg(m) && phoneLocked())) select(m.pid); b.classList.add('hidden'); };
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.add('hidden'), 8000);
}
function beep(level) {
  if (!$('#sound').checked) return;
  try {
    ui.audio = ui.audio || new (window.AudioContext || window.webkitAudioContext)();
    const ac = ui.audio, t = ac.currentTime;
    const tones = level >= 2 ? [880, 660, 880] : [660];
    tones.forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t + i * 0.18); g.gain.exponentialRampToValueAtTime(0.15, t + i * 0.18 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.16);
      o.connect(g).connect(ac.destination); o.start(t + i * 0.18); o.stop(t + i * 0.18 + 0.17);
    });
  } catch { /* no audio */ }
}

function alarm() {
  if (!$('#sound').checked) return;
  try {
    ui.audio = ui.audio || new (window.AudioContext || window.webkitAudioContext)();
    const ac = ui.audio, t = ac.currentTime;
    [988, 784, 988].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = f; o.type = 'square';
      g.gain.setValueAtTime(0.0001, t + i * 0.22); g.gain.exponentialRampToValueAtTime(0.05, t + i * 0.22 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.22 + 0.18);
      o.connect(g).connect(ac.destination); o.start(t + i * 0.22); o.stop(t + i * 0.22 + 0.2);
    });
  } catch { /* no audio */ }
}

// ------------------------------------------------------------------------ the hospital phone
// Pages arrive on SecureChat, which logs you out about every half hour of game time "for hospital security
// purposes". Locked, you see who is paging but not what they want. UI only: nothing here touches the sim,
// so replays are unaffected (the spinner runs on wall-clock time while the floor keeps going).
const PHONE_ROLES = new Set(['nurse', 'charge', 'pharmacy', 'anesthesia', 'attending', 'lab', 'phone', 'family']);
function isPhoneMsg(m) { return PHONE_ROLES.has(m.role); }
function phoneLocked() { return !ui.phone || ui.phone.state !== 'in'; }
function phoneReset() {
  const fails = new Set();
  const nFail = Math.random() < 0.5 ? 1 : 2;
  while (fails.size < nFail) fails.add(2 + Math.floor(Math.random() * 14)); // somewhere in the night's 2nd-15th login
  ui.phone = { open: ui.phone ? ui.phone.open : true, state: 'out', attempts: 0, fails, nextLogoutT: Infinity, why: 'start', err: '' };
  renderLogin();
}
function phoneTick() {
  const ph = ui.phone, s = ui.sim;
  if (!ph || !s || ph.state !== 'in' || s.t < ph.nextLogoutT) return;
  ph.state = 'out'; ph.why = 'timeout'; ph.err = '';
  renderLogin();
}
function phoneLogin() {
  const ph = ui.phone;
  if (ph.state !== 'out') return;
  ph.state = 'spin'; ph.attempts++; ph.err = '';
  renderLogin();
  setTimeout(() => {
    if (ui.phone !== ph) return;
    if (ph.fails.has(ph.attempts)) { ph.fails.delete(ph.attempts); ph.state = 'out'; ph.err = 'You forgot your password. Try again.'; renderLogin(); return; }
    ph.state = 'in';
    const s = ui.sim;
    ph.nextLogoutT = s.t + Math.round((20 + Math.random() * 20) * 60);
    renderLogin(); refreshFeed(); renderPhone();
  }, 1000 + Math.random() * 2000);
}
function renderLogin() {
  const el = $('#login'), ph = ui.phone;
  if (!el || !ph) return;
  $('.phone').classList.toggle('locked', ph.state !== 'in');
  if (ph.state === 'in') { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  if (ph.state === 'spin') { el.innerHTML = `<div class="lt">SecureChat™</div><div class="spinner"></div><div class="small">Authenticating with Active Directory…</div>`; return; }
  el.innerHTML = `<div class="lt">SecureChat™</div>
    ${ph.err ? `<div class="err">${esc(ph.err)}</div>` : ph.why === 'timeout' ? `<div>You were logged out for hospital security purposes.</div>
      <div class="small">Per Information Security Policy IS-114 (rev. 03/1998), sessions expire every 30 minutes whether or not they are in use.</div>` : `<div class="small">Sign in to view secure messages.</div>`}
    <button id="loginBtn">Log in</button>`;
  $('#loginBtn').onclick = phoneLogin;
}
function phoneUnread() {
  let n = 0, last = null;
  for (const m of ui.sim.msgs) if (isPhoneMsg(m) && !m.read && m.prio >= 1) { n++; last = m; }
  return [n, last];
}
function renderPhone() {
  const s = ui.sim, ph = ui.phone; if (!s || !ph) return;
  $('#main').classList.toggle('pocket', !ph.open);
  $('#phoneClock').textContent = s.clock();
  const [n, last] = phoneUnread();
  const b = $('#phoneBadge');
  b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n);
  $('#phoneMiniFrom').textContent = last ? (phoneLocked() ? 'Alert from ' + last.from.replace(/,.*$/, '') : last.from.replace(/,.*$/, '') + ': ' + last.text.slice(0, 60)) : '';
}
function renderMe() {
  const md = ui.sim.floor && ui.sim.floor.md; if (!md) return;
  const where = md.path.length ? `walking → ${md.dest}` : `in ${md.at}`;
  const todo = md.queue.length ? ` · then ${md.queue.length} more` : '';
  $('#meStatus').textContent = `You: ${md.task && !md.path.length ? md.doing : where}${todo}`;
}
function toggleFloor() { $('#floorWrap').classList.toggle('collapsed'); }
function togglePhone() { ui.phone.open = !ui.phone.open; renderPhone(); }
function bedsideLine(m) {
  const el = $('#bedsideLog'); if (!el) return;
  const d = document.createElement('div');
  d.className = `${m.role === 'md' ? 'md' : ''} p${m.prio}`;
  d.title = m.text;
  d.innerHTML = `<span class="t">${ui.sim.clock(m.t)}</span>${m.room ? `<b>${esc(m.room)}</b> ` : ''}${esc(m.text)}`;
  if (m.pid) { d.style.cursor = 'pointer'; d.onclick = () => select(m.pid); }
  el.prepend(d);
  while (el.children.length > 5) el.lastChild.remove();
}

// ------------------------------------------------------------------------ selection & rendering
function select(pid) {
  ui.selId = pid;

  const s = ui.sim;
  if (!phoneLocked()) for (const m of s.msgs) if (m.pid === pid) m.read = true;
  ui.view.live = true;
  renderAll();
}

function renderAll() {
  const s = ui.sim; if (!s) return;
  phoneTick(); renderTop(); renderEmerg(); renderBoard(); renderPatient(); refreshFeed(); renderPhone(); renderMe();
}

// Everything here is what the team in the room knows: clocks, what's been tried, the last rhythm
// check. Never p.T.
function renderEmerg() {
  const s = ui.sim, el = $('#emerg');
  const list = s.patients.filter(p => p.status !== 'gone' && (realtimeEmergency(p) || (p.crisis && p.crisis.phase === 'rosc')));
  if (!list.length) { if (!el.classList.contains('hidden')) { el.innerHTML = ''; el.classList.add('hidden'); } return; }
  el.classList.remove('hidden');
  const B = (p, label, text) => `<button data-pid="${p.id}" data-order="${esc(text)}"${ui.replay ? ' disabled' : ''}>${esc(label)}</button>`;
  let h = '';
  for (const p of list) {
    const who = `${esc(p.room || '')} · ${esc(p.name)}`;
    if (p.sd && p.sd.active) {
      const sd = p.sd;
      const tried = sd.tries.filter(x => x.ok === false).map(x => SD_MOVES[x.key].label + ' ✗');
      const now = sd.tries.filter(x => x.ok == null).map(x => SD_MOVES[x.key].label + (x.start > s.t ? ' (next)' : ' …'));
      h += `<div class="em" data-pid="${p.id}"><div class="emh"><b>SHOULDER DYSTOCIA</b><span>${who}</span><span class="emsub">head out</span><span class="emclock">${mmss(s.t - sd.t0)}</span></div>
        <div class="emline">${tried.length ? 'Tried: ' + esc(tried.join(', ')) : 'Nothing tried yet.'}${now.length ? ' · Now: ' + esc(now.join(', ')) : ''}${sd.help ? ' · help called' : ''}</div>
        <div class="emb">${B(p, 'McRoberts', 'McRoberts')}${B(p, 'Suprapubic', 'suprapubic pressure')}${B(p, 'Posterior arm', 'deliver posterior arm')}${B(p, 'Rubin / Woods', 'woods screw')}${B(p, 'All fours', 'gaskin all fours')}${B(p, 'Episiotomy', 'episiotomy')}${B(p, 'Pull harder', 'traction')}${B(p, 'Fundal pressure', 'fundal pressure')}${B(p, 'Zavanelli', 'Zavanelli')}${sd.help ? '' : B(p, 'Call for help', 'call for help')}</div></div>`;
    }
    const a = p.crisis;
    if (!a) continue;
    const pregnant = !p.outcome && p.gaDays >= 140;
    const blood = B(p, 'MTP', 'massive transfusion') + B(p, 'Cryo 10 u', 'cryo 10 units') + B(p, 'FFP 4 u', 'FFP 4 units') + B(p, 'TXA 1 g', 'TXA 1 g IV') + B(p, 'Fibrinogen', 'fibrinogen');
    if (a.phase === 'prodrome') {
      h += `<div class="em" data-pid="${p.id}"><div class="emh"><b>SOMETHING'S WRONG</b><span>${who}</span><span class="emclock">${mmss(s.t - a.t0)}</span></div>
        <div class="emline">“I feel like I'm going to die.” Short of breath, agitated.</div>
        <div class="emb">${B(p, 'O₂ NRB', 'O2')}${B(p, 'Vitals', 'vitals')}${B(p, 'Code blue', 'code blue')}</div></div>`;
    } else if (a.phase === 'collapse') {
      h += `<div class="em" data-pid="${p.id}"><div class="emh"><b>MATERNAL COLLAPSE</b><span>${who}</span><span class="emclock">${mmss(s.t - a.collapseT)}</span></div>
        <div class="emline">Gray, gasping, hypotensive.${a.codeT != null ? ' Code called.' : ''}</div>
        <div class="emb">${a.codeT == null ? B(p, 'Code blue', 'code blue') : ''}${B(p, 'O₂ NRB', 'O2')}${B(p, 'Phenylephrine 100', 'phenylephrine 100 mcg IV')}${B(p, 'Intubate', 'intubate')}${pregnant ? B(p, 'C-section STAT', 'c-section stat for maternal collapse') : ''}${blood}</div></div>`;
    } else if (a.phase === 'arrest') {
      const epi = s.lastDose(p, 'epinephrine');
      const lastEpi = epi && epi.t >= a.arrestT ? `last epi ${mmss(s.t - epi.t)} ago` : 'no epi yet';
      const rhythm = a.lastCheck ? `${a.lastCheck.rhythm} at ${mmss(a.lastCheck.t - a.arrestT)}` : 'pads going on';
      const team = a.teamT != null && s.t >= a.teamT ? 'code team here' : a.codeT != null ? 'code team coming' : 'code not called';
      const mag = a.cause === 'mag';
      const ca = s.lastDose(p, 'calcium');
      const magLine = mag ? ` · ${ca && ca.t >= a.arrestT ? 'calcium in' : 'no calcium yet'} · ${p.meds.mag.on ? '<b>MAG STILL RUNNING</b>' : 'mag off'}` : '';
      h += `<div class="em" data-pid="${p.id}"><div class="emh"><b>CODE BLUE</b><span>${who}</span><span class="emsub">no pulse</span><span class="emclock">${mmss(s.t - a.arrestT)}</span></div>
        <div class="emline">Rhythm: ${esc(rhythm)} · ${lastEpi} · ${team} · ${a.intubated ? 'intubated' : 'bag-mask'}${magLine}${pregnant ? ` · ${a.lud ? 'LUD on' : 'NO uterine displacement'} · <b>still pregnant</b>${a.hystT != null ? ' — cutting' : ''}` : ''}</div>
        <div class="emb">${mag ? B(p, 'Calcium gluconate 1 g', 'calcium gluconate 1 g IV') + (p.meds.mag.on ? B(p, 'Stop mag', 'stop mag') : '') : ''}${B(p, 'Epi 1 mg IV', 'epinephrine 1 mg IV')}${pregnant && !a.lud ? B(p, 'LUD', 'LUD') : ''}${pregnant && a.hystT == null ? B(p, 'Resuscitative hysterotomy', 'resuscitative hysterotomy') : ''}${B(p, 'Shock', 'defibrillate')}${a.intubated ? '' : B(p, 'Intubate', 'intubate')}${a.codeT == null ? B(p, 'Code blue', 'code blue') : ''}${blood}</div></div>`;
    } else if (a.phase === 'rosc') {
      h += `<div class="em post" data-pid="${p.id}"><div class="emh"><b>POST-ARREST</b><span>${who}</span><span class="emsub">ROSC</span><span class="emclock">${mmss(s.t - a.roscT)}</span></div>
        <div class="emline">Pulse back after ${mmss(a.roscT - a.arrestT)}. ${pregnant ? 'Still pregnant.' : a.cause === 'afe' ? 'Watch the bleeding — AFE means DIC.' : p.meds.mag.on ? 'The magnesium is still running.' : ''}</div>
        <div class="emb">${B(p, 'Phenylephrine 100', 'phenylephrine 100 mcg IV')}${a.intubated ? '' : B(p, 'Intubate', 'intubate')}${pregnant ? B(p, 'C-section STAT', 'c-section stat for maternal collapse') : ''}${blood}</div></div>`;
    }
  }
  if (el.dataset.html !== h) { el.innerHTML = h; el.dataset.html = h; }
}

function renderTop() {
  const s = ui.sim;
  $('#clock').textContent = s.clock();
  const occ = s.rooms.filter(r => r.pid).length;
  const cleaning = s.rooms.filter(r => !r.pid && r.cleanUntil > s.t).length;
  const tri = s.bays.filter(b => b.pid).length;
  const wait = s.waiting.filter(id => { const p = s.byId[id]; return p && p.area === 'waiting'; }).length;
  const or = s.ors.map(o => o.pid ? `<span class="busy">${o.name}: ${esc(s.byId[o.pid].name.split(' ')[0])} (${o.phase})</span>` : o.cleanUntil > s.t ? `<span>${o.name}: cleaning</span>` : `<span>${o.name}: <b>free</b></span>`).join(' ');
  const an = s.anes.map(a => a.task ? `<span class="busy">${a.short}: ${a.task.kind === 'cs' ? 'in OR' : a.task.kind === 'code' ? 'CODE ' : 'epidural ' + esc(s.byId[a.task.pid]?.room || '')}</span>` : `<span>${a.short}: <b>free</b></span>`).join(' ');
  const q = s.anesQueue.length ? ` <span class="busy">(${s.anesQueue.length} epidural${s.anesQueue.length > 1 ? 's' : ''} waiting)</span>` : '';
  const nt = ntsvNow(s);
  const ntTxt = nt.tot ? `${nt.cs}/${nt.tot} (${Math.round(nt.rate * 100)}%)` : '—';
  $('#floorstats').innerHTML = `<span>LDR <b>${occ}/8</b>${cleaning ? ` (${cleaning} cleaning)` : ''}</span><span>Triage <b>${tri}/3</b>${wait ? ` <span class="bad">+${wait} waiting</span>` : ''}</span>${or}<span>${an}${q}</span><span>NTSV CS <b class="${nt.rate > 0.236 && nt.tot >= 3 ? 'bad' : ''}">${ntTxt}</b></span>${ui.replay ? '<span class="busy">▶ REPLAY</span>' : ''}${s.mode === 'lab' ? '' : `<span>ends ${s.clock(s.endT)}</span>`}`;
}

function knownStatus(p, s) {
  const bits = [];
  if (p.outcome) {
    const o = p.outcome;
    bits.push(`Delivered ${s.clock(o.t)} ${o.mode === 'cs' ? 'CS' : o.mode === 'home' ? '(home!)' : o.vacuum ? 'VAVD' : 'SVD'}`);
    if (p.T.pp) { const last = [...p.chart.vitals].reverse().find(v => v.qbl != null); if (last) bits.push(`QBL ${last.qbl}`); }
    return bits.join(' · ');
  }
  if (p.sd && p.sd.active) return `<b style="color:var(--red)">SHOULDER DYSTOCIA ${mmss(s.t - p.sd.t0)}</b>`;
  if (p.crisis && p.crisis.phase === 'arrest') return `<b style="color:var(--red)">CODE BLUE ${mmss(s.t - p.crisis.arrestT)}</b>`;
  if (p.crisis && p.crisis.phase === 'collapse') return `<b style="color:var(--red)">COLLAPSE</b>`;
  if (p.flags.maternalDeath) return `Died ${s.clock(p.flags.maternalDeath)}`;
  if (p.area === 'or') return `In ${p.room} — ${p.csRequest ? p.csRequest.urgency : ''} section`;
  if (p.area === 'preop') return `Pre-op · ${p.csRequest ? 'CS at ' + s.clock(p.csRequest.notBefore || p.csRequest.reqT) : ''}`;
  if (p.area === 'triage' || p.area === 'waiting') {
    bits.push(s.complaintText(p));
  }
  if (p.pushing === 'pushing') bits.push(`Pushing ${fmtDur(s.t - p.pushStartT)}`);
  else if (p.pushing === 'labor_down') bits.push('Laboring down');
  const sv = p.chart.sves[p.chart.sves.length - 1];
  if (sv && p.pushing !== 'pushing') bits.push(`${sveString(sv)} @${s.clock(sv.t)}`);
  if (p.meds.pit.rate) bits.push(`Pit ${p.meds.pit.rate}${p.meds.pit.protocol ? 'ᵖ' : ''}`);
  if (p.meds.mag.on) bits.push(`Mg ${p.meds.mag.rate}`);
  if (p.meds.cervidil.in) bits.push('Cervidil');
  if (p.meds.foley.in) bits.push('Foley');
  if (p.epidural.state !== 'none') bits.push(p.epidural.state === 'working' ? 'epidural' : 'epi: ' + p.epidural.state.replace('_', ' '));
  if (p.csRequest && p.csRequest.phase === 'waiting') bits.push(`<b style="color:var(--red)">CS ${p.csRequest.urgency} pending</b>`);
  return bits.join(' · ');
}
function tags(p) {
  const t = [];
  const k = p.known;
  if (k.preE === 'severe') t.push(['PreE SF', 'red']); else if (k.preE === 'mild' || p.chart.problems.includes('preE')) t.push(['PreE', 'amber']);
  if (p.dx.gHTN && k.preE === 'none') t.push(['gHTN', 'amber']);
  if (p.dx.cHTN) t.push(['cHTN', 'amber']);
  if (p.priorCS) t.push([p.kind === 'cs_sched' ? 'prior CS' : 'TOLAC', 'amber']);
  if (p.gbs === 'pos') t.push(['GBS+', 'violet']); else if (p.gbs === 'unknown') t.push(['GBS ?', 'violet']);
  if (p.allergy.pcn !== 'none') t.push([`PCN ${p.allergy.pcn === 'anaphylaxis' ? 'anaph' : 'rash'}`, 'red']);
  if (p.dx.gdm) t.push(['GDM', 'blue']);
  if (p.dx.iugr) t.push(['FGR', 'blue']);
  if (p.asthma) t.push(['asthma', 'blue']);
  if (k.breech || k.breechSuspected) t.push([k.breech ? 'BREECH' : 'breech?', 'red']);
  if (k.previa) t.push(['PREVIA', 'red']);
  if (p.dx.twins) t.push(['twins', 'blue']);
  if (p.gaDays < 259) t.push([fmtGA(p.gaDays), 'amber']);
  if (p.chart.romKnown && !p.outcome) t.push(['ROM', 'green']);
  if (p.T.fluid === 'mec' && p.chart.romKnown) t.push(['MSF', 'amber']);
  return t.map(([x, c]) => `<span class="tag ${c}">${esc(x)}</span>`).join('');
}
function truthLine(p) {
  const T = p.T;
  if (!ui.view.teaching) return '';
  const pH = 7.31 - 0.019 * (T.bd - 3) - 0.11 * T.resp;
  return `<div class="truth">truth: ${T.dil.toFixed(1)} cm, sta ${T.station.toFixed(1)}, R ${T.R.toFixed(2)} · BD ${T.bd.toFixed(1)} pH≈${pH.toFixed(2)} · plac ${T.plac.toFixed(2)}${p.sd && p.sd.active ? ` · SD difficulty ×${p.sd.k.toFixed(2)}` : ''}${p.crisis ? ` · ${CRISIS_LABEL[p.crisis.cause]} ${p.crisis.phase}${p.crisis.phase === 'arrest' ? ' ' + p.crisis.rhythm : ''}, fib ${Math.round(T.fib)}` : ''}${T.prolapse ? ' · PROLAPSE' : ''}${T.abr ? ' · abruption ' + T.abr.toFixed(2) : ''}${T.infect > 1 ? ' · Triple I' : ''}${T.demise ? ' · DEMISE' : ''}</div>`;
}
function unreadCount(pid) { let n = 0, hi = 0; for (const m of ui.sim.msgs) if (m.pid === pid && !m.read && m.prio >= 1) { n++; hi = Math.max(hi, m.prio); } return [n, hi]; }

function card(p, s, label) {
  const [n, hi] = unreadCount(p.id);
  const nurse = s.nurseOf(p);
  const ga = fmtGA(p.gaDays);
  return `<div class="card${p.id === ui.selId ? ' sel' : ''}" data-pid="${p.id}">
    <div class="r1"><span class="room">${esc(label || p.room || '')}${n ? ` <span class="badge${hi < 2 ? ' lo' : ''}">${n}</span>` : ''}</span><span class="meta">${nurse ? esc(nurse.name) : ''}</span></div>
    <div><span class="nm">${esc(p.name.split(' ')[0])}</span> <span class="meta">${p.age} G${p.gravida}P${p.para} ${ga}</span></div>
    <div class="st">${knownStatus(p, s)}</div>
    <div class="tags">${tags(p)}</div>
    ${truthLine(p)}
    ${p.mon.on && p.mon.t0 !== null && !p.outcome ? `<canvas data-mini="${p.id}"></canvas>` : ''}
  </div>`;
}

function renderBoard() {
  const s = ui.sim;
  let h = '<div class="bsec"><h3><span>Labor &amp; delivery</span></h3>';
  for (const r of s.rooms) {
    const p = r.pid ? s.byId[r.pid] : null;
    h += p ? card(p, s, r.name) : `<div class="card empty">${r.name} — ${r.cleanUntil > s.t ? 'being cleaned (' + Math.ceil((r.cleanUntil - s.t) / 60) + ' min)' : 'open'}</div>`;
  }
  h += '</div><div class="bsec"><h3><span>Triage</span></h3>';
  for (const b of s.bays) {
    const p = b.pid ? s.byId[b.pid] : null;
    h += p ? card(p, s, b.name + (p.boarding ? ' (boarding)' : '')) : `<div class="card empty">${b.name} — open</div>`;
  }
  const waiting = s.patients.filter(p => p.area === 'waiting' && p.status !== 'gone');
  if (waiting.length) { h += '<h3><span>Waiting room</span></h3>'; for (const p of waiting) h += card(p, s, p.waitingForBay ? 'Waiting (triage full)' : 'Waiting (scheduled)'); }
  h += '</div>';
  const elsewhere = s.patients.filter(p => ['or', 'pacu', 'preop'].includes(p.area) && p.status !== 'gone');
  if (elsewhere.length) { h += '<div class="bsec"><h3><span>Pre-op / OR / PACU</span></h3>'; for (const p of elsewhere) h += card(p, s, p.room); h += '</div>'; }
  const sched = (s.boardSchedule || []).filter(x => x.t > s.t);
  if (sched.length) h += `<div class="bsec"><h3><span>Coming up</span></h3>${sched.map(x => `<div class="resline"><b>${s.clock(x.t)}</b> ${esc(x.text)}</div>`).join('')}</div>`;
  const gone = s.patients.filter(p => (p.status === 'gone' && p.outcome) || p.area === 'home');
  if (gone.length) h += `<div class="bsec"><h3><span>Off the floor</span></h3>${gone.map(p => `<div class="resline" data-pid="${p.id}" style="cursor:pointer">${esc(p.name)} — ${p.outcome ? (p.outcome.mode === 'cs' ? 'CS' : 'SVD') + ' ' + s.clock(p.outcome.t) + (p.outcome.neo.nicu ? ' · NICU' : '') : p.phone ? 'phone: ' + (p.phoneAdvice || 'call') : 'discharged ' + s.clock(p.dischargeT)}</div>`).join('')}</div>`;
  const board = $('#board');
  const scroll = board.scrollTop;
  board.innerHTML = h;
  board.scrollTop = scroll;
  board.querySelectorAll('canvas[data-mini]').forEach(c => drawMini(c, s, s.byId[c.dataset.mini]));
}

function renderPatient() {
  const s = ui.sim, p = s.byId[ui.selId];
  if (!p) { $('#ptHeader').innerHTML = '<span class="sub">Select a patient on the board.</span>'; return; }
  const nurse = s.nurseOf(p);
  $('#ptHeader').innerHTML = `<span class="big">${esc(p.name)}</span><span class="sub">${p.age}yo G${p.gravida}P${p.para} · ${fmtGA(p.gaDays)} wk · BMI ${p.bmi} · ${esc(p.room || p.area)}</span>
    <span class="sub">${esc(p.indication)}</span>${nurse ? `<span class="sub">RN <b>${esc(nurse.name)}</b> <span class="tag">${esc(nurse.label)}</span></span>` : ''}${p.labMode ? '<span class="tag green">lab</span>' : ''}`;
  // strip info
  const m = p.mon;
  $('#stripInfo').textContent = `${p.devices.fse ? 'FSE' : 'US'} / ${p.devices.iupc ? 'IUPC' : 'TOCO'}${m.on ? '' : ' · OFF MONITOR'}${ui.view.live ? '' : ' · viewing ' + s.clock(ui.view.endT)}`;
  $('#liveBtn').classList.toggle('live', ui.view.live);
  // vitals bar
  const v = s.lastVitals(p);
  const vb = [];
  if (v) {
    const hot = v.sbp >= 160 || v.dbp >= 110;
    vb.push(`<span class="${hot ? 'hot' : ''}">BP <b>${v.sbp}/${v.dbp}</b></span>`, `HR <b>${v.hr}</b>`, `<span class="${v.temp >= 38 ? 'hot' : ''}">T <b>${v.temp}</b></span>`, `RR <b>${v.rr}</b>`, `SpO₂ <b>${v.spo2}</b>`);
    if (v.reflex) vb.push(`<span class="${v.reflex === 'absent' ? 'hot' : ''}">DTR <b>${v.reflex}</b></span>`);
    vb.push(`<span>@${s.clock(v.t)} (${esc(v.by)})</span>`);
  }
  const pit = p.meds.pit;
  if (pit.rate || pit.protocol) vb.push(`Pit <b>${pit.rate}</b> mU/min${pit.protocol ? ` (protocol ↑${pit.protocol.inc} q${pit.protocol.intervalMin}′, max ${pit.protocol.max})` : ''}`);
  if (p.meds.mag.on) vb.push(`Mg <b>${p.meds.mag.rate}</b> g/h`);
  if (p.meds.o2) vb.push('O₂');
  if (p.devices.amnioinf) vb.push('amnioinfusion');
  if (p.chart.romKnown && p.T.romT > -1e8 && !p.outcome) vb.push(`ROM ${fmtDur(s.t - p.T.romT)}`);
  if (p.T.pp) { const q = [...p.chart.vitals].reverse().find(x => x.qbl != null); if (q) vb.push(`QBL <b>${q.qbl}</b> · fundus ${esc(q.fundus)}`); }
  $('#vitalsBar').innerHTML = vb.join('') || '<span>No vitals yet.</span>';
  renderQuick(p);
  renderTabs();
  renderChart(p);
}

function quickDefs(p) {
  const O = (label, text, cls) => ({ label, text, cls });
  if (p.outcome) return [O('Fundal massage', 'fundal massage'), O('TXA 1 g', 'TXA 1 g IV'), O('Methergine 0.2', 'methergine 0.2 mg IM'), O('Hemabate 250', 'hemabate 250 mcg IM'), O('Miso 800 PR', 'miso 800 mcg PR'), O('Pit 40 u/1 L', 'pit 40 units in 1 L'), '|', O('Bakri', 'bakri'), O('Transfuse 2u', 'transfuse 2 units'), O('Return to OR', 'return to OR', 'cs'), '|', O('CBC', 'CBC'), O('Fibrinogen', 'fibrinogen'), O('Vitals', 'vitals')];
  if (p.area === 'triage' || p.area === 'waiting') return [O('Admit', 'admit'), O('Discharge', 'discharge'), O('Walk 2 h', 'observe'), '|', O('SVE (RN)', 'SVE'), { label: 'Examine (you)', md: true }, O('ROM test', 'ROM test'), O('Bedside US', 'bedside US'), O('PIH labs', 'PIH labs'), O('UPC', 'UPC'), O('Vitals', 'vitals'), O('VAS', 'VAS'), '|', { label: 'C-section…', cs: true }];
  return [
    O('SVE (RN)', 'SVE'), { label: 'Examine (you)', md: true }, O('Vitals', 'vitals'), O('Reposition', 'reposition'), O('LR 500', 'LR bolus 500'), O('O₂', 'O2'), '|',
    O('Pit protocol', 'pit per protocol'), O('Pit ↑2', 'pit up 2'), O('Pit ↓2', 'pit down 2'), O('Pit off', 'pit off'), '|',
    O('AROM', 'AROM'), O('IUPC', 'IUPC'), O('FSE', 'FSE'), O('Amnioinfusion', 'amnioinfusion'), O('Terb', 'terbutaline 0.25 mg SQ'), O('VAS', 'VAS'), '|',
    O('Epidural', 'epidural'), O('Bedside US', 'bedside US'), O('CBC', 'CBC'), O('PIH labs', 'PIH labs'), '|',
    O('Push', 'push'), O('Labor down', 'labor down'), O('Vacuum', 'vacuum'), { label: 'C-section…', cs: true },
  ];
}
let quickFor = null;
function renderQuick(p) {
  const key = p.id + (p.outcome ? 'pp' : p.area);
  if (quickFor === key) return;
  quickFor = key;
  const q = $('#quick');
  q.innerHTML = '';
  for (const d of quickDefs(p)) {
    if (d === '|') { const sp = document.createElement('span'); sp.className = 'sep'; q.appendChild(sp); continue; }
    const b = document.createElement('button');
    b.textContent = d.label;
    if (d.cls || d.cs) b.className = 'cs';
    b.onclick = () => {
      if (ui.replay) return;
      if (d.md) feedback(ui.sim.command({ type: 'mdExam', pid: ui.selId }));
      else if (d.cs) csDialog();
      else submitOrder(d.text);
    };
    q.appendChild(b);
  }
}

function csDialog() {
  const ov = $('#overlay');
  const p = ui.sim.byId[ui.selId];
  ov.innerHTML = `<div class="dlg narrow cs-dlg"><h2>Cesarean — ${esc(p.name)}</h2>
    <div class="row"><label><input type="radio" name="urg" value="stat"> <b>STAT</b> (category 1 — now, GA if no epidural)</label></div>
    <div class="row"><label><input type="radio" name="urg" value="urgent" checked> <b>Urgent</b> (category 2 — next available)</label></div>
    <div class="row"><label><input type="radio" name="urg" value="routine"> <b>Scheduled / non-urgent</b></label></div>
    <div class="row" style="display:block"><label>Indication<br><select id="csInd">${CS_INDICATIONS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label></div>
    <div class="btnrow"><button id="csGo" class="danger">Call the section</button><button id="csCancel" class="ghost">Cancel</button></div></div>`;
  ov.classList.add('show');
  $('#csCancel').onclick = () => ov.classList.remove('show');
  $('#csGo').onclick = () => {
    const urg = ov.querySelector('input[name=urg]:checked').value;
    const ind = CS_INDICATIONS.find(x => x[0] === $('#csInd').value)[1];
    ov.classList.remove('show');
    submitOrder(`c-section ${urg === 'routine' ? 'scheduled' : urg} for ${ind}`);
  };
}

const TABS = [['overview', 'Overview'], ['exams', 'Exams'], ['vitals', 'Vitals'], ['labs', 'Labs'], ['orders', 'Orders'], ['mar', 'MAR'], ['truth', 'Truth']];
function renderTabs() {
  const el = $('#chartTabs');
  const want = TABS.filter(([k]) => k !== 'truth' || ui.view.teaching);
  const sig = want.map(x => x[0]).join() + ui.tab;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.innerHTML = want.map(([k, l]) => `<button data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${l}</button>`).join('');
  el.querySelectorAll('button').forEach(b => b.onclick = () => { ui.tab = b.dataset.tab; renderPatient(); });
}

function renderChart(p) {
  const s = ui.sim, el = $('#chart');
  let h = '';
  if (ui.tab === 'overview') {
    const k = p.known;
    const sched = (p.meds.sched || []).filter(x => !x.lostShown).map(x => `${x.drug} ${x.amt}${x.route ? ' ' + x.route : ''} q${x.everyH}h — next ${s.clock(x.nextT)}`);
    const abx = p.meds.abx.slice(-4).map(a => `${a.drug} @${s.clock(a.t)}`);
    h = `<div class="cols"><div class="kv">
      <span class="k">Indication</span><span>${esc(p.indication)}</span>
      <span class="k">Plan (sign-out)</span><span>${esc(p.plan || '—')}</span>
      <span class="k">G/P</span><span>G${p.gravida}P${p.para}${p.priorCS ? ` · prior CS ×${p.priorCS}` : ''}${p.priorVag ? ` · ${p.priorVag} prior vaginal` : ''}</span>
      <span class="k">GA</span><span>${fmtGA(p.gaDays)} weeks</span>
      <span class="k">BMI / weight</span><span>${p.bmi} / ${p.weightKg} kg</span>
      <span class="k">Allergies</span><span>${p.allergy.list.length ? esc(p.allergy.list.join(', ')) : 'NKDA'}</span>
      <span class="k">GBS</span><span>${p.gbs}${p.gbs === 'pos' && p.known.clindaResult ? ' (clinda ' + p.known.clindaResult + ')' : ''}</span>
      <span class="k">History</span><span>${esc(k.notes.join('; ') || '—')}</span>
      <span class="k">Membranes</span><span>${p.chart.romKnown ? 'ruptured' + (p.T.romT > -1e8 ? ' ' + fmtDur(s.t - p.T.romT) + ' ago' : '') : p.chart.romResult === 'negative' ? 'intact (ROM test neg)' : 'intact (as far as we know)'}</span>
    </div><div class="kv">
      <span class="k">Status</span><span>${knownStatus(p, s) || '—'}</span>
      <span class="k">Epidural</span><span>${p.epidural.state}${p.flags.natural ? ' (wants natural birth)' : ''}</span>
      <span class="k">Devices</span><span>${[p.devices.iupc && 'IUPC', p.devices.fse && 'FSE', p.devices.amnioinf && 'amnioinfusion', p.meds.foley.in && 'cervical Foley', p.meds.cervidil.in && `Cervidil (in ${fmtDur(s.t - p.meds.cervidil.inT)})`].filter(Boolean).join(', ') || '—'}</span>
      <span class="k">Scheduled meds</span><span>${esc(sched.join('; ') || '—')}</span>
      <span class="k">Recent abx</span><span>${esc(abx.join(', ') || '—')}</span>
      <span class="k">Admitted</span><span>${p.admitT != null ? s.clock(p.admitT) : '—'}${p.flags.iolStartT != null ? ` · IOL started ${s.clock(p.flags.iolStartT)}` : ''}</span>
      ${p.outcome ? `<span class="k">Delivery</span><span>${s.clock(p.outcome.t)} ${p.outcome.mode}${p.outcome.vacuum ? ' (vacuum)' : ''} · ${p.outcome.neo.liveborn ? `${p.outcome.neo.sex} ${p.outcome.neo.weight} g, Apgars ${p.outcome.neo.apgar1}/${p.outcome.neo.apgar5}` : 'stillborn'}</span>` : ''}
    </div></div>`;
  } else if (ui.tab === 'exams') {
    const rows = p.chart.sves.slice().reverse().map((x, i, arr) => {
      const prev = arr[i + 1];
      const dt = prev ? fmtDur(x.t - prev.t) : '';
      return `<tr><td class="mono">${s.clock(x.t)}</td><td class="mono"><b>${sveString(x)}</b></td><td>${esc(x.by)}</td><td class="mono">${dt}</td><td>${esc((x.notes || []).join(', '))}</td>${ui.view.teaching && x.trueDil != null ? `<td class="truth">true ${x.trueDil.toFixed(1)} / ${x.trueSta.toFixed(1)}</td>` : ''}</tr>`;
    }).join('');
    h = `<table><tr><th>Time</th><th>Exam</th><th>By</th><th>Interval</th><th>Notes</th>${ui.view.teaching ? '<th>Truth</th>' : ''}</tr>${rows || '<tr><td colspan=5>No exams yet.</td></tr>'}</table>`;
  } else if (ui.tab === 'vitals') {
    const rows = p.chart.vitals.slice(-30).reverse().map(v => v.qbl != null
      ? `<tr><td class="mono">${s.clock(v.t)}</td><td colspan=6>QBL <b>${v.qbl}</b> mL · fundus ${esc(v.fundus)}</td><td>${esc(v.by)}</td></tr>`
      : `<tr><td class="mono">${s.clock(v.t)}</td><td class="mono" style="${v.sbp >= 160 || v.dbp >= 110 ? 'color:var(--red)' : ''}">${v.sbp}/${v.dbp}</td><td class="mono">${v.hr}</td><td class="mono" style="${v.temp >= 38 ? 'color:var(--red)' : ''}">${v.temp}</td><td class="mono">${v.rr}</td><td class="mono">${v.spo2}</td><td>${v.reflex || ''}</td><td>${esc(v.by)}</td></tr>`).join('');
    h = `<table><tr><th>Time</th><th>BP</th><th>HR</th><th>T</th><th>RR</th><th>SpO₂</th><th>DTR</th><th>By</th></tr>${rows}</table>`;
  } else if (ui.tab === 'labs') {
    const rows = p.chart.labs.slice().reverse().map(l => `<tr><td class="mono">${s.clock(l.orderT)}</td><td>${esc(l.label)}</td><td class="mono">${l.values ? esc(l.text) : `pending (≈${s.clock(l.resultT)})`}</td></tr>`).join('');
    h = `<table><tr><th>Ordered</th><th>Test</th><th>Result</th></tr>${rows || '<tr><td colspan=3>No labs.</td></tr>'}</table>`;
  } else if (ui.tab === 'orders') {
    const rows = p.chart.orders.slice().reverse().map(o => `<tr><td class="mono">${s.clock(o.t)}</td><td>${esc(o.label)}<div class="mono" style="color:var(--dim);font-size:11px">${esc(o.text)}</div></td><td class="st-${o.status}">${o.status.replace('_', ' ')}${o.overridden ? ' (override)' : ''}</td><td>${o.status.startsWith('held') || o.status === 'new' ? `<button class="small" data-cancel="${o.id}">cancel</button>` : ''}</td></tr>`).join('');
    h = `<table><tr><th>Time</th><th>Order</th><th>Status</th><th></th></tr>${rows || '<tr><td colspan=4>No orders yet.</td></tr>'}</table>`;
  } else if (ui.tab === 'mar') {
    const rows = p.chart.mar.slice().reverse().map(x => `<tr><td class="mono">${s.clock(x.t)}</td><td>${esc(x.text)}</td><td>${esc(x.by)}</td></tr>`).join('');
    h = `<table><tr><th>Time</th><th>Given</th><th>By</th></tr>${rows || '<tr><td colspan=3>Nothing given yet.</td></tr>'}</table>`;
  } else if (ui.tab === 'truth') {
    const T = p.T, n = s.nurseOf(p);
    const pH = 7.31 - 0.019 * (T.bd - 3) - 0.11 * T.resp;
    h = `<div class="truthbox"><h4>Hidden truth (teaching mode)</h4><div class="cols"><div class="kv">
      <span class="k">Dilation / station</span><span>${T.dil.toFixed(2)} cm / ${T.station.toFixed(2)} ${T.op ? '(OP)' : ''}</span>
      <span class="k">Ripeness R</span><span>${T.R.toFixed(2)}</span>
      <span class="k">Labor</span><span>${p.truePhase || '—'} · drive S ${T.S.toFixed(2)} · rate ${(T.dilRate || 0).toFixed(2)} cm/h</span>
      <span class="k">Contractions</span><span>f10 ${T.f10drive?.toFixed(1)} · MVU ${Math.round(T.mvu)} · tone ${T.tone?.toFixed(0)}</span>
      <span class="k">Pit sensitivity</span><span>EC50 ${T.ec50.toFixed(1)} mU/min · effect-site ${T.pitCe.toFixed(1)}</span>
      <span class="k">CPD / arrest</span><span>${T.cpdCm != null ? 'arrests at ' + T.cpdCm.toFixed(1) + ' cm' : T.cpdSta != null ? 'descent stops at ' + T.cpdSta.toFixed(1) : 'none'}</span>
      <span class="k">Infection</span><span>${T.infect.toFixed(2)} ${T.infect > 1 ? '(Triple I)' : ''}</span>
    </div><div class="kv">
      <span class="k">Placental reserve</span><span>${T.plac.toFixed(2)}</span>
      <span class="k">Oxygenation</span><span>${T.ox.toFixed(2)}</span>
      <span class="k">Base deficit</span><span>${T.bd.toFixed(1)} → pH ≈ ${pH.toFixed(2)}</span>
      <span class="k">Cord</span><span>vuln ${T.cordVuln.toFixed(3)} × pos ${T.cordPos.toFixed(2)}${T.nuchal ? ' · nuchal' : ''}${T.prolapse ? ' · PROLAPSE' : ''}</span>
      <span class="k">EFW (true)</span><span>${T.efw} g</span>
      <span class="k">Mother</span><span>BP ${T.sbp.toFixed(0)}/${T.dbp.toFixed(0)} · Mg ${T.mg.toFixed(1)} · plt ${T.plt.toFixed(0)} · Cr ${T.cr.toFixed(2)}</span>
      <span class="k">Nurse</span><span>${n ? `${esc(n.name)}: dil bias ${n.dilBias >= 0 ? '+' : ''}${n.dilBias.toFixed(1)} ±${n.dilNoise.toFixed(1)}, station bias ${n.staBias.toFixed(1)}, knowledge ${n.knowledge.toFixed(2)}, pit ${n.pit}` : '—'}</span>
    </div></div>
    <div style="margin-top:8px">${(p.truthLog || []).slice(-12).map(x => `<div class="mono" style="font-size:11px">${s.clock(x.t)} ${esc(x.text)}</div>`).join('')}</div></div>`;
  }
  const scroll = el.scrollTop;
  if (el.dataset.html !== h) { el.innerHTML = h; el.dataset.html = h; el.scrollTop = scroll; }
}

// ------------------------------------------------------------------------ orders
function submitOrder(text) {
  if (!ui.sim || ui.replay) return;
  if (!ui.selId && !/backup/i.test(text)) { feedback({ ok: false, msg: 'Select a patient first.' }); return; }
  const r = ui.sim.command({ type: 'order', pid: ui.selId, text });
  feedback(r);
  ui.tab === 'orders' && renderPatient();
}
function feedback(r) {
  const el = $('#orderPreview');
  if (!r) return;
  el.textContent = r.ok ? '✓ ' + (r.msg || 'sent') : '✗ ' + (r.msg || 'not sent');
  el.classList.toggle('err', !r.ok);
}

function wire() {
  // the board and chart re-render several times a second: delegate on mousedown so clicks never land on a stale node
  $('#board').addEventListener('mousedown', (e) => { const el = e.target.closest('[data-pid]'); if (el) select(el.dataset.pid); });
  $('#emerg').addEventListener('mousedown', (e) => {
    const b = e.target.closest('button[data-order]');
    const box = e.target.closest('[data-pid]');
    if (box) select(box.dataset.pid);
    if (b && !b.disabled && !ui.replay) feedback(ui.sim.command({ type: 'order', pid: b.dataset.pid, text: b.dataset.order }));
  });
  $('#chart').addEventListener('mousedown', (e) => { const b = e.target.closest('[data-cancel]'); if (b && !ui.replay) ui.sim.command({ type: 'cancel', oid: +b.dataset.cancel }); });
  $('#orderHints').innerHTML = ORDER_HINTS.map(h => `<option value="${esc(h)}">`).join('');
  const inp = $('#orderInput');
  inp.addEventListener('input', () => {
    const v = inp.value.trim();
    const el = $('#orderPreview');
    if (!v) { el.textContent = ''; return; }
    const o = parseOrder(v);
    el.textContent = o.ok ? '→ ' + describeParsed(o) : o.error;
    el.classList.toggle('err', !o.ok);
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = inp.value.trim(); if (v) { submitOrder(v); inp.value = ''; } }
    if (e.key === 'Escape') inp.blur();
  });
  $('#orderGo').onclick = () => { const v = inp.value.trim(); if (v) { submitOrder(v); inp.value = ''; } };
  document.querySelectorAll('#speed button').forEach(b => b.onclick = () => setSpeed(b.dataset.speed === 'skip' ? 'skip' : +b.dataset.speed));
  $('#menuBtn').onclick = () => { setSpeed(0); showMenu(); };
  $('#endBtn').onclick = () => {
    if (!ui.sim || ui.ended) return;
    if (!confirm('End the shift now and go to the debrief?')) return;
    if (ui.replay) { endShift(); return; }
    ui.sim.command({ type: 'endShift' }); ui.sim.tick();
  };
  $('#teach').onchange = (e) => { ui.view.teaching = e.target.checked; if (ui.sim) ui.sim.teaching = e.target.checked; renderAll(); };
  document.querySelectorAll('.filters button').forEach(b => b.onclick = () => {
    ui.filter = b.dataset.filter;
    document.querySelectorAll('.filters button').forEach(x => x.classList.toggle('on', x === b));
    refreshFeed();
  });
  $('#phoneToggle').onclick = togglePhone;
  $('#floorToggle').onclick = toggleFloor;
  const fl = $('#floor');
  fl.addEventListener('mousemove', (e) => { const r = fl.getBoundingClientRect(); setHover({ x: e.clientX - r.left, y: e.clientY - r.top }); });
  fl.addEventListener('mouseleave', () => setHover(null));
  fl.addEventListener('mousedown', (e) => {
    if (!ui.sim || ui.replay) return;
    const r = fl.getBoundingClientRect();
    const place = roomAt(fl, e.clientX - r.left, e.clientY - r.top);
    if (!place) return;
    feedback(ui.sim.command({ type: 'walk', place, run: e.shiftKey }));
    const p = ui.sim.patients.find(q => q.status !== 'gone' && (q.room === place || (place === 'Waiting' && q.area === 'waiting')));
    if (p) select(p.id);
  });
  $('#phoneMini').onclick = togglePhone;
  $('#stripWindow').onchange = (e) => { ui.view.window = e.target.value === 'paper' ? 'paper' : +e.target.value; };
  $('#liveBtn').onclick = () => { ui.view.live = true; };
  // scrub the strip: drag or wheel
  const cv = $('#strip');
  let drag = null;
  cv.addEventListener('mousedown', (e) => { drag = { x: e.clientX, end: ui.view.live ? ui.sim.t : ui.view.endT }; });
  window.addEventListener('mouseup', () => { drag = null; });
  window.addEventListener('mousemove', (e) => {
    if (!drag || !ui.sim) return;
    const secPerPx = (ui.view.winSec || 600) / (cv.clientWidth - 40);
    const end = clamp(drag.end - (e.clientX - drag.x) * secPerPx, 300, ui.sim.t);
    ui.view.endT = end; ui.view.live = end >= ui.sim.t - 2;
  });
  cv.addEventListener('wheel', (e) => {
    if (!ui.sim) return;
    e.preventDefault();
    const base = ui.view.live ? ui.sim.t : ui.view.endT;
    const end = clamp(base + (e.deltaY + e.deltaX) * (ui.view.winSec || 600) / 1500, 300, ui.sim.t);
    ui.view.endT = end; ui.view.live = end >= ui.sim.t - 2;
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if ($('#overlay').classList.contains('show') || !$('#landing').classList.contains('hidden')) return;
    if (e.key === ' ') { e.preventDefault(); setSpeed(ui.speed ? 0 : 1); }
    else if (e.key === '1') setSpeed(1); else if (e.key === '2') setSpeed(10); else if (e.key === '3') setSpeed(60); else if (e.key === '4') setSpeed(240);
    else if (e.key === 'n' || e.key === 'N') setSpeed('skip');
    else if (e.key === '/') { e.preventDefault(); $('#orderInput').focus(); }
    else if (e.key === 'p' || e.key === 'P') togglePhone();
    else if (e.key === 'm' || e.key === 'M') toggleFloor();
    else if ((e.key === 'e' || e.key === 'E') && ui.selId) feedback(ui.sim.command({ type: 'mdExam', pid: ui.selId }));
    else if (e.key === '[' || e.key === ']') {
      const list = [...document.querySelectorAll('#board .card[data-pid]')].map(c => c.dataset.pid);
      const i = list.indexOf(ui.selId);
      if (list.length) select(list[(i + (e.key === ']' ? 1 : -1) + list.length) % list.length]);
    }
  });
}

// ------------------------------------------------------------------------ tracing lab
function renderLab() {
  const s = ui.sim, p = s.patients[0];
  const box = document.createElement('div');
  box.className = 'labpanel';
  const sl = (key, label, min, max, step, val) => `<label>${label} <span id="lv_${key}">${val}</span><input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${val}"></label>`;
  box.innerHTML = sl('plac', 'Placental reserve', 0.3, 1.1, 0.01, p.T.plac.toFixed(2)) + sl('pit', 'Pit mU/min', 0, 30, 1, 0)
    + sl('cordVuln', 'Cord vulnerability /ctx', 0, 0.8, 0.01, p.T.cordVuln.toFixed(2)) + sl('bd', 'Base deficit (set)', 0, 20, 0.5, p.T.bd.toFixed(1))
    + sl('epiHypo', 'Epidural hypotension (mmHg)', 0, 50, 1, 0) + sl('temp', 'Maternal temp °C', 36.5, 40, 0.1, p.T.temp0.toFixed(1))
    + `<label><span>Devices / events</span><span style="display:flex;gap:6px;flex-wrap:wrap"><button data-tog="rom">ROM</button><button data-tog="iupc">IUPC</button><button data-tog="fse">FSE</button><button data-tog="prolapse">Cord prolapse</button></span></label>`;
  $('#chart').before(box);
  box.querySelectorAll('input[type=range]').forEach(r => r.oninput = () => {
    $('#lv_' + r.dataset.key).textContent = r.value;
    s.command({ type: 'lab', pid: p.id, key: r.dataset.key, value: +r.value });
  });
  const state = { rom: false, iupc: false, fse: false, prolapse: false };
  box.querySelectorAll('[data-tog]').forEach(b => b.onclick = () => {
    const k = b.dataset.tog;
    state[k] = !state[k];
    if ((k === 'iupc' || k === 'fse') && state[k]) { state.rom = true; s.command({ type: 'lab', pid: p.id, key: 'rom', value: 1 }); }
    s.command({ type: 'lab', pid: p.id, key: k, value: state[k] ? 1 : 0 });
    box.querySelectorAll('[data-tog]').forEach(x => x.classList.toggle('on', state[x.dataset.tog]));
  });
  ui.tab = 'truth'; ui.view.teaching = true; s.teaching = true; $('#teach').checked = true;
}

window.ldNight = ui; // console handle for debugging / drills
wire();
requestAnimationFrame(frame);
showMenu(true);
