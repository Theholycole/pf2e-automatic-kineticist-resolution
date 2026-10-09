import assert from "node:assert/strict";
import test from "node:test";
import { impulseCountsAs, countsAsDomains, aliasRulesForBlasts, ALIAS_MARK, nextAttackNumber } from "../src/core/impulse-as.js";

test("impulses count as Strikes (1 action) and spells (2 actions) only with the option on", () => {
    assert.equal(impulseCountsAs("1", true), "strike");
    assert.equal(impulseCountsAs("2", true), "spell");
    assert.equal(impulseCountsAs("3", true), null);
    assert.equal(impulseCountsAs("reaction", true), null);
    assert.equal(impulseCountsAs("1", false), null);
    assert.deepEqual(countsAsDomains("strike").attack, ["strike-attack-roll", "attack-roll", "attack"]);
    assert.deepEqual(countsAsDomains("spell").dc, ["spell-dc"]);
    assert.ok(countsAsDomains("spell").options.includes("item:type:spell"));
});

test("Elemental Blast: Strike and spell modifiers copied onto its selectors by action count", () => {
    const rules = [
        { key: "FlatModifier", selector: "strike-damage", value: 2, type: "status", slug: "courage" },
        { key: "FlatModifier", selector: ["spell-attack-roll", "spell-dc"], value: 1, type: "item", predicate: ["self:effect:x"] },
        { key: "Resistance", type: "fire", value: 5 },
        { key: "FlatModifier", selector: "perception", value: 1 }
    ];
    const out = aliasRulesForBlasts(rules);
    const added = out.filter(rule => rule[ALIAS_MARK]);
    assert.deepEqual(added.map(rule => [rule.selector, rule.predicate, rule.slug]), [
        ["elemental-blast-damage", ["action:cost:1"], "courage-blast-1"],
        ["elemental-blast-attack-roll", ["self:effect:x", "action:cost:2"], undefined]
    ]);
    assert.equal(aliasRulesForBlasts([{ key: "Resistance", type: "fire", value: 5 }]), null);
    assert.equal(aliasRulesForBlasts(added), null);
});

test("the multiple attack penalty's attack number", () => {
    assert.deepEqual([0, 1, 2, 5].map(nextAttackNumber), [1, 2, 3, 3]);
});

test("spellshape riders on an impulse's own damage: the type swap and extra components in PF2e's @Damage body", async () => {
    const { shapedRaw } = await import("../scripts/spell-like.js");
    const original = [{ formula: "3d6", type: "fire", category: null }];
    const shaped = { components: [{ formula: "3d6", type: "cold", category: null }, { formula: "2", type: "cold", category: null, from: "Elemental Shift" }, { formula: "1d4", type: "fire", category: "persistent", from: "Burning Spell" }] };
    assert.equal(shapedRaw("(floor((@actor.level -1)/2)+1)d6[fire]|options:area-damage", shaped, original), "(floor((@actor.level -1)/2)+1)d6[cold],2[cold],1d4[persistent,fire]|options:area-damage");
    assert.equal(shapedRaw(null, shaped, original), null);
});
