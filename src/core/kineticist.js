// The Kineticist's own rules, pure: the kinetic aura and overflow, stances, impulse and critical blast junctions, Matter Blast's table.
// Texts: PF2e Player Core 2 (Channel Elements, the gates' junction tables, the overflow trait), as PF2e 8.5 prints them.

export const ELEMENTS = Object.freeze(["air", "earth", "fire", "metal", "water", "wood"]);
export const KINETIC_AURA_UUID = "Compendium.pf2e.feat-effects.Item.pLurcSPQb2gjAzoP";
export const KINETIC_AURA_SLUG = "effect-kinetic-aura";
export const IMPULSE_JUNCTION_EFFECTS = Object.freeze({
    earth: "Compendium.pf2e.feat-effects.Item.09oP0FBBAhXOS4JW",
    wood: "Compendium.pf2e.feat-effects.Item.rCsmv66TzQhte4Gp"
});

/** The actor's junctions from its roll options ("junction:fire:impulse"): { impulse: [elements], critical: [...], aura, resistance, skill }. */
export function junctions(rollOptions) {
    const out = { impulse: [], critical: [], aura: [], resistance: [], skill: [] };
    for (const option of rollOptions ?? []) {
        const m = /^junction:([a-z]+):(impulse|critical|aura|resistance|skill)$/.exec(option);
        if (m && ELEMENTS.includes(m[1])) out[m[2]].push(m[1]);
    }
    return out;
}

/**
 * The impulse junctions a use of a plan can trigger: a 2+-action impulse with the junction's element trait, once per round (the round's
 * use recorded by the runtime). The fire junction is PF2e's (a DamageAlteration on the impulse's damage), so it's listed as "native".
 */
export function impulseJunctionsFor(plan, rollOptions, { usedThisRound = false } = {}) {
    if (usedThisRound) return [];
    const actions = plan.kineticist?.actions;
    if (!["2", "3"].includes(String(actions))) return [];
    const have = junctions(rollOptions).impulse;
    return (plan.kineticist?.elements ?? []).filter(element => have.includes(element)).map(element => impulseJunction(element, plan));
}

/** One element's impulse junction as an offer: { element, label, change } (the change the card applies when accepted). */
export function impulseJunction(element, plan) {
    const level = plan.level ?? 1;
    switch (element) {
        case "earth": return { element, label: "Earth impulse junction: +1 circumstance bonus to AC until the start of your next turn", change: { op: "effect", target: "source", effect: { uuid: IMPULSE_JUNCTION_EFFECTS.earth, name: "Effect: Earth Impulse Junction" } } };
        case "wood": return { element, label: `Wood impulse junction: ${level} temporary Hit Points until the start of your next turn`, change: { op: "effect", target: "source", effect: { uuid: IMPULSE_JUNCTION_EFFECTS.wood, name: "Effect: Wood Impulse Junction" } } };
        case "fire": return { element, label: "Fire impulse junction: the impulse's fire damage dice are one step larger (PF2e applies it to the damage roll)", native: true, change: null };
        case "metal": return { element, label: `Metal impulse junction: until the start of your next turn, a creature touching you or hitting you with an unarmed or non-reach melee attack takes ${Math.max(1, Math.floor(level / 2))} damage`,
            choice: { label: "Damage type", options: ["acid", "electricity", "piercing"] },
            change: { op: "effect", target: "source", effect: { generated: "metal-junction", name: "Metal Impulse Junction", duration: { kind: "source-turn", edge: "start" }, retaliation: { amount: Math.max(1, Math.floor(level / 2)), trigger: "touch-or-unarmed-or-nonreach-melee" } } } };
        case "water": return { element, label: "Water impulse junction: after the impulse, move one creature it targeted or affected 5 feet (10 feet in a body of water), if it's willing, failed its save, or you hit it", change: { op: "move", target: "chosen", kind: "shift", distance: 5, waterDistance: 10, eligible: ["willing", "failed-save", "hit"] } };
        case "air": return { element, label: "Air impulse junction: before or after the impulse, Stride up to half your Speed or Step (Fly up to half your fly Speed if you have one)", change: { op: "note", audience: "owner", text: "Stride up to half your Speed or Step (or Fly up to half your fly Speed), before or after the impulse." } };
        default: return null;
    }
}

/**
 * The critical blast junctions PF2e leaves to text (air push, earth prone or descent, wood roots, metal rust). Fire's persistent damage, metal's
 * bleed and water's splash are PF2e's own damage rules.
 * @param elements  the blast's element(s) (two with Two-Element Infusion)
 */
export function criticalBlastJunctions(elements, rollOptions, { targetMetal = false, targetGrounded = true } = {}) {
    const have = junctions(rollOptions).critical;
    const out = [];
    for (const element of elements ?? []) {
        if (!have.includes(element)) continue;
        if (element === "air") out.push({ element, label: "Critical blast (air): push the target up to 10 feet", change: { op: "move", target: "target", kind: "push", distance: 10, upTo: true } });
        else if (element === "earth") out.push(targetGrounded
            ? { element, label: "Critical blast (earth): the target is knocked prone", change: { op: "condition", target: "target", slug: "prone", value: null, duration: null } }
            : { element, label: "Critical blast (earth): the target descends up to 20 feet (you choose)", change: { op: "move", target: "target", kind: "descend", distance: 20, upTo: true } });
        else if (element === "wood") out.push({ element, label: "Critical blast (wood): roots immobilize the target if it's adjacent to a surface (Interact + DC 10 Athletics to pull free)",
            question: "Is the target adjacent to a surface (and not incorporeal or liquid)?",
            change: { op: "effect", target: "target", effect: { generated: "rooted", name: "Rooted (Critical Blast)", conditions: [{ slug: "immobilized", value: null }], duration: null, endsOn: ["check"], check: { statistic: "athletics", dc: 10, action: "Interact" } } } });
        else if (element === "metal" && targetMetal) out.push({ element, label: "Critical blast (metal): against a metal creature the persistent damage is rust (no type) instead of bleed", change: { op: "note", audience: "gm", text: "The metal target takes the 1d6 persistent damage as untyped rust damage instead of bleed." } });
    }
    return out;
}

/** Does using this plan end the kinetic aura? (The overflow trait, unless the text says otherwise.) */
export function overflowEndsAura(plan) {
    return Boolean(plan?.kineticist?.overflow);
}

/** A stance Effect's identity: PF2e's "Stance: …" Effects and the module's generated ones. */
export function isStanceEffect(item) {
    const name = String(item?.name ?? "");
    return item?.type === "effect" && (name.startsWith("Stance:") || Boolean(item?.flags?.["pf2e-automatic-kineticist-resolution"]?.stance));
}

/**
 * Matter Blast / Elemental Blast from a table read off the text, at a level: the dice (one die plus one every 4 levels), the damage types and
 * range of an element.
 */
export function blastProfile(table, element, level, { improved = null } = {}) {
    const row = (table ?? []).find(entry => entry.element === element);
    if (!row) return null;
    const faces = Number(/d(\d+)/.exec(row.die)?.[1]);
    const dice = improved ?? Math.max(1, 1 + Math.floor((level - 1) / 4));
    return { element, dice, faces, formula: `${dice}d${faces}`, damageTypes: row.damageTypes, range: row.range };
}

/** Two-Element Infusion: split a damage total in half by type (the odd point goes to the element the kineticist chooses). */
export function splitTwoElements(total, [first, second], higher = first) {
    const half = Math.floor(total / 2);
    const rest = total - half;
    return higher === first ? [{ type: first, amount: rest }, { type: second, amount: half }] : [{ type: first, amount: half }, { type: second, amount: rest }];
}

/** Impulse junction once-per-round key: the combat round (or the world time outside combat). */
export function roundKey(combat, worldTime) {
    return combat?.started ? `${combat.id}:${combat.round}` : `time:${Math.floor(Number(worldTime ?? 0) / 6)}`;
}
