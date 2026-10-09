// Impulses counting as spells (the "Impulses count as Strikes and spells" option): the spell module's casting rules, through its public
// api.castingRules.onSpellLike (2026-10-08). Counterspell offers, the casting conditions (castConditions: true; Stupefied stays this module's),
// and spellshapes, whose riders this module applies to its own rolls: extra and flat damage, persistent damage, the type swap, a grown area.
// Never touches the spell module's code: its API only.
import { MODULE_ID, escapeHTML } from "./utils.js";

const SPELL_MODULE = "pf2e-automatic-resolution";
const api = () => (game.modules.get(SPELL_MODULE)?.active ? game.modules.get(SPELL_MODULE)?.api : null);
export const spellLikeAvailable = () => typeof api()?.castingRules?.onSpellLike === "function";

/** The descriptor the spell module checks spellshape requirements and counteracts against. */
export function describe(state, actor) {
    const plan = state.plan;
    const r = plan.resolution;
    const components = r.sharedDamage?.components ?? [];
    const area = plan.targeting.areaChoices?.[state.areaChoice ?? 0] ?? plan.targeting.area ?? null;
    return {
        actor, name: state.itemName, slug: plan.source.slug,
        traits: [...new Set([...(plan.traits ?? []), "impulse", "primal"])], elements: plan.kineticist.elements ?? [],
        rank: plan.rank, level: plan.level, actions: Number(plan.activation.time) || 2,
        damageTypes: [...new Set(components.filter(c => !c.healing).map(c => c.type).filter(Boolean))],
        area: area ? { type: area.type, value: area.value } : null,
        range: plan.targeting.range?.feet ? `${plan.targeting.range.feet} feet` : area?.within ? `${area.within} feet` : plan.targeting.target?.range ? `${plan.targeting.target.range} feet` : "",
        target: plan.targeting.who === "targets" ? `${plan.targeting.maxTargets ?? plan.targeting.target?.count ?? 1} creature${(plan.targeting.maxTargets ?? 1) > 1 ? "s" : ""}` : "",
        targets: state.targets.filter(t => !t.excluded).map(t => t.tokenUuid),
        saveStatistic: r.check?.statistic ?? null, attack: Boolean(r.attack), dc: state.dc, cantrip: false,
        itemUuid: state.itemUuid, sourceTokenUuid: state.sourceTokenUuid, castConditions: true
    };
}

/** Run the spell module's casting rules on a card (active GM, right after the card is created). Returns a summary for the card. */
export async function castAsSpell(message, state, actor) {
    if (!spellLikeAvailable()) return { unavailable: true };
    const result = await api().castingRules.onSpellLike(message, describe(state, actor));
    return summarize(message.id, result);
}

/** For PF2e's own 2-action Elemental Blast: its attack message counts as the cast. */
export async function blastAsSpell(message, actor, { element, damageType, dc, rank, level, targetTokenUuid }) {
    if (!spellLikeAvailable()) return null;
    const result = await api().castingRules.onSpellLike(message, {
        actor, name: "Elemental Blast", slug: "elemental-blast", traits: ["impulse", "kineticist", "primal", "attack", element].filter(Boolean), elements: [element].filter(Boolean),
        rank, level, actions: 2, damageTypes: [damageType].filter(Boolean), area: null, range: "30 feet", target: "1 creature", targets: [targetTokenUuid].filter(Boolean),
        saveStatistic: null, attack: true, dc, cantrip: false, itemUuid: actor.itemTypes.action.find(i => i.slug === "elemental-blast")?.uuid ?? null,
        sourceTokenUuid: actor.getActiveTokens(true, true)[0]?.uuid ?? null, castConditions: true
    });
    return summarize(message.id, result);
}

function summarize(messageId, result) {
    const riders = api()?.spellshapes?.riders?.(messageId) ?? [];
    return {
        shapes: (result?.shapes ?? []).map(shape => shape.name ?? shape),
        rules: (result?.rules ?? []).map(rule => rule.name ?? rule.rule ?? rule),
        lost: result?.lost ?? null,
        targetMisses: result?.targetMisses ?? [],
        riders: riders.map(entry => ({ name: entry.name, types: (entry.riders ?? []).map(rider => rider.type) })),
        typeSwap: api()?.spellshapes?.typeSwap?.(messageId) ?? null,
        area: api()?.spellshapes?.area?.(messageId) ?? null
    };
}

/** Was the cast lost (countered, or a casting condition's flat check failed)? Checked again at Apply time: an offer can be answered later. */
export function spellLost(message) {
    return message?.getFlag?.(SPELL_MODULE, "spellLost") ?? null;
}

/**
 * The spellshape riders that change this module's own damage roll: extra damage, flat damage, persistent damage as extra components, and the
 * type swap applied to the impulse's components. "rank" formulas are the card's rank.
 */
export function shapedComponents(messageId, components, rank) {
    const riders = (api()?.spellshapes?.riders?.(messageId) ?? []).flatMap(entry => (entry.riders ?? []).map(rider => ({ ...rider, from: entry.name })));
    const formula = value => String(value ?? "").replace(/\brank\b/g, String(rank));
    const swap = api()?.spellshapes?.typeSwap?.(messageId) ?? null;
    let out = components.map(component => (swap && (swap.from ?? []).includes(component.type) ? { ...component, type: swap.to } : { ...component }));
    const firstType = out.find(component => !component.healing)?.type ?? "untyped";
    const notes = [];
    for (const rider of riders) {
        if (rider.type === "extra-damage" && rider.formula) out.push({ formula: formula(rider.formula), type: rider.damageType ?? firstType, category: null, healing: false, from: rider.from });
        else if (rider.type === "flat-damage" && rider.formula && rider.when !== "damaged") out.push({ formula: formula(rider.formula), type: rider.damageType ?? firstType, category: null, healing: false, from: rider.from });
        else if (rider.type === "persistent" && rider.formula) out.push({ formula: formula(rider.formula), type: rider.damageType ?? firstType, category: "persistent", healing: false, from: rider.from });
        else if (rider.type === "ignore-resistance") notes.push(`${rider.from}: the damage ignores ${rider.value} resistance${rider.types?.length ? ` (${rider.types.join(", ")})` : ""} — the GM lowers it`);
        else if (rider.type === "reroll-ones") notes.push(`${rider.from}: reroll damage dice that roll a 1`);
        else if (rider.type === "attack-crit") notes.push(`${rider.from}: on a critical hit, the target attempts a ${rider.save?.statistic ?? ""} save (DC ${rider.save?.dc ?? "?"}) or is pushed ${rider.failure?.push ?? "?"} feet`);
        else if (!["damage-type", "attack-defense", "spellstrike", "strike-dice"].includes(rider.type)) notes.push(`${rider.from}: ${rider.type}`);
    }
    if (swap) notes.unshift(`${swap.label ?? "Type swap"}: ${(swap.from ?? []).join("/")} → ${swap.to}`);
    return { components: out, changed: out.length !== components.length || Boolean(swap), notes };
}

/** A GM card for a 2-action blast's spellshapes (PF2e rolls the blast's damage itself: the riders are listed to add). */
export async function blastShapingCard(actor, summary) {
    if (!summary || (!summary.shapes.length && !summary.lost && !summary.rules.length)) return;
    const lines = [
        summary.lost ? `The blast is lost: ${summary.lost.reason ?? summary.lost}.` : null,
        summary.shapes.length ? `Spellshapes: ${summary.shapes.join(", ")}.` : null,
        summary.riders.length ? `Riders to add to its damage: ${summary.riders.map(entry => `${entry.name} (${entry.types.join(", ")})`).join("; ")}.` : null,
        summary.typeSwap ? `Damage type: ${(summary.typeSwap.from ?? []).join("/")} → ${summary.typeSwap.to}.` : null
    ].filter(Boolean);
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: ChatMessage.getWhisperRecipients("GM").map(user => user.id),
        content: `<p><strong>Elemental Blast (2 actions, counts as a spell)</strong></p>${lines.map(line => `<p>${escapeHTML(line)}</p>`).join("")}` });
}

/** Shadow Signet-style riders: the impulse attack goes against a save DC instead of AC ({ choice: ["fortitude", "reflex"] }), or null. */
export function attackDefense(messageId) {
    const rider = (api()?.spellshapes?.riders?.(messageId) ?? []).flatMap(entry => entry.riders ?? []).find(entry => entry.type === "attack-defense");
    return rider?.choice ?? null;
}

/** Extra components as a raw @Damage body PF2e rolls (the type swap applied to the impulse's own body). */
export function shapedRaw(raw, shaped, original) {
    if (!raw) return null;
    let body = raw.split("|")[0];
    const options = raw.includes("|") ? raw.slice(raw.indexOf("|")) : "";
    for (const component of shaped.components) {
        const was = original.find(entry => entry.formula === component.formula && entry.category === component.category);
        if (was && was.type !== component.type) body = body.replace(new RegExp(`([\\[,])${was.type}\\]`, "g"), `$1${component.type}]`);
    }
    const extras = shaped.components.filter(component => component.from).map(component => `${component.formula}[${[component.category, component.type].filter(Boolean).join(",")}]`);
    return `${[body, ...extras].join(",")}${options}`;
}

/**
 * What the spell module recorded on a card (read live from its flags each time: a copy on this module's card could be overwritten by its own
 * writes): { active, shapes, lost, targetMisses }.
 */
export function spellLikeView(message) {
    const flags = message?.flags?.[SPELL_MODULE] ?? {};
    if (!flags.spellLike) return null;
    const misses = flags.castingRules?.targetMisses ?? flags.targetMisses ?? [];
    return {
        active: true,
        shapes: (flags.shaping?.shapes ?? []).map(shape => shape.name ?? shape),
        lost: flags.spellLost ?? null,
        targetMisses: Array.isArray(misses) ? misses : Object.keys(misses ?? {}),
        area: api()?.spellshapes?.area?.(message.id) ?? null
    };
}
