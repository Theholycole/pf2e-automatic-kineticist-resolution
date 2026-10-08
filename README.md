# PF2e Automatic Kineticist Resolution

A Foundry VTT module (Foundry 14, PF2e 8.5.0) that automates the PF2e Kineticist, confirmation-first: every impulse's chat card gets **Resolve impulse**, which opens a resolution card. The owner rolls, the targets save, and the GM applies.

- **Impulses** are read from their own text at the kineticist's level: saves against the class DC, impulse attacks, damage, healing, conditions and their durations, forced movement, persistent damage, Effects, lingering terrain, creations, Sustain and its repeats. 118 of the 119 impulses (official plus Matter Blast) are read completely; see [docs/coverage.md](docs/coverage.md).
- **The kinetic aura:**
  - overflow deactivates it
  - being knocked out deactivates it
  - stances end with it
  - a stance ends your other stances
  - stance aura triggers (Thermal Nimbus, Drifting Pollen, Winter Sleet…) whisper the GM a card
- **Junctions:** impulse junctions are offered on the card. Critical blast junctions are offered on an Elemental Blast critical hit.
- **What PF2e already does stays PF2e's:** Elemental Blast's rolls, the aura Effect, stance Effects, and the resistance, aura and skill junctions.
- **Impulses with a spell's effects** (Wall of Fire, Earthquake, Vapor Form…) go through [PF2e Automatic Spell Resolution](../PF2e%20AUTOMATIC%20SPELL%20RESOLUTION) when it's active.
- **Third-party:**
  - Alchemists+ Chrysopoet: Matter Blast, and Render Circle as the aura
  - Barbarians+ Elemental Instinct: the rage trait on impulses

Design and decisions: [docs/design.md](docs/design.md). The plan format: [docs/plan-format.md](docs/plan-format.md).

## Development

- Tests run on Node with `node --test test/*.test.js`. There's no system Node here, so use the codex runtime's (`~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`).
- Fixtures: `node tools/export-fixtures.mjs` reads PF2e's and the "+" modules' packs read-only (`tools/leveldb.mjs`) into `.cache/kineticist-items.json`.
- Reader coverage: `node tools/coverage.mjs --unread` lists every impulse and any sentence no form reads. `node tools/coverage-doc.mjs` regenerates `docs/coverage.md`.
- `src/` is pure: the reader (`src/reader`) and the resolver (`src/core`). `scripts/` is the Foundry layer: cards, the apply layer, the aura, triggers, creations, armor, blasts, spells.
- API: `game.modules.get("pf2e-automatic-kineticist-resolution").api` provides:
  - `readImpulse(source, { level })`
  - `planFor(item, actor)`
  - `resolve(item, { targets })`
  - `core.resolveSave/resolveAttack/resolveHealing`
