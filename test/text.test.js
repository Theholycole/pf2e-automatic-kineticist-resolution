import assert from "node:assert/strict";
import test from "node:test";

import { evaluate, formulaAt, readDamage, readCheck, readTemplate, inlineTags, paragraphs, sentences, readable } from "../src/reader/text.js";

test("level expressions: floor, ceil, max, ternary/gte", () => {
    assert.equal(evaluate("floor((@actor.level -1)/2)+1", 7), 4);
    assert.equal(evaluate("ceil(@actor.level/2)", 5), 3);
    assert.equal(evaluate("ternary(gte(@actor.level,20),10,9)", 20), 10);
    assert.equal(evaluate("ternary(gte(@actor.level,20),10,9)", 18), 9);
    assert.equal(evaluate("process.exit()", 1), null);
});

test("damage formulas at a level", () => {
    assert.equal(formulaAt("(floor((@actor.level -1)/2)+1)d6", 1), "1d6");
    assert.equal(formulaAt("(floor((@actor.level -1)/2)+1)d6", 9), "5d6");
    assert.equal(formulaAt("(ceil(@actor.level/2)d8)", 5), "3d8");
    assert.equal(formulaAt("(2*floor((@actor.level -1)/3)+1)", 7), "5");
    assert.equal(formulaAt("((floor((max(1,@actor.level)-1)/2)+1)d4+(floor((max(1,@actor.level)-1)/2)*5+1))", 3), "2d4+6");
    assert.equal(formulaAt("(10 + floor(@actor.level/20)*4)d8", 20), "14d8");
    assert.equal(formulaAt("floor(@actor.level/4)d8", 18), "4d8");
    assert.equal(formulaAt("((@actor.level/2)+2)d6", 12), "8d6");
    assert.equal(formulaAt("(ternary(gte(@actor.level, 20), 5, 4)d10+9)", 18), "4d10+9");
});

test("@Damage bodies: components, categories, healing, options", () => {
    const hail = readDamage("(floor((@actor.level -1)/2)+1)d4[piercing],(floor((@actor.level -1)/2)+1)d4[persistent,bleed]|options:area-damage", 3);
    assert.deepEqual(hail.components.map(c => [c.formula, c.type, c.category]), [["2d4", "piercing", null], ["2d4", "bleed", "persistent"]]);
    assert.deepEqual(hail.options, ["area-damage"]);
    const balm = readDamage("(floor((max(1,@actor.level)-1)/2)+1)d8[healing]", 1);
    assert.deepEqual([balm.components[0].formula, balm.components[0].healing], ["1d8", true]);
    const produce = readDamage("((floor((max(1,@actor.level)-1)/2)+1)d4+(floor((max(1,@actor.level)-1)/2)*5+1))[vitality,healing]", 1);
    assert.deepEqual([produce.components[0].formula, produce.components[0].type, produce.components[0].healing], ["1d4+1", "vitality", true]);
    const nimbus = readDamage("(floor(@actor.level/2))[@actor.flags.system.kineticist.thermalNimbus]", 4);
    assert.deepEqual([nimbus.components[0].formula, nimbus.components[0].typeFrom], ["2", "@actor.flags.system.kineticist.thermalNimbus"]);
});

test("@Check, @Template and the tag scanner", () => {
    assert.deepEqual(readCheck("reflex|against:kineticist|basic|options:area-effect"), { statistic: "reflex", basic: true, against: "kineticist", dc: null, adjustment: 0, defense: null, options: ["area-effect"], traits: [], rollerRole: null });
    assert.equal(readCheck("acrobatics|against:kineticist|adjustment:-2|rollerRole:target").adjustment, -2);
    assert.deepEqual(readTemplate("line|distance:30|width:10"), { type: "line", distance: 30, width: 10 });
    assert.deepEqual(readTemplate("type:emanation|distance:10"), { type: "emanation", distance: 10, width: null });
    const text = "in a @Template[cone|distance:15]{15-foot cones} take @Damage[(floor((@actor.level -1)/2)+1)d8[bludgeoning]|options:area-damage] damage";
    assert.deepEqual(inlineTags(text).map(tag => [tag.kind, tag.label]), [["template", "15-foot cones"], ["damage", null]]);
    assert.equal(readable(text, 5), "in a 15-foot cones take 3d8 bludgeoning damage");
});

test("paragraphs and sentences keep inline tags whole", () => {
    const [p] = paragraphs("<p>Each creature takes @Damage[1d6[fire]] damage. It's @UUID[Compendium.pf2e.conditionitems.Item.x]{Clumsy 1}. Done.</p><hr /><p><strong>Level (+2)</strong> More.</p>");
    assert.deepEqual(sentences(p), ["Each creature takes @Damage[1d6[fire]] damage.", "It's @UUID[Compendium.pf2e.conditionitems.Item.x]{Clumsy 1}.", "Done."]);
});
