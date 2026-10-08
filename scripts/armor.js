// Armor impulses (Armor in Earth, Hardwood Armor, Metal Carapace): a temporary armor item with the text's statistics, worn in place of the
// kineticist's armor ("Any bonuses, runes, and magical abilities of your actual armor are suppressed") and the shield the text offers, until the
// impulse ends (its tracker). "Uses your highest armor proficiency": the item raises medium (or heavy) armor proficiency to the kineticist's best.
import { MODULE_ID, escapeHTML } from "./utils.js";

/** The armor's statistics at the kineticist's level: the text's, plus reached "Level (3rd) The armor becomes heavy armor…" entries. */
export function armorAtLevel(plan) {
    const armor = { ...plan.resolution.armor };
    for (const entry of plan.levelEntries ?? []) {
        if (!entry.active) continue;
        const heavy = /The armor becomes heavy armor\. Its AC Bonus becomes \+(\d+), and it gains the ([a-z]+) armor trait\./.exec(entry.text);
        if (heavy) { armor.category = "heavy"; armor.acBonus = Number(heavy[1]); armor.traits = [...new Set([...(armor.traits ?? []), heavy[2]])]; }
        const shield = /The shield's Hardness increases by (\d+), its HP by (\d+), and its BT by (\d+)\./.exec(entry.text);
        if (shield && armor.shield) armor.shield = { ...armor.shield, hardness: armor.shield.hardness + Number(shield[1]) * entry.times, hp: armor.shield.hp + Number(shield[2]) * entry.times, bt: armor.shield.bt + Number(shield[3]) * entry.times };
    }
    return armor;
}

export async function applyArmor(actor, plan, context) {
    const armor = armorAtLevel(plan);
    const log = [];
    // (Using it again ends any existing one: the old item goes with its tracker; here the worn armor is put aside.)
    const worn = actor.itemTypes.armor.filter(item => item.isEquipped && !item.flags?.[MODULE_ID]?.instance);
    const category = armor.category ?? "medium";
    const proficiencyPath = `system.proficiencies.defenses.${category}.rank`;
    const source = {
        type: "armor", name: plan.source.name, img: context.item?.img ?? "systems/pf2e/icons/default-icons/armor.svg",
        system: {
            category, group: armor.group ?? null, acBonus: armor.acBonus ?? 0, dexCap: armor.dexCap ?? 0, checkPenalty: armor.checkPenalty ?? 0, speedPenalty: armor.speedPenalty ?? 0, strength: armor.strength ?? null,
            bulk: { value: armor.bulk ?? 1 }, traits: { value: armor.traits ?? [], rarity: "common" }, equipped: { carryType: "worn", inSlot: true }, quantity: 1, level: { value: 0 }, price: { value: {} },
            description: { value: `<p>Made by ${escapeHTML(plan.source.name)}. ${armor.replicateRunes ? "Runes of your actual armor that could apply to it are replicated onto it (the GM applies them)." : ""}</p>` },
            rules: [{ key: "ActiveEffectLike", mode: "upgrade", path: proficiencyPath, value: "max(@actor.system.proficiencies.defenses.light.rank, @actor.system.proficiencies.defenses.unarmored.rank, @actor.system.proficiencies.defenses.medium.rank, @actor.system.proficiencies.defenses.heavy.rank)" }]
        },
        flags: { [MODULE_ID]: { kind: "armor", instance: context.instanceId, replaced: worn.map(item => item.id) } }
    };
    if (worn.length) await actor.updateEmbeddedDocuments("Item", worn.map(item => ({ _id: item.id, "system.equipped.inSlot": false })));
    const items = [source];
    if (armor.shield) items.push({
        type: "shield", name: `${plan.source.name} shield`, img: "systems/pf2e/icons/equipment/shields/steel-shield.webp",
        system: { acBonus: 2, hardness: armor.shield.hardness, hp: { value: armor.shield.hp, max: armor.shield.hp }, brokenThreshold: armor.shield.bt, bulk: { value: 1 }, equipped: { carryType: "held", handsHeld: 1 }, quantity: 1, level: { value: 0 }, price: { value: {} },
            traits: { value: [], rarity: "common" }, description: { value: "<p>You can Shield Block with it even without the feat. The hand wielding it counts as a free hand for impulses. It ends if broken or released.</p>" } },
        flags: { [MODULE_ID]: { kind: "armor", instance: context.instanceId, shield: true } }
    });
    await actor.createEmbeddedDocuments("Item", items);
    log.push(`${actor.name} wears ${plan.source.name} (AC +${armor.acBonus}, ${category})${armor.shield ? " and holds its shield" : ""}${worn.length ? `; ${worn.map(item => item.name).join(", ")} put aside` : ""}.`);
    return log;
}

/** The impulse ended: its armor and shield go, the armor put aside is worn again. */
export async function restoreArmor(actor, instance) {
    if (!actor) return;
    const made = actor.items.filter(item => item.flags?.[MODULE_ID]?.kind === "armor" && item.flags[MODULE_ID].instance === instance);
    if (!made.length) return;
    const replaced = made.flatMap(item => item.flags[MODULE_ID].replaced ?? []);
    await actor.deleteEmbeddedDocuments("Item", made.map(item => item.id)).catch(() => null);
    const back = replaced.filter(id => actor.items.has(id)).map(id => ({ _id: id, "system.equipped.inSlot": true }));
    if (back.length) await actor.updateEmbeddedDocuments("Item", back).catch(() => null);
}
