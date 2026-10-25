# Manage Childbirth (OB Floor Sim): Spec Sheet

> **Status:** built 2026-10-17 (playable; see README.md). Captured 2026-10-13.
> **Platform:** Desktop browser game (computer, not phone first).

## 1. Concept

You're the OB doctor running a labor & delivery floor. You don't catch babies. You **manage
everything up to delivery**: triage, induction scheduling, labor management, meds, reading the
fetal heart tracing, and deciding *when to send for a C-section*. Several women labor at once.
The fun is in the disaster, the insanity and the vibes-based medicine of a real L&D night.

## 2. Design pillar: hidden truth, noisy reports

Every patient has a **hidden physiological truth**. You only see it through noisy, delayed,
human reports. You manage what the nurses tell you, not what's actually happening.

## 3. Simulation engine

### 3.1 Hidden cervix model
- True dilation, effacement, station and **ripeness** (Bishop-like latent) per patient.
- Evolve over time based on parity, gestational age, prior vaginal delivery, membranes, and what you've given her.
- Labor progress follows **Zhang-style curves** (not Friedman).
- Consequences are emergent, e.g. Pit started on an unripe G1 at 39+0 at midnight → 18 hours at 3 cm → arrest → tired, infected C-section.

### 3.2 Nurse SVEs
- Each nurse has a persistent **bias + noise** profile. One always calls 4 cm when it's really 3. Another under-calls station.
- Two exams 20 minutes apart can disagree.
- Nurses also report vitals, pain, "she feels pressure", and push back on bad orders.

### 3.3 Fetal reserve
- A hidden acid-base variable per fetus.
- Worn down by contraction frequency/tachysystole, uteroplacental insufficiency, cord compression, maternal hypotension (e.g. post-epidural), fever.
- Drives the tracing (§4) **and** the outcome (cord gas, Apgar, NICU).

### 3.4 Delay penalty & resources
- Every minute between "this needs a section" and incision raises the risk of hemorrhage, infection and acidemia.
- **One OR**, one anesthesiologist who's often busy. A crash section bumps your scheduled repeat.
- C-section surgeon handles the surgery. **Your job is the call and its timing.**

### 3.5 Patients & comorbidities
- Generated from distributions: parity, GA, BMI, prior CS (TOLAC/repeat), GDM, cHTN/gHTN/preeclampsia (± severe features), IUGR, PPROM, GBS+, twins, breech, macrosomia, etc.
- Comorbidities set the "must deliver by" windows (e.g. preeclampsia with severe features at 34w) and induction indications.

## 4. FHR / toco tracing (the centerpiece; build first)

Generated **from physiology**, not drawn from templates:
- Baseline FHR (set by GA, fever, drugs, reserve).
- Variability = noise process whose amplitude **falls as reserve falls**.
- Accelerations in a well-oxygenated fetus.
- Decels **mechanically tied to toco**:
  - **Early:** mirror the contraction (head compression)
  - **Late:** start after the peak, depth scales with placental insufficiency × contraction strength
  - **Variable:** abrupt, from stochastic cord-compression events (worse with oligohydramnios/ROM)
  - **Prolonged:** hypotension, tachysystole, cord prolapse, abruption
- Pit-induced tachysystole should produce recurrent lates **with no special scripting**.
- The game never labels the category. You read it. Realistic paper speed/grid (3 cm/min US standard), artifacts, maternal HR pickup, lost-contact gaps.
- Reuse the **physics-first philosophy of `ekg`/`cardiacmodel`** (signals emerge from a model, not pre-drawn).

## 5. Orders

Free-form **drug, dose, route, frequency**, validated against real parameters:
- **Ripening/induction:** misoprostol (PO/vaginal), Cervidil, Foley balloon, AROM, oxytocin titration
- **Hypertension:** mag sulfate load + maintenance, labetalol, hydralazine, nifedipine
- **Other labor meds:** terbutaline, GBS prophylaxis (PCN/cefazolin/clinda/vanc per allergy), betamethasone timing, epidural/IV analgesia, antipyretics/abx for Triple I
- **Hemorrhage:** TXA, Methergine (contraindicated in preeclampsia), Hemabate (contraindicated in asthma), miso, oxytocin bolus

Wrong orders produce **nurse pushback**, a **pharmacy callback**, or **harm**. Mag toxicity shows
loss of reflexes before respiratory depression. Reuse the dosing-validation approach from `antibiotiX`.

## 6. Chaos layer

- Triage walk-ins ("is this labor?"), phone calls, ROM-or-not, decreased fetal movement.
- Scheduled inductions piling up against a **census cap**.
- Shift change (nurse personalities rotate), handoff losses.
- Patients and family "asking to deliver".

## 7. Scoring

- Outcomes: maternal (hemorrhage, infection, eclampsia, uterine rupture), neonatal (acidemia, NICU, death).
- **NTSV cesarean rate** is tracked so sectioning everyone isn't a winning strategy.
- Time-to-incision for emergent sections; induction-to-delivery intervals.
- End-of-shift debrief: reveals the hidden truth timeline next to what you were told.

## 8. Architecture

- **Seeded simulation engine kept separate from the UI.** Same seed = same night → replayable and **teachable for residents**.
- Engine: pure JS/TS module, deterministic tick (e.g. 1 sim-second), time compression controls (pause / 1× / 10× / 60×).
- UI: browser (canvas for tracings, DOM for orders/board). No build step if feasible, like other projects here.
- Preview server: claim a port with `port-claim.sh ob-floor-game dev`, bind 127.0.0.1.

## 9. Reuse candidates in ~/Projects

| Project | What to take |
|---|---|
| `laborlog` | parameterized dilation reference curves (Zhang-style), delivery-ETA prediction |
| `34.08-labor app` | earlier labor app notes, check contents |
| `ekg` / `cardiacmodel` | physiology-first waveform generation pattern |
| `antibiotiX` / `antibiotic-armory(3)` | dose/route/interval validation UI + data shape |
| `The_Hospital` | seeded world generation conventions |
| `a_clinic_in_the_valley` | patient-arrival game loop |

## 10. Build order

1. **FHR/toco generator** you can watch in real time (decides whether the whole thing feels real)
2. Single patient: hidden cervix + nurse SVEs + Pit titration
3. Order parser + validation + pushback
4. Multiple patients + OR/anesthesia resource
5. Triage/chaos layer, scoring, debrief, seeds

## 11. Open questions

- Sim speed: real-time with fast-forward, or turn-based "check in every N minutes"?
- How granular are nurse personalities (fixed archetypes vs generated)?
- Teaching mode: show the hidden truth overlay live?
- Literature anchoring: which sources for curves and outcome risks (Zhang 2010, ACOG bulletins), to be cited in the code.
