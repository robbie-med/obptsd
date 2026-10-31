// The front page: a length of fetal-monitor paper feeding through, and an order sheet underneath.
// UI only. The tracing is drawn once from a seeded noise source and scrolls with CSS.

const W = 1400;          // one period of paper, px (the SVG holds two so the loop is seamless)
const FHR_H = 210;       // 240..30 bpm at 1 px/bpm
const GAP = 16, TOCO_H = 80;

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// one period of a believable strip: baseline ~140, moderate variability, a couple of accels, contractions
// every ~3 min, and one decel that's late enough to make you look twice
function tracePaths() {
  const r = rng(19000700);
  const ctxEvery = 175, ctxW = 70;
  const toco = (x) => {
    const k = ((x % ctxEvery) + ctxEvery) % ctxEvery;
    const u = (k - 40) / ctxW;
    return u > 0 && u < 1 ? Math.pow(Math.sin(Math.PI * u), 1.6) * (52 + 6 * Math.sin(x / 300)) : 0;
  };
  const accel = (x) => [[260, 22], [880, 18], [1180, 16]].reduce((a, [c, h]) => a + h * Math.exp(-((x - c) ** 2) / (2 * 14 ** 2)), 0);
  const late = (x) => 34 * Math.exp(-((x - 627) ** 2) / (2 * 20 ** 2)); // nadir after the 3rd contraction's peak
  let v = 0, f = '', t = '';
  for (let x = 0; x <= W; x += 2) {
    v = v * 0.55 + (r() - 0.5) * 9;                     // beat-to-beat variability
    const wobble = 3 * Math.sin(x / 23) + 2 * Math.sin(x / 9.7);
    let bpm = 140 + v + wobble + accel(x) - late(x);
    // close the loop: blend the last 40 px into the start value
    if (x > W - 40) bpm = bpm + (140 - bpm) * ((x - (W - 40)) / 40);
    const y = 240 - bpm;
    f += (x ? 'L' : 'M') + x + ' ' + y.toFixed(1);
    const ty = FHR_H + GAP + TOCO_H - 8 - toco(x) - (r() - 0.5) * 1.2;
    t += (x ? 'L' : 'M') + x + ' ' + ty.toFixed(1);
  }
  return { f, t };
}

function minuteMarks() {
  // heavy line every minute (3 cm at 3 cm/min ≈ 117 px here), clock labels every third
  let out = '';
  for (let x = 0, m = 0; x < W; x += W / 12, m++) {
    out += `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${FHR_H + GAP + TOCO_H}" stroke="#dc8f78" stroke-width="1.4"/>`;
    if (m % 3 === 0) out += `<text x="${(x + 3).toFixed(1)}" y="${FHR_H + 11}" ${MONO} fill="#a4523e">19:${String(m).padStart(2, '0')}</text>`;
  }
  return out;
}

const NOTES = [
  [70, 30, '19:01  SVE 4/70/−2 · K.R., RN'],
  [455, 196, 'repositioned L lat'],
  [640, 40, 'MD notified 19:34'],
  [930, 196, 'MD notified again'],
  [1150, 30, '"is anyone coming?"'],
];

// <use> clones don't pick up class selectors, so the strip is styled with attributes
const MONO = `font-family="ui-monospace, Menlo, Consolas, monospace" font-size="9"`;
const SERIF = `font-family="Iowan Old Style, Palatino Linotype, Palatino, Georgia, serif" font-size="13" font-style="italic"`;

// horizontal grid: thin every 10 bpm, heavier every 30; toco every 25 mmHg. Fixed, so it lines up with the axis.
function hgrid() {
  let g = '';
  for (let b = 30; b <= 240; b += 10) g += `<line x1="0" x2="${W * 2}" y1="${240 - b}" y2="${240 - b}" stroke="${b % 30 ? '#efc9ba' : '#e2a48f'}" stroke-width="${b % 30 ? 0.8 : 1.1}"/>`;
  for (let u = 0; u <= 100; u += 25) { const y = FHR_H + GAP + TOCO_H - 8 - u * 0.62; g += `<line x1="0" x2="${W * 2}" y1="${y}" y2="${y}" stroke="#efc9ba" stroke-width="0.8"/>`; }
  return g;
}

export function landingHTML({ seed, last, canResume, hasSim, prefs }) {
  const { f, t } = tracePaths();
  const bands = [60, 90, 120, 150, 180, 210].map(b => `<text x="4" y="${240 - b - 2}" ${MONO} fill="#a4523e">${b}</text>`).join('');
  const notes = NOTES.map(([x, y, s]) => `<text x="${x}" y="${y}" ${SERIF} fill="#2a3f8f" opacity="0.85">${s}</text>`).join('');
  const strip = `
    <svg class="lp-trace" viewBox="0 0 ${W * 2} ${FHR_H + GAP + TOCO_H}" preserveAspectRatio="xMinYMid slice" aria-hidden="true">
      <defs>
        <g id="lpPeriod">
          ${minuteMarks()}
          <path d="${f}" fill="none" stroke="#232027" stroke-width="1.35" stroke-linejoin="round" opacity="0.9"/>
          <path d="${t}" fill="none" stroke="#232027" stroke-width="1.2" stroke-linejoin="round" opacity="0.85"/>
          ${notes}
        </g>
      </defs>
      <rect x="0" y="${240 - 160}" width="${W * 2}" height="50" fill="#e8c9a9" opacity="0.28"/>
      ${hgrid()}
      <g class="feed"><use href="#lpPeriod"/><use href="#lpPeriod" x="${W}"/></g>
      <g>${bands}</g>
    </svg>`;
  const mode = prefs.mode || 'night';
  const radio = (v, label, note) => `<label class="lp-radio"><input type="radio" name="lpMode" value="${v}" ${mode === v ? 'checked' : ''}><span>${label}</span><small>${note}</small></label>`;
  const box = (id, label, note, on) => `<label class="lp-box"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span>${label}</span><small>${note}</small></label>`;
  const k = (keys, what) => `<div class="lp-k"><dt>${keys}</dt><dd>${what}</dd></div>`;
  return `
  <div class="lp">
    <div class="lp-paper">${strip}</div>
    <div class="lp-sheet">
      <div class="lp-head">
        <div class="lp-stamp">NIGHT<br>19:00–07:00</div>
        <h1>L<em>&amp;</em>D Night</h1>
        <p class="lp-sub">You're the obstetrician on a labor floor, overnight. Eight rooms, a triage wing, one operating room, one anesthesiologist, and nurses who are people. The strip is real enough to lie to you.</p>
        <p class="lp-snark">Obstetrics: two patients, one you can't see, and a statute of limitations that runs until the invisible one can legally drink.</p>
      </div>

      <section class="lp-keys" aria-label="Keys">
        <h2>Keys</h2>
        <dl>
          ${k('<kbd>space</kbd>', 'pause / play')}
          ${k('<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>4</kbd>', '1× · 10× · 60× · 240×')}
          ${k('<kbd>N</kbd>', 'skip to the next page')}
          ${k('<kbd>/</kbd>', 'write an order, in words')}
          ${k('<kbd>E</kbd>', 'go examine her yourself')}
          ${k('<kbd>[</kbd><kbd>]</kbd>', 'previous / next patient')}
          ${k('<kbd>P</kbd>', 'phone in or out of your pocket')}
          ${k('<kbd>M</kbd>', 'floor map')}
          ${k('click a room', 'walk there · <kbd>shift</kbd> to run')}
        </dl>
      </section>

      <section class="lp-form" aria-label="Tonight">
        <h2>Tonight</h2>
        <fieldset><legend>Shift</legend>
          ${radio('night', 'Night', '12 h, full board')}
          ${radio('quick', 'Short', '4 h, three patients')}
          ${radio('single', 'One patient', 'an induction, no chaos')}
          ${radio('lab', 'Tracing lab', 'turn the hidden knobs')}
        </fieldset>
        <fieldset><legend>Options</legend>
          ${box('cloudIn', 'Black cloud', 'the rare disasters stop being rare', prefs.cloud)}
          ${box('teachIn', 'Truth', 'show the hidden physiology', prefs.teach)}
          ${box('autoslowIn', 'Auto-slow', 'drop to 1× when it goes wrong', prefs.autoslow !== false)}
          ${box('soundIn', 'Pager beeps', '', prefs.sound)}
          ${box('fhrIn', 'Room audio', 'monitors, pumps, the Doppler', prefs.fhr)}
        </fieldset>
        <label class="lp-seed">Seed <input id="seedIn" value="${seed}" spellcheck="false" autocomplete="off"><button type="button" id="rndSeed" title="Another night">↻</button></label>
      </section>

      <div class="lp-go">
        <button id="startBtn" class="lp-step">Step in</button>
        <div class="lp-more">
          ${canResume ? '<button id="resumeBtn" type="button">resume</button>' : ''}
          ${last ? `<button id="replayBtn" type="button">replay last night</button>` : ''}
          ${hasSim ? '<button id="exportBtn" type="button">export this night</button>' : ''}
          <label>import a replay<input type="file" id="importIn" accept=".json" hidden></label>
        </div>
      </div>

      <details class="lp-long"><summary>the long version</summary>
        <p>Orders are free text: <code>pit per protocol</code>, <code>mag 4 g IV load then 2 g/h</code>, <code>labetalol 20 mg IV</code>, <code>c-section stat for prolonged decel</code>. Wrong ones get pushback from a nurse or a call from pharmacy, or they go through quietly and hurt someone, depending on who's on.</p>
        <p>Pages arrive on a phone that logs you out every half hour for security reasons nobody has revisited since 1998. Ignore a nurse and her charge nurse calls; ignore them both and the backup OB comes in over your head.</p>
        <p>Nobody labels the strip for you. Dystocias and codes run in real time. Scoring is on outcomes, with your NTSV cesarean rate watched so sectioning everyone doesn't win. The debrief shows what was actually happening next to what you were told.</p>
      </details>
      <p class="lp-foot">Fiction. The physiology is from the literature; the people are invented. Not medical advice — though neither, at 3 a.m., is most of what you'll hear.</p>
    </div>
  </div>`;
}
