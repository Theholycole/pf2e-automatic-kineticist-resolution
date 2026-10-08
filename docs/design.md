# PF2e Automatic Kineticist Resolution: design

Started 2026-10-08. The user asked for the whole PF2e Kineticist to be automated as its own module, built on the spell automation module, built in full first and tested in Foundry at the end. This document records the design and every decision taken along the way. Decisions the user should look at are marked **(review)**.

## 1. What PF2e 8.5 already does (and the module leaves alone)

A lot of the Kineticist is already automated by PF2e itself. The module never re-implements these:

- **Elemental Blast**: the attack and damage rolls (`game.pf2e.ElementalBlast`), element and damage-type choice, the 1- or 2-action cost (status bonus from Constitution), Strength on melee, the die every 4 levels, and the kinetic-aura requirement.
- **Channel Elements**: its self-effect, `Effect: Kinetic Aura`, carries the aura (an `Aura` rule element, size chosen with Aura Shaping).
- **Gate junctions** (rules on the Air/Earth/Fire/Metal/Water/Wood Gate features):
  - elemental resistance and immunity
  - aura junctions (as `Aura` rules)
  - skill junctions
  - the fire impulse junction's die step on impulse damage
  - the fire, metal and water critical blast damage
- **Stances**: 20 impulses link a self-effect (`Stance: Thermal Nimbus`, …). Several of them give allies their Effect through `Aura` rules.
- **Weapon Infusion, Versatile Blasts, Improved Elemental Blast, Kinetic Pinnacle, Kinetic Durability/Quickness, Voice of Elements**: all rule elements.

## 2. What the module adds

The module adds the parts PF2e leaves as text:

1. **Impulse resolution cards** (confirmation-first, like the spell module). Each impulse is read from its text into a plan, and its chat card gets a **Resolve** button. The card covers:
   - targets and areas
   - saves against the kineticist's class DC
   - impulse attacks against AC
   - damage at the kineticist's level
   - conditions with their durations
   - forced movement
   - persistent damage
   - healing
   - Effects
   - lingering terrain
   - creations (conjured creatures and objects)
   - Sustain repeats
   - GM notes for anything left to judgment

   The GM confirms before anything is applied.
2. **The kinetic aura's state:**
   - An **overflow** impulse deactivates the aura (it deletes `Effect: Kinetic Aura`).
   - When the aura ends, **stance impulses end** too.
   - Being knocked out (unconscious) ends the aura.
   - A stance ends the kineticist's other stances.
3. **Junctions PF2e only notes as text:**
   - **Impulse junctions**, when a 2+-action impulse of the element is used (once per round):
     - Earth: +1 AC Effect
     - Wood: temporary HP Effect
     - Metal: a retaliation Effect
     - Water: a 5-foot move of a creature, as a card button
     - Air: a Stride or Step reminder
   - **Critical blast junctions** on an Elemental Blast critical hit:
     - Air: push 10 feet
     - Earth: prone, or a 20-foot descent
     - Wood: immobilized with an Athletics DC 10 escape
     - Metal: the rust variant against metal creatures
4. **Aura triggers** from stances: damage or saves when a creature enters the aura, starts or ends its turn there, or moves in it. Examples: Thermal Nimbus damage, Crowned in Tempest's Fury, Drifting Pollen, Steam Knight's steam, Winter Sleet's ice, Ravel of Thorns, Drowning Mist. Each trigger opens a card; the GM confirms.
5. **Extract Element**: the target's Effect (a −1 penalty against the kineticist's impulses), and IWR bypass offered when that kineticist's impulse damage is applied.
6. **Infusions:**
   - Two-Element Infusion: split damage types.
   - Chain Infusion: a card button chains the blast to the next target.
   - Pacifying Infusion: the next impulse gains the nonlethal trait and can exclude Safe Elements' creatures.
7. **Start-of-turn prompts:**
   - Final Gate: Channel Elements when the aura is inactive.
   - Effortless Impulse: Sustain one impulse.
   - Imperious Aura: use a stance impulse.
8. **Impulses that have a spell's effects** (Wall of Fire, Wall of Stone, Wall of Ice, Earthquake, Vapor Form, Fiery Body, Ferrous Form, Feet to Fins, Protector Tree, Clad in Metal, Message, Elemental Form): resolved by the **spell module** when it's active, at rank ⌈level/2⌉ against the kineticist's class DC. See §5.
9. **Third-party** (user decision 2026-10-08, "Both"):
   - **Alchemists+ Chrysopoet:** Matter Blast as an impulse attack with its element table, Intelligence as the 2-action status bonus, and Render Circle's circle standing in for the kinetic aura (overflow ends it).
   - **Barbarians+ Elemental Instinct:** impulses of the instinct's element gain the rage trait while raging, and so does Sustaining them.

## 3. Architecture

```
src/reader/   pure: impulse text → plan (Node-tested against every official impulse)
  text.js             inline tags (@Damage, @Check, @Template, @UUID) and level formulas
  phrases.js          durations, conditions, distances
  forms.js            core sentence forms + degree rows + finishPlan
  forms-impulses.js   creations, armor, lingering areas, Sustain repeats, summons, options
  impulse-reader.js   readImpulse(source, { level }) → plan (model version 13)
src/core/     pure: plan + rolls → typed decisions and Change ops (docs/plan-format.md)
scripts/      Foundry: hooks, cards, the apply layer
tools/        fixture export, reader coverage
test/         node --test
```

- **The reader is the module's own** (user decision 2026-10-08, "Own impulse reader"). The spell compiler rejects every impulse (0 of 118 pass its save gate, even after rewording), and the spell module is mid-cleanup. The kineticist reader writes plans in the shared format so they can move onto `pf2e-resolution-core` later.
- **Plans are read at the kineticist's level.** Impulse damage formulas already scale with `@actor.level`, so they are evaluated at that level. "Level (+N)" entries are already in the formulas and are not applied twice. "Level (Nth)" entries the kineticist has reached are shown on the card.
- **Every sentence is read or shown.** A sentence no form reads appears on the card as a GM note and the plan is "guided". 118 of 119 impulses (including Matter Blast) are read completely. Drowning Mist is guided: PF2e has no Stance Effect for it, so its "difficult terrain for non-swimmers" stays a GM note.
- **No prototype is wrapped twice.** The module wraps no PF2e prototype at all. It uses hooks and PF2e's public methods (`actor.applyDamage`, `Statistic.roll`, `ElementalBlast`, `DamageRoll`). Only the active GM acts on hooks. Card handlers skip messages carrying `flags.pf2e.context.type`. Combat-update hooks return at once unless a recorded aura, stance or lingering area exists.
- **The spell module is optional** (`relationships.recommends`). Without it, the spell-equivalent impulses get a card that links the spell and notes its rank and DC.

## 4. Resolution families

| Family | Impulses (examples) | Card |
|---|---|---|
| Area save | Tidal Hands, Blazing Wave, Storm Spiral, Hail of Splinters | targets in the placed area; class-DC save per target; one damage roll; degree multipliers; riders (conditions, push, persistent) |
| Degree save | Glacial Prison, Witchwood Seed, Solar Detonation, Tumbling Lumber | save rows from the text, with conditions and Effects per degree |
| Passed-through / trigger | Flying Flame, Lightning Dash, Ash Strider, Volcanic Escape, Calcifying Sand | the GM targets the creatures passed through, or the triggering creature |
| Impulse attack | Magnetic Pinions (3 targets, MAP after all), Molten Wire, Whirling Grindstone, Elemental Artillery | `impulse` statistic against AC per target, then damage (double on a critical) and riders on a hit |
| Blast-based | Lightning Rod, Liberating Dive, Matter Blast | PF2e's Elemental Blast (or the module's for Matter Blast), plus the impulse's extra damage and rider |
| Healing | Ocean's Balm, Dash of Herbs, Torrent in the Blood, Tree of Duality | healing roll at level, the linked Effect, temporary immunity |
| Effect | Born to the Trees, Spike Skin, Cyclonic Ascent, Clear as Air, Return to the Sea | PF2e's Effect or one generated from the text |
| Armor | Armor in Earth, Hardwood Armor, Metal Carapace | a temporary armor item with the text's statistics (and the shield) replaces the worn armor until it ends |
| Stance | Thermal Nimbus, Winter Sleet, Drifting Pollen, Shattershields | PF2e's Stance Effect; other stances end; aura triggers recorded |
| Lingering area | Scorching Column, Winter's Clutch, Rain of Razors, Rain of Rust, Ignite the Sun, Impenetrable Fog | a Region from the placed template: difficult/hazardous terrain, start/end-of-turn saves, concealment, its duration and Sustain |
| Creation | Sand Snatcher, Crawling Fire, Jagged Berms, walls, Rouse the Forest's Fury, Beasts of Slumbering Steel, Ambush Bladderwort | a token (conjured creature or object, stats from the text) placed by the owner, ended with the impulse |
| Summon | Fearsome Familiar | pick a common elemental of level ≤ L−4; it replaces the familiar while Sustained |
| Spell | Architect of Flame, Rock Rampart, Barrier of Boreal Frost, Body of Air, Furnace Form, Timber Sentinel | the spell module resolves the spell at rank ⌈L/2⌉ with the class DC |
| Modes | Shard Strike, Base Kinesis, Turn the Wheel of Seasons, Usurp the Lunar Reins | the caster picks the option(s) on the card |
| Counteract | Counter Element, Purify Element | class DC − 10 modifier, rank ⌈L/2⌉ |

## 5. Decisions

- **2026-10-08, the user:** the module reads impulses itself and doesn't route them through the spell compiler.
- **2026-10-08, the user:** include both "+" modules' Kineticist content.
- **Confirmation-first everywhere** (user decision for spells and abilities, carried over). Nothing is applied before the GM's confirmation on the card.
- **Movement is the owner's** (Burning Jet, Lava Leap, Four Winds, Ride the Tsunami…). The card states the movement allowed, and the owner moves the token. Damage to creatures passed through goes to the creatures the GM targets. **(review)**
- **Forced movement** (push, pull, downward) is a card button per target that moves the token directly away from the kineticist, as in the spell module. "Pushed out of the line in the most direct path" (Tumbling Lumber) is the GM's: the button only reminds. **(review)**
- **Conjured creatures and objects become tokens**, following the spell module's "conjured: token" decision (2026-10-01). Walls (Scrap Barricade, Wooden Palisade, Hedge Maze, Jagged Berms) are placed as tokens or wall segments the owner positions. Their statistics come from the text. **(review)**
- **Armor impulses** create a temporary armor item from the text's statistics, equip it in place of the worn armor, and restore the old armor when the impulse ends. Rune replication is left to the GM (noted on the card). **(review)**
- **The overflow trait ends the aura when the impulse is resolved (or confirmed)**, not when the card is posted. A cancelled card leaves the aura alone. **(review)**
- **Impulse junctions are offered, not forced** ("you can always choose not to use a gate junction"). They are once per round, tracked by a flag on the kineticist.
- **"Against your impulses"** (Extract Element, Burning Demand's sigil) use PF2e's `origin:signature` and `origin:item:trait:impulse` roll options, so they only apply against that kineticist.
- **Pass-through, "once per round" and "first creature" limits** are enforced on the card's target list. The geometry (who was passed through) is the GM's targeting.
- **A metal creature's extras** (Rain of Rust, Storm Spiral's −1, Retch Rust, Lightning Rod) come from a per-target question on the card, pre-ticked when the actor has the metal trait or wears metal armor.

## 6. Still open

- Turn the Wheel of Seasons' "cube 100 feet" and other cubes become square regions (no height) on a 2-D canvas.
- Earthquake (Rattle the Earth) and other spell-equivalents depend on how the spell module resolves those spells.

## 7. Live verification (pftest, 2026-10-08)

Run with `tools/kin-live-verification.mjs` (PF2e's iconic Yoon, a level 5 fire kineticist, and three NPCs, all prefixed "PFTEST KIN"). All 12 cases pass:

| Case | What it checked |
|---|---|
| Scorching Column | area save, class DC 21, damage through PF2e's inline roll (the fire impulse junction's d8s applied), half and full damage, overflow ending the aura, the placed Region tagged, tracker with Sustain |
| Real save | a target's own Reflex save through PF2e, its degree on the card |
| Tidal Hands | critical failure: double damage and a 5-foot push away from the kineticist |
| Glacial Prison | success → Slowed 1 until the end of its next turn; critical failure → Frozen Solid + Slowed; immunity Effects |
| Magnetic Pinions | impulse attacks through PF2e's impulse statistic; a critical hit doubled (14 → 28) |
| Ocean's Balm | healing roll, PF2e's Effect: Ocean's Balm, temporary immunity |
| Armor in Earth | the armor item worn (AC 23), removed with its tracker |
| Stances | Thermal Nimbus with the card's choice (no PF2e prompt), replaced by Drifting Pollen, ended with the aura |
| Earth junction | offered on Tremor, PF2e's Effect: Earth Impulse Junction applied |
| Sand Snatcher | its token placed and removed with its tracker |
| Burning Demand | the sigil's follow-up on the target |
| Architect of Flame | Wall of Fire handed to the spell module at rank 3, class DC 21 (it then asks for the wall's region) |

An extra check in combat: Thermal Nimbus's aura triggers (entering, starting a turn) whispered the GM a card; applying it dealt 2 fire.

Fixed during the live run:
- "Choose cold or fire." was read as flavor.
- A shift-click didn't skip PF2e's roll dialog (the logic was inverted).
- The impulse junction's once-per-round limit stuck outside combat.
- The spell-equivalent is now its own repeatable "Resolve the spell" button, so a wall can be drawn first and retried.
