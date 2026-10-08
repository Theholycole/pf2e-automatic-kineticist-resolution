import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { readImpulse } from "../src/reader/impulse-reader.js";
import { resolveSave, resolveAttack, resolveHealing, targetDecisions, saveAdjustment, impulseLifecycle, resolveAuraTrigger } from "../src/core/resolve.js";
import { junctions, impulseJunctionsFor, criticalBlastJunctions, splitTwoElements, blastProfile, roundKey, overflowEndsAura } from "../src/core/kineticist.js";
import { gridDirection, stepsWithin } from "../src/core/geometry.js";

const items = JSON.parse(readFileSync(new URL("../.cache/kineticist-items.json", import.meta.url)));
const read = (name, level) => readImpulse(items.impulses.find(item => item.name === name), { level });
const ops = changes => changes.map(change => `${change.target}:${change.op}${change.multiplier != null ? `×${change.multiplier}` : ""}${change.slug ? `:${change.slug}` : ""}${change.distance ? `:${change.distance}` : ""}${change.effect ? `:${change.effect.name}` : ""}`);

test("a basic area save: damage by degree, the critical failure's push", () => {
    const plan = read("Tidal Hands", 5);
    const { changes } = resolveSave(plan, { targets: [{ id: "a", degree: "criticalSuccess" }, { id: "b", degree: "success" }, { id: "c", degree: "failure" }, { id: "d", degree: "criticalFailure" }] });
    assert.deepEqual(ops(changes), ["b:damage×0.5", "c:damage×1", "d:damage×2", "d:move:5"]);
});

test("riders: Storm Spiral's metal penalty and deafened timings; Retch Rust's persistent damage only on metal", () => {
    const storm = read("Storm Spiral", 8);
    const target = { id: "t", degree: "failure", traits: ["metal"] };
    assert.equal(saveAdjustment(storm, target, {}), -1);
    assert.equal(saveAdjustment(storm, target, { "metal:t": false }), 0);
    assert.deepEqual(targetDecisions(storm, target).map(decision => [decision.id, decision.phase, decision.default]), [["metal:t", "pre-roll", true]]);
    const cf = resolveSave(storm, { targets: [{ id: "t", degree: "criticalFailure" }] }).changes.find(change => change.op === "condition");
    assert.deepEqual([cf.slug, cf.duration], ["deafened", { kind: "time", rounds: 10 }]);
    const retch = read("Retch Rust", 8);
    assert.equal(resolveSave(retch, { targets: [{ id: "m", degree: "failure", traits: ["metal"] }] }).changes.filter(change => change.roll === "rider").length, 1);
    assert.equal(resolveSave(retch, { targets: [{ id: "n", degree: "failure", traits: [] }] }).changes.filter(change => change.roll === "rider").length, 0);
});

test("degree saves: Glacial Prison's frozen Effect and immunity; Witchwood Seed's recurring save; Burning Demand's delayed sigil", () => {
    const glacial = read("Glacial Prison", 12);
    const { changes } = resolveSave(glacial, { targets: [{ id: "g", degree: "criticalFailure" }] });
    assert.deepEqual(ops(changes), ["g:condition:slowed", "g:effect:Frozen Solid", "g:effect:Immune to Glacial Prison"]);
    const seed = resolveSave(read("Witchwood Seed", 12), { targets: [{ id: "w", degree: "criticalFailure" }] }).changes;
    assert.ok(seed.some(change => change.op === "followUp" && change.plan.recurringSave && change.when === "target-turn-end"));
    const demand = resolveSave(read("Burning Demand", 12), { targets: [{ id: "d", degree: "failure" }] }).changes;
    assert.deepEqual(demand.filter(change => change.op === "followUp").map(change => [change.when, change.plan.damage[0].formula]), [["target-turn-start", "8d6"]]);
});

test("Flinging Updraft: a willing target takes the full effect without saving", () => {
    const plan = read("Flinging Updraft", 6);
    assert.equal(targetDecisions(plan, { id: "x", ally: true }).find(decision => decision.id === "unwilling:x").default, false);
    const willing = resolveSave(plan, { targets: [{ id: "x" }], answers: { "unwilling:x": false } }).changes;
    assert.ok(willing.some(change => change.op === "note" && /maximum distance \(30 feet\)/.test(change.text)));
});

test("Command Elemental: control by level, else slowed while Sustained", () => {
    const plan = read("Command Elemental", 8);
    const low = resolveSave(plan, { targets: [{ id: "low", degree: "failure", level: 5 }] }).changes;
    const high = resolveSave(plan, { targets: [{ id: "high", degree: "failure", level: 6 }] }).changes;
    assert.deepEqual(ops(low), ["low:ownership"]);
    assert.deepEqual(ops(high), ["high:condition:slowed"]);
});

test("impulse attacks: double on a critical hit, Molten Wire's wire on a hit", () => {
    const pinions = read("Magnetic Pinions", 1);
    assert.deepEqual([pinions.resolution.attack.maxTargets, pinions.resolution.attack.mapAfterAll, pinions.resolution.attack.range], [3, true, 60]);
    assert.deepEqual(ops(resolveAttack(pinions, { targets: [{ id: "a", degree: "criticalSuccess" }, { id: "b", degree: "failure" }, { id: "c", degree: "success" }] }).changes), ["a:damage×2", "c:damage×1"]);
    const wire = resolveAttack(read("Molten Wire", 6), { targets: [{ id: "w", degree: "success" }] }).changes;
    assert.deepEqual(ops(wire), ["w:damage×1", "w:effect:Wrapped in Molten Wire"]);
    const rod = read("Lightning Rod", 6);
    const metal = resolveAttack(rod, { targets: [{ id: "r", degree: "criticalSuccess", traits: ["metal"] }] }).changes.find(change => change.op === "effect");
    assert.equal(metal.effect.rules[0].value, -2);
});

test("healing: the recipient, its linked resistance, temporary immunity", () => {
    const balm = read("Ocean's Balm", 3);
    assert.equal(balm.resolution.healing.components[0].formula, "2d8");
    const { changes } = resolveHealing(balm, { targets: [{ id: "h" }] });
    assert.deepEqual(changes.map(change => `${change.op}${change.effect ? `:${change.effect.name}` : ""}`), ["heal", "effect:Effect: Ocean's Balm", "effect:Immune to Ocean's Balm", "note"]);
    assert.deepEqual(resolveHealing(balm, { targets: [{ id: "h", immune: true }] }).changes.map(change => change.op), ["note"]);
});

test("lifecycle: Scorching Column is tracked and Sustained; a stance isn't tracked separately; Metal Carapace ends on a critical hit", () => {
    const column = impulseLifecycle(read("Scorching Column", 1));
    assert.deepEqual([column.tracked, column.sustainable, column.sustainMaxRounds, column.duration.expiry], [true, true, 10, "turn-end"]);
    assert.equal(impulseLifecycle(read("Thermal Nimbus", 4)).tracked, false);
    assert.ok(impulseLifecycle(read("Metal Carapace", 1)).ends.includes("critical-hit-damage"));
});

test("aura triggers: Drifting Pollen's save rows, Thermal Nimbus' damage", () => {
    const pollen = read("Drifting Pollen", 8).resolution.aura.triggers[0];
    assert.deepEqual(resolveAuraTrigger(pollen, { id: "p" }, "criticalFailure").map(change => `${change.slug}${change.value ?? ""}`), ["sickened2", "dazzled"]);
    const nimbus = read("Thermal Nimbus", 6).resolution.aura.triggers[0];
    assert.deepEqual([nimbus.events, nimbus.damage[0].formula], [["turn-start", "enter"], "3"]);
});

test("junctions: impulse junctions on 2+-action impulses of the element, once per round; critical blast junctions", () => {
    const options = ["junction:earth:impulse", "junction:fire:impulse", "junction:air:critical", "junction:wood:critical"];
    assert.deepEqual(junctions(options).impulse, ["earth", "fire"]);
    const tremor = read("Tremor", 1);
    assert.deepEqual(impulseJunctionsFor(tremor, options).map(offer => offer.element), ["earth"]);
    assert.deepEqual(impulseJunctionsFor(tremor, options, { usedThisRound: true }), []);
    assert.deepEqual(impulseJunctionsFor(read("Armor in Earth", 1), options), []);
    assert.equal(impulseJunctionsFor(read("Blazing Wave", 4), options)[0].native, true);
    assert.deepEqual(criticalBlastJunctions(["air", "wood", "fire"], options).map(offer => [offer.element, offer.change.op]), [["air", "move"], ["wood", "effect"]]);
    assert.equal(overflowEndsAura(tremor), true);
    assert.equal(roundKey({ started: true, id: "c", round: 3 }, 0), "c:3");
});

test("Matter Blast (Alchemists+): its element table at a level; Two-Element Infusion's split", () => {
    const matter = readImpulse(items.plus.find(item => item.name === "Matter Blast"), { level: 9 });
    assert.equal(matter.automation.level, "automatic");
    assert.deepEqual(blastProfile(matter.resolution.blast.elements, "earth", 9), { element: "earth", dice: 3, faces: 8, formula: "3d8", damageTypes: ["bludgeoning", "piercing"], range: 30 });
    assert.deepEqual(splitTwoElements(11, ["fire", "cold"]), [{ type: "fire", amount: 6 }, { type: "cold", amount: 5 }]);
});

test("geometry: grid directions and diagonal costs", () => {
    assert.deepEqual(gridDirection({ x: 0, y: 0 }, { x: 10, y: 10 }), [1, 1]);
    assert.equal(stepsWithin(15, true), 2);
    assert.equal(stepsWithin(15, false), 3);
});
