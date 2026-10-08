// Shared phrase readers: durations, conditions, distances, creature sets. Pure.

export const DEGREES = Object.freeze(["criticalSuccess", "success", "failure", "criticalFailure"]);
export const DEGREE_LABELS = Object.freeze({ "Critical Success": "criticalSuccess", Success: "success", Failure: "failure", "Critical Failure": "criticalFailure" });
export const ELEMENTS = Object.freeze(["air", "earth", "fire", "metal", "water", "wood"]);
export const VALUED = new Set(["clumsy", "doomed", "drained", "dying", "enfeebled", "frightened", "sickened", "slowed", "stunned", "stupefied", "wounded"]);

const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10 };
export const number = word => /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[String(word).toLowerCase()] ?? null;

/** A condition from its link label: "Clumsy 1" → { slug: "clumsy", value: 1 }; "Off-Guard" → { slug: "off-guard", value: null }. */
export function conditionFromLabel(label) {
    const m = /^([A-Za-z-]+(?: [A-Za-z-]+)?)(?: (\d+))?$/.exec(String(label).trim());
    if (!m) return null;
    const slug = m[1].toLowerCase().replace(/\s+/g, "-");
    return { slug, value: m[2] ? Number(m[2]) : VALUED.has(slug) ? 1 : null };
}

/**
 * A duration phrase → { kind, … } or null:
 *   until the start/end of your next turn → { kind: "source-turn", edge: "start"|"end" }
 *   until the end of its next turn → { kind: "target-turn", edge: "end" }
 *   for N rounds/minutes/hours → { kind: "time", rounds }
 *   for as long as you Sustain … / while … remains → { kind: "impulse" }
 *   as long as it remains in the area → { kind: "area" }
 *   until it Escapes → { kind: "escape" }
 */
export function readDuration(phrase) {
    const text = String(phrase ?? "").trim().replace(/[.,;]$/, "");
    let m;
    if ((m = /^until the (start|end) of your next turn$/i.exec(text))) return { kind: "source-turn", edge: m[1].toLowerCase() };
    if ((m = /^until the (start|end) of (?:its|their|the creature's|the target's) next turn$/i.exec(text))) return { kind: "target-turn", edge: m[1].toLowerCase() };
    if ((m = /^until the end of your turn$/i.exec(text))) return { kind: "source-turn", edge: "end", current: true };
    if ((m = /^(?:for )?(\d+|one|a|an|ten) (round|minute|hour|day)s?$/i.exec(text))) return { kind: "time", rounds: number(m[1]) * { round: 1, minute: 10, hour: 600, day: 14400 }[m[2].toLowerCase()] };
    if (/^(?:for )?as long as (?:it|the creature) remains in the area$/i.test(text)) return { kind: "area" };
    if (/^(?:for )?as long as (?:the willow remains|you Sustain the (?:effect|impulse)|the impulse lasts)$/i.test(text)) return { kind: "impulse" };
    if (/^until it Escapes$/i.test(text)) return { kind: "escape" };
    if (/^until it's no longer sickened$/i.test(text)) return { kind: "linked", to: "sickened" };
    return null;
}

/** Feet in "30 feet", "a 30-foot", "60-foot": a number or null. */
export function feet(text) {
    const m = /(\d+)(?:-foot| feet| foot)/.exec(String(text));
    return m ? Number(m[1]) : null;
}

/** Round "half your level rounded up" style values. */
export const halfLevelUp = level => Math.ceil(level / 2);
