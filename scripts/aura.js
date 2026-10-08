// The kinetic aura (PF2e's "Effect: Kinetic Aura") and what hangs on it: overflow deactivates it; being knocked out deactivates it; stances (and
// trackers that end with the aura) end when it goes; Body of Air ends when it's activated; a stance ends the kineticist's other stances.
// Stance aura triggers: damage or saves when a creature enters the aura, starts or ends its turn in it (Thermal Nimbus, Crowned in Tempest's Fury,
// Drifting Pollen), the kineticist's own start-of-turn options (Steam Knight's steam), and the start-of-turn prompts (Final Gate, Effortless
// Impulse, Imperious Aura). Only the active GM acts; hooks return at once when no kineticist with a stance or aura is on the scene.
import { MODULE_ID, escapeHTML, isActiveGM, notifyError, inKineticAura, componentsFormula, classDC, DamageRollClass, degreeKey } from "./utils.js";
import { isStanceEffect, KINETIC_AURA_UUID } from "../src/core/kineticist.js";
import { resolveAuraTrigger } from "../src/core/resolve.js";
import { applyChanges, createEffect } from "./apply.js";
import { trackersOf } from "./tracker.js";

// (Alchemists+ Chrysopoet: a rendered transmutation circle is "the area of your kinetic aura" and ends when an overflow impulse is used.)
export const isKineticAura = item => item?.type === "effect" && (item.slug === "effect-kinetic-aura" || item.name === "Effect: Kinetic Aura" || item.sourceId === KINETIC_AURA_UUID
    || item._stats?.compendiumSource === KINETIC_AURA_UUID || item.name === "Effect: Render Circle" || item.slug === "effect-render-circle");
export const kineticAuraOf = actor => actor?.itemTypes?.effect?.find(isKineticAura) ?? null;

/** Deactivate the kinetic aura (overflow, knocked out, Dismiss). */
export async function endKineticAura(actor, reason = "") {
    const aura = kineticAuraOf(actor);
    if (!aura) return false;
    await aura.delete();
    if (reason) await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: ChatMessage.getWhisperRecipients("GM").map(user => user.id), content: `<p>${escapeHTML(actor.name)}'s kinetic aura deactivates: ${escapeHTML(reason)}.</p>` }).catch(() => null);
    return true;
}

/** Enter a stance impulse: the other stances end; PF2e's Stance Effect (or the module's) with the card's choice and the aura triggers. */
export async function applyStance(actor, plan, context, state) {
    const log = [];
    const others = actor.itemTypes.effect.filter(isStanceEffect);
    if (others.length) { await actor.deleteEmbeddedDocuments("Item", others.map(item => item.id)); log.push(`Other stances end: ${others.map(item => item.name).join(", ")}.`); }
    const link = plan.resolution.effects.find(effect => effect.uuid && /^Stance:/.test(effect.name ?? "")) ?? (plan.selfEffect?.uuid ? { uuid: plan.selfEffect.uuid, name: plan.selfEffect.name } : null);
    const generated = plan.resolution.effects.find(effect => effect.stance && !effect.uuid);
    const choice = state?.answers?.casterChoice ?? null;
    const choices = plan.resolution.stanceChoice?.flag && choice ? { [plan.resolution.stanceChoice.flag]: choice } : null;
    const spec = link ? { uuid: link.uuid, name: link.name, choices } : { ...(generated ?? {}), name: `Stance: ${plan.source.name}`, rules: [], text: plan.resolution.notes.map(entry => entry.text).join(" ") || null };
    spec.flags = { kind: "stance", stance: true, triggers: plan.resolution.aura?.triggers ?? [], aura: plan.resolution.aura ?? null, choice };
    const created = await createEffect(actor, spec, context);
    if (created) log.push(`${actor.name} enters ${created.name}${choice ? ` (${choice})` : ""}.`);
    // (A stance used without an active aura has nothing to hang on: PF2e's Stance needs the aura.)
    if (!kineticAuraOf(actor)) log.push("Note: the kinetic aura isn't active — use Channel Elements (stances end with the aura).");
    return log;
}

// ---------------------------------------------------------------- hooks

/** An Effect deleted: the kinetic aura → stances and aura-bound trackers end; a stance or tracker → nothing more here. */
export async function onDeleteItem(item) {
    if (!isActiveGM() || !isKineticAura(item)) return;
    const actor = item.actor;
    if (!actor) return;
    const ending = [...actor.itemTypes.effect.filter(isStanceEffect), ...trackersOf(actor).filter(tracker => tracker.flags[MODULE_ID].endsWithAura)];
    if (ending.length) await actor.deleteEmbeddedDocuments("Item", [...new Set(ending.map(entry => entry.id))]).catch(error => notifyError("Ending the stances", error));
    // (Extract Element's matter is in the aura: its Effects on other creatures end too.)
    for (const token of canvas.scene?.tokens ?? []) {
        const extracted = token.actor?.itemTypes?.effect?.filter(effect => effect.flags?.[MODULE_ID]?.sourceActor === actor.uuid && (effect.flags[MODULE_ID].endsWithSourceAura || /Extracted/.test(effect.name))) ?? [];
        if (extracted.length) await token.actor.deleteEmbeddedDocuments("Item", extracted.map(entry => entry.id)).catch(() => null);
    }
}

/** An Effect created: the kinetic aura activated → impulses that end then (Body of Air) end; unconscious → the aura deactivates. */
export async function onCreateItem(item) {
    if (!isActiveGM()) return;
    const actor = item.actor;
    if (!actor) return;
    if (isKineticAura(item)) {
        const ending = trackersOf(actor).filter(tracker => (tracker.flags[MODULE_ID].ends ?? []).includes("aura-activated"));
        if (ending.length) await actor.deleteEmbeddedDocuments("Item", ending.map(entry => entry.id)).catch(() => null);
    }
    if (item.type === "condition" && item.slug === "unconscious" && kineticAuraOf(actor)) await endKineticAura(actor, "knocked out");
}

// ---------------------------------------------------------------- aura triggers

/** The kineticists on the scene with a stance that has aura triggers (cheap: their Effects' flags). */
function triggerHolders() {
    const out = [];
    for (const token of canvas.scene?.tokens ?? []) {
        const actor = token.actor;
        if (!actor?.itemTypes?.effect?.length) continue;
        for (const effect of actor.itemTypes.effect) {
            const triggers = effect.flags?.[MODULE_ID]?.triggers;
            if (triggers?.length && kineticAuraOf(actor)) out.push({ token, actor, effect, triggers });
        }
    }
    return out;
}

/** The start or end of a combatant's turn (updateCombat). */
export async function onTurnChange(combat, changes) {
    if (!isActiveGM() || !("turn" in changes || "round" in changes)) return;
    const holders = triggerHolders();
    const promptActors = startOfTurnPromptActors(combat);
    if (!holders.length && !promptActors.length) return;
    const current = combat.combatant?.token;
    const previous = combat.previous?.tokenId ? combat.scene?.tokens.get(combat.previous.tokenId) ?? canvas.scene?.tokens.get(combat.previous.tokenId) : null;
    for (const holder of holders) for (const trigger of holder.triggers) {
        try {
            const events = trigger.events ?? (trigger.event ? [trigger.event] : []);
            if (events.includes("source-turn-start") && current?.actor?.id === holder.actor.id) await triggerCard(holder, trigger, null, "At the start of your turn (free action)");
            if (events.includes("turn-start") && current && current.id !== holder.token.id && inKineticAura(holder.token, current)) await triggerCard(holder, trigger, current, "starts its turn in the aura");
            if (events.includes("turn-end") && previous && previous.id !== holder.token.id && inKineticAura(holder.token, previous)) await triggerCard(holder, trigger, previous, "ends its turn in the aura");
        } catch (error) { notifyError("An aura trigger", error); }
    }
    for (const actor of promptActors) await startOfTurnPrompt(actor).catch(error => notifyError("A start-of-turn prompt", error));
}

/** A token moved: did it enter a kineticist's aura? (Thermal Nimbus, Crowned in Tempest's Fury, Drifting Pollen: "enters".) */
export async function onTokenMove(tokenDocument, changes) {
    if (!isActiveGM() || !("x" in changes || "y" in changes)) return;
    const holders = triggerHolders();
    if (!holders.length) return;
    for (const holder of holders) {
        if (holder.token.id === tokenDocument.id) continue;
        const was = tokenDocument.flags?.[MODULE_ID]?.inAura?.[holder.token.id] ?? false;
        const now = inKineticAura(holder.token, tokenDocument);
        if (was !== now) await tokenDocument.setFlag(MODULE_ID, `inAura.${holder.token.id}`, now).catch(() => null);
        if (!now || was) continue;
        for (const trigger of holder.triggers) if ((trigger.events ?? []).includes("enter")) await triggerCard(holder, trigger, tokenDocument, "enters the aura").catch(error => notifyError("An aura trigger", error));
    }
}

/** A trigger's card: damage (with or without a save) and conditions for one creature, confirmed by the GM. */
async function triggerCard(holder, trigger, token, why) {
    const round = game.combat?.started ? `${game.combat.id}:${game.combat.round}` : null;
    if (token && trigger.oncePerRound) {
        const key = `${holder.effect.id}:${token.id}`;
        const hits = holder.effect.flags[MODULE_ID].hits ?? {};
        if (hits[key] === round) return;
        await holder.effect.setFlag(MODULE_ID, `hits.${key}`, round);
    }
    if (token && trigger.skipIfAffected && token.actor?.itemTypes?.effect?.some(effect => effect.flags?.[MODULE_ID]?.trigger === holder.effect.id)) return;
    // (Safe Elements: creatures the kineticist designated as immune to the aura's damage and drawbacks.)
    if (token && (trigger.damage || trigger.save || trigger.effect) && (holder.actor.flags?.[MODULE_ID]?.safeElements?.damage ?? []).includes(token.actor?.uuid)) return;
    const name = holder.effect.name.replace(/^Stance: /, "");
    const formula = trigger.damage ? componentsFormula(trigger.damage.map(component => ({ ...component, type: component.type ?? holder.actor.flags?.system?.kineticist?.thermalNimbus ?? "fire" }))) : null;
    const save = trigger.save ? `${trigger.save.basic ? "basic " : ""}${trigger.save.statistic}` : null;
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: holder.actor }),
        whisper: ChatMessage.getWhisperRecipients("GM").map(user => user.id),
        content: `<p><strong>${escapeHTML(name)}</strong>: ${escapeHTML(token?.name ?? holder.actor.name)} ${escapeHTML(why)}.${formula ? ` ${escapeHTML(formula)} damage` : ""}${save ? ` (${escapeHTML(save)} against DC ${classDC(holder.actor) ?? "?"})` : ""}${trigger.effect ? ` ${escapeHTML(trigger.effect.name)}` : ""}${trigger.manual ? " (the GM decides when it applies)" : ""}.</p>`,
        flags: { [MODULE_ID]: { trigger: { holderTokenUuid: holder.token.uuid, effectUuid: holder.effect.uuid, trigger, targetTokenUuid: token?.uuid ?? null, why, status: "open" } } }
    });
}

export function renderTriggerCard(message, html) {
    const data = message.flags?.[MODULE_ID]?.trigger;
    if (!data) return;
    const root = html.querySelector?.(".message-content") ?? html;
    root.querySelector(".pf2e-kin-trigger")?.remove();
    const element = document.createElement("div");
    element.className = "pf2e-kin-trigger";
    if (data.status !== "open") { element.innerHTML = `<p><em>${escapeHTML(data.status)}.</em></p>`; root.appendChild(element); return; }
    if (!game.user.isGM) return;
    const targets = data.targetTokenUuid ? [data.targetTokenUuid] : null;
    element.innerHTML = `${data.trigger.save ? `<button type="button" data-kin="trigger-save">Roll save and apply</button>` : ""}${data.trigger.damage && !data.trigger.save ? `<button type="button" data-kin="trigger-apply">Apply damage</button>` : ""}${data.trigger.effect ? `<button type="button" data-kin="trigger-apply">Apply ${escapeHTML(data.trigger.effect.name)}</button>` : ""}${!targets ? `<button type="button" data-kin="trigger-targets">Apply to targeted creatures</button>` : ""} <button type="button" data-kin="trigger-skip">Skip</button>`;
    root.appendChild(element);
    element.querySelector('[data-kin="trigger-save"]')?.addEventListener("click", () => runTrigger(message, { save: true }).catch(error => notifyError("Aura trigger", error)));
    element.querySelectorAll('[data-kin="trigger-apply"]').forEach(node => node.addEventListener("click", () => runTrigger(message, { save: false }).catch(error => notifyError("Aura trigger", error))));
    element.querySelector('[data-kin="trigger-targets"]')?.addEventListener("click", () => runTrigger(message, { save: Boolean(data.trigger.save), targets: [...game.user.targets].map(token => token.document.uuid) }).catch(error => notifyError("Aura trigger", error)));
    element.querySelector('[data-kin="trigger-skip"]')?.addEventListener("click", () => message.update({ [`flags.${MODULE_ID}.trigger.status`]: "skipped" }));
}

async function runTrigger(message, { save, targets = null }) {
    const data = message.flags[MODULE_ID].trigger;
    const holderToken = await fromUuid(data.holderTokenUuid);
    const holder = holderToken?.actor;
    const effect = await fromUuid(data.effectUuid).catch(() => null);
    const tokens = (targets ?? (data.targetTokenUuid ? [data.targetTokenUuid] : [])).map(uuid => fromUuidSync(uuid)).filter(token => token?.actor);
    const trigger = data.trigger;
    const map = new Map();
    const changes = [];
    let damageJSON = null;
    if (trigger.damage) {
        const DamageRoll = DamageRollClass();
        const roll = await new DamageRoll(componentsFormula(trigger.damage.map(component => ({ ...component, type: component.type ?? holder.flags?.system?.kineticist?.thermalNimbus ?? "fire" })))).evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: holder }), flavor: escapeHTML(effect?.name ?? "Aura") });
        damageJSON = JSON.stringify(roll.toJSON());
    }
    for (const token of tokens) {
        map.set(token.id, { actor: token.actor, token });
        let degree = "failure";
        if (save && trigger.save) {
            const statistic = token.actor.saves?.[trigger.save.statistic] ?? token.actor.getStatistic?.(trigger.save.statistic);
            const dc = (classDC(holder) ?? 10) + Number(trigger.save.adjustment ?? 0);
            const roll = await statistic?.roll({ dc: { value: dc }, origin: holder, extraRollOptions: ["item:trait:impulse"], createMessage: true });
            degree = degreeKey(roll?.degreeOfSuccess) ?? "failure";
        }
        const list = resolveAuraTrigger(trigger, { id: token.id }, degree).map(change => change.op === "damage" && !change.components ? change : change.op === "damage" ? { ...change, components: undefined, roll: "shared" } : change);
        if (trigger.effect) list.push({ op: "effect", target: token.id, effect: { ...trigger.effect, flags: { trigger: effect?.id ?? null } } });
        // (Conditions from a stance's save — Drifting Pollen — are linked to the stance so a creature "doesn't attempt a new save if already affected".)
        changes.push(...list.map(change => change.op === "condition" ? { ...change, duration: change.duration ?? null } : change));
    }
    const log = await applyChanges(changes, { sourceActor: holder, sourceToken: holderToken, item: null, plan: { source: { name: effect?.name ?? "Aura" }, level: holder.level, traits: [] }, instanceId: effect?.flags?.[MODULE_ID]?.instance ?? null, damageJSON, targets: map, dc: classDC(holder) });
    await message.update({ [`flags.${MODULE_ID}.trigger.status`]: `applied: ${log.join("; ")}` });
}

// ---------------------------------------------------------------- start-of-turn prompts (Final Gate, Effortless Impulse, Imperious Aura)

function startOfTurnPromptActors(combat) {
    const actor = combat.combatant?.actor;
    if (!actor?.itemTypes?.feat) return [];
    const has = slug => actor.itemTypes.feat.some(feat => feat.slug === slug);
    return has("final-gate") || has("effortless-impulse") || has("imperious-aura") ? [actor] : [];
}

async function startOfTurnPrompt(actor) {
    const lines = [];
    const has = slug => actor.itemTypes.feat.some(feat => feat.slug === slug);
    if (has("final-gate") && !kineticAuraOf(actor)) lines.push("Final Gate: your kinetic aura is inactive — your first action is Channel Elements (free), unless you suppress it.");
    if (has("effortless-impulse") && trackersOf(actor).some(tracker => tracker.flags[MODULE_ID].sustain)) lines.push("Effortless Impulse (free): Sustain one of your active impulses — use its card's Sustain.");
    if (has("imperious-aura") && kineticAuraOf(actor)) lines.push("Imperious Aura (free): use a stance impulse that affects your kinetic aura.");
    if (!lines.length) return;
    const owners = game.users.filter(user => actor.testUserPermission?.(user, "OWNER")).map(user => user.id);
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: owners, content: lines.map(line => `<p>${escapeHTML(line)}</p>`).join("") });
}

/**
 * Safe Elements: when the kineticist Channels Elements or uses a stance impulse, designate up to its Constitution modifier (minimum 1) creatures as
 * immune to the aura's benefits or to its damage and drawbacks. The module skips the aura's damage triggers for the second group; the first is the
 * GM's (PF2e's Aura rules hand out the benefits).
 */
export async function designateSafeElements(actor, tokens, group) {
    const max = Math.max(1, Number(actor?.abilities?.con?.mod ?? actor?.system?.abilities?.con?.mod ?? 1));
    const uuids = tokens.map(token => (token.document ?? token).actor?.uuid).filter(Boolean).slice(0, max);
    await actor.setFlag(MODULE_ID, "safeElements", { ...(actor.flags?.[MODULE_ID]?.safeElements ?? {}), [group]: uuids });
    return uuids;
}
