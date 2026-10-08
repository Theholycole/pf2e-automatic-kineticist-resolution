// Things that happen later, each offered to the GM on a card (confirmation-first):
//   - lingering areas (the impulse's Regions): hazardous squares moved into, damage or saves at the start or end of a turn in them, conditions that
//     last "as long as it remains in the area" ending when the creature leaves
//   - follow-ups on a creature (Burning Demand's sigil, Witchwood Seed's recurring save) at its turn
//   - linked conditions ("dazzled until it's no longer sickened")
//   - retaliation (Spike Skin, the metal impulse junction) when the bearer is damaged by an unarmed or non-reach melee attack
//   - an impulse that ends on a critical hit (Metal Carapace)
// Only the active GM acts; the hooks return at once unless an Effect or Region of the module is on the scene.
import { MODULE_ID, escapeHTML, isActiveGM, notifyError, componentsFormula, DamageRollClass, classDC, degreeKey } from "./utils.js";
import { trackersOf } from "./tracker.js";
import { applyChanges } from "./apply.js";

const gmIds = () => ChatMessage.getWhisperRecipients("GM").map(user => user.id);
const ourRegions = scene => (scene?.regions ?? []).filter(region => region.flags?.[MODULE_ID]?.instance && region.flags[MODULE_ID].terrain);
const centreOf = (token, x = token.x, y = token.y) => ({ x: x + token.width * token.parent.grid.size / 2, y: y + token.height * token.parent.grid.size / 2, elevation: token.elevation ?? 0 });
const inRegion = (region, point) => { try { return Boolean(region.testPoint(point)); } catch (_) { return false; } };

// ---------------------------------------------------------------- movement

/** Remember where a token was (preUpdateToken), so the move's squares can be counted. */
export function onPreUpdateToken(token, changes, options) {
    if (!("x" in changes || "y" in changes)) return;
    options[MODULE_ID] = { ...(options[MODULE_ID] ?? {}), from: { x: token.x, y: token.y } };
}

export async function onTokenMoved(token, changes, options) {
    if (!isActiveGM() || !("x" in changes || "y" in changes) || options?.[MODULE_ID]?.forcedMovement) return;
    const regions = ourRegions(token.parent);
    const effects = token.actor?.itemTypes?.effect?.filter(effect => effect.flags?.[MODULE_ID]?.areaBound) ?? [];
    if (!regions.length && !effects.length) return;
    const from = options?.[MODULE_ID]?.from ?? null;
    // (Foundry 14 animates a move: when this hook runs the document can still hold the old position — the destination is in the changes.)
    const to = { x: changes.x ?? token.x, y: changes.y ?? token.y };
    // (Conditions that last while it's in the area: gone once it's out.)
    for (const effect of effects) {
        const region = typeof effect.flags[MODULE_ID].areaBound === "string" ? fromUuidSync(effect.flags[MODULE_ID].areaBound) : null;
        if (region && !inRegion(region, centreOf(token, to.x, to.y))) await effect.delete().catch(() => null);
    }
    for (const region of regions) {
        const terrain = region.flags[MODULE_ID].terrain;
        if (!terrain.hazardous && !terrain.inArea) continue;
        const squares = squaresEntered(token, region, from, to);
        if (!squares) continue;
        const formula = terrain.hazard ? componentsFormula(terrain.hazard) : null;
        if (terrain.hazardous && formula) await laterCard(region, token, `moved into ${squares} square${squares === 1 ? "" : "s"} of hazardous terrain`, { damage: terrain.hazard, times: squares });
        else if (terrain.inArea) await laterCard(region, token, "entered the area", { usePlan: true });
    }
}

/** The squares of a straight move from → to that lie in a Region and weren't in it at the start. */
function squaresEntered(token, region, from, to = { x: token.x, y: token.y }) {
    const size = token.parent.grid.size;
    const start = from ?? to;
    const steps = Math.max(Math.abs(to.x - start.x), Math.abs(to.y - start.y)) / size;
    if (!steps) return inRegion(region, centreOf(token, to.x, to.y)) && !from ? 1 : 0;
    let count = 0;
    for (let i = 1; i <= Math.round(steps); i++) {
        const x = start.x + (to.x - start.x) * i / steps, y = start.y + (to.y - start.y) * i / steps;
        if (inRegion(region, centreOf(token, x, y))) count++;
    }
    return count;
}

// ---------------------------------------------------------------- turns

export async function onTurnChange(combat, changes) {
    if (!isActiveGM() || !("turn" in changes || "round" in changes)) return;
    const scene = combat.scene ?? canvas.scene;
    const regions = ourRegions(scene);
    const current = combat.combatant?.token ?? null;
    const previous = combat.previous?.tokenId ? scene?.tokens.get(combat.previous.tokenId) : null;
    // (Lingering areas: the start of the current creature's turn, the end of the previous one's.)
    for (const region of regions) {
        const terrain = region.flags[MODULE_ID].terrain;
        if (current && terrain.turnStart && inRegion(region, centreOf(current))) await laterCard(region, current, "starts its turn in the area", { damage: terrain.turnStart.damage, save: terrain.turnStart.save, persistentOnFailure: terrain.turnStart.persistentOnFailure, question: terrain.affects?.question ?? null });
        if (current && terrain.inArea && inRegion(region, centreOf(current))) await laterCard(region, current, "starts its turn in the area", { usePlan: true });
        if (previous && terrain.endTurn && inRegion(region, centreOf(previous))) await laterCard(region, previous, "ends its turn in the area", { damage: terrain.endTurn });
        if (previous && terrain.turnEnd?.usesPlan && inRegion(region, centreOf(previous))) await laterCard(region, previous, "ends its turn in the area", { usePlan: true });
    }
    // (Follow-ups on creatures: at the start of the current one's turn, the end of the previous one's.)
    for (const [token, edge] of [[current, "target-turn-start"], [previous, "target-turn-end"]]) {
        if (!token?.actor) continue;
        for (const effect of token.actor.itemTypes.effect.filter(item => item.flags?.[MODULE_ID]?.followUp?.when === edge)) await followUpCard(token, effect).catch(error => notifyError("A follow-up", error));
    }
}

/** A lingering area's card for the GM: roll the save (if any) and apply the damage. */
async function laterCard(region, token, why, data) {
    const flags = region.flags[MODULE_ID];
    const round = game.combat?.started ? `${game.combat.id}:${game.combat.round}` : null;
    if (flags.oncePerRound && round) {
        if (flags.hits?.[token.id] === round) return;
        await region.setFlag(MODULE_ID, `hits.${token.id}`, round);
    }
    const damage = data.usePlan ? flags.damage : data.damage;
    const save = data.usePlan ? flags.check : data.save;
    await ChatMessage.create({
        whisper: gmIds(), speaker: { alias: region.name },
        content: `<p><strong>${escapeHTML(region.name)}</strong>: ${escapeHTML(token.name)} ${escapeHTML(why)}.${damage ? ` ${escapeHTML(componentsFormula(damage))}${data.times > 1 ? ` × ${data.times}` : ""} damage` : ""}${save ? ` (${save.basic ? "basic " : ""}${escapeHTML(save.statistic)})` : ""}${data.persistentOnFailure ? `, plus ${escapeHTML(componentsFormula(data.persistentOnFailure))} if it fails` : ""}.${data.question ? ` <em>${escapeHTML(data.question)}</em>` : ""}</p>`,
        flags: { [MODULE_ID]: { later: { regionUuid: region.uuid, tokenUuid: token.uuid, damage, save, times: data.times ?? 1, persistentOnFailure: data.persistentOnFailure ?? null, sourceActorUuid: flags.sourceActorUuid ?? null, instance: flags.instance, status: "open" } } }
    });
}

export function renderLaterCard(message, html) {
    const data = message.flags?.[MODULE_ID]?.later;
    if (!data || !game.user.isGM) return;
    const root = html.querySelector?.(".message-content") ?? html;
    root.querySelector(".pf2e-kin-later")?.remove();
    const element = document.createElement("div");
    element.className = "pf2e-kin-later";
    element.innerHTML = data.status !== "open" ? `<p><em>${escapeHTML(data.status)}</em></p>` : `<button type="button" data-kin="later-apply">${data.save ? "Roll save and apply" : "Apply"}</button> <button type="button" data-kin="later-skip">Skip</button>`;
    root.appendChild(element);
    element.querySelector('[data-kin="later-apply"]')?.addEventListener("click", () => runLater(message).catch(error => notifyError("Lingering area", error)));
    element.querySelector('[data-kin="later-skip"]')?.addEventListener("click", () => message.update({ [`flags.${MODULE_ID}.later.status`]: "Skipped." }));
}

/** The kineticist whose impulse made a Region (its tracker's actor). */
function sourceOf(instance) {
    for (const actor of [...game.actors, ...(canvas.scene?.tokens ?? []).map(token => token.actor).filter(Boolean)]) {
        if (trackersOf(actor).some(tracker => tracker.flags[MODULE_ID].instance === instance)) return actor;
    }
    return null;
}

async function runLater(message) {
    const data = message.flags[MODULE_ID].later;
    const token = await fromUuid(data.tokenUuid);
    const source = sourceOf(data.instance);
    if (!token?.actor) throw new Error("The creature is gone.");
    let degree = "failure";
    if (data.save) {
        const roll = await (token.actor.saves?.[data.save.statistic] ?? token.actor.getStatistic(data.save.statistic))?.roll({ dc: { value: classDC(source) ?? 10 }, origin: source ?? undefined, extraRollOptions: ["item:trait:impulse", "area-effect"], createMessage: true, skipDialog: true });
        degree = degreeKey(roll?.degreeOfSuccess) ?? "failure";
    }
    const multiplier = data.save?.basic ? { criticalSuccess: 0, success: 0.5, failure: 1, criticalFailure: 2 }[degree] : data.save ? (["failure", "criticalFailure"].includes(degree) ? 1 : 0) : 1;
    const changes = [];
    let json = null;
    if (data.damage && multiplier) {
        const formula = componentsFormula(data.damage);
        const DamageRoll = DamageRollClass();
        const roll = await new DamageRoll(data.times > 1 ? `(${formula}) * ${data.times}` : formula).evaluate();
        await roll.toMessage({ speaker: { alias: message.speaker?.alias ?? "" }, flavor: escapeHTML(token.name) });
        changes.push({ op: "damage", target: token.id, multiplier, roll: "shared" });
        json = JSON.stringify(roll.toJSON());
    }
    if (data.persistentOnFailure && ["failure", "criticalFailure"].includes(degree)) changes.push({ op: "damage", target: token.id, multiplier: 1, components: data.persistentOnFailure });
    const log = await applyChanges(changes, { sourceActor: source, item: null, plan: { source: { name: message.speaker?.alias ?? "" }, level: source?.level, traits: [] }, damageJSON: json, targets: new Map([[token.id, { actor: token.actor, token }]]), instanceId: data.instance });
    await message.update({ [`flags.${MODULE_ID}.later.status`]: `${degree}: ${log.join("; ") || "no damage"}` });
}

// ---------------------------------------------------------------- follow-ups on a creature

async function followUpCard(token, effect) {
    const followUp = effect.flags[MODULE_ID].followUp;
    const source = effect.flags[MODULE_ID].sourceActor ? fromUuidSync(effect.flags[MODULE_ID].sourceActor) : null;
    if (followUp.recurringSave) {
        const roll = await (token.actor.saves?.[followUp.statistic] ?? token.actor.getStatistic(followUp.statistic))?.roll({ dc: { value: followUp.dc ?? classDC(source) ?? 10 }, origin: source ?? undefined, extraRollOptions: ["item:trait:impulse"], createMessage: true, skipDialog: true });
        const degree = degreeKey(roll?.degreeOfSuccess);
        if (["success", "criticalSuccess"].includes(degree)) {
            const instance = effect.flags[MODULE_ID].instance;
            const ending = token.actor.itemTypes.effect.filter(item => item.flags?.[MODULE_ID]?.instance === instance);
            await token.actor.deleteEmbeddedDocuments("Item", ending.map(item => item.id));
            await ChatMessage.create({ whisper: gmIds(), content: `<p>${escapeHTML(token.name)} succeeds at its new save: ${escapeHTML(effect.name.replace(/: pending$/, ""))} ends.</p>` });
        }
        return;
    }
    await ChatMessage.create({
        whisper: gmIds(), speaker: { alias: effect.name },
        content: `<p><strong>${escapeHTML(effect.name.replace(/: pending$/, ""))}</strong> — ${escapeHTML(token.name)}: ${escapeHTML(followUp.question ?? "")} If not: ${escapeHTML(componentsFormula(followUp.damage ?? []))}${followUp.persistent ? ` and ${escapeHTML(componentsFormula(followUp.persistent))}` : ""}.</p>`,
        flags: { [MODULE_ID]: { followUpCard: { tokenUuid: token.uuid, effectUuid: effect.uuid, followUp, status: "open" } } }
    });
}

export function renderFollowUpCard(message, html) {
    const data = message.flags?.[MODULE_ID]?.followUpCard;
    if (!data || !game.user.isGM) return;
    const root = html.querySelector?.(".message-content") ?? html;
    root.querySelector(".pf2e-kin-followup")?.remove();
    const element = document.createElement("div");
    element.className = "pf2e-kin-followup";
    element.innerHTML = data.status !== "open" ? `<p><em>${escapeHTML(data.status)}</em></p>` : `<button type="button" data-kin="obeyed">It obeyed: the sigil vanishes</button> <button type="button" data-kin="ignite">It didn't: the sigil ignites</button>`;
    root.appendChild(element);
    const finish = async ignite => {
        const token = await fromUuid(data.tokenUuid);
        const effect = await fromUuid(data.effectUuid).catch(() => null);
        let log = [];
        if (ignite && token?.actor) {
            const changes = [{ op: "damage", target: token.id, multiplier: 1, components: data.followUp.damage }];
            if (data.followUp.persistent) changes.push({ op: "damage", target: token.id, multiplier: 1, components: data.followUp.persistent });
            log = await applyChanges(changes, { sourceActor: null, item: null, plan: { source: { name: effect?.name ?? "" }, traits: [] }, targets: new Map([[token.id, { actor: token.actor, token }]]) });
        }
        if (effect) await effect.delete().catch(() => null);
        await message.update({ [`flags.${MODULE_ID}.followUpCard.status`]: ignite ? `Ignited: ${log.join("; ")}` : "Obeyed: the sigil vanishes." });
    };
    element.querySelector('[data-kin="obeyed"]')?.addEventListener("click", () => finish(false).catch(error => notifyError("Follow-up", error)));
    element.querySelector('[data-kin="ignite"]')?.addEventListener("click", () => finish(true).catch(error => notifyError("Follow-up", error)));
}

// ---------------------------------------------------------------- linked conditions, retaliation, critical hits

/** A condition ended: the module's Effects linked to it on that creature end ("dazzled until it's no longer sickened"). */
export async function onConditionDeleted(item) {
    if (!isActiveGM() || item.type !== "condition" || !item.actor) return;
    const linked = item.actor.itemTypes.effect.filter(effect => effect.flags?.[MODULE_ID]?.linkedTo === item.slug);
    if (linked.length) await item.actor.deleteEmbeddedDocuments("Item", linked.map(effect => effect.id)).catch(() => null);
}

/** A PF2e damage roll: retaliation for its target (Spike Skin, the metal junction), and impulses that end on a critical hit (Metal Carapace). */
export async function onDamageMessage(message) {
    if (!isActiveGM()) return;
    const context = message.flags?.pf2e?.context;
    if (context?.type !== "damage-roll" || !context.target?.actor) return;
    const target = fromUuidSync(context.target.actor);
    if (!target?.itemTypes) return;
    const options = new Set(context.options ?? []);
    const attacker = message.actor;
    const melee = options.has("item:melee") || options.has("melee") || [...options].some(option => option.startsWith("item:category:unarmed"));
    const reach = [...options].some(option => /^item:trait:reach/.test(option));
    const unarmed = [...options].some(option => /unarmed/.test(option));
    for (const effect of target.itemTypes.effect) {
        const retaliation = effect.flags?.[MODULE_ID]?.retaliation;
        if (!retaliation || !attacker || !melee || (reach && !unarmed)) continue;
        const damage = retaliation.damage ?? [{ formula: String(retaliation.amount), type: retaliation.type ?? "piercing", category: null }];
        await ChatMessage.create({ whisper: gmIds(), speaker: { alias: effect.name },
            content: `<p><strong>${escapeHTML(effect.name)}</strong>: ${escapeHTML(attacker.name)} damaged ${escapeHTML(target.name)} with an unarmed or non-reach melee attack — it takes ${escapeHTML(componentsFormula(damage))}.</p>`,
            flags: { [MODULE_ID]: { later: { tokenUuid: attacker.getActiveTokens(true, true)[0]?.uuid ?? null, damage, save: null, times: 1, instance: effect.flags[MODULE_ID].instance ?? null, status: "open" } } } });
    }
    if (degreeKey(context.outcome) === "criticalSuccess") {
        for (const tracker of trackersOf(target).filter(entry => (entry.flags[MODULE_ID].ends ?? []).includes("critical-hit-damage"))) {
            await ChatMessage.create({ whisper: gmIds(), content: `<p><strong>${escapeHTML(tracker.name)}</strong>: if ${escapeHTML(target.name)} takes damage from this critical hit, the metal shatters and the impulse ends.</p>`,
                flags: { [MODULE_ID]: { endImpulse: { trackerUuid: tracker.uuid, status: "open" } } } });
        }
    }
}

export function renderEndImpulseCard(message, html) {
    const data = message.flags?.[MODULE_ID]?.endImpulse;
    if (!data || !game.user.isGM) return;
    const root = html.querySelector?.(".message-content") ?? html;
    root.querySelector(".pf2e-kin-end")?.remove();
    const element = document.createElement("div");
    element.className = "pf2e-kin-end";
    element.innerHTML = data.status !== "open" ? `<p><em>${escapeHTML(data.status)}</em></p>` : `<button type="button">It took the damage: end the impulse</button>`;
    root.appendChild(element);
    element.querySelector("button")?.addEventListener("click", async () => {
        const tracker = await fromUuid(data.trackerUuid).catch(() => null);
        if (tracker) await tracker.delete();
        await message.update({ [`flags.${MODULE_ID}.endImpulse.status`]: "Ended." });
    });
}
