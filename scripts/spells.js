// Impulses with a spell's effects ("This has the effects of Wall of Stone", "You gain the benefits of the Fiery Body spell", "as a Protector Tree
// spell of a rank equal to half your level rounded up"): the spell at rank ⌈level/2⌉, the kineticist's class DC for its saves. The spell module
// (pf2e-automatic-resolution) resolves it when it's active, through its public API — never by editing or wrapping it. Without it, the card links
// the spell with its rank and DC.
import { MODULE_ID, escapeHTML } from "./utils.js";

const SPELL_MODULE = "pf2e-automatic-resolution";

/** A spell document owned by the kineticist, at the impulse's rank (PF2e's variant for the rank). */
async function spellAt(uuid, actor, rank) {
    const spell = await fromUuid(uuid).catch(() => null);
    if (!spell) return null;
    const source = spell.toObject();
    source.system.location = { value: null, heightenedLevel: rank };
    const own = new CONFIG.Item.documentClass(source, { parent: actor });
    try { return own.loadVariant?.({ castRank: rank }) ?? own; } catch (_) { return own; }
}

/**
 * Cast a spell at a rank with a DC through the spell module (its route from api.diagnose), or post its link when the module isn't active.
 * Returns a log line.
 */
export async function castSpellAt(actor, { uuid, name, rank, dc, targets = [], note = "", shapeMessageId = null }) {
    const api = game.modules.get(SPELL_MODULE)?.active ? game.modules.get(SPELL_MODULE)?.api : null;
    const line = `${name} at rank ${rank}, DC ${dc}${note ? ` (${note})` : ""}.`;
    if (!api?.diagnose) {
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p>${escapeHTML(line)} @UUID[${uuid}]{${escapeHTML(name)}}</p>` });
        return `${line} (the spell module isn't active: resolve the spell by hand)`;
    }
    const spell = await spellAt(uuid, actor, rank);
    if (!spell) return `${name} couldn't be found.`;
    const diagnosis = await api.diagnose(spell).catch(() => ({ route: "none" }));
    const options = { castRank: rank, dc, sourceActor: actor, targets, plan: diagnosis.plan, ...(shapeMessageId ? { shapeMessageId } : {}) };
    try {
        if (diagnosis.route === "save") { await api.saves.start(spell, options); return `${line} The spell module opened its save card.`; }
        if (diagnosis.route === "effect") { await api.execute(spell, options); return `${line} The spell module applied it.`; }
        if (diagnosis.route === "form") { await api.forms?.start?.(spell, options); return `${line} The spell module applied the form.`; }
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p>${escapeHTML(line)} @UUID[${uuid}]{${escapeHTML(name)}}</p>` });
        return `${line} The spell module has no automatic route for it (${diagnosis.route}): resolve it from the spell's card.`;
    } catch (error) {
        console.error(`${MODULE_ID} | ${name}`, error);
        return `${line} The spell module couldn't resolve it: ${error.message}`;
    }
}

/** Resolve the spell-equivalent: returns log lines for the impulse card. */
export async function resolveSpellEquivalent(actor, plan, context, state) {
    const data = plan.resolution.spell;
    if (!data?.uuid) return [];
    const rank = data.rankChoice ? Math.min(data.rankChoice.max, Number(state.answers?.spellRank ?? data.rankChoice.max)) : data.rank;
    const api = game.modules.get(SPELL_MODULE)?.active ? game.modules.get(SPELL_MODULE)?.api : null;
    const targets = [...state.targets.filter(t => !t.excluded)].map(t => fromUuidSync(t.tokenUuid)?.object).filter(Boolean);
    const note = `${plan.source.name}: ${data.name} at rank ${rank}, class DC ${state.dc}${data.adjustments?.length ? ` (${data.adjustments.join(" ")})` : ""}.`;
    if (!api?.diagnose) {
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p>${escapeHTML(note)} @UUID[${data.uuid}]{${escapeHTML(data.name)}}</p>` });
        return [`${note} (the spell module isn't active: resolve the spell by hand)`];
    }
    const spell = await spellAt(data.uuid, actor, rank);
    if (!spell) return [`${data.name} couldn't be found.`];
    const diagnosis = await api.diagnose(spell).catch(error => ({ route: "none", error }));
    const options = { castRank: rank, dc: state.dc, sourceActor: actor, targets, plan: diagnosis.plan, ...(context.shapeMessageId ? { shapeMessageId: context.shapeMessageId } : {}) };
    try {
        switch (diagnosis.route) {
            case "save": await api.saves.start(spell, options); return [`${note} The spell module opened its save card.`];
            case "effect": await api.execute(spell, options); return [`${note} The spell module applied it.`];
            case "form": await api.forms?.start?.(spell, options); return [`${note} The spell module applied the form.`];
            default:
                await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p>${escapeHTML(note)} @UUID[${data.uuid}]{${escapeHTML(data.name)}}</p>`, flags: { [MODULE_ID]: { spellEquivalent: { uuid: data.uuid, rank, dc: state.dc } } } });
                return [`${note} The spell module has no automatic route for it (${diagnosis.route}): resolve it from the spell's card.`];
        }
    } catch (error) {
        console.error(`${MODULE_ID} | ${data.name}`, error);
        return [`${note} The spell module couldn't resolve it: ${error.message}`];
    }
}
