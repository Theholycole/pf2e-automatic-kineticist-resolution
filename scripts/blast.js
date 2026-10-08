// Blasts. PF2e rolls Elemental Blast itself; the module adds:
//   - impulses built on a blast (Lightning Rod's extra damage and rod, Liberating Dive's 1-action blast): the card reads PF2e's blast result
//   - critical blast junctions PF2e leaves to text (air push, earth prone, wood roots, metal rust), offered on a critical hit
//   - infusions: Chain Infusion (blast again from the target; damage rolled once), Two-Element Infusion (half each type), Pacifying Infusion
//     (nonlethal; Safe Elements' creatures excluded)
//   - Matter Blast (Alchemists+ Chrysopoet): the module's own impulse attack from the element table read off its text
import { MODULE_ID, escapeHTML, isActiveGM, notifyError, degreeKey, DamageRollClass, classDC, tokenOf } from "./utils.js";
import { criticalBlastJunctions, splitTwoElements, blastProfile, ELEMENTS } from "../src/core/kineticist.js";
import { applyChanges } from "./apply.js";

const ATTACK_LABEL = { criticalSuccess: "Critical Hit", success: "Hit", failure: "Miss", criticalFailure: "Critical Miss" };

/** The latest PF2e Elemental Blast attack by an actor after a time (Lightning Rod and Liberating Dive read their blast from it). */
function latestBlast(actor, after) {
    return game.messages.contents.filter(message => message.flags?.pf2e?.context?.type === "attack-roll" && (message.flags.pf2e.context.options ?? []).includes("action:elemental-blast")
        && (message.speaker?.actor === actor.id || message.actor?.id === actor.id) && Number(message.timestamp ?? 0) >= after).at(-1) ?? null;
}

export function renderBlast(message, state, { owner, locked }) {
    const blast = state.plan.resolution.blast;
    if (!blast) return "";
    if (blast.native) return `<p><em>Elemental Blast is PF2e's: use it from the character sheet's Elemental Blast panel.</em></p>`;
    if (blast.elements && !blast.native) {
        const actor = fromUuidSync(state.sourceActorUuid);
        const element = state.answers.element ?? blast.elements[0].element;
        const profile = blastProfile(blast.elements, element, state.level);
        return `<div class="pf2e-kin-blast"><p>Element: ${blast.elements.map(row => `<button type="button" data-kin="blast-element" data-element="${row.element}" ${element === row.element ? "class=\"active\"" : ""} ${locked ? "disabled" : ""}>${escapeHTML(row.element)}</button>`).join("")}</p>
            <p>${escapeHTML(profile?.formula ?? "")} ${escapeHTML((profile?.damageTypes ?? []).join(" or "))}, ${profile?.range ?? "?"} feet · ${["1", "2"].map(n => `<button type="button" data-kin="blast-actions" data-n="${n}" ${String(state.answers.actions ?? 1) === n ? "class=\"active\"" : ""} ${locked ? "disabled" : ""}>${n} action${n === "2" ? "s" : ""}</button>`).join("")}
            ${["melee", "ranged"].map(mode => `<button type="button" data-kin="blast-mode" data-mode="${mode}" ${(state.answers.blastMode ?? "ranged") === mode ? "class=\"active\"" : ""} ${locked ? "disabled" : ""}>${mode}</button>`).join("")}</p>
            ${profile?.damageTypes?.length > 1 ? `<p>Type: ${profile.damageTypes.map(type => `<button type="button" data-kin="blast-type" data-type="${type}" ${(state.answers.damageType ?? profile.damageTypes[0]) === type ? "class=\"active\"" : ""} ${locked ? "disabled" : ""}>${type}</button>`).join("")}</p>` : ""}
            ${owner && !locked ? `<p><button type="button" data-kin="matter-damage">Roll damage (${escapeHTML(matterFormula(state, actor) ?? "")})</button></p>` : ""}</div>`;
    }
    return `<div class="pf2e-kin-blast"><p>Make the ${blast.actions ?? ""}${blast.actions ? "-action " : ""}${escapeHTML(blast.mode ?? "")} Elemental Blast${blast.element ? ` using the ${escapeHTML(blast.element)} element` : ""} with PF2e (sheet), targeting the creature, then:</p>
        ${owner && !locked ? `<button type="button" data-kin="read-blast">Read the blast's result</button>` : ""}
        ${blast.extraDamage ? `<p>On a hit: +${escapeHTML(blast.extraDamage.map(c => `${c.formula} ${c.type}`).join(" + "))}${state.damage ? ` → <strong>${state.damage.total}</strong>` : owner && !locked ? ` <button type="button" data-kin="blast-extra">Roll it</button>` : ""}</p>` : ""}</div>`;
}

/** Matter Blast's damage formula: the element's dice at the level, Strength on a melee blast, Intelligence as a status bonus on 2 actions. */
function matterFormula(state, actor) {
    const blast = state.plan.resolution.blast;
    const element = state.answers.element ?? blast.elements[0].element;
    const profile = blastProfile(blast.elements, element, state.level);
    if (!profile) return null;
    const type = state.answers.damageType ?? profile.damageTypes[0];
    const str = (state.answers.blastMode ?? "ranged") === "melee" ? Number(actor?.abilities?.str?.mod ?? actor?.system?.abilities?.str?.mod ?? 0) : 0;
    const int = String(state.answers.actions ?? 1) === "2" ? Number(actor?.abilities?.int?.mod ?? actor?.system?.abilities?.int?.mod ?? 0) : 0;
    const flat = str + int;
    return `${profile.formula}${flat ? `+${flat}` : ""}[${type}]`;
}

export const blastFamily = {
    bind(message, element, state, handle) {
        const { requestOp } = blastFamily.card;
        handle('[data-kin="read-blast"]', async () => {
            const actor = await fromUuid(state.sourceActorUuid);
            const found = latestBlast(actor, Number(message.timestamp ?? 0));
            if (!found) throw new Error("Make the Elemental Blast with PF2e first (targeting the creature).");
            const targetUuid = found.flags.pf2e.context.target?.token ?? null;
            const degree = degreeKey(found.flags.pf2e.context.outcome);
            const target = state.targets.find(t => t.tokenUuid === targetUuid) ?? state.targets[0];
            if (!target) {
                const token = targetUuid ? fromUuidSync(targetUuid) : null;
                if (token) await requestOp("addTargets", { messageId: message.id, tokenUuids: [token.uuid] });
                const fresh = blastFamily.card.stateOf(game.messages.get(message.id));
                const added = fresh.targets.find(t => t.tokenUuid === targetUuid);
                if (added) await requestOp("target", { messageId: message.id, targetId: added.id, patch: { degree, total: found.rolls?.[0]?.total ?? null } });
                return;
            }
            await requestOp("target", { messageId: message.id, targetId: target.id, patch: { degree, total: found.rolls?.[0]?.total ?? null } });
        });
        handle('[data-kin="blast-extra"]', async () => {
            const actor = await fromUuid(state.sourceActorUuid);
            const DamageRoll = DamageRollClass();
            const roll = await new DamageRoll(state.plan.resolution.blast.extraDamage.map(c => `${c.formula}[${c.type}]`).join(",").replace(/^(.*)$/, components => state.plan.resolution.blast.extraDamage.length > 1 ? `{${components}}` : components)).evaluate();
            await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${escapeHTML(state.itemName)}: extra damage on a hit` });
            await requestOp("update", { messageId: message.id, patch: { damage: { json: JSON.stringify(roll.toJSON()), total: roll.total } } });
        });
        handle('[data-kin="blast-element"]', node => requestOp("update", { messageId: message.id, patch: { answers: { element: node.dataset.element, damageType: null } } }));
        handle('[data-kin="blast-actions"]', node => requestOp("update", { messageId: message.id, patch: { answers: { actions: Number(node.dataset.n) } } }));
        handle('[data-kin="blast-mode"]', node => requestOp("update", { messageId: message.id, patch: { answers: { blastMode: node.dataset.mode } } }));
        handle('[data-kin="blast-type"]', node => requestOp("update", { messageId: message.id, patch: { answers: { damageType: node.dataset.type } } }));
        handle('[data-kin="matter-damage"]', async () => {
            const actor = await fromUuid(state.sourceActorUuid);
            const roll = await new (DamageRollClass())(matterFormula(state, actor)).evaluate();
            await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${escapeHTML(state.itemName)}: damage` });
            await requestOp("update", { messageId: message.id, patch: { damage: { json: JSON.stringify(roll.toJSON()), total: roll.total } } });
        });
    },
    card: null
};

export const blastOps = {};

/** Matter Blast's attack: the impulse statistic when the actor has one, else the class DC − 10 against the target's AC. */
export async function matterAttack(state, target, attackNumber = 1) {
    const actor = await fromUuid(state.sourceActorUuid);
    const targetActor = await fromUuid(target.actorUuid);
    const statistic = actor?.getStatistic?.("impulse");
    const traits = [...state.plan.traits, state.answers.element ?? state.plan.resolution.blast.elements[0].element];
    if (statistic) {
        const roll = await statistic.roll({ target: targetActor, dc: { slug: "ac" }, attackNumber, traits, extraRollOptions: ["item:trait:impulse", "action:elemental-blast", (state.answers.blastMode ?? "ranged")], label: `${state.itemName}: impulse attack` });
        return roll ? { degree: degreeKey(roll.degreeOfSuccess), total: roll.total } : null;
    }
    const modifier = (classDC(actor) ?? 10) - 10 - (attackNumber - 1) * 5;
    const roll = await new Roll(`1d20 + ${modifier}`).evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${escapeHTML(state.itemName)}: impulse attack against ${escapeHTML(targetActor?.name ?? "")}` });
    const ac = Number(targetActor?.armorClass?.value ?? targetActor?.system?.attributes?.ac?.value ?? 10);
    const natural = roll.dice[0].total;
    let steps = roll.total >= ac + 10 ? 3 : roll.total >= ac ? 2 : roll.total <= ac - 10 ? 0 : 1;
    if (natural === 20) steps = Math.min(3, steps + 1);
    if (natural === 1) steps = Math.max(0, steps - 1);
    return { degree: degreeKey(steps), total: roll.total };
}

// ---------------------------------------------------------------- PF2e's Elemental Blast: critical blast junctions and infusions

/** A PF2e attack-roll message: an Elemental Blast critical hit by a kineticist with critical blast junctions → the GM's card of offers. */
export async function onAttackMessage(message) {
    if (!isActiveGM()) return;
    const context = message.flags?.pf2e?.context;
    if (context?.type !== "attack-roll" || !(context.options ?? []).includes("action:elemental-blast")) return;
    const actor = message.actor ?? (message.speaker?.actor ? game.actors.get(message.speaker.actor) : null);
    if (!actor) return;
    const elements = ELEMENTS.filter(element => (context.options ?? []).includes(`item:trait:${element}`) || (context.traits ?? []).includes(element));
    // (Every blast attack adds to this turn's multiple attack penalty count the module's impulse cards read.)
    const { countAttack, countsAsEnabled } = await import("./card.js");
    await countAttack(actor, 1);
    // (A 2-action blast counting as a spell: a stupefied kineticist's flat check, DC 5 + the value, decides whether the blast was lost.)
    const stupefied = Number(actor.getCondition?.("stupefied")?.value ?? 0);
    if (countsAsEnabled() && stupefied && (context.options ?? []).includes("action:cost:2")) {
        const roll = await new Roll("1d20").evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), whisper: ChatMessage.getWhisperRecipients("GM").map(user => user.id),
            flavor: `Elemental Blast (2 actions, counts as a spell): stupefied flat check DC ${5 + stupefied} — ${roll.total >= 5 + stupefied ? "it goes off" : "failed: the blast is lost (don't apply its damage)"}` });
    }
    const outcome = degreeKey(context.outcome);
    const infusion = actor.flags?.[MODULE_ID]?.nextBlast ?? null;
    const lines = [];
    const buttons = [];
    if (outcome === "criticalSuccess") {
        const target = context.target?.actor ? fromUuidSync(context.target.actor) : null;
        const offers = criticalBlastJunctions(elements, actor.getRollOptions?.() ?? [], { targetMetal: Boolean(target?.traits?.has?.("metal") || target?.system?.traits?.value?.includes?.("metal")), targetGrounded: Number(fromUuidSync(context.target?.token ?? "")?.elevation ?? 0) <= 0 });
        offers.forEach((offer, index) => { lines.push(offer.label); buttons.push(`<button type="button" data-kin="crit-junction" data-index="${index}">${escapeHTML(offer.element)}</button>`); });
        if (offers.length) await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: ChatMessage.getWhisperRecipients("GM").map(user => user.id),
            content: `<p><strong>Critical blast junction</strong> against ${escapeHTML(target?.name ?? "the target")}:</p><ul>${lines.map(line => `<li>${escapeHTML(line)}</li>`).join("")}</ul>`,
            flags: { [MODULE_ID]: { critJunction: { offers, targetTokenUuid: context.target?.token ?? null, actorUuid: actor.uuid, status: "open" } } } });
    }
    // (Infusions armed for this blast.)
    if (infusion?.chain && ["success", "criticalSuccess"].includes(outcome)) {
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: owners(actor), content: `<p><strong>Chain Infusion</strong>: the blast hit — target a different creature within the blast's range of the creature hit, and make a ranged Elemental Blast from it (MAP applies; up to 5 blasts, no creature twice). Roll damage once and apply it to each hit (the damage message's buttons).</p>` });
    }
    if (infusion && !infusion.chain && infusion.twoElement) {
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: owners(actor), content: `<p><strong>Two-Element Infusion</strong>: split this blast's damage between ${escapeHTML(infusion.twoElement.join(" and "))} — use “Apply split” on the damage card's module button.</p>` });
    }
    if (infusion && !infusion.chain) await actor.unsetFlag(MODULE_ID, "nextBlast").catch(() => null);
}

const owners = actor => game.users.filter(user => actor.testUserPermission?.(user, "OWNER")).map(user => user.id);

export function renderCritJunctionCard(message, html) {
    const data = message.flags?.[MODULE_ID]?.critJunction;
    if (!data || !game.user.isGM) return;
    const root = html.querySelector?.(".message-content") ?? html;
    root.querySelector(".pf2e-kin-crit")?.remove();
    const element = document.createElement("div");
    element.className = "pf2e-kin-crit";
    element.innerHTML = data.status !== "open" ? `<p><em>${escapeHTML(data.status)}</em></p>` : data.offers.map((offer, index) => `<button type="button" data-index="${index}">Apply: ${escapeHTML(offer.element)}</button>`).join("");
    root.appendChild(element);
    element.querySelectorAll("button").forEach(node => node.addEventListener("click", async () => {
        try {
            const offer = data.offers[Number(node.dataset.index)];
            const actor = await fromUuid(data.actorUuid);
            const token = data.targetTokenUuid ? await fromUuid(data.targetTokenUuid) : null;
            const targets = new Map([["target", { actor: token?.actor, token }]]);
            const log = await applyChanges([offer.change], { sourceActor: actor, sourceToken: tokenOf(actor), item: null, plan: { source: { name: "Critical blast junction" }, level: actor.level, traits: [] }, targets, instanceId: null });
            await message.update({ [`flags.${MODULE_ID}.critJunction.status`]: `Applied: ${log.join("; ")}` });
        } catch (error) { notifyError("Critical blast junction", error); }
    }));
}

/** An infusion used (its feat's chat card): arm the next blast. */
export async function onInfusionMessage(message) {
    if (!isActiveGM()) return;
    const item = message.item ?? null;
    const traits = item?.system?.traits?.value ?? [];
    if (!traits.includes("infusion") || message.flags?.pf2e?.context?.type) return;
    const actor = message.actor ?? item?.actor;
    if (!actor) return;
    const text = item.system?.description?.value ?? "";
    const next = { ...(actor.flags?.[MODULE_ID]?.nextBlast ?? {}) };
    if (/keeps reconstituting itself to travel onward/.test(text)) next.chain = true;
    if (/choose two of your kinetic elements instead of one/.test(text)) next.twoElement = (actor.flags?.system?.kineticist?.elements ?? []).map(entry => entry.value ?? entry).slice(0, 2);
    if (/it gains the nonlethal trait/.test(text)) next.pacifying = true;
    if (!Object.keys(next).length) return;
    await actor.setFlag(MODULE_ID, "nextBlast", next);
}

/** Two-Element Infusion: half the damage of each type (the GM's button on a damage roll). */
export async function applySplit(message, targets) {
    const roll = message.rolls?.[0];
    const actor = message.actor;
    const infusion = actor?.flags?.[MODULE_ID]?.nextBlast?.twoElement ?? actor?.flags?.system?.kineticist?.elements?.map(entry => entry.value ?? entry).slice(0, 2);
    if (!roll || !infusion?.length) return;
    const [a, b] = splitTwoElements(roll.total, infusion);
    const DamageRoll = DamageRollClass();
    const split = await new DamageRoll(`{${a.amount}[${a.type}],${b.amount}[${b.type}]}`).evaluate();
    for (const token of targets) await token.actor?.applyDamage({ damage: split, token, rollOptions: new Set(["item:trait:impulse"]) });
}
