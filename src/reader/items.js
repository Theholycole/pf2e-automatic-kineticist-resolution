// Kineticist items read from their text. PF2e 8.5 has one: the gate attenuator (three grades). Its item bonus to impulse attack rolls is PF2e's own
// rule (selector impulse-attack-roll, which the impulse statistic rolls with); its once-a-day "Elemental Spell" activation is read here:
// "casts a 1st-rank spell, with a spell attack modifier of +7 and spell DC of 17. If you're a kineticist and the spell's element matches one of your
// kinetic elements, you can use your impulse attack modifier instead … or your impulse DC instead of the spell DC. … air @UUID[…]{Gust of Wind} …"
import { paragraphs } from "./text.js";
import { ELEMENTS } from "./phrases.js";

/** An item's elemental-spell activation, or null: { label, actions, frequency, rank, attack, dc, kineticistSubstitute, spells: { element: { uuid, name } } }. */
export function readElementalSpellActivation(source) {
    const text = paragraphs(source?.system?.description?.value ?? "").join(" ");
    const m = /Activate\s*-\s*([A-Z][\w ]+?) (\d) \(([^)]*)\) Frequency (once per [a-z]+) Effect The [\w ]+? casts an? (\d+)(?:st|nd|rd|th)-rank spell, with a spell attack modifier of \+(\d+) and (?:a )?spell DC of (\d+)\.\s*(If you're a kineticist and the spell's element matches one of your kinetic elements, you can use your impulse attack modifier instead of the spell attack modifier or your impulse DC instead of the spell DC\.)?\s*The spell corresponds to the element the item is attuned to, and it gains that element's trait if it doesn't already have it: (.+)$/.exec(text);
    if (!m) return null;
    const spells = {};
    const list = /((?:air|earth|fire|metal|water|wood) @UUID\[[^\]]+\]\{[^}]+\}\s*)+/.exec(m[9])?.[0] ?? "";
    for (const entry of list.matchAll(/(air|earth|fire|metal|water|wood) @UUID\[([^\]]+)\]\{([^}]+)\}/g)) spells[entry[1]] = { uuid: entry[2], name: entry[3] };
    if (!ELEMENTS.every(element => spells[element])) return null;
    return { label: m[1].trim(), actions: m[2], traits: m[3].split(/,\s*/), frequency: m[4], rank: Number(m[5]), attack: Number(m[6]), dc: Number(m[7]), kineticistSubstitute: Boolean(m[8]), spells };
}

/**
 * The statistics the cast uses: the item's, or — for a kineticist whose kinetic elements include the spell's — its impulse attack modifier and DC
 * when they're higher ("you can use": the better one is offered).
 */
export function elementalSpellStatistics(activation, element, { kineticElements = [], impulseAttack = null, impulseDc = null } = {}) {
    const matches = activation.kineticistSubstitute && kineticElements.includes(element);
    const attack = matches && Number.isFinite(impulseAttack) ? Math.max(activation.attack, impulseAttack) : activation.attack;
    const dc = matches && Number.isFinite(impulseDc) ? Math.max(activation.dc, impulseDc) : activation.dc;
    return { attack, dc, usesImpulse: { attack: attack !== activation.attack, dc: dc !== activation.dc } };
}
