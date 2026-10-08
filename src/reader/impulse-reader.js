// The impulse reader: a Kineticist impulse's TEXT → a resolution plan (shared plan model version 13, docs/plan-format.md).
// Each sentence is read by the forms in ./forms.js; a sentence no form reads stays on the plan as a GM note (automation "guided").
// Rules come from the text, never from names. Pure: no Foundry.
import { paragraphs, sentences, inlineTags, readDamage, readCheck, readTemplate, readUuid, readable } from "./text.js";
import { DEGREE_LABELS, conditionFromLabel } from "./phrases.js";
import { FORMS, OPTION_FORMS, readDegreeEntry, finishPlan, areaOf } from "./forms.js";
import { MORE_FORMS, MORE_OPTION_FORMS } from "./forms-impulses.js";

const ALL_FORMS = [FORMS[0], ...MORE_FORMS, ...FORMS.slice(1)];
const ALL_OPTION_FORMS = [...MORE_OPTION_FORMS, ...OPTION_FORMS];

export const READER_VERSION = "0.1.0";

/** Tokenize a sentence: each inline tag → "⟦n⟧", its parsed data in `tags[n]` (shared across the impulse). */
export function tokenize(text, tags, level, data) {
    let out = "", at = 0;
    for (const tag of inlineTags(text)) {
        out += text.slice(at, tag.start);
        tags.push(parseTag(tag, level, data));
        out += `⟦${tags.length - 1}⟧`;
        at = tag.end;
    }
    return out + text.slice(at);
}

function parseTag(tag, level, data) {
    const base = { kind: tag.kind, label: tag.label, raw: tag.raw, body: tag.body };
    if (tag.kind === "damage") return { ...base, ...(readDamage(tag.body, level, data) ?? { components: null, options: [] }) };
    if (tag.kind === "check") return { ...base, ...readCheck(tag.body) };
    if (tag.kind === "template") return { ...base, ...readTemplate(tag.body) };
    if (tag.kind === "uuid") {
        const uuid = readUuid(tag.body);
        return { ...base, ...uuid, condition: uuid.pack === "conditionitems" ? conditionFromLabel(tag.label ?? "") : null };
    }
    return base;
}

/** "Level (+2)" / "Level (6th)" entries: { step, at, text, active } at the kineticist's level. */
function readLevelEntry(line, itemLevel, level) {
    const m = /^Level \((?:\+(\d+)|(\d+)(?:st|nd|rd|th))\)\s*(.*)$/.exec(line);
    if (!m) return null;
    if (m[1]) {
        const step = Number(m[1]);
        const times = Math.max(0, Math.floor((level - Math.max(1, itemLevel)) / step));
        return { step, at: null, text: m[3], active: times > 0, times };
    }
    const at = Number(m[2]);
    return { step: null, at, text: m[3], active: level >= at, times: level >= at ? 1 : 0 };
}

/**
 * Read an impulse.
 * @param {object} source  the item's source data (PF2e feat or action)
 * @param {object} options { level: the kineticist's level (default: the item's level), data: extra roll data for "@actor.flags…" }
 */
export function readImpulse(source, { level = null, data = {} } = {}) {
    const system = source?.system ?? {};
    const itemLevel = Number(system.level?.value ?? 1) || 1;
    const atLevel = Math.max(1, Number(level ?? itemLevel) || 1);
    const traits = [...(system.traits?.value ?? [])];
    const actionType = system.actionType?.value ?? "action";
    const actions = system.actions?.value ?? null;
    const plan = basePlan(source, { atLevel, itemLevel, traits, actionType, actions });
    const tags = [];
    const context = { plan, tags, level: atLevel, itemLevel, data, degreeMode: false, lastSave: null, modes: null, currentMode: null, effectLinks: [], sentenceIndex: 0, section: null };
    // (PF2e's self-effect: the Effect or Stance the action's card applies — linked like a "@UUID[…]{Effect: …}" line.)
    if (system.selfEffect?.uuid) { plan.selfEffect = { uuid: system.selfEffect.uuid, name: system.selfEffect.name ?? null }; context.effectLinks.push({ uuid: system.selfEffect.uuid, name: system.selfEffect.name ?? "", self: true }); }

    const lines = paragraphs(system.description?.value ?? "");
    for (const line of lines) {
        // ("1 or 2" / "R or 2": the action-count line Elemental Blast and Body of Air print.)
        if (/^(?:\d|R) or \d$/.test(line)) { plan.activation.variableActions = line; continue; }
        const levelEntry = readLevelEntry(line, itemLevel, atLevel);
        if (levelEntry) { plan.levelEntries.push(levelEntry); continue; }
        const trigger = /^Trigger (.+)$/.exec(line);
        if (trigger) { plan.trigger.raw = trigger[1]; plan.trigger.event = "reaction"; continue; }
        const requirement = /^Requirements? (.+)$/.exec(line);
        if (requirement) { plan.activation.requirements = requirement[1]; continue; }
        const frequency = /^Frequency (.+)$/.exec(line);
        if (frequency) { plan.trigger.frequency = { raw: frequency[1] }; continue; }
        // (A standalone link to PF2e's Effect: "@UUID[…feat-effects…]{Effect: Ocean's Balm}".)
        const lone = /^@UUID\[(Compendium\.pf2e\.(?:feat-effects|equipment-effects|spell-effects)\.Item\.[A-Za-z0-9]+)\]\{([^}]+)\}$/.exec(line);
        if (lone) { if (!context.effectLinks.some(link => link.uuid === lone[1])) context.effectLinks.push({ uuid: lone[1], name: lone[2] }); continue; }
        const tokenLine = tokenize(line, tags, atLevel, data);
        // (Degree entries: "Critical Success The creature is unaffected." — one per paragraph, or run together in one.)
        const degree = /^(Critical Success|Success|Failure|Critical Failure) (.+)$/.exec(tokenLine);
        if (degree) {
            const entries = tokenLine.split(/(?<![Cc]ritical) (?=(?:Critical Success|Success|Failure|Critical Failure) [A-Z])/);
            for (const entry of entries) {
                const m = /^(Critical Success|Success|Failure|Critical Failure) (.+)$/.exec(entry);
                if (!m || !readDegreeEntry(DEGREE_LABELS[m[1]], m[2], context)) note(plan, readable(untokenize(entry, tags), atLevel, data), "degree");
                else plan.automation.claimed.push(entry);
            }
            continue;
        }
        // (Option entries: "Shards Shards deal …", "Spring Each ally …", "Air 1d6 electricity or slashing, 60 feet".)
        if (readOption(tokenLine, context)) continue;
        for (const sentence of sentences(tokenLine)) readSentence(sentence, context);
    }
    finishPlan(context);
    return plan;
}

function readOption(line, context) {
    context.modes ??= [];
    for (const [pattern, make] of ALL_OPTION_FORMS) {
        const m = pattern.exec(line);
        if (!m) continue;
        if (make(m, context) === false) continue;
        context.plan.automation.claimed.push(line);
        return true;
    }
    return false;
}

function readSentence(sentence, context) {
    const { plan } = context;
    // (The description's opening sentence is usually flavor: claimed when it holds no tag, number or rules word.)
    const first = context.sentenceIndex++ === 0;
    if (first && isOpening(sentence)) { plan.automation.claimed.push(sentence); return true; }
    for (const [pattern, make] of ALL_FORMS) {
        const m = pattern.exec(sentence);
        if (!m) continue;
        const made = make(m, context, sentence);
        if (made === false) continue;
        plan.automation.claimed.push(sentence);
        // (A template in a claimed sentence — "Creatures in a ⟦30-foot cone⟧ take …" — is the impulse's area when none is set.)
        if (!plan.targeting.area && !context.currentMode) {
            const template = [...sentence.matchAll(/⟦(\d+)⟧/g)].map(x => context.tags[Number(x[1])]).find(t => t?.kind === "template");
            if (template) plan.targeting.area = { ...areaOf(template), ...(/within (\d+) feet/.exec(sentence) ? { within: Number(/within (\d+) feet/.exec(sentence)[1]) } : {}) };
        }
        return true;
    }
    note(plan, readable(untokenize(sentence, context.tags), context.level, context.data), "body");
    plan.automation.unclaimed.push(sentence);
    return false;
}

const OPENING_BLOCK = /⟦|\d|\bsave\b|damage|\bDC\b|Speed|bonus|penalty|resistance|immune|Hit Points|\bHP\b|Sustain|Dismiss|Stride|Strike|Target|target |within|lasts|until|\bregains?\b|\bheal(?:s|ing)?\b(?! a creature)|difficult|hazardous|\bChoose\b/;
const isOpening = sentence => !OPENING_BLOCK.test(sentence) || /^A small cloud of medicinal herbs heal a creature\.$/.test(sentence);

export function untokenize(text, tags) {
    return text.replace(/⟦(\d+)⟧/g, (_, i) => tags[Number(i)]?.raw ?? "");
}

function note(plan, text, where) {
    plan.resolution.notes.push({ text, where, audience: "gm" });
}

function basePlan(source, { atLevel, itemLevel, traits, actionType, actions }) {
    const time = actionType === "reaction" ? "reaction" : actionType === "free" ? "free" : actionType === "passive" ? null : String(actions ?? 1);
    return {
        modelVersion: 13,
        reader: { id: "kineticist-impulse", version: READER_VERSION },
        source: {
            documentType: "Item",
            itemType: source?.type ?? null,
            id: source?._id ?? null,
            uuid: source?.uuid ?? null,
            name: source?.name ?? "",
            slug: source?.system?.slug ?? slugify(source?.name ?? ""),
            image: source?.img ?? null,
            publication: source?.system?.publication ?? null,
            family: "kineticist"
        },
        level: atLevel,
        itemLevel,
        rank: Math.ceil(atLevel / 2),
        traits,
        activation: { time, traits, requirements: source?.system?.requirements || null, cost: null, variableActions: null },
        targeting: { target: null, range: null, area: null, areaChoices: null, who: null, actorConstraints: { predicates: [] } },
        trigger: { event: actionType === "reaction" ? "reaction" : "use", timing: "manual-confirmation", raw: source?.system?.trigger || null, frequency: null, immunity: null },
        decisionWindows: { beforeRoll: true, nativeRollDialog: true, provisionalResult: true, rerollBeforeApplication: "replace", rerollAfterApplication: "manual-review", applicationRequiresConfirmation: true },
        lifecycle: { duration: null, sustained: null, dismissable: false, stance: traits.includes("stance"), endsWithAura: traits.includes("stance"), replacesPrevious: false, ends: [] },
        resolution: {
            kind: "note",
            check: null,
            sharedDamage: null,
            outcomes: null,
            attack: null,
            healing: null,
            effects: [],
            terrain: null,
            creations: [],
            movement: null,
            spell: null,
            modes: null,
            aura: null,
            reaction: null,
            riders: [],
            immunity: null,
            notes: []
        },
        kineticist: {
            overflow: traits.includes("overflow"),
            composite: traits.includes("composite"),
            stance: traits.includes("stance"),
            elements: traits.filter(trait => ["air", "earth", "fire", "metal", "water", "wood"].includes(trait)),
            actions: time,
            impulseJunction: ["2", "3"].includes(time)
        },
        levelEntries: [],
        automation: { level: "automatic", claimed: [], unclaimed: [], pendingCapabilities: [] },
        diagnostics: []
    };
}

export const slugify = name => String(name).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
