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
- **Tracing lab**: one laboring patient with sliders for the hidden knobs: placental reserve, Pit, cord
  vulnerability, base deficit, epidural hypotension, fever, ROM/IUPC/FSE, cord prolapse (spec build step 1).

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
