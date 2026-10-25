// Free-form order parser (SPEC §5): "mag 4 g IV load then 2 g/h", "pit up 2", "labetalol 20 IV",
// "PCN 5 MU IV then 2.5 MU q4h", "c-section stat for prolonged decel".
// Produces a structured order; validation/execution live in drugs.js.

// alias -> canonical id. Longest alias wins.
const ALIASES = {
  oxytocin: ['oxytocin', 'pitocin', 'pit', 'oxy'],
  misoprostol: ['misoprostol', 'cytotec', 'miso'],
  cervidil: ['cervidil', 'dinoprostone', 'prostin', 'prepidil'],
  foley: ['foley bulb', 'foley balloon', 'cook balloon', 'cervical foley', 'balloon', 'foley', 'bulb'],
  magnesium: ['magnesium sulfate', 'magnesium', 'mag sulfate', 'mgso4', 'mag'],
  labetalol: ['labetalol', 'trandate', 'labet'],
  hydralazine: ['hydralazine', 'apresoline', 'hydral'],
  nifedipine: ['nifedipine', 'procardia', 'nifed', 'nifedepine'],
  terbutaline: ['terbutaline', 'terb', 'brethine'],
  penicillin: ['penicillin g', 'penicillin', 'pcn g', 'pcn', 'pen g'],
  ampicillin: ['ampicillin', 'amp'],
  cefazolin: ['cefazolin', 'ancef', 'kefzol'],
  clindamycin: ['clindamycin', 'clinda', 'cleocin'],
  vancomycin: ['vancomycin', 'vanc', 'vanco'],
  gentamicin: ['gentamicin', 'gent', 'genta'],
  azithromycin: ['azithromycin', 'azithro', 'zithromax'],
  betamethasone: ['betamethasone', 'celestone', 'beta', 'bmz', 'steroids'],
  fentanyl: ['fentanyl', 'fent'],
  nalbuphine: ['nalbuphine', 'nubain', 'butorphanol', 'stadol'],
  acetaminophen: ['acetaminophen', 'tylenol', 'apap', 'paracetamol', 'ofirmev'],
  txa: ['tranexamic acid', 'tranexamic', 'txa', 'cyklokapron'],
  methergine: ['methylergonovine', 'methergine', 'methergin', 'ergonovine'],
  hemabate: ['carboprost', 'hemabate', '15-methyl pgf2a', 'pgf2a'],
  calcium: ['calcium gluconate', 'calcium', 'ca gluconate', 'ca gluc'],
  phenylephrine: ['phenylephrine', 'neo', 'neosynephrine', 'neo-synephrine'],
  ephedrine: ['ephedrine'],
  epinephrine: ['epinephrine', 'epi pen', 'epipen', 'adrenaline'],
  albuterol: ['albuterol', 'duoneb', 'neb'],
  fluids: ['lactated ringers', 'lactated ringer', 'normal saline', 'fluid bolus', 'ivf bolus', 'lr bolus', 'ns bolus', 'bolus', 'lr', 'ns', 'fluids', 'ivf'],
  // actions
  sve: ['cervical exam', 'check cervix', 'check her', 'recheck', 're-check', 'check', 'sve', 'exam', 'examine'],
  arom: ['rupture membranes', 'rupture her membranes', 'break her water', 'break water', 'amniotomy', 'arom', 'amnihook'],
  iupc: ['iupc', 'intrauterine pressure catheter', 'pressure catheter'],
  fse: ['fetal scalp electrode', 'scalp electrode', 'spiral electrode', 'scalp lead', 'fse', 'spiral'],
  amnioinfusion: ['amnioinfusion', 'amnio infusion', 'amnio'],
  reposition: ['position change', 'reposition', 'left lateral', 'right lateral', 'hands and knees', 'turn her', 'turn patient', 'change position', 'roll her'],
  o2: ['oxygen', 'o2', 'nrb', 'non-rebreather', 'face mask'],
  epidural: ['epidural', 'cle', 'cse', 'neuraxial', 'labor analgesia'],
  push: ['start pushing', 'begin pushing', 'push', 'pushing'],
  labordown: ['labor down', 'passive descent', 'delayed pushing'],
  stoppush: ['stop pushing', 'quit pushing'],
  cs: ['cesarean section', 'cesarean delivery', 'cesarean', 'c-section', 'c section', 'csection', 'c/s', 'section', 'crash', 'stat section', 'to the or', 'take her back'],
  vacuum: ['vacuum', 'operative vaginal', 'kiwi', 'forceps', 'ovd'],
  us: ['bedside ultrasound', 'bedside us', 'ultrasound', 'sono', 'us', 'bpp', 'presentation check'],
  labs: ['labs'],
  cbc: ['cbc', 'platelets', 'plt', 'hgb', 'h/h', 'h&h', 'blood count'],
  cmp: ['cmp', 'bmp', 'lfts', 'lft', 'creatinine', 'chem'],
  pih: ['pih labs', 'preeclampsia labs', 'pre-eclampsia labs', 'pree labs', 'pih panel', 'hellp labs', 'pih'],
  upc: ['upc', 'urine protein', 'protein creatinine', 'p/c ratio', 'pcr ratio'],
  ts: ['type and screen', 'type & screen', 't&s', 'type and cross', 'crossmatch', 't&c'],
  fib: ['fibrinogen', 'fib'],
  mglevel: ['mag level', 'magnesium level', 'serum mag', 'mg level'],
  gbs: ['gbs pcr', 'gbs culture', 'gbs swab'],
  coag: ['coags', 'pt/inr', 'ptt', 'inr'],
  vitals: ['vitals', 'vital signs', 'recheck bp', 'repeat bp', 'bp check', 'blood pressure'],
  nst: ['nst', 'non-stress test', 'monitor', 'put her on the monitor', 'efm'],
  romtest: ['rom test', 'amnisure', 'rom plus', 'romplus', 'nitrazine', 'fern', 'sse', 'sterile speculum', 'speculum'],
  admit: ['admit', 'admission'],
  discharge: ['discharge', 'send home', 'd/c home', 'dc home', 'go home'],
  observe: ['observe', 'walk', 'ambulate', 'recheck in 2', 'recheck in two', 'labor check'],
  vas: ['vibroacoustic', 'vas', 'acoustic stim', 'scalp stim', 'fetal stim', 'buzz'],
  massage: ['fundal massage', 'massage', 'bimanual'],
  bakri: ['bakri', 'balloon tamponade', 'jada', 'tamponade'],
  transfuse: ['transfuse', 'prbc', 'blood transfusion', 'mtp', 'massive transfusion', 'units of blood', 'units blood'],
  returnor: ['return to or', 'back to the or', 'exploratory laparotomy', 'ex lap', 'hysterectomy', 'b-lynch'],
  elevate: ['elevate presenting part', 'elevate the head', 'elevate head', 'elevate', 'knee chest', 'knee-chest'],
  backup: ['call backup', 'backup team', 'second team', 'call in backup', 'backup anesthesia', 'call the backup'],
  removeFse: [],
};

const ALIAS_LIST = [];
for (const [id, arr] of Object.entries(ALIASES)) for (const a of arr) ALIAS_LIST.push([a, id]);
ALIAS_LIST.sort((a, b) => b[0].length - a[0].length);

export const DRUG_IDS = new Set(['oxytocin', 'misoprostol', 'cervidil', 'magnesium', 'labetalol', 'hydralazine', 'nifedipine',
  'terbutaline', 'penicillin', 'ampicillin', 'cefazolin', 'clindamycin', 'vancomycin', 'gentamicin', 'azithromycin', 'betamethasone',
  'fentanyl', 'nalbuphine', 'acetaminophen', 'txa', 'methergine', 'hemabate', 'calcium', 'phenylephrine', 'ephedrine', 'epinephrine',
  'albuterol', 'fluids']);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }

function findAction(low) {
  for (const [alias, id] of ALIAS_LIST) {
    const re = new RegExp('(^|[^a-z0-9])' + escapeRe(alias) + '($|[^a-z0-9])');
    const m = re.exec(low);
    if (m) return { id, alias, index: m.index + m[1].length };
  }
  return null;
}

const ROUTE_RE = /\b(ivpb|ivp|iv|im|po|pv|per vagina|vaginal(?:ly)?|vag|sl|sublingual(?:ly)?|buccal(?:ly)?|pr|per rectum|rectal(?:ly)?|sq|sc|subq|subcut|neb|nebulized|epidural)\b/;
function normRoute(r) {
  if (!r) return null;
  if (r.startsWith('iv')) return 'IV';
  if (r === 'im') return 'IM';
  if (r === 'po') return 'PO';
  if (r === 'pv' || r.startsWith('vag') || r === 'per vagina') return 'PV';
  if (r === 'sl' || r.startsWith('subling')) return 'SL';
  if (r.startsWith('bucc')) return 'BUCCAL';
  if (r === 'pr' || r.startsWith('rect') || r === 'per rectum') return 'PR';
  if (['sq', 'sc', 'subq', 'subcut'].includes(r)) return 'SQ';
  if (r.startsWith('neb')) return 'NEB';
  if (r === 'epidural') return 'EPIDURAL';
  return r.toUpperCase();
}

// number + unit (+ optional per-time)
const QTY_RE = /(\d+(?:\.\d+)?)\s*(million units?|million|milliunits?|mu|mcg|µg|ug|mg\/kg|mg|grams?|gm|g|units?|u|ml|cc|liters?|litres?|l)?\b(\s*(?:\/|per|an?)\s*(?:h|hr|hrs|hour|min|minute))?/g;

function extractQuantities(raw, low) {
  const out = [];
  QTY_RE.lastIndex = 0;
  let m;
  while ((m = QTY_RE.exec(low))) {
    const value = parseFloat(m[1]);
    let unit = m[2] || null;
    const per = m[3] ? (/min/.test(m[3]) ? 'min' : 'h') : null;
    // MU (million units) vs mU (milliunits): look at original casing
    if (unit === 'mu') {
      const origUnit = raw.substr(m.index + m[0].indexOf(m[2], m[1].length), 2);
      unit = origUnit === 'MU' || origUnit === 'Mu' ? 'MU' : 'mU';
    } else if (unit && unit.startsWith('million')) unit = 'MU';
    else if (unit && unit.startsWith('milliunit')) unit = 'mU';
    else if (unit === 'µg' || unit === 'ug') unit = 'mcg';
    else if (unit === 'grams' || unit === 'gram' || unit === 'gm') unit = 'g';
    else if (unit === 'units' || unit === 'unit' || unit === 'u') unit = 'units';
    else if (unit === 'cc') unit = 'ml';
    else if (unit && (unit.startsWith('lit') || unit === 'l')) unit = 'L';
    // skip "q4h"-style frequency digits and times like "x2"
    const before = low.slice(Math.max(0, m.index - 1), m.index);
    const before2 = low.slice(Math.max(0, m.index - 2), m.index);
    if (before === 'q' || before === 'x' || before2 === 'q ') continue;
    out.push({ value, unit, per, index: m.index, text: m[0] });
  }
  return out;
}

function extractFreq(low) {
  const m = /\bq\s*(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|min|mins|minutes?)?\b/.exec(low);
  if (m) {
    const v = parseFloat(m[1]);
    const isMin = m[2] && m[2].startsWith('min');
    return { everyH: isMin ? v / 60 : v, text: m[0] };
  }
  if (/\b(once|x1|x 1|one dose|now|stat)\b/.test(low)) return { once: true };
  if (/\bbid\b/.test(low)) return { everyH: 12 };
  if (/\btid\b/.test(low)) return { everyH: 8 };
  if (/\bqid\b/.test(low)) return { everyH: 6 };
  if (/\bdaily|qd|q24\b/.test(low)) return { everyH: 24 };
  return null;
}

export function parseOrder(raw) {
  const text = String(raw || '').trim();
  const low = text.toLowerCase().replace(/\s+/g, ' ');
  if (!low) return { ok: false, error: 'Empty order.' };
  const act = findAction(low);
  if (!act) return { ok: false, error: `Couldn't find a drug or action in “${text}”.`, raw: text };
  const route = normRoute((ROUTE_RE.exec(low) || [])[1]);
  const qty = extractQuantities(text.replace(/\s+/g, ' '), low);
  const freq = extractFreq(low);
  const has = (re) => re.test(low);
  const o = { ok: true, raw: text, id: act.id, isDrug: DRUG_IDS.has(act.id), route, qty, freq };
  o.stop = has(/\b(stop|off|hold|discontinue|dc|d\/c|remove|pull|turn off|shut off|cancel)\b/) && !has(/\bstop pushing\b/);
  o.up = has(/\b(up|increase|inc|titrate up|go up|bump)\b|\+/);
  o.down = has(/\b(down|decrease|dec|reduce|lower|titrate down|back off|cut)\b/) || /(^|\s)-\s*\d/.test(low);
  o.toAbs = has(/\bto\s*\d/);
  o.half = has(/\b(half|halve|by 50%)\b/);
  o.protocol = has(/\bprotocol\b/);
  o.highDose = has(/\bhigh[- ]dose\b/);
  o.load = has(/\b(load|loading|bolus)\b/);
  o.then = has(/\bthen\b/);
  o.prn = has(/\bprn\b/);
  o.urgency = has(/\b(stat|crash|emergent|emergency|now|cat(egory)? ?1|cat ?i\b)/) ? 'stat'
    : has(/\b(urgent|cat(egory)? ?2|soon)\b/) ? 'urgent'
    : has(/\b(scheduled|routine|elective|when (the )?or (is )?free|non-urgent|cat(egory)? ?[34])\b/) ? 'routine' : null;
  o.text = low;
  // indication sniffing for CS
  if (o.id === 'cs') {
    o.indication =
      has(/prolapse/) ? 'prolapse' : has(/ruptur/) && !has(/membran/) ? 'rupture' : has(/abruption|abrupt/) ? 'abruption'
      : has(/arrest of desc|descent|failure to descend/) ? 'arrest_desc' : has(/arrest|ftp|failure to progress|protraction/) ? 'arrest_dil'
      : has(/failed (iol|induction)|failed ind/) ? 'failed_iol' : has(/breech|malpres|transverse|footling/) ? 'malpres'
      : has(/failed (vac|ovd|forceps|operative)/) ? 'failed_ovd' : has(/repeat|rcs|rlts/) ? 'repeat'
      : has(/request|wants|asking/) ? 'request' : has(/preeclampsia|pre-eclampsia|severe feat|hellp/) ? 'severe_pe'
      : has(/decel|brady|tracing|fhr|cat ?(3|iii|2|ii)|non-?reassuring|nrfht|distress|fetal intol/) ? 'cat3' : null;
  }
  if (o.id === 'transfuse') {
    const n = qty.find(q => !q.unit || q.unit === 'units');
    o.units = n ? n.value : (has(/mtp|massive/) ? 4 : 2);
  }
  return o;
}

export function describeParsed(o) {
  if (!o || !o.ok) return o?.error || '';
  const parts = [o.id];
  if (o.qty.length) parts.push(o.qty.map(q => q.value + (q.unit ? ' ' + q.unit : '') + (q.per ? '/' + q.per : '')).join(', '));
  if (o.route) parts.push(o.route);
  if (o.freq) parts.push(o.freq.once ? 'once' : `q${o.freq.everyH}h`);
  if (o.stop) parts.push('STOP');
  if (o.up) parts.push('↑');
  if (o.down) parts.push('↓');
  if (o.protocol) parts.push('per protocol');
  if (o.urgency) parts.push(o.urgency);
  if (o.indication) parts.push('for ' + o.indication);
  return parts.join(' · ');
}

export const ORDER_HINTS = [
  'pit per protocol', 'pit 2', 'pit up 2', 'pit down', 'pit off', 'miso 25 mcg PV q4h', 'miso 50 PO q4h', 'cervidil', 'remove cervidil',
  'foley bulb', 'AROM', 'IUPC', 'FSE', 'amnioinfusion', 'reposition', 'LR bolus 500', 'O2', 'SVE', 'terbutaline 0.25 mg SQ',
  'mag 4 g IV load then 2 g/h', 'stop mag', 'labetalol 20 mg IV', 'hydralazine 5 mg IV', 'nifedipine 10 mg PO',
  'PCN G 5 MU IV then 2.5 MU q4h', 'ampicillin 2 g IV then 1 g q4h', 'cefazolin 2 g IV then 1 g q8h', 'clindamycin 900 mg IV q8h',
  'vancomycin 20 mg/kg IV q8h', 'ampicillin 2 g IV q6h', 'gentamicin 5 mg/kg IV q24h', 'azithromycin 1 g PO',
  'betamethasone 12 mg IM q24h', 'epidural', 'fentanyl 100 mcg IV', 'nubain 10 mg IV', 'acetaminophen 1 g PO',
  'calcium gluconate 1 g IV', 'phenylephrine 100 mcg IV', 'ephedrine 10 mg IV', 'epinephrine 0.3 mg IM', 'albuterol neb',
  'TXA 1 g IV', 'methergine 0.2 mg IM', 'hemabate 250 mcg IM', 'miso 800 mcg PR', 'pit 40 units in 1 L', 'pit 10 units IM',
  'fundal massage', 'bakri', 'transfuse 2 units', 'return to OR', 'push', 'labor down', 'stop pushing', 'vacuum',
  'c-section stat', 'c-section urgent for arrest of dilation', 'bedside US', 'CBC', 'PIH labs', 'UPC', 'type and screen',
  'fibrinogen', 'mag level', 'vitals', 'NST', 'ROM test', 'admit', 'discharge', 'observe 2 hours', 'VAS', 'elevate presenting part', 'call backup',
];
