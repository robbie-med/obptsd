# L&D Night (00-IDEA-ob-floor-game)

Browser game per SPEC.md; see README.md for the architecture.

- Preview: `./serve.sh` on **127.0.0.1:3938** (claimed in ~/Projects/PORTS.md). Never another port.
- Tests: `node test/engine.test.mjs` and `node test/bot.test.mjs 3`. Run both after any change to `js/engine`.
- The engine must stay deterministic: no `Math.random`, `Date`, or wall-clock time in `js/engine`. Use `sim.rng.fork(...)`
  or the patient's `T.rng`. All player input goes through `sim.command()` (it's what gets logged and replayed).
- The UI must never show `p.T` (hidden truth) unless teaching mode (`ui.view.teaching`) is on.
- No build step; plain ES modules.
