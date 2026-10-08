// Kineticist items: the gate attenuator's once-a-day "Elemental Spell" (its item bonus to impulse attack rolls is PF2e's own rule). A button on the
// item's chat card: the attuned element (remembered on the item), the item's spell at its rank, and its spell DC — or the kineticist's impulse DC
// (and attack modifier) when the element is one of its kinetic elements and that's better. Cast through the spell module.
import { MODULE_ID, escapeHTML, notifyError, classDC } from "./utils.js";
import { readElementalSpellActivation, elementalSpellStatistics } from "../src/reader/items.js";
import { castSpellAt } from "./spells.js";
import { ELEMENTS } from "../src/core/kineticist.js";

const today = () => Math.floor(Number(game.time.worldTime ?? 0) / 86400);

export function addItemButtons(message, html, item) {
    if (!item || item.type !== "equipment") return;
    const activation = readElementalSpellActivation(item);
    if (!activation) return;
    const actor = item.actor;
    if (!actor || !(game.user.isGM || actor.isOwner)) return;
    const root = html.querySelector?.(".message-content") ?? html;
    if (root.querySelector(".pf2e-kin-item")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pf2e-kin-item pf2e-kin-resolve";
    button.textContent = `${activation.label} (${activation.frequency})`;
    (root.querySelector(".card-buttons") ?? root).appendChild(button);
    button.addEventListener("click", async () => {
        button.disabled = true;
        try { await castElementalSpell(item, activation); } catch (error) { notifyError(item.name, error); } finally { button.disabled = false; }
    });
}

/** Cast it (the dialogs ask for the element and confirm a second use; `element` presets the first, `force` skips the second, for scripted runs). */
export async function castElementalSpell(item, activation = readElementalSpellActivation(item), { element: preset = null, force = false } = {}) {
    const actor = item.actor;
    const flags = item.flags?.[MODULE_ID] ?? {};
    if (flags.elementalSpellDay === today() && !force) {
        const again = await foundry.applications.api.DialogV2.confirm({ window: { title: item.name }, content: `<p>${escapeHTML(activation.label)} was already used today (${escapeHTML(activation.frequency)}). Use it anyway?</p>` });
        if (!again) return;
    }
    const element = preset ?? await foundry.applications.api.DialogV2.wait({ window: { title: `${item.name}: attuned element` }, content: "<p>The element the attenuator is attuned to:</p>",
        buttons: ELEMENTS.map(entry => ({ action: entry, label: `${entry}: ${activation.spells[entry].name}`, default: entry === flags.attunedElement })), rejectClose: false, close: () => null });
    if (!element) return;
    const kineticElements = (actor.flags?.system?.kineticist?.elements ?? []).map(entry => entry?.value ?? entry);
    const impulse = actor.getStatistic?.("impulse");
    const stats = elementalSpellStatistics(activation, element, { kineticElements, impulseAttack: impulse?.check?.mod ?? null, impulseDc: impulse?.dc?.value ?? classDC(actor) });
    const spell = activation.spells[element];
    await item.update({ [`flags.${MODULE_ID}.attunedElement`]: element, [`flags.${MODULE_ID}.elementalSpellDay`]: today() });
    const note = `spell attack +${stats.attack}${stats.usesImpulse.dc || stats.usesImpulse.attack ? ", the kineticist's impulse statistics" : ", the item's statistics"}; it gains the ${element} trait`;
    const line = await castSpellAt(actor, { uuid: spell.uuid, name: spell.name, rank: activation.rank, dc: stats.dc, targets: [...game.user.targets], note });
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p><strong>${escapeHTML(item.name)}</strong> — ${escapeHTML(activation.label)}: ${escapeHTML(line)}</p>` });
    return { element, stats, line };
}
