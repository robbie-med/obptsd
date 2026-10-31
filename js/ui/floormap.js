// The floor from above: rooms, the OB ED wing, and everyone as a dot (floor.js moves them; this only
// draws). Click a room to walk there (shift-click to run). Reads staff positions and the board — never p.T.
import { PLAN, placeOf } from '../engine/floor.js';

const COLORS = { md: '#ffffff', charge: '#ffb454', anes: '#f5e663', backup: '#ff7a8a', nurse: '#4fd1c5', triage: '#b794f4' };
const ROOM_W = { ldr: 8, other: 7 };

let hover = null; // { x, y } in canvas px

function layout(cv) {
  const b = PLAN.bounds, w = cv.clientWidth, h = cv.clientHeight;
  const sx = w / (b.x1 - b.x0), sy = h / (b.y1 - b.y0), s = Math.min(sx, sy);
  const ox = (w - s * (b.x1 - b.x0)) / 2 - b.x0 * s, oy = (h - s * (b.y1 - b.y0)) / 2 - b.y0 * s;
  return { s, X: (x) => ox + x * s, Y: (y) => oy + y * s, inv: (px, py) => [(px - ox) / s, (py - oy) / s] };
}

function roomRects() {
  const out = [];
  for (const [name, x, side] of PLAN.rooms) out.push({ name, x, y: 20 + side * 10, w: name.startsWith('LDR') ? ROOM_W.ldr : ROOM_W.other, h: 8, wing: 'ld' });
  for (const [name, x, side] of PLAN.obed) out.push({ name, x, y: 20 + side * 9, w: name === 'Waiting' ? 8 : 6, h: 7, wing: 'ed' });
  return out;
}
const RECTS = roomRects();

export function roomAt(cv, px, py) {
  const L = layout(cv);
  const [x, y] = L.inv(px, py);
  const r = RECTS.find(r => Math.abs(x - r.x) <= r.w / 2 && Math.abs(y - r.y) <= r.h / 2);
  if (r) return r.name;
  if (Math.abs(x - 19) < 3 && Math.abs(y - 20) < 2) return 'Station';
  return null;
}

export function drawFloor(cv, sim, ui, alpha = 1) {
  if (!cv || !sim || !sim.floor) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== cv.clientWidth * dpr || cv.height !== cv.clientHeight * dpr) { cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const L = layout(cv), s = L.s;
  g.clearRect(0, 0, cv.clientWidth, cv.clientHeight);
  g.fillStyle = '#0d141b'; g.fillRect(0, 0, cv.clientWidth, cv.clientHeight);
  // wings
  const wing = (x0, x1, label) => {
    g.fillStyle = '#121c26'; g.strokeStyle = '#2a3a4a'; g.lineWidth = 1;
    g.fillRect(L.X(x0), L.Y(5.5), (x1 - x0) * s, 29 * s); g.strokeRect(L.X(x0), L.Y(5.5), (x1 - x0) * s, 29 * s);
    g.fillStyle = '#5b6f84'; g.font = `600 ${Math.max(8, s * 1.15)}px system-ui`; g.textAlign = 'left'; g.fillText(label, L.X(x0) + 3, L.Y(17.6));
  };
  wing(-45, -16.5, 'OB ED / TRIAGE');
  wing(-1, 68.5, 'LABOR & DELIVERY');
  // corridors
  g.fillStyle = '#1a2633';
  g.fillRect(L.X(-1), L.Y(18), 69.5 * s, 4 * s);
  g.fillRect(L.X(-44), L.Y(18), 27.5 * s, 4 * s);
  g.fillStyle = '#141e28'; g.fillRect(L.X(-16.5), L.Y(18.7), 15.5 * s, 2.6 * s); // public hallway
  g.fillStyle = '#5b6f84'; g.font = `${Math.max(8, s * 1.2)}px system-ui`; g.textAlign = 'center';
  g.fillText('hallway', L.X(-8.7), L.Y(17.8));
  // badge doors
  g.fillStyle = '#c96'; for (const x of [-1.5, -16.5]) g.fillRect(L.X(x) - 1, L.Y(18.4), 2, 3.2 * s);
  // rooms
  const occ = {};
  for (const p of sim.patients) { const pl = placeOf(p); if (pl) (occ[pl] || (occ[pl] = [])).push(p); }
  const myPlace = sim.floor.md.at;
  for (const r of RECTS) {
    const x = L.X(r.x - r.w / 2), y = L.Y(r.y - r.h / 2), w = r.w * s, h = r.h * s;
    const pts = occ[r.name] || [];
    const sel = pts.some(p => p.id === ui.selId);
    const emerg = pts.some(p => (p.sd && p.sd.active) || (p.crisis && ['prodrome', 'collapse', 'arrest'].includes(p.crisis.phase)));
    const urgent = pts.some(p => unreadPrio(sim, p.id) >= 3);
    g.fillStyle = emerg ? (Math.floor(Date.now() / 400) % 2 ? '#5a1720' : '#3a1016') : pts.length ? '#1f3142' : r.name === 'Med room' ? '#1c2b22' : '#16212c';
    g.fillRect(x, y, w, h);
    g.strokeStyle = sel ? '#7fb6ff' : urgent ? '#ff6b6b' : '#33475b'; g.lineWidth = sel || urgent ? 2 : 1;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    const fs = Math.max(8, Math.min(12, s * 1.25));
    g.fillStyle = '#9fb3c8'; g.font = `600 ${fs}px system-ui`; g.textAlign = 'center';
    g.fillText(r.name.replace('Triage ', 'Tri ').replace('Report room', 'Report').replace('Med room', 'Meds 💊').replace('Call room', 'Call rm').replace('OB ED station', 'ED desk'), x + w / 2, y + fs + 1);
    if (pts.length) {
      g.fillStyle = '#d7e3ef'; g.font = `${fs - 1}px system-ui`;
      g.fillText(pts.map(p => p.name.split(' ')[0]).slice(0, 3).join(', '), x + w / 2, y + h - 4);
    }
    if (r.name === myPlace) { g.strokeStyle = '#ffffff55'; g.setLineDash([3, 3]); g.strokeRect(x + 3, y + 3, w - 6, h - 6); g.setLineDash([]); }
  }
  // nurses' station island
  g.fillStyle = '#26394c'; g.fillRect(L.X(16.5), L.Y(19), 5 * s, 2 * s);
  g.fillStyle = '#9fb3c8'; g.font = `600 ${Math.max(8, s * 1.1)}px system-ui`; g.textAlign = 'center'; g.fillText('station', L.X(19), L.Y(23.6));
  g.fillStyle = '#26394c'; g.fillRect(L.X(-22), L.Y(12), 4 * s, 2 * s);
  // where you're headed
  const md = sim.floor.md;
  if (md.path.length) {
    g.strokeStyle = '#ffffff66'; g.setLineDash([4, 4]); g.lineWidth = 1.2; g.beginPath();
    g.moveTo(L.X(md.x), L.Y(md.y));
    for (const id of md.path) { const nd = PLAN.nodes[id]; g.lineTo(L.X(nd.x), L.Y(nd.y)); }
    g.stroke(); g.setLineDash([]);
  }
  // people
  const view = sim.floor.view();
  const r0 = Math.max(3.5, Math.min(6, s * 0.75));
  hoverInfo = null;
  // spread dots that share a spot so a crowded room shows everyone
  const spot = {};
  for (const a of view) {
    const ix = a.px + (a.x - a.px) * alpha, iy = a.py + (a.y - a.py) * alpha;
    const k = Math.round(ix) + ',' + Math.round(iy);
    const n = (spot[k] = (spot[k] || 0) + 1) - 1;
    const ang = n * 2.1, rad = n ? r0 * 1.9 : 0;
    const X = L.X(ix) + Math.cos(ang) * rad, Y = L.Y(iy) + Math.sin(ang) * rad;
    const col = a.kind === 'nurse' ? (a.triage ? COLORS.triage : COLORS.nurse) : COLORS[a.kind] || '#ccc';
    if (a.prio >= 8) { g.strokeStyle = '#ff4d4d'; g.lineWidth = 2; g.beginPath(); g.arc(X, Y, r0 + 3 + (Date.now() / 120 % 3), 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = col; g.beginPath(); g.arc(X, Y, a.kind === 'md' ? r0 + 1 : r0, 0, Math.PI * 2); g.fill();
    if (a.kind === 'md') { g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke(); }
    if (a.carrying.length) { g.fillStyle = '#7CFC9A'; g.beginPath(); g.arc(X + r0 * 0.8, Y - r0 * 0.8, r0 * 0.45, 0, Math.PI * 2); g.fill(); }
    if (s >= 6) { g.fillStyle = '#e8eef4'; g.font = `${Math.max(9, s * 1.1)}px system-ui`; g.textAlign = 'left'; g.fillText(a.kind === 'md' ? 'You' : a.name.split(' ')[0], X + r0 + 2, Y + 3); }
    if (hover && Math.hypot(hover.x - X, hover.y - Y) < r0 + 4) hoverInfo = { a, X, Y };
  }
  if (hoverInfo) {
    const { a, X, Y } = hoverInfo;
    const role = a.kind === 'md' ? '' : a.kind === 'nurse' ? (a.triage ? ' (triage RN)' : ' (RN)') : a.kind === 'charge' ? ' (charge RN)' : a.kind === 'backup' ? ' (backup OB)' : '';
    const text = `${a.name}${role}${a.doing ? ' — ' + a.doing : ''}${a.carrying.length ? ' · carrying ' + a.carrying.join(', ') : ''}`;
    g.font = '12px system-ui'; const tw = g.measureText(text).width + 12;
    const tx = Math.min(X + 8, cv.clientWidth - tw - 4), ty = Math.max(4, Y - 26);
    g.fillStyle = '#000d'; g.fillRect(tx, ty, tw, 20); g.fillStyle = '#fff'; g.textAlign = 'left'; g.fillText(text, tx + 6, ty + 14);
  }
}
let hoverInfo = null;
export function setHover(pt) { hover = pt; }

function unreadPrio(sim, pid) { let hi = 0; for (let i = sim.msgs.length - 1, k = 0; i >= 0 && k < 60; i--, k++) { const m = sim.msgs[i]; if (m.pid === pid && !m.read && !m.resolved) hi = Math.max(hi, m.prio); } return hi; }
