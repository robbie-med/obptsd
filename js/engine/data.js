// Reference data. Literature anchors (cited where the numbers are used):
//  [Zhang2010] Zhang J, et al. Contemporary patterns of spontaneous labor with normal neonatal
//              outcomes. Obstet Gynecol 2010;116:1281-7. (Table 2: median hours per cm)
//  [OCC1-2014] ACOG/SMFM Obstetric Care Consensus No.1, Safe prevention of the primary cesarean
//              delivery (2014; reaffirmed). Active phase from 6 cm; arrest definitions.
//  [ACOG-PB203] Chronic hypertension; [ACOG-PB222] Gestational HTN & preeclampsia (2020):
//              severe range 160/110, treat within 30-60 min; Mg 4-6 g load, 1-2 g/h.
//  [ACOG-CO797] GBS prophylaxis (2020): PCN G 5 MU then 2.5-3 MU q4h; ampicillin 2 g then 1 g q4h;
//              cefazolin 2 g then 1 g q8h; clindamycin 900 mg q8h if susceptible; vanc 20 mg/kg q8h.
//  [ACOG-PB107] Induction of labor; [ACOG-PB205] VBAC (avoid prostaglandins in TOLAC).
//  [ACOG-PB183] Postpartum hemorrhage; WOMAN trial (TXA 1 g within 3 h).
//  [ACOG-PB106] Intrapartum FHR monitoring: nomenclature, interpretation (NICHD 2008).
//  [ACOG-PB178] Shoulder dystocia (2017): McRoberts and suprapubic pressure first, then posterior arm,
//              rotational maneuvers, all-fours; Zavanelli as a last resort; no fundal pressure.
//  [Gherman1997] Gherman RB, et al. Am J Obstet Gynecol 1997: McRoberts alone resolved ~42%.
//  [Hoffman2011] Hoffman MK, et al. Obstet Gynecol 2011;117:1272: posterior shoulder delivery had the
//              highest success (84%).
//  [Bruner1998] Bruner JP, et al. J Reprod Med 1998: Gaskin all-fours maneuver, 83%.
//  [Leung2011]  Leung TY, et al. BJOG 2011: acidosis and HIE rise with head-to-body interval >= 5 min.
//  [AHA2015]    Jeejeebhoy FM, et al. Cardiac arrest in pregnancy, Circulation 2015: manual left uterine
//              displacement; resuscitative hysterotomy if no ROSC by 4 min, delivery by 5 min.
//  [SMFM-AFE2016] SMFM Clinical Guideline No. 9: Amniotic fluid embolism (2016): sudden hypoxia,
//              hypotension, arrest and DIC; give cryo/FFP early.

// Median hours to progress from the given cm to the next, spontaneous labor, [Zhang2010] Table 2.
// Values below 3-4 cm are extrapolated (Zhang reports 3->4 for P0 only); ripeness gates them anyway.
export const ZHANG_HOURS_PER_CM = {
  P0:  [3.2, 3.0, 2.6, 1.8, 1.3, 0.8, 0.6, 0.5, 0.5, 0.5],
  P1:  [2.6, 2.4, 2.0, 1.6, 1.4, 0.8, 0.5, 0.4, 0.3, 0.3],
  P2:  [2.6, 2.4, 2.0, 1.6, 1.4, 0.8, 0.5, 0.4, 0.3, 0.3],
};
// 95th percentile / median ratio is ~4-5x at 4-5 cm and ~3x at 7-9 cm in [Zhang2010]; the per-patient
// lognormal `indiv` plus a slow per-patient wobble reproduces that spread.

// Second stage median (h), [Zhang2010]: P0 epidural 1.1, P0 none 0.6, P1+ epidural 0.4, none 0.2.
export const SECOND_STAGE_MEDIAN_H = { P0_epi: 1.1, P0_none: 0.6, Pm_epi: 0.4, Pm_none: 0.2 };

export const FIRST_NAMES = [
  'Ashley', 'Brianna', 'Maria', 'Jessica', 'Destiny', 'Amanda', 'Keisha', 'Nicole', 'Priya', 'Sofia',
  'Mei', 'Fatima', 'Yolanda', 'Hannah', 'Kayla', 'Emily', 'Guadalupe', 'Tiffany', 'Samantha', 'Aaliyah',
  'Rachel', 'Ngozi', 'Lindsey', 'Crystal', 'Jasmine', 'Olivia', 'Thao', 'Imani', 'Rebecca', 'Leah',
  'Carmen', 'Megan', 'Shanice', 'Anjali', 'Kristen', 'Ana', 'Brittany', 'Daniela', 'Ruth', 'Hye-jin',
];
export const LAST_NAMES = [
  'Garcia', 'Johnson', 'Nguyen', 'Williams', 'Patel', 'Smith', 'Okafor', 'Martinez', 'Brown', 'Lee',
  'Davis', 'Hernandez', 'Kim', 'Wilson', 'Lopez', 'Moore', 'Jackson', 'Thompson', 'Rivera', 'Clark',
  'Lewis', 'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Hill', 'Flores',
  'Adams', 'Baker', 'Nelson', 'Carter', 'Mitchell', 'Perez', 'Roberts', 'Turner', 'Phillips', 'Campbell',
];
export const NURSE_NAMES = [
  'Brenda', 'Tina', 'Marcus', 'Deb', 'Kelsey', 'Rosa', 'Janelle', 'Pam', 'Hector', 'Linh',
  'Carol', 'Shay', 'Becca', 'Tom', 'Ifeoma', 'Gwen', 'Alexis', 'Moira', 'Dana', 'Yesenia',
];

// Nurse archetypes: fixed personalities with per-night jitter (answers SPEC §11 "archetypes vs
// generated": both). bias in cm/stations; noise = SD of exam error; knowledge = P(catch a bad order);
// assert = P(push back when caught); alert = how fast she notices tracing/BP problems.
export const NURSE_ARCHETYPES = [
  { key: 'veteran', label: 'veteran', dilBias: 0.0, dilNoise: 0.45, staBias: 0.0, knowledge: 0.95, assert: 0.9, alert: 0.9, pit: 'cautious', chatty: 0.3, years: [18, 34] },
  { key: 'optimist', label: 'optimist', dilBias: +0.8, dilNoise: 0.6, staBias: +0.5, knowledge: 0.7, assert: 0.5, alert: 0.55, pit: 'aggressive', chatty: 0.5, years: [4, 12] },
  { key: 'worrier', label: 'worrier', dilBias: -0.3, dilNoise: 0.6, staBias: 0.0, knowledge: 0.8, assert: 0.7, alert: 0.95, pit: 'cautious', chatty: 0.95, years: [2, 9] },
  { key: 'newgrad', label: 'new grad', dilBias: 0.0, dilNoise: 1.0, staBias: -0.5, knowledge: 0.35, assert: 0.25, alert: 0.6, pit: 'standard', chatty: 0.7, years: [0, 1] },
  { key: 'traveler', label: 'traveler', dilBias: +0.3, dilNoise: 0.7, staBias: -1.0, knowledge: 0.65, assert: 0.6, alert: 0.7, pit: 'standard', chatty: 0.4, years: [5, 15] },
  { key: 'pitpusher', label: 'pit pusher', dilBias: -0.2, dilNoise: 0.55, staBias: 0.0, knowledge: 0.75, assert: 0.85, alert: 0.5, pit: 'aggressive', chatty: 0.35, years: [8, 22] },
  { key: 'steady', label: 'steady', dilBias: 0.0, dilNoise: 0.55, staBias: 0.0, knowledge: 0.8, assert: 0.7, alert: 0.75, pit: 'standard', chatty: 0.5, years: [5, 16] },
];

export const ROOMS = ['LDR 1', 'LDR 2', 'LDR 3', 'LDR 4', 'LDR 5', 'LDR 6', 'LDR 7', 'LDR 8'];
export const TRIAGE_BAYS = ['Triage A', 'Triage B', 'Triage C'];

// Lab turnaround (minutes) — order -> result.
export const LABS = {
  cbc: { label: 'CBC', tat: [30, 50] },
  cmp: { label: 'CMP', tat: [45, 70] },
  pih: { label: 'PIH labs (CBC, CMP, LDH, uric acid)', tat: [45, 70] },
  upc: { label: 'Urine protein/creatinine', tat: [60, 90] },
  ts: { label: 'Type & screen', tat: [40, 60] },
  fib: { label: 'Fibrinogen', tat: [35, 55] },
  mglevel: { label: 'Serum magnesium', tat: [40, 60] },
  gbs: { label: 'GBS PCR (rapid)', tat: [60, 90] },
  coag: { label: 'PT/INR/PTT', tat: [35, 55] },
};

export const CS_INDICATIONS = [
  ['cat3', 'Category III / non-reassuring FHR'],
  ['arrest_dil', 'Arrest of dilation'],
  ['arrest_desc', 'Arrest of descent'],
  ['failed_iol', 'Failed induction'],
  ['malpres', 'Malpresentation'],
  ['prolapse', 'Cord prolapse'],
  ['abruption', 'Abruption'],
  ['rupture', 'Uterine rupture'],
  ['failed_ovd', 'Failed operative vaginal delivery'],
  ['repeat', 'Repeat cesarean'],
  ['request', 'Maternal request'],
  ['severe_pe', 'Severe preeclampsia, unfavorable cervix'],
  ['other', 'Other'],
];
