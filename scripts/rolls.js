// Impulse damage and healing rolls through PF2e's own inline @Damage path, so the kineticist's modifiers apply (the fire impulse junction's die
// step, Desert Wind, Consume Power, Ignite the Sun…). Falls back to a plain DamageRoll of the plan's formula at the kineticist's level.
import { MODULE_ID, escapeHTML, DamageRollClass, componentsFormula } from "./utils.js";

/** Wait for the next PF2e damage-roll message from an actor (posted by PF2e's inline roll). */
function nextDamageMessage(actor, timeout = 15000) {
    return new Promise(resolve => {
        const hook = Hooks.on("createChatMessage", message => {
            if (message.flags?.pf2e?.context?.type !== "damage-roll") return;
            if (message.speaker?.actor !== actor.id && message.actor?.uuid !== actor.uuid) return;
            Hooks.off("createChatMessage", hook);
            clearTimeout(timer);
            resolve(message);
        });
        const timer = setTimeout(() => { Hooks.off("createChatMessage", hook); resolve(null); }, timeout);
    });
}

/** Roll the impulse's @Damage tag as PF2e does when its link is clicked. Returns the evaluated roll, or null when PF2e didn't post one. */
async function rollThroughPF2e({ actor, item, raw }) {
    const editor = game.pf2e?.TextEditor;
    if (!editor?.enrichHTML || !editor._onClickInlineRoll || !item?.uuid || !raw) return null;
    const html = await editor.enrichHTML(`@Damage[${raw}]`, { rollData: item.getRollData?.() ?? actor.getRollData(), relativeTo: item });
    const wrapper = document.createElement("div");
    wrapper.dataset.itemUuid = item.uuid;
    wrapper.style.display = "none";
    wrapper.innerHTML = html;
    document.body.appendChild(wrapper);
    try {
        const anchor = wrapper.querySelector("a.inline-roll[data-damage-roll], a[data-damage-roll], a.inline-roll");
        if (!anchor) return null;
        const waiting = nextDamageMessage(actor);
        // (Shift-click: PF2e's "skip the dialog" toggle, as with its own buttons.)
        await editor._onClickInlineRoll({ target: anchor, currentTarget: anchor, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, button: 0, preventDefault() {}, stopPropagation() {} });
        const message = await waiting;
        return message?.rolls?.[0] ?? null;
    } finally {
        wrapper.remove();
    }
}

/**
 * The impulse's damage (or healing) roll. `components` come from the plan at the kineticist's level; `raw` (the @Damage body) lets PF2e build it.
 * Returns an evaluated DamageRoll.
 */
export async function rollImpulseDamage({ actor, item, components, plan, label = "Damage", raw = null }) {
    const body = raw ?? plan?.resolution?.sharedDamage?.raw ?? null;
    const sameComponents = plan?.resolution?.sharedDamage?.components === components || plan?.resolution?.healing?.components === components;
    const healingRaw = plan?.resolution?.healing?.components === components ? plan.resolution.healing.raw : null;
    try {
        const native = await rollThroughPF2e({ actor, item, raw: raw ?? (sameComponents ? healingRaw ?? body : null) });
        if (native) return native;
    } catch (error) {
        console.warn(`${MODULE_ID} | PF2e's inline damage couldn't be used; rolling the formula.`, error);
    }
    const formula = componentsFormula(components);
    const DamageRoll = DamageRollClass();
    const roll = await new DamageRoll(formula, actor?.getRollData?.() ?? {}).evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `<strong>${escapeHTML(item?.name ?? plan?.source?.name ?? "")}</strong>: ${escapeHTML(label)}` });
    return roll;
}
