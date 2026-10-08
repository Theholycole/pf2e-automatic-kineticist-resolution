import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { readImpulse } from "../src/reader/impulse-reader.js";

// The save families, read from PF2e 8.5's text (fixture: node tools/export-fixtures.mjs).
const items = JSON.parse(readFileSync(new URL("../.cache/kineticist-items.json", import.meta.url)));
const impulse = name => items.impulses.find(item => item.name === name);
const read = (name, level) => readImpulse(impulse(name), { level });
const row = (plan, degree) => plan.resolution.outcomes[degree];
const slugs = list => list.map(condition => `${condition.slug}${condition.value ?? ""}`);

test("every official impulse is read with no unread sentence except Drowning Mist's stance", () => {
    const unread = items.impulses.map(item => [item.name, readImpulse(item)]).filter(([, plan]) => plan.automation.unclaimed.length);
    assert.deepEqual(unread.map(([name]) => name), []);
    const guided = items.impulses.map(item => [item.name, readImpulse(item)]).filter(([, plan]) => plan.automation.level !== "automatic").map(([name]) => name);
    assert.deepEqual(guided, ["Drowning Mist"]);
});

test("basic area saves: class DC, area, damage at the kineticist's level, standard multipliers", () => {
    const tidal = read("Tidal Hands", 5);
    assert.deepEqual([tidal.resolution.kind, tidal.resolution.check.statistic, tidal.resolution.check.basic, tidal.resolution.check.against], ["save", "reflex", true, { dc: "source", statistic: "class" }]);
    assert.deepEqual(tidal.resolution.sharedDamage.components.map(c => [c.formula, c.type]), [["3d8", "bludgeoning"]]);
    assert.deepEqual(tidal.targeting.areaChoices.map(area => [area.type, area.value, area.count]), [["cone", 15, 2], ["cone", 30, 1]]);
    assert.deepEqual(["criticalSuccess", "success", "failure", "criticalFailure"].map(degree => row(tidal, degree).damage.multiplier), [0, 0.5, 1, 2]);
    assert.deepEqual(row(tidal, "criticalFailure").forcedMovement, { kind: "push", distance: 5 });
    assert.equal(row(tidal, "failure").forcedMovement, null);
    assert.equal(tidal.kineticist.overflow, true);
    const hail = read("Hail of Splinters", 1);
    assert.deepEqual(hail.resolution.sharedDamage.components.map(c => [c.formula, c.category, c.type]), [["1d4", null, "piercing"], ["1d4", "persistent", "bleed"]]);
    assert.deepEqual([hail.targeting.area.type, hail.targeting.area.value], ["cone", 30]);
});

test("riders: prone on a critical failure, pushes by degree, timed conditions, metal persistent damage", () => {
    assert.deepEqual(slugs(row(read("Blazing Wave", 4), "criticalFailure").conditions), ["prone"]);
    assert.deepEqual(slugs(row(read("Blazing Wave", 4), "failure").conditions), []);
    const hurricane = read("Call the Hurricane", 8);
    assert.deepEqual([row(hurricane, "failure").forcedMovement.distance, row(hurricane, "criticalFailure").forcedMovement.distance], [10, 20]);
    const storm = read("Storm Spiral", 8);
    assert.deepEqual(row(storm, "failure").conditions[0].duration, { kind: "target-turn", edge: "end" });
    assert.deepEqual(row(storm, "criticalFailure").conditions[0].duration, { kind: "time", rounds: 10 });
    assert.equal(storm.resolution.check.targetAdjustments[0].value, -1);
    const retch = read("Retch Rust", 8);
    assert.deepEqual(row(retch, "failure").persistent.map(c => [c.formula, c.category, c.type, c.onlyIf]), [["2d4", "persistent", "slashing", "metal"]]);
    const mud = read("Roiling Mudslide", 6);
    assert.deepEqual([row(mud, "failure").forcedMovement.distance, row(mud, "criticalFailure").forcedMovement.distance, row(mud, "failure").effects[0].name], [5, 10, "Coated in Mud"]);
});

test("degree saves: rows from the text, inherited rows, immunity", () => {
    const glacial = read("Glacial Prison", 12);
    assert.deepEqual([glacial.resolution.check.statistic, glacial.resolution.check.basic], ["fortitude", false]);
    assert.equal(row(glacial, "criticalSuccess").unaffected, true);
    assert.deepEqual(slugs(row(glacial, "success").conditions), ["slowed1"]);
    assert.equal(row(glacial, "failure").effects[0].name, "Frozen Solid");
    assert.deepEqual([row(glacial, "criticalFailure").effects[0].name, slugs(row(glacial, "criticalFailure").conditions)], ["Frozen Solid", ["slowed1"]]);
    assert.equal(glacial.trigger.immunity.rounds, 24 * 600);
    const seed = read("Witchwood Seed", 12);
    assert.deepEqual(seed.resolution.sharedDamage.components.map(c => c.formula), ["5d10"]);
    assert.deepEqual(["success", "failure", "criticalFailure"].map(degree => row(seed, degree).damage.multiplier), [0.5, 1, 2]);
    assert.deepEqual(slugs(row(seed, "failure").conditions), ["clumsy2", "immobilized"]);
    assert.ok(row(seed, "criticalFailure").recurringSave);
    assert.deepEqual(seed.targeting.actorConstraints.predicates, [{ kind: "not-trait", traits: ["fungus", "plant", "wood"] }]);
    const solar = read("Solar Detonation", 8);
    assert.deepEqual(solar.trigger.immunity, { scope: "conditions", rounds: 100, conditions: ["dazzled", "blinded"] });
    const weight = read("Weight of Stone", 6);
    assert.deepEqual([row(weight, "failure").forcedMovement.kind, row(weight, "failure").forcedMovement.distance, row(weight, "criticalFailure").forcedMovement.distance], ["push-down", 40, 80]);
});

test("passed-through, triggering and targeted saves", () => {
    assert.equal(read("Flying Flame", 1).targeting.who, "passed-through");
    assert.equal(read("Ash Strider", 6).targeting.maxTargets, 1);
    assert.equal(read("Volcanic Escape", 6).targeting.who, "trigger");
    const sand = read("Calcifying Sand", 4);
    assert.deepEqual([sand.targeting.who, slugs(row(sand, "criticalFailure").conditions), sand.resolution.reaction.value], ["trigger", ["petrified"], 4]);
    assert.equal(read("Extract Element", 3).targeting.target.elementTrait, true);
    assert.equal(row(read("Extract Element", 3), "success").effects[0].generated, "extracted");
});

test("Level entries are in the formulas, not applied twice; reached Nth-level entries go on the card", () => {
    assert.equal(read("Scorching Column", 1).resolution.sharedDamage.components[0].formula, "1d6");
    assert.equal(read("Scorching Column", 4).resolution.sharedDamage.components[0].formula, "2d6");
    assert.equal(read("Scorching Column", 4).resolution.terrain.hazard[0].formula, "3");
    const shattered = read("The Shattered Mountain Weeps", 20);
    assert.equal(shattered.resolution.sharedDamage.components[0].formula, "10d10");
    assert.equal(shattered.resolution.terrain.endTurn[0].formula, "4d10");
    assert.ok(read("Born to the Trees", 6).resolution.notes.some(note => /At level 6: You can target up to 5/.test(note.text)));
    assert.ok(!read("Born to the Trees", 4).resolution.notes.some(note => note.where === "level"));
});
