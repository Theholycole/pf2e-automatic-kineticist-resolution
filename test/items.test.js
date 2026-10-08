import assert from "node:assert/strict";
import test from "node:test";
import { readElementalSpellActivation, elementalSpellStatistics } from "../src/reader/items.js";

// The gate attenuator's activation, from PF2e 8.5's text (abridged to the read sentence).
const text = grade => `<p>If you're a kineticist, the attenuator grants you a +1 item bonus to your impulse attack modifier.</p><p><strong>Activate - Elemental Spell</strong> <span class="action-glyph">2</span> (concentrate)</p><p><strong>Frequency</strong> once per day</p><hr /><p><strong>Effect</strong> The gate attenuator casts a ${grade.rank}-rank spell, with a spell attack modifier of +${grade.attack} and spell DC of ${grade.dc}. If you're a kineticist and the spell's element matches one of your kinetic elements, you can use your impulse attack modifier instead of the spell attack modifier or your impulse DC instead of the spell DC. The spell corresponds to the element the item is attuned to, and it gains that element's trait if it doesn't already have it: air @UUID[Compendium.pf2e.spells-srd.Item.a]{Gust of Wind} earth @UUID[Compendium.pf2e.spells-srd.Item.b]{Pummeling Rubble} fire @UUID[Compendium.pf2e.spells-srd.Item.c]{Dehydrate} metal @UUID[Compendium.pf2e.spells-srd.Item.d]{Thunderstrike} water @UUID[Compendium.pf2e.spells-srd.Item.e]{Snowball} wood @UUID[Compendium.pf2e.spells-srd.Item.f]{Flourishing Flora}</p>`;

test("gate attenuator: the Elemental Spell activation read from its text", () => {
    const read = readElementalSpellActivation({ system: { description: { value: text({ rank: "1st", attack: 7, dc: 17 }) } } });
    assert.deepEqual([read.label, read.actions, read.frequency, read.rank, read.attack, read.dc, read.kineticistSubstitute, read.spells.fire.name], ["Elemental Spell", "2", "once per day", 1, 7, 17, true, "Dehydrate"]);
});

test("gate attenuator: the kineticist's impulse statistics when the element matches and they're better", () => {
    const read = readElementalSpellActivation({ system: { description: { value: text({ rank: "1st", attack: 7, dc: 17 }) } } });
    assert.deepEqual(elementalSpellStatistics(read, "fire", { kineticElements: ["fire"], impulseAttack: 9, impulseDc: 19 }), { attack: 9, dc: 19, usesImpulse: { attack: true, dc: true } });
    assert.deepEqual(elementalSpellStatistics(read, "water", { kineticElements: ["fire"], impulseAttack: 9, impulseDc: 19 }), { attack: 7, dc: 17, usesImpulse: { attack: false, dc: false } });
    assert.equal(readElementalSpellActivation({ system: { description: { value: "<p>A wheelchair's impulse control.</p>" } } }), null);
});
