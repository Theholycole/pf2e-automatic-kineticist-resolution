// The "impulses count as Strikes and spells" option (user request 2026-10-08): a 1-action impulse also counts as a Strike, a 2-action impulse as a spell.
// Pure helpers: which way an impulse counts, the roll domains and options it gains, and the rule rewrite that carries Strike and spell modifiers onto
// PF2e's own Elemental Blast (which PF2e rolls itself, with its own domains).

/** "strike", "spell" or null for an impulse's action count. */
export function impulseCountsAs(actions, enabled) {
    if (!enabled) return null;
    const time = String(actions ?? "");
    if (time === "1") return "strike";
    if (time === "2") return "spell";
    return null;
}

/** The roll domains and roll options an impulse gains when it counts as a Strike or a spell. */
export function countsAsDomains(as) {
    if (as === "strike") return {
        attack: ["strike-attack-roll", "attack-roll", "attack"],
        damage: ["strike-damage", "attack-damage"],
        dc: [],
        options: ["action:strike", "strike", "impulse:counts-as:strike"],
        traits: ["attack"]
    };
    if (as === "spell") return {
        attack: ["spell-attack-roll", "spell-attack"],
        damage: ["spell-damage"],
        dc: ["spell-dc"],
        options: ["item:type:spell", "origin:item:type:spell", "spell", "magical", "impulse:counts-as:spell"],
        traits: ["magical"]
    };
    return { attack: [], damage: [], dc: [], options: [], traits: [] };
}

// Selector aliases for PF2e's Elemental Blast: a modifier on Strikes applies to a 1-action blast, a modifier on spells to a 2-action blast.
const ALIASES = [
    { from: ["strike-attack-roll"], to: "elemental-blast-attack-roll", cost: 1 },
    { from: ["strike-damage"], to: "elemental-blast-damage", cost: 1 },
    { from: ["spell-attack-roll", "spell-attack"], to: "elemental-blast-attack-roll", cost: 2 },
    { from: ["spell-damage"], to: "elemental-blast-damage", cost: 2 }
];
const SELECTOR_KEYS = new Set(["FlatModifier", "DamageDice", "Note", "AdjustModifier", "DamageAlteration", "RollTwice", "AdjustDegreeOfSuccess", "CriticalSpecialization"]);
export const ALIAS_MARK = "kineticistCountsAs";

/**
 * A rule list with, for each rule whose selector names Strikes or spells, a copy aimed at Elemental Blast and limited to the matching action
 * count ("action:cost:1" for Strikes, "action:cost:2" for spells). Returns null when nothing changes.
 */
export function aliasRulesForBlasts(rules) {
    if (!Array.isArray(rules) || !rules.length) return null;
    const added = [];
    for (const rule of rules) {
        if (!rule || rule[ALIAS_MARK] || !SELECTOR_KEYS.has(rule.key)) continue;
        const selectors = [rule.selector ?? rule.selectors].flat().filter(Boolean);
        if (!selectors.length) continue;
        for (const alias of ALIASES) {
            if (!selectors.some(selector => alias.from.includes(selector))) continue;
            if (selectors.includes(alias.to)) continue;
            const copy = structuredClone(rule);
            if ("selectors" in copy) copy.selectors = [alias.to];
            else copy.selector = alias.to;
            copy.predicate = [...(Array.isArray(rule.predicate) ? rule.predicate : []), `action:cost:${alias.cost}`];
            copy[ALIAS_MARK] = true;
            if (copy.slug) copy.slug = `${copy.slug}-blast-${alias.cost}`;
            added.push(copy);
        }
    }
    return added.length ? [...rules, ...added] : null;
}

/** The impulse's place in this turn's multiple attack penalty: the attack number for its next attack roll (1–3). */
export function nextAttackNumber(count) {
    return Math.min(3, Number(count ?? 0) + 1);
}
