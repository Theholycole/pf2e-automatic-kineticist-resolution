// An impulse that lasts (Sustained, with a duration, a lingering area, creations or a stance) is tracked by an Effect on the kineticist,
// "Impulse: <name>". Its chat card offers Sustain, the Sustain's repeat (Whirling Grindstone's attack, the willow's lashes) and End. When the
// tracker goes — it expires, is ended, is Dismissed, or the kinetic aura takes a stance with it — everything the impulse made ends with it:
// the module's Effects on any creature, its Regions, its tokens and control of a commanded elemental.
import { MODULE_ID, escapeHTML, isActiveGM, notifyError, systemDuration } from "./utils.js";
import { impulseLifecycle } from "../src/core/resolve.js";
import { releaseControl } from "./apply.js";
import { restoreArmor } from "./armor.js";

const TRACKER = "tracker";

export const isTracker = item => item?.type === "effect" && item.flags?.[MODULE_ID]?.kind === TRACKER;
export const trackersOf = actor => actor?.itemTypes?.effect?.filter(isTracker) ?? [];

/** Start (or replace) the tracker for a resolved impulse. Returns log lines. */
export async function startTracker(actor, plan, context, state) {
    const lifecycle = impulseLifecycle(plan);
    const log = [];
    if (lifecycle.replacesPrevious) {
        for (const old of trackersOf(actor).filter(item => item.flags[MODULE_ID].impulse === plan.source.slug)) { await old.delete(); log.push(`The previous ${plan.source.name} ends.`); }
    }
    const duration = lifecycle.stance ? { value: -1, unit: "unlimited", expiry: null, sustained: false } : systemDuration(plan.lifecycle.duration ?? (lifecycle.sustainable ? { kind: "source-turn", edge: "end" } : null));
    const [tracker] = await actor.createEmbeddedDocuments("Item", [{
        type: "effect",
        name: `Impulse: ${plan.source.name}`,
        img: context.item?.img ?? "systems/pf2e/icons/default-icons/effect.svg",
        system: {
            description: { value: `<p>${escapeHTML(plan.source.name)} is active. ${lifecycle.sustainable ? "Sustain it from its chat card." : ""}${lifecycle.dismissable ? " You can Dismiss it (delete this Effect)." : ""}</p>` },
            duration, rules: [], level: { value: plan.level }, tokenIcon: { show: false }, start: { value: game.time.worldTime, initiative: game.combat?.combatants.find(c => c.actor?.id === actor.id)?.initiative ?? null }
        },
        flags: { [MODULE_ID]: { kind: TRACKER, instance: context.instanceId, impulse: plan.source.slug, itemUuid: context.item?.uuid ?? null, sustain: { max: lifecycle.sustainMaxRounds, used: 0, lastRound: null },
            endsWithAura: lifecycle.endsWithAura, stance: lifecycle.stance, ends: lifecycle.ends, regionUuid: state.regionUuid ?? null, repeat: plan.resolution.sustainRepeat ?? null, cardId: null } }
    }]);
    if (!tracker) return log;
    if (state.regionUuid) await tagRegion(state.regionUuid, context.instanceId, plan);
    if (lifecycle.sustainable || plan.resolution.sustainRepeat || plan.resolution.followUp) {
        const card = await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<div class="pf2e-kin-card-title"><strong>${escapeHTML(plan.source.name)}</strong> — ongoing impulse</div>`,
            flags: { [MODULE_ID]: { tracker: { actorUuid: actor.uuid, trackerId: tracker.id, instance: context.instanceId } } } });
        await tracker.setFlag(MODULE_ID, "cardId", card?.id ?? null);
    }
    log.push(`${plan.source.name} is tracked on ${actor.name}${lifecycle.sustainable ? " (Sustain from its card)" : ""}.`);
    return log;
}

/** A Region the impulse made: flagged with its instance so it ends with the impulse, its terrain and triggers added. */
async function tagRegion(uuid, instance, plan) {
    const region = await fromUuid(uuid).catch(() => null);
    if (!region) return;
    const terrain = plan.resolution.terrain ?? {};
    await region.update({ name: `${plan.source.name}`, [`flags.${MODULE_ID}`]: { instance, impulse: plan.source.slug, terrain, damage: plan.resolution.sharedDamage?.components ?? null, check: plan.resolution.check ?? null,
        oncePerRound: Boolean(plan.resolution.oncePerRound || terrain.inArea?.oncePerRound), hits: {} } });
    if (terrain.difficult) await region.createEmbeddedDocuments("RegionBehavior", [{ name: `${plan.source.name}: difficult terrain`, type: "modifyMovementCost", system: { difficulties: { walk: 2, travel: 2 } } }]).catch(error => console.warn(`${MODULE_ID} | difficult terrain`, error));
}

/** Render the ongoing impulse's card: Sustain, the repeat, End. */
export function renderTrackerCard(message, html) {
    const data = message.flags?.[MODULE_ID]?.tracker;
    if (!data) return;
    const actor = fromUuidSync(data.actorUuid);
    const tracker = actor?.items?.get(data.trackerId);
    const root = html.querySelector?.(".message-content") ?? html;
    root.querySelector(".pf2e-kin-tracker")?.remove();
    const element = document.createElement("section");
    element.className = "pf2e-kin-tracker";
    if (!tracker) { element.innerHTML = "<p><em>Ended.</em></p>"; root.appendChild(element); return; }
    const flags = tracker.flags[MODULE_ID];
    const owner = game.user.isGM || actor.isOwner;
    const repeat = flags.repeat;
    element.innerHTML = `<p>Sustained ${flags.sustain?.used ?? 0} time(s)${flags.sustain?.max ? ` (up to ${flags.sustain.max} rounds)` : ""}.</p>
        ${owner ? `<button type="button" data-kin="sustain"><i class="fa-solid fa-hourglass"></i> Sustain</button>` : ""}
        ${owner && repeat?.options ? repeat.options.map((option, index) => `<button type="button" data-kin="repeat-option" data-index="${index}">${escapeHTML(option)}</button>`).join("") : ""}
        ${owner && repeat?.alternative ? `<button type="button" data-kin="repeat-alt">${escapeHTML(repeat.alternative)}</button>` : ""}
        ${owner ? `<button type="button" data-kin="end"><i class="fa-solid fa-xmark"></i> End</button>` : ""}`;
    root.appendChild(element);
    element.querySelector('[data-kin="sustain"]')?.addEventListener("click", () => sustain(actor, tracker).catch(error => notifyError("Sustain", error)));
    element.querySelector('[data-kin="end"]')?.addEventListener("click", () => tracker.delete().catch(error => notifyError("End", error)));
    element.querySelector('[data-kin="repeat-alt"]')?.addEventListener("click", () => ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p>${escapeHTML(tracker.name)}: ${escapeHTML(repeat.alternative)}.</p>` }));
    element.querySelectorAll('[data-kin="repeat-option"]').forEach(node => node.addEventListener("click", () => repeatOption(actor, tracker, Number(node.dataset.index)).catch(error => notifyError("Sustain", error))));
}

/**
 * Sustain: the tracker lasts until the end of the kineticist's next turn again (up to its maximum), and the Sustain's repeat runs — a new
 * resolution card for the repeated effect (first time each round only, when the text says so).
 */
export async function sustain(actor, tracker) {
    const flags = tracker.flags[MODULE_ID];
    const round = game.combat?.started ? `${game.combat.id}:${game.combat.round}` : null;
    const used = Number(flags.sustain?.used ?? 0) + 1;
    if (flags.sustain?.max && used > flags.sustain.max) throw new Error(`${tracker.name} can't be Sustained beyond ${flags.sustain.max} rounds.`);
    await tracker.update({ "system.duration": { value: 1, unit: "rounds", expiry: "turn-end", sustained: false }, "system.start": { value: game.time.worldTime, initiative: game.combat?.combatants.find(c => c.actor?.id === actor.id)?.initiative ?? null },
        [`flags.${MODULE_ID}.sustain`]: { ...flags.sustain, used, lastRound: round } });
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p>${escapeHTML(actor.name)} Sustains <strong>${escapeHTML(tracker.name.replace(/^Impulse: /, ""))}</strong>.</p>` });
    const repeat = flags.repeat;
    const first = !repeat?.firstEachRound || flags.sustain?.lastRound !== round;
    if (repeat && first && (repeat.repeatPlan || repeat.damage || repeat.repeatAttack || repeat.creationStrike)) await openRepeatCard(actor, tracker, repeat);
}

async function repeatOption(actor, tracker, index) {
    const repeat = tracker.flags[MODULE_ID].repeat;
    const option = repeat.options[index];
    if (/attack|Grapple|Shoot/i.test(option)) return openRepeatCard(actor, tracker, { ...repeat, repeatAttack: true });
    return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p>${escapeHTML(tracker.name.replace(/^Impulse: /, ""))}: ${escapeHTML(option)}.</p>` });
}

/** The Sustain's repeat as a resolution card: the impulse's own plan again (no overflow, no junction), or its stated repeat damage and save. */
async function openRepeatCard(actor, tracker, repeat) {
    const { openCard } = await import("./card.js");
    const item = await fromUuid(tracker.flags[MODULE_ID].itemUuid).catch(() => null);
    if (!item) throw new Error("The impulse's item is no longer on the kineticist.");
    const region = tracker.flags[MODULE_ID].regionUuid ? await fromUuid(tracker.flags[MODULE_ID].regionUuid).catch(() => null) : null;
    const targets = region ? (region.parent?.tokens ?? []).filter(token => token.actor && region.testPoint?.({ x: token.x + token.width * canvas.grid.size / 2, y: token.y + token.height * canvas.grid.size / 2, elevation: token.elevation ?? 0 })) : null;
    return openCard({ item, actor, targets: targets?.map(token => token.object ?? token), repeat });
}

/** When a tracker is deleted: end what the impulse made. Runs on the active GM. */
export async function trackerEnded(item) {
    if (!isTracker(item) || !isActiveGM()) return;
    const flags = item.flags[MODULE_ID];
    const instance = flags.instance;
    const actors = new Set([...game.actors, ...(canvas.scene?.tokens ?? []).map(token => token.actor).filter(Boolean)]);
    for (const actor of actors) {
        const linked = actor.items.filter(entry => entry.flags?.[MODULE_ID]?.instance === instance && entry.id !== item.id && (entry.flags[MODULE_ID].duration?.kind === "impulse" || ["impulse-effect", "stance", "creation", "armor"].includes(entry.flags[MODULE_ID].kind) || entry.flags[MODULE_ID].stance));
        if (linked.length) await actor.deleteEmbeddedDocuments("Item", linked.map(entry => entry.id)).catch(() => null);
        if (actor.flags?.[MODULE_ID]?.controlledBy?.instance === instance) await releaseControl(actor);
    }
    await restoreArmor(item.actor, instance);
    for (const scene of game.scenes) {
        const regions = scene.regions.filter(region => region.flags?.[MODULE_ID]?.instance === instance).map(region => region.id);
        if (regions.length) await scene.deleteEmbeddedDocuments("Region", regions).catch(() => null);
        const tokens = scene.tokens.filter(token => token.flags?.[MODULE_ID]?.instance === instance).map(token => token.id);
        if (tokens.length) await scene.deleteEmbeddedDocuments("Token", tokens).catch(() => null);
        const hidden = scene.tokens.filter(token => token.flags?.[MODULE_ID]?.hiddenBy === instance);
        for (const token of hidden) await token.update({ hidden: false, [`flags.${MODULE_ID}.-=hiddenBy`]: null }).catch(() => null);
        const walls = scene.walls.filter(wall => wall.flags?.[MODULE_ID]?.instance === instance).map(wall => wall.id);
        if (walls.length) await scene.deleteEmbeddedDocuments("Wall", walls).catch(() => null);
    }
    const card = flags.cardId ? game.messages.get(flags.cardId) : null;
    if (card) ui.chat?.updateMessage?.(card);
}
