# L&D Night — OB floor sim

Desktop browser game: you're the OB running a labor & delivery floor overnight. You don't catch
babies — you manage triage, inductions, Pit, magnesium, the strip, and when to call the section.
Every patient has a hidden physiology; you only see it through the monitor and your nurses.
Spec: [SPEC.md](SPEC.md).

## Run

```bash
./serve.sh            # http://127.0.0.1:3938  (port claimed in ~/Projects/PORTS.md)
node test/engine.test.mjs   # physiology + determinism + parser checks
node test/bot.test.mjs 3    # autoplayer plays whole nights, verifies replays reproduce
```

No build step, no dependencies: plain ES modules.

## Modes

- **Night shift**: 19:00–07:00. Sign-out from the day team (with handoff errors), five patients on the floor, scheduled
  inductions and sections, triage walk-ins, phone calls, family requests, a nurse shift change at 23:00.
- **Short shift**: 19:00–23:00, three patients.
- **Single patient**: one unripe G1 induction and her nurse (spec build step 2).
- **☁ Black cloud** (menu toggle, any mode): shoulder dystocia ×3, amniotic fluid embolism ×75 (roughly one night in
  four). For when you want your colleagues to remember the night.
- **Tracing lab**: one laboring patient with sliders for the hidden knobs: placental reserve, Pit, cord
  vulnerability, base deficit, epidural hypotension, fever, ROM/IUPC/FSE, cord prolapse (spec build step 1).

## Emergencies (real time)

A shoulder dystocia or a maternal code drops the clock to 1× (it won't fast-forward until it's over), sounds an
alarm if sound is on, and puts a bar with a timer and the relevant buttons above the chart. The rest of the floor keeps
paging you.

- **Shoulder dystocia**: rolled at every vaginal birth on the floor from EFW, GDM and vacuum (hidden difficulty per
  baby). The head is out, the strip is gone, and the fetus loses ~0.02 pH per minute. You call the maneuvers: McRoberts,
  suprapubic, posterior arm, Rubin/Woods, all fours, episiotomy, Zavanelli. Each takes time and has a success rate from
  the literature; repeats work less well. Traction and fundal pressure are available, get nurse pushback, and hurt
  the baby. If you freeze, the nurse does McRoberts at 1 min and the backup OB walks in at 5–9 min.
- **Amniotic fluid embolism**: about 1 in 1,700 births (~15× real life, so it happens at all), while laboring with
  ROM or right after delivery. "I feel like I'm going
  to die" → collapse (hypoxia, hypotension, fetal bradycardia) → cardiac arrest in ~70% → DIC either way. In the code
  you run epi, LUD, shocks (only VF is shockable), intubation once anesthesia or the code team arrive, and the
  resuscitative hysterotomy at 4 min. Delivery is what gets the pulse back. Anesthesia may be stuck in the OR. Then the
  bleeding: MTP, cryo, FFP, TXA. Mothers can die.

- **Magnesium arrest**: Mg toxicity that gets as far as cardiac arrest runs through the same code (asystole or PEA).
  Calcium gluconate and stopping the infusion are what bring her back; epi alone mostly doesn't.

Scoring judges the response, not the bad luck: head-to-body interval, traction, arrest-to-delivery (> 5 min), LUD, and
epinephrine in the first 5 min, calcium in the first 5 min of a magnesium arrest. Rates and maneuver success are cited in `data.js`.

## Architecture (`js/engine` is UI-free and runs headless in Node)

| File | What it does |
|---|---|
| `rng.js` | Seeded sfc32 streams with `fork(label)`, so arrivals don't depend on your orders |
| `physio.js` | Hidden truth, 1 sim-second per step. Uterus: contraction phase accumulator driven by spontaneous drive + oxytocin Emax + prostaglandins. Cervix: Zhang 2010 per-cm rates × contraction adequacy (MVU) × ripeness gate × OP/CPD. Fetus: oxygenation from placental reserve × uteroplacental flow (IUP, maternal MAP) × cord flow, base deficit accrual, then FHR = baseline + chemoreflex (late) + head compression (early) + baroreflex (variable) + accels + noise whose amplitude falls with BD. Mother: BP/preeclampsia, Mg PK, infection, epidural, PPH. |
| `monitor.js` | What the paper shows: Doppler dropouts, maternal pickup, doubling, toco slip and gain, IUPC/FSE. `analyzeStrip` = what a nurse can read off the strip (features only, never a category) |
| `nurses.js` | Archetypes with per-night jitter: exam bias and noise, Pit style, alertness, knowledge, assertiveness. Vitals, SVEs, Pit protocol titration, intrauterine resuscitation, pages |
| `orders.js` / `drugs.js` | Free-text order parser, plus a drug/action database with dose, route and interval limits and contraindications → pharmacy callback, nurse pushback, or harm |
| `sim.js` | The floor: rooms, triage, OR + anesthesia queues, labs, delivery, messages, command log and replay |
| `scenario.js` | Sign-out presets, the board, the chaos timeline, shift change |
| `emergency.js` | Shoulder dystocia and AFE/maternal-arrest state machines (maneuvers, code team, rhythm checks, hysterotomy) |
| `scoring.js` | Outcomes, NTSV CS rate, OCC-2014 CS criteria, DDI, severe-BP time-to-treat |

UI (`js/ui`): `app.js` (board, chart, orders, pages, speed loop), `strip.js` (US paper at 3 cm/min),
`debrief.js` (truth vs report).

**Determinism:** same seed plus same command log gives the same night. Replays are stored in localStorage (last 20)
and can be exported or imported as JSON for teaching.

Answers to SPEC §11 open questions as built: real-time with pause/1×/10×/60×/240× and "fast-forward to the
next page"; nurse personalities are fixed archetypes with generated jitter; teaching mode shows the truth
live (the "truth" toggle). Literature anchors are cited in `js/engine/data.js`.

## Not yet

Twins are only scheduled-CS patients (no dual tracing). There is no forceps, ECV or external cephalic
version. Neonatal outcomes are a single-step estimate at birth.
