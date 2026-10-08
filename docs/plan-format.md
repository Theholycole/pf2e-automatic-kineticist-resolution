# Kineticist plans (shared model version 13)

The reader (`src/reader/impulse-reader.js`) writes each impulse as a plan in the shared plan model (`PF2e RESOLUTION CORE/docs/plan-model.md`). That's version 12's skeleton with optional fields, so the module can move onto `pf2e-resolution-core` when it exists. The plan is read at the kineticist's level: formulas are evaluated and "Level (Nth)" entries applied.

## Skeleton (as version 12)

| Field | Kineticist content |
|---|---|
| `modelVersion` | 13 |
| `reader` | `{ id: "kineticist-impulse", version }` |
| `source` | `documentType`, `itemType`, `id`, `uuid`, `name`, `slug`, `image`, `publication`, `family: "kineticist"` |
| `level`, `itemLevel`, `rank` | the kineticist's level, the feat's level, ⌈level/2⌉ (counteract and spell rank) |
| `activation` | `time` ("1", "2", "3", "reaction", "free"), `traits`, `requirements`, `variableActions` ("1 or 2"), `alternative` (Body of Air's 2 actions) |
| `targeting` | `area` and `areaChoices` (type, value, width, within, height, cylinder); `who`; `target` (count, willing, living, range, elementTrait); `maxTargets`; `path`; `near`; `actorConstraints.predicates` (enemy, living, not-trait) |
| `trigger` | `event` ("use" or "reaction"), `raw`, `frequency`, `immunity` ({ scope, rounds, conditions }) |
| `decisionWindows` | `applicationRequiresConfirmation: true` (always) |
| `lifecycle` | `duration`, `sustained` ({ maxRounds }), `dismissable`, `stance`, `endsWithAura`, `replacesPrevious`, `singleInstance`, `ends` (hostile-action, critical-hit-damage, aura-activated), `onEnd` |
| `resolution.kind` | save, attack, blast, heal, effect, stance, area, creation, summon, spell, armor, modes, counteract, movement, reaction, use-stance, note |

**Durations** are `{ kind, … }`, one of:
- `source-turn` (edge start or end)
- `target-turn`
- `time` (rounds)
- `impulse`: as long as the impulse lasts
- `area`: while in the area
- `escape`
- `linked` (`to`: a condition slug)
- `unlimited`
- `gm`

## `resolution` payloads

- `check`: `{ roll: "save", statistic, basic, against: { dc: "source", statistic: "class" }, adjustment, options, traits, targetAdjustments, onlyIf, alreadyControlled }`
- `sharedDamage`: `{ components: [{ formula, type, category, healing }], raw }`. `raw` is the @Damage body PF2e rolls natively.
- `outcomes[degree]`: `{ damage: { multiplier }, conditions: [{ slug, value, duration }], effects, persistent, forcedMovement, notes, unaffected, immunity, control, delayed, recurringSave, forcedJump }`
- `attack`: `{ statistic: "impulse", against: "ac", maxTargets, range, mapAfterAll, targetBonus }`; `onHit.effect`
- `blast`: `{ actions, element, mode, native, extraDamage, elements (a table) }`
- `healing`: `{ components, raw, recipients, afflictionSave, maladySave, variants, immunityRounds }`
- `effects`: `[{ uuid | generated, name, recipient (self, targets, allies-…), rules, conditions, duration, linked, stance }]`
- `terrain`: `{ difficult, hazardous, hazard, concealment, until, turnStart, endTurn, turnEnd, inArea, inAreaConditions, light, lingering }`
- `aura.triggers`: `[{ events (enter, turn-start, turn-end, source-turn-start, stance…), damage, save, outcomes, push, oncePerRound, skipIfAffected }]`
- `creations`: `[{ name, size, sizes, count, ac, hp, hardness, saves, strikes, wall, length, height, food, trigger, onDestroyed, … }]`
- `sustainRepeat`: `{ firstEachRound, damage, save, repeatPlan, repeatAttack, move, options }`
- `spell`: `{ uuid, name, rank, adjustments, rankChoice }`
- `armor`: `{ category, acBonus, dexCap, checkPenalty, speedPenalty, strength, bulk, group, traits, shield }`
- `modes` / `modeChoice` / `casterChoice` / `stanceChoice`: options the owner picks on the card
- `summon`, `counteract`, `control`, `drainHeal`, `retaliation`, `movement`, `notes` (`{ text, audience: gm | owner, where }`)

## Kineticist block

`kineticist: { overflow, composite, stance, elements, actions, impulseJunction }`

## Resolver output

`src/core/resolve.js` turns a plan plus the table's results into `{ changes, decisions }`, following plan-model §3–4.

The Change ops used:
- `damage` (`multiplier`, `roll: "shared"`, or `components` for riders)
- `heal`, `tempHp`
- `condition`
- `effect`
- `move` (push, push-down, shift, descend)
- `ownership`
- `followUp`
- `note`

Decisions are typed (`id`, `phase`, `question`, `options`, `default`, `audience`): the metal question, whether the target is unwilling, whether it's already controlled, and per-Effect questions.
