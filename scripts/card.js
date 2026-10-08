// The impulse resolution card: one chat message per use of an impulse, holding the plan and what has happened (targets, saves, attack results,
// the damage or healing roll, the answers to its questions). Anyone can roll what they own; the active GM confirms and applies. Every write to the
// card and to other actors goes through the active GM (socket "card-op").
import { MODULE_ID, SOCKET, isActiveGM, escapeHTML, clone, randomID, notifyError, classDC, degreeKey, tokenOf, DamageRollClass, componentsFormula } from "./utils.js";
import { readImpulse } from "../src/reader/impulse-reader.js";
import { resolveSave, resolveAttack, resolveHealing, targetDecisions, saveAdjustment, impulseLifecycle, modePlan, counteracts, DEGREES } from "../src/core/resolve.js";
import { impulseJunctionsFor, overflowEndsAura, roundKey } from "../src/core/kineticist.js";
import { impulseCountsAs, countsAsDomains, nextAttackNumber } from "../src/core/impulse-as.js";
import { applyChanges, createEffect, storedRoll } from "./apply.js";
import { startTracker } from "./tracker.js";
import { endKineticAura, applyStance, kineticAuraOf } from "./aura.js";
import { rollImpulseDamage } from "./rolls.js";
import { placeCreations } from "./creations.js";
import { resolveSpellEquivalent } from "./spells.js";
import { applyArmor } from "./armor.js";
import { blastFamily, renderBlast, blastOps, matterAttack } from "./blast.js";

const DEGREE_LABEL = { criticalSuccess: "Critical Success", success: "Success", failure: "Failure", criticalFailure: "Critical Failure" };
const ATTACK_LABEL = { criticalSuccess: "Critical Hit", success: "Hit", failure: "Miss", criticalFailure: "Critical Miss" };

// ---------------------------------------------------------------- reading an impulse for an actor

/** Extra roll data the impulse texts read from the actor ("@actor.flags.system.kineticist.thermalNimbus"). */
function rollDataPaths(actor) {
    const nimbus = actor?.flags?.system?.kineticist?.thermalNimbus;
    return nimbus ? { "@actor.flags.system.kineticist.thermalNimbus": nimbus } : {};
}

export function planFor(item, actor) {
    const plan = readImpulse(item.toObject ? item.toObject() : item, { level: Number(actor?.level ?? item?.level ?? 1), data: rollDataPaths(actor) });
    plan.source.uuid = item.uuid ?? plan.source.uuid;
    // (Thermal Nimbus: the damage type the stance chose.)
    for (const component of plan.resolution.aura?.triggers?.flatMap(trigger => trigger.damage ?? []) ?? []) {
        if (!component.type && component.typeFrom) component.type = actor?.flags?.system?.kineticist?.thermalNimbus ?? null;
    }
    return plan;
}

/** Is this item an impulse the module resolves (PF2e's or a "+" module's)? Elemental Blast itself is PF2e's. */
export function isImpulse(item) {
    const traits = item?.system?.traits?.value ?? [];
    if (item?.system?.slug === "elemental-blast" || item?.name === "Elemental Blast") return false;
    // (Active Kineticist feats that aren't impulses — Elemental Transformation's Elemental Form — resolve the same way; infusions arm the next blast instead.)
    const active = ["action", "reaction", "free"].includes(item?.system?.actionType?.value);
    return traits.includes("impulse") || (traits.includes("kineticist") && active && !traits.includes("infusion") && item?.type === "feat");
}

// ---------------------------------------------------------------- card state

const stateOf = message => clone(message?.flags?.[MODULE_ID]?.card ?? null);

function targetEntry(token) {
    const document = token.document ?? token;
    const actor = document.actor;
    return { id: randomID(), tokenUuid: document.uuid, actorUuid: actor?.uuid ?? null, name: document.name ?? actor?.name ?? "?", img: document.texture?.src ?? actor?.img ?? "",
        degree: null, total: null, natural: null, excluded: false, applied: false, traits: [...(actor?.traits ?? actor?.system?.traits?.value ?? [])], level: Number(actor?.level ?? 0),
        wearsMetalArmor: Boolean(actor?.wornArmor?.material?.type && ["iron", "steel", "cold-iron", "silver", "mithral", "adamantine", "orichalcum", "dawnsilver", "duskwood"].includes(actor.wornArmor.material.type))
            || Boolean(actor?.wornArmor && ["plate", "chain"].includes(actor.wornArmor.group)), ally: false };
}

/**
 * Open a resolution card for a use of an impulse.
 * @param {object} args { item, actor, token, message (the impulse's own chat card), targets (tokens) }
 */
export async function openCard({ item, actor, token = null, message = null, targets = null, repeat = null }) {
    const plan = repeat ? repeatPlan(planFor(item, actor), repeat) : planFor(item, actor);
    const tokens = [...(targets ?? game.user.targets ?? [])];
    const state = {
        version: 1,
        id: randomID(),
        status: "open",
        itemUuid: item.uuid,
        itemName: item.name,
        sourceActorUuid: actor.uuid,
        sourceTokenUuid: token?.uuid ?? tokenOf(actor)?.uuid ?? null,
        impulseMessageId: message?.id ?? null,
        level: plan.level,
        countsAs: impulseCountsAs(plan.activation.time, countsAsEnabled()),
        dc: null,
        plan,
        mode: null,
        areaChoice: plan.targeting.areaChoices ? 0 : null,
        // (A creature temporarily immune to this impulse starts excluded; the GM can include it.)
        targets: tokens.filter(t => (t.document ?? t).actor).map(targetEntry).map(entry => ({ ...entry, ally: entry.actorUuid === actor.uuid || isAlly(actor, entry), excluded: immuneTo(entry, { plan }) })),
        answers: {},
        damage: null,
        healing: null,
        junctions: { offers: repeat ? [] : impulseJunctionsFor(plan, actor.getRollOptions?.() ?? [], { usedThisRound: junctionUsed(actor) }), accepted: [], choices: {} },
        overflow: !repeat && overflowEndsAura(plan) ? { pending: hasKineticAura(actor) } : null,
        repeat: Boolean(repeat),
        rage: rageTrait(actor, plan),
        log: [],
        user: game.user.id
    };
    if (plan.resolution.modes?.length && plan.resolution.modes.some(mode => mode.sharedDamage || mode.save)) state.mode = null;
    // (Counting as a spell: the DC takes spell-DC modifiers too.)
    state.dc = impulseDC(actor, state.countsAs) ?? classDC(actor);
    // (Counting as a Strike or with an attack roll: this turn's multiple attack penalty.)
    state.attackNumber = nextAttackNumber(mapCount(actor));
    // (Counting as a spell: casting rules — a stupefied kineticist's flat check, DC 5 + the value.)
    if (state.countsAs === "spell" && !repeat) state.disrupted = await stupefiedCheck(actor, item.name);
    return requestOp("create", { state });
}

/** A Sustain's repeat: the impulse's own plan once more, or the repeat's stated damage and save (Hell of 1,000,000 Needles, the weeping willow). */
export function repeatPlan(plan, repeat) {
    const out = clone(plan);
    out.kineticist.overflow = false;
    out.kineticist.impulseJunction = false;
    out.lifecycle = { ...out.lifecycle, duration: null, sustained: null, stance: false, replacesPrevious: false };
    out.resolution.terrain = null;
    out.resolution.creations = [];
    out.resolution.effects = (out.resolution.effects ?? []).filter(effect => effect.recipient !== "self");
    out.resolution.sustainRepeat = null;
    out.source.name = `${plan.source.name} (Sustained)`;
    if (repeat.damage) {
        out.resolution.kind = "save";
        out.resolution.sharedDamage = { mode: "text", rollOnce: true, components: repeat.damage, options: [], raw: null };
        out.resolution.check = { roll: "save", statistic: repeat.save?.statistic ?? "reflex", basic: repeat.save?.basic ?? true, against: { dc: "source", statistic: "class" }, adjustment: 0, options: ["area-effect"], traits: [] };
        out.resolution.outcomes = Object.fromEntries(DEGREES.map((degree, index) => [degree, { damage: { multiplier: [0, 0.5, 1, 2][index] }, conditions: [], effects: [], persistent: [], forcedMovement: null, notes: [], unaffected: false }]));
        out.targeting.who = "area";
        if (repeat.enemiesOnly) out.targeting.actorConstraints.predicates.push({ kind: "enemy" });
    }
    return out;
}

/** The world option: 1-action impulses count as Strikes and 2-action impulses as spells. */
export function countsAsEnabled() {
    try { return Boolean(game.settings.get(MODULE_ID, "impulsesAsStrikesAndSpells")); } catch (_) { return false; }
}

/** The impulse statistic, with the extra domains of a Strike or a spell (PF2e's Statistic.extend: modifiers on those selectors apply). */
export function impulseStatistic(actor, countsAs) {
    const statistic = actor?.getStatistic?.("impulse");
    if (!statistic || !countsAs) return statistic ?? null;
    const domains = countsAsDomains(countsAs);
    try { return statistic.extend({ check: { domains: domains.attack }, dc: { domains: domains.dc } }); } catch (_) { return statistic; }
}

function impulseDC(actor, countsAs) {
    const value = Number(impulseStatistic(actor, countsAs)?.dc?.value);
    return Number.isFinite(value) && value > 0 ? value : null;
}

/** Attacks the kineticist made this turn with the module's impulses (and PF2e's blasts), for the multiple attack penalty. */
export function mapCount(actor) {
    const record = actor?.flags?.[MODULE_ID]?.map;
    return record && record.turn === turnKey(actor) ? Number(record.count ?? 0) : 0;
}
function turnKey(actor) {
    const combat = game.combat;
    return combat?.started && combat.combatant?.actor?.id === actor?.id ? `${combat.id}:${combat.round}:${combat.turn}` : null;
}
export async function countAttack(actor, howMany = 1) {
    const key = turnKey(actor);
    if (!key) return;
    await actor.setFlag(MODULE_ID, "map", { turn: key, count: mapCount(actor) + howMany }).catch(() => null);
}

/** A stupefied spellcaster's flat check (DC 5 + the value): on a failure the spell — here the impulse — is lost. */
async function stupefiedCheck(actor, name) {
    const value = Number(actor?.getCondition?.("stupefied")?.value ?? actor?.itemTypes?.condition?.find(c => c.slug === "stupefied")?.value ?? 0);
    if (!value) return null;
    const roll = await new Roll("1d20").evaluate();
    const dc = 5 + value;
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${escapeHTML(name)}: stupefied flat check (DC ${dc}) — the impulse counts as a spell` });
    return roll.total >= dc ? null : { dc, total: roll.total };
}

function isAlly(actor, entry) {
    const target = fromUuidSync(entry.actorUuid);
    if (!target) return false;
    try { return actor.isAllyOf?.(target) ?? (actor.alliance && actor.alliance === target.alliance); } catch (_) { return false; }
}

function hasKineticAura(actor) {
    return Boolean(kineticAuraOf(actor));
}

/** Barbarians+ Elemental Instinct: while raging, impulses of the instinct's element gain the rage trait (and so does Sustaining them). */
function rageTrait(actor, plan) {
    const options = new Set(actor?.getRollOptions?.() ?? []);
    const raging = options.has("self:effect:rage") || Boolean(actor?.itemTypes?.effect?.some(effect => effect.slug === "effect-rage"));
    return raging && (plan.kineticist?.elements ?? []).some(element => options.has(`elemental-instinct:${element}`));
}

function junctionUsed(actor) {
    // ("You can gain only one impulse junction per round": rounds exist in an encounter; outside one there's no limit to track.)
    if (!game.combat?.started) return false;
    const key = roundKey(game.combat, game.time.worldTime);
    return actor?.flags?.[MODULE_ID]?.junctionRound === key;
}

// ---------------------------------------------------------------- the GM's operations

/** Run an operation on the active GM (locally, or over the socket). */
export async function requestOp(op, payload) {
    if (isActiveGM()) return runOp(op, payload, game.user.id);
    if (!game.users.activeGM) throw new Error("An active GM is needed to resolve impulses.");
    game.socket.emit(SOCKET, { type: "card-op", op, payload, userId: game.user.id });
    return { status: "requested" };
}

export async function onSocket(data) {
    if (data?.type !== "card-op" || !isActiveGM()) return;
    try { await runOp(data.op, data.payload, data.userId); }
    catch (error) { console.error(`${MODULE_ID} | ${data.op} failed`, error); }
}

const OPS = {
    async create({ state }, userId) {
        const actor = fromUuidSync(state.sourceActorUuid);
        const message = await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div class="pf2e-kin-card-title"><strong>${escapeHTML(state.itemName)}</strong> — impulse resolution</div>`,
            flags: { [MODULE_ID]: { card: state } }
        });
        return { status: "created", messageId: message?.id };
    },
    async update({ messageId, patch }) {
        const message = game.messages.get(messageId);
        const state = stateOf(message);
        if (!state || state.status === "applied") return { status: "locked" };
        foundry.utils.mergeObject(state, patch);
        await message.update({ [`flags.${MODULE_ID}.card`]: state });
        return { status: "updated" };
    },
    async target({ messageId, targetId, patch }) {
        const message = game.messages.get(messageId);
        const state = stateOf(message);
        const target = state?.targets.find(entry => entry.id === targetId);
        if (!target || state.status === "applied") return { status: "locked" };
        Object.assign(target, patch);
        await message.update({ [`flags.${MODULE_ID}.card`]: state });
        return { status: "updated" };
    },
    async addTargets({ messageId, tokenUuids }) {
        const message = game.messages.get(messageId);
        const state = stateOf(message);
        if (!state || state.status === "applied") return { status: "locked" };
        const actor = fromUuidSync(state.sourceActorUuid);
        for (const uuid of tokenUuids) {
            if (state.targets.some(entry => entry.tokenUuid === uuid)) continue;
            const token = fromUuidSync(uuid);
            if (token?.actor) { const entry = targetEntry(token); entry.ally = isAlly(actor, entry); state.targets.push(entry); }
        }
        await message.update({ [`flags.${MODULE_ID}.card`]: state });
        return { status: "updated" };
    },
    async apply({ messageId }, userId) {
        return applyCard(game.messages.get(messageId), userId);
    },
    /** A spell-equivalent through the spell module; repeatable (a wall's region drawn and selected first, then again). */
    async spell({ messageId }) {
        const message = game.messages.get(messageId);
        const state = stateOf(message);
        const actor = await fromUuid(state.sourceActorUuid);
        const item = await fromUuid(state.itemUuid).catch(() => null);
        const targets = await documentsFor(state);
        const log = await resolveSpellEquivalent(actor, state.plan, { sourceActor: actor, item, plan: state.plan, instanceId: state.id, targets }, state);
        await message.update({ [`flags.${MODULE_ID}.card.spellLog`]: log.join(" "), [`flags.${MODULE_ID}.card.spellResolved`]: !/couldn't|by hand|no automatic/.test(log.join(" ")) });
        return { status: "spell", log };
    },
    async cancel({ messageId }) {
        const message = game.messages.get(messageId);
        const state = stateOf(message);
        if (!state || state.status === "applied") return { status: "locked" };
        state.status = "cancelled";
        await message.update({ [`flags.${MODULE_ID}.card`]: state });
        return { status: "cancelled" };
    },
    ...blastOps
};

/** Other modules' card operations (creations, spells): registered at load to keep imports one-way. */
export function registerOp(name, handler) { OPS[name] = handler; }

async function runOp(op, payload, userId) {
    const handler = OPS[op];
    if (!handler) throw new Error(`Unknown card operation: ${op}`);
    return handler(payload, userId);
}

// ---------------------------------------------------------------- rolls (on the clicking user's client)

/** PF2e's convention: the user's "show check dialogs" setting, inverted by a shift-click. */
function skipCheckDialog(event) {
    const show = game.user.settings?.showCheckDialogs ?? true;
    return event?.shiftKey ? show : !show;
}

async function rollSave(message, state, target, event) {
    const actor = await fromUuid(target.actorUuid);
    const source = await fromUuid(state.sourceActorUuid);
    const item = await fromUuid(state.itemUuid);
    const check = (state.mode ? modePlan(state.plan, state.mode) : state.plan).resolution.check;
    if (!actor || !check) throw new Error("The target or the save is unavailable.");
    const statistic = actor.saves?.[check.statistic] ?? actor.getStatistic?.(check.statistic);
    if (!statistic) throw new Error(`${actor.name} has no ${check.statistic} save.`);
    const adjustment = saveAdjustment(state.mode ? modePlan(state.plan, state.mode) : state.plan, target, state.answers);
    const modifiers = adjustment ? [new game.pf2e.Modifier({ slug: "impulse-adjustment", label: state.itemName, modifier: adjustment, type: "circumstance" })] : [];
    const roll = await statistic.roll({
        dc: { value: state.dc, label: `${state.itemName} DC` },
        origin: source, item: item ?? undefined,
        extraRollOptions: [...(check.options ?? []), "item:trait:impulse", ...(state.plan.traits ?? []).map(trait => `item:trait:${trait}`), ...(state.plan.targeting.area ? ["area-effect"] : []), ...countsAsDomains(state.countsAs).options],
        traits: [...new Set([...(state.plan.traits ?? []), ...(check.traits ?? []), ...countsAsDomains(state.countsAs).traits])],
        modifiers,
        skipDialog: skipCheckDialog(event),
        createMessage: true
    });
    if (!roll) return;
    const degree = degreeKey(roll.degreeOfSuccess ?? roll.options?.degreeOfSuccess);
    const natural = roll.dice?.[0]?.results?.find(result => result.active)?.result ?? null;
    await requestOp("target", { messageId: message.id, targetId: target.id, patch: { degree, total: roll.total, natural } });
}

async function rollAttack(message, state, target, index, event) {
    // (Matter Blast: the module's own impulse attack from its element table.)
    if (state.plan.resolution.blast?.elements) {
        const result = await matterAttack(state, target, Math.min(3, Number(state.attackNumber ?? 1) + index));
        if (result) await requestOp("target", { messageId: message.id, targetId: target.id, patch: { degree: result.degree, total: result.total } });
        return;
    }
    const source = await fromUuid(state.sourceActorUuid);
    const actor = await fromUuid(target.actorUuid);
    const item = await fromUuid(state.itemUuid);
    const statistic = impulseStatistic(source, state.countsAs);
    if (!statistic || !actor) throw new Error("The kineticist's impulse attack or the target is unavailable.");
    const attack = state.plan.resolution.attack;
    // ("All three attacks count toward your multiple attack penalty, but it doesn't increase until after all the attacks.")
    const attackNumber = attack.mapAfterAll ? Number(state.attackNumber ?? 1) : Math.min(3, Number(state.attackNumber ?? 1) + index);
    const modifiers = [];
    if (attack.targetBonus && (state.answers[`metal:${target.id}`] ?? false)) modifiers.push(new game.pf2e.Modifier({ slug: "metal-target", label: state.itemName, modifier: attack.targetBonus.value, type: attack.targetBonus.type }));
    const roll = await statistic.roll({
        target: actor, dc: { slug: "ac" }, attackNumber, item: item ?? undefined, modifiers,
        traits: [...new Set([...state.plan.traits, ...countsAsDomains(state.countsAs).traits])], extraRollOptions: ["item:trait:impulse", ...state.plan.traits.map(trait => `item:trait:${trait}`), attack.melee ? "melee" : "ranged", `action:cost:${state.plan.activation.time}`, ...countsAsDomains(state.countsAs).options],
        label: `${state.itemName}: impulse attack`, damaging: true,
        skipDialog: skipCheckDialog(event)
    });
    if (!roll) return;
    const degree = degreeKey(roll.degreeOfSuccess ?? roll.options?.degreeOfSuccess);
    await requestOp("target", { messageId: message.id, targetId: target.id, patch: { degree, total: roll.total, natural: roll.dice?.[0]?.results?.find(result => result.active)?.result ?? null } });
}

async function rollDamage(message, state, kind = "damage") {
    const source = await fromUuid(state.sourceActorUuid);
    const item = await fromUuid(state.itemUuid);
    const mode = state.mode ? state.plan.resolution.modes.find(entry => entry.label === state.mode) : null;
    const components = kind === "healing" ? state.healingVariant ? state.plan.resolution.healing.variants.find(v => v.when === state.healingVariant)?.components : state.plan.resolution.healing?.components
        : mode?.sharedDamage?.components ?? state.plan.resolution.sharedDamage?.components;
    if (!components?.length) throw new Error("This impulse has no damage to roll.");
    const roll = await rollImpulseDamage({ actor: source, item, components, plan: state.plan, label: kind === "healing" ? "Healing" : "Damage", countsAs: kind === "healing" ? null : state.countsAs });
    if (!roll) return;
    const patch = kind === "healing" ? { healing: { json: JSON.stringify(roll.toJSON()), total: roll.total } } : { damage: { json: JSON.stringify(roll.toJSON()), total: roll.total, formula: roll.formula } };
    await requestOp("update", { messageId: message.id, patch });
}

// ---------------------------------------------------------------- applying (active GM)

async function documentsFor(state) {
    const map = new Map();
    for (const target of state.targets) {
        const token = await fromUuid(target.tokenUuid).catch(() => null);
        const actor = token?.actor ?? await fromUuid(target.actorUuid).catch(() => null);
        map.set(target.id, { actor, token });
    }
    return map;
}

async function applyCard(message, userId) {
    const state = stateOf(message);
    if (!state || state.status !== "open") return { status: "locked" };
    if (state.disrupted) return { status: "disrupted" };
    const sourceActor = await fromUuid(state.sourceActorUuid);
    const sourceToken = state.sourceTokenUuid ? await fromUuid(state.sourceTokenUuid).catch(() => null) : null;
    const item = await fromUuid(state.itemUuid).catch(() => null);
    const plan = state.mode ? modePlan(state.plan, state.mode) : state.plan;
    const instanceId = state.id;
    const targets = await documentsFor(state);
    const centredOnArea = plan.targeting.area && ["burst", "cylinder"].includes(plan.targeting.area.type) && state.areaCenter?.x != null;
    const context = { sourceActor, sourceToken, item, plan, instanceId, damageJSON: state.damage?.json ?? null, healingTotal: state.healing?.total ?? null, dc: state.dc, targets, regionUuid: state.regionUuid ?? null,
        areaCenter: centredOnArea ? state.areaCenter : null, answers: state.answers, countsAs: state.countsAs };
    const log = [];
    const r = plan.resolution;
    // The family's changes.
    let changes = [];
    if (r.kind === "attack" || (r.kind === "blast" && !r.blast?.native)) changes = resolveAttack(plan, { targets: state.targets.filter(t => !t.excluded && t.degree), answers: state.answers }).changes;
    else if (r.check) changes = resolveSave(plan, { targets: state.targets.filter(t => !t.excluded), answers: state.answers, damageTaken: state.damageTaken ?? null }).changes;
    // (Turn the Wheel of Seasons' spring: temporary HP to each targeted ally.)
    if (r.modeTempHp) for (const target of state.targets.filter(t => !t.excluded)) changes.push({ op: "tempHp", target: target.id, amount: r.modeTempHp.amount });
    // (Calcifying Sand: resistance to the triggering attack's physical damage.)
    if (r.reaction?.kind === "resistance") changes.push({ op: "effect", target: "source", effect: { generated: "reaction-resistance", name: `${plan.source.name}: resistance`, rules: [{ key: "Resistance", type: r.reaction.types.includes("physical") ? ["physical"] : r.reaction.types, value: r.reaction.value }], duration: { kind: "source-turn", edge: "end", current: true } } });
    if (r.healing && state.healing) changes.push(...resolveHealing(plan, { targets: healingRecipients(state, sourceActor) }).changes.map(change => change.op === "heal" ? { ...change, amount: state.healing.total } : change));
    // Effects the impulse gives (PF2e's linked ones or generated): on the kineticist, or on its targets.
    for (const effect of r.effects ?? []) {
        if (effect.stance || (plan.lifecycle.stance && /^Stance:/.test(effect.name ?? ""))) continue;
        if (r.healing && effect.recipient === "targets") continue;
        const recipients = effect.recipient === "self" || (!state.targets.length && effect.recipient !== "targets") ? ["source"] : effect.recipient === "targets" ? state.targets.filter(t => !t.excluded).map(t => t.id) : [];
        const extra = r.retaliation && effect.recipient === "targets" ? { retaliation: { damage: r.retaliation.damage } } : {};
        for (const id of recipients) changes.push({ op: "effect", target: id, effect: { ...effect, duration: effect.duration ?? plan.lifecycle.duration ?? null, flags: { kind: "impulse-effect", ...extra } } });
    }
    if (r.tempHp && !r.modes) changes.push({ op: "tempHp", target: "source", amount: r.tempHp.amount });
    // Junctions the kineticist accepted.
    for (const element of state.junctions.accepted ?? []) {
        const offer = state.junctions.offers.find(entry => entry.element === element);
        if (!offer?.change) continue;
        const change = clone(offer.change);
        if (change.effect?.generated === "metal-junction") change.effect.flags = { retaliation: { ...change.effect.retaliation, type: state.junctions.choices?.metal ?? "piercing" } };
        if (change.op === "move") { log.push("Water impulse junction: move the chosen creature 5 feet (10 in water) — use the target's push button."); continue; }
        changes.push(change);
    }
    log.push(...await applyChanges(changes, context));
    if (state.junctions.accepted?.length) await sourceActor.setFlag(MODULE_ID, "junctionRound", roundKey(game.combat, game.time.worldTime));
    // Families that act on the scene or the kineticist.
    if (r.kind === "stance" || plan.lifecycle.stance) log.push(...await applyStance(sourceActor, plan, context, state));
    if (r.armor) log.push(...await applyArmor(sourceActor, plan, context));
    if (r.creations?.length && !state.creationsPlaced) log.push("Creations: use “Place creations” on the card (they're placed where you click).");
    if (r.kind === "spell" && !state.spellResolved) log.push(`${r.spell.name}: use “Resolve the spell” on the card (the spell module's card follows).`);
    // The impulse's own lifetime (Sustain, area, creations, stances): its tracking Effect on the kineticist.
    const lifecycle = impulseLifecycle(plan);
    if (lifecycle.tracked) log.push(...await startTracker(sourceActor, plan, context, state));
    // Overflow: the kinetic aura deactivates.
    if (state.overflow?.pending) { await endKineticAura(sourceActor, `${plan.source.name} (overflow)`); log.push("Overflow: the kinetic aura deactivates."); }
    // (The multiple attack penalty: each impulse attack roll, and a 1-action impulse counting as a Strike, adds to this turn's count.)
    const attacks = state.targets.filter(t => t.degree && (r.attack || r.blast?.elements)).length;
    if (attacks || state.countsAs === "strike") await countAttack(sourceActor, Math.max(attacks, state.countsAs === "strike" ? 1 : 0));
    state.status = "applied";
    state.log = [...(state.log ?? []), ...log];
    for (const target of state.targets) if (!target.excluded) target.applied = true;
    await message.update({ [`flags.${MODULE_ID}.card`]: state });
    return { status: "applied", log };
}

function healingRecipients(state, sourceActor) {
    const recipients = state.targets.filter(t => !t.excluded).map(t => ({ ...t, immune: immuneTo(t, state) }));
    if (!recipients.length && sourceActor) return [{ id: "source", name: sourceActor.name }];
    return recipients;
}

function immuneTo(target, state) {
    const actor = fromUuidSync(target.actorUuid);
    return Boolean(actor?.itemTypes?.effect?.some(effect => effect.flags?.[MODULE_ID]?.immunity?.source === state.plan.source.slug));
}

// ---------------------------------------------------------------- rendering

export function renderCard(message, html) {
    const state = stateOf(message);
    if (!state) return;
    const root = html.querySelector?.(".message-content") ?? html;
    root.querySelector(".pf2e-kin-card")?.remove();
    const element = document.createElement("section");
    element.className = "pf2e-kin-card";
    element.innerHTML = cardHTML(message, state);
    root.appendChild(element);
    bindCard(message, element, state);
}

function canRollFor(actorUuid) {
    const actor = fromUuidSync(actorUuid);
    return game.user.isGM || Boolean(actor?.isOwner);
}

function cardHTML(message, state) {
    const plan = state.plan;
    const r = plan.resolution;
    const owner = canRollFor(state.sourceActorUuid);
    const locked = state.status !== "open";
    const parts = [];
    parts.push(`<p class="pf2e-kin-meta">Level ${plan.level} · class DC ${escapeHTML(state.dc ?? "?")}${plan.kineticist.overflow ? " · <strong>overflow</strong>" : ""}${plan.automation.level === "guided" ? " · <em>guided</em>" : ""}</p>`);
    if (state.countsAs) parts.push(`<p class="pf2e-kin-counts">Counts as ${state.countsAs === "strike" ? "a Strike (Strike modifiers and triggers apply; it uses this turn's multiple attack penalty" : "a spell (spell modifiers apply; it can be counterspelled and spellshaped, and spellcasting restrictions apply"}) as well as an impulse.${state.attackNumber > 1 ? ` This turn's attack number: ${state.attackNumber}.` : ""}</p>`);
    if (state.disrupted) parts.push(`<p class="pf2e-kin-overflow">Stupefied: the flat check failed (${state.disrupted.total} vs DC ${state.disrupted.dc}). The impulse is lost.</p>`);
    if (state.rage) parts.push(`<p class="pf2e-kin-rage">Elemental Instinct: this impulse gains the rage trait while you rage (and so does Sustaining it).</p>`);
    if (plan.targeting.area) parts.push(`<p>Area: ${areaText(plan, state)}</p>`);
    if (plan.targeting.areaChoices?.length > 1 && !locked) parts.push(`<p>${plan.targeting.areaChoices.map((area, index) => `<button type="button" data-kin="area-choice" data-index="${index}" ${state.areaChoice === index ? "class=\"active\"" : ""}>${escapeHTML(area.label ?? `${area.value}-foot ${area.type}`)}</button>`).join("")}</p>`);
    if (r.modes?.length) parts.push(modesHTML(state, locked));
    if (r.casterChoice) parts.push(`<p>${escapeHTML(r.casterChoice.label)}: ${r.casterChoice.options.map(option => `<button type="button" data-kin="caster-choice" data-value="${escapeHTML(option)}" ${state.answers.casterChoice === option ? "class=\"active\"" : ""}>${escapeHTML(option)}</button>`).join("")}</p>`);
    if (r.stanceChoice) parts.push(`<p>${escapeHTML(r.stanceChoice.label)}: ${r.stanceChoice.options.map(option => `<button type="button" data-kin="caster-choice" data-value="${escapeHTML(option)}" ${state.answers.casterChoice === option ? "class=\"active\"" : ""}>${escapeHTML(option)}</button>`).join("")}</p>`);
    if (plan.movement) parts.push(`<p class="pf2e-kin-move"><strong>Movement (the owner moves the token):</strong> ${plan.movement.steps.map(escapeHTML).join(" ")}</p>`);
    if (r.kind === "blast" || r.blast) parts.push(renderBlast(message, state, { owner, locked }));
    if (r.check || r.attack) parts.push(targetsHTML(state, { owner, locked }));
    else if (plan.targeting.who === "targets" || r.healing || r.effects?.some(effect => effect.recipient === "targets")) parts.push(targetsHTML(state, { owner, locked, noRolls: true }));
    const damage = state.mode ? r.modes?.find(mode => mode.label === state.mode)?.sharedDamage : r.sharedDamage;
    if (damage) parts.push(`<p>Damage: ${escapeHTML(componentsFormula(damage.components))}${state.damage ? ` → <strong>${state.damage.total}</strong>` : ""} ${!locked && owner && !state.damage ? `<button type="button" data-kin="roll-damage">Roll damage</button>` : ""}</p>`);
    if (r.healing) parts.push(`<p>Healing: ${escapeHTML(componentsFormula(r.healing.components))}${state.healing ? ` → <strong>${state.healing.total}</strong>` : ""} ${!locked && owner && !state.healing ? `<button type="button" data-kin="roll-healing">Roll healing</button>` : ""}${r.healing.variants ? r.healing.variants.map(variant => ` <button type="button" data-kin="healing-variant" data-when="${escapeHTML(variant.when)}" ${state.healingVariant === variant.when ? "class=\"active\"" : ""}>${escapeHTML(variant.when)}: ${escapeHTML(componentsFormula(variant.components))}</button>`).join("") : ""}</p>`);
    if (r.effects?.length) parts.push(`<p>Effects: ${r.effects.map(effect => `${escapeHTML(effect.name ?? effect.generated)} (${escapeHTML(effect.recipient ?? "self")})`).join(", ")}</p>`);
    if (r.terrain) parts.push(`<p>Area left behind: ${escapeHTML(terrainText(r.terrain))} ${!locked && owner ? `<button type="button" data-kin="use-region">Use the placed area</button>` : ""}${state.regionUuid ? " ✓" : ""}</p>`);
    if (r.creations?.length) parts.push(`<p>Creations: ${r.creations.map(entry => escapeHTML(creationText(entry))).join("; ")} ${owner && !state.creationsPlaced ? `<button type="button" data-kin="place-creations">Place creations</button>` : state.creationsPlaced ? "✓ placed" : ""}</p>`);
    if (r.spell) parts.push(`<p>Has the effects of <strong>${escapeHTML(r.spell.name)}</strong> (rank ${r.spell.rank}, class DC ${escapeHTML(state.dc)})${r.spell.adjustments?.length ? `: ${r.spell.adjustments.map(escapeHTML).join(" ")}` : ""}. ${owner ? `<button type="button" data-kin="resolve-spell">Resolve the spell</button>` : ""}${state.spellLog ? ` <em>${escapeHTML(state.spellLog)}</em>` : ""}</p>`);
    if (r.counteract) parts.push(`<p>Counteract: modifier class DC − 10 (${(state.dc ?? 10) - 10}), rank ${r.counteract.rank}${r.counteract.selfOnlyUnless ? " — protects only you unless a critical success" : ""}. ${owner && !locked ? `<button type="button" data-kin="counteract">Roll counteract</button>` : ""}${state.counteract ? ` → <strong>${escapeHTML(state.counteract.text)}</strong>` : ""}</p>`);
    if (r.summon) parts.push(`<p>Summon: a common elemental of level ${r.summon.maxLevel} or lower${r.summon.replacesFamiliar ? ", in your familiar's space (the familiar disappears)" : ""}. ${owner && !locked && !state.summoned ? `<button type="button" data-kin="summon">Choose and summon</button>` : state.summoned ? `✓ ${escapeHTML(state.summoned)}` : ""}</p>`);
    if (r.armor) parts.push(`<p>Armor: AC +${r.armor.acBonus}, Dex cap +${r.armor.dexCap}, check penalty ${r.armor.checkPenalty}, Speed penalty ${r.armor.speedPenalty} ft, Str ${r.armor.strength}, ${escapeHTML(r.armor.group ?? "")}${r.armor.shield ? `; ${escapeHTML(r.armor.shield.base)} in a free hand` : ""}.</p>`);
    if (state.junctions.offers?.length) parts.push(junctionsHTML(state, { owner, locked }));
    if (state.overflow?.pending) parts.push(`<p class="pf2e-kin-overflow">Overflow: the kinetic aura deactivates when this is applied.</p>`);
    const lifecycle = impulseLifecycle(plan);
    if (lifecycle.tracked) parts.push(`<p class="pf2e-kin-life">${escapeHTML(lifecycleText(plan))}</p>`);
    const notes = r.notes.filter(entry => entry.audience === "gm" ? game.user.isGM : true);
    if (notes.length) parts.push(`<ul class="pf2e-kin-notes">${notes.map(entry => `<li class="${entry.audience}">${escapeHTML(entry.text)}</li>`).join("")}</ul>`);
    if (!locked) parts.push(`<div class="pf2e-kin-actions">${game.user.isGM ? `<button type="button" data-kin="apply"><i class="fa-solid fa-check"></i> Apply (GM)</button>` : `<em>The GM confirms and applies.</em>`}${owner || game.user.isGM ? ` <button type="button" data-kin="cancel">Cancel</button>` : ""}</div>`);
    else parts.push(`<p class="pf2e-kin-status">${state.status === "applied" ? "Applied." : "Cancelled."}</p>${state.log?.length && game.user.isGM ? `<details><summary>What was applied</summary><ul>${state.log.map(line => `<li>${escapeHTML(line)}</li>`).join("")}</ul></details>` : ""}`);
    return parts.join("");
}

function areaText(plan, state) {
    const area = plan.targeting.areaChoices?.[state.areaChoice ?? 0] ?? plan.targeting.area;
    return `${area.label ?? `${area.value}-foot ${area.type}${area.width ? ` (${area.width} feet wide)` : ""}${area.cylinder ? " cylinder" : ""}`}${area.within != null ? ` within ${area.within} feet` : ""}${area.height ? `, ${area.height} feet high` : ""}`;
}

function modesHTML(state, locked) {
    const modes = state.plan.resolution.modes;
    return `<div class="pf2e-kin-modes">${modes.map(mode => `<button type="button" data-kin="mode" data-label="${escapeHTML(mode.label)}" ${state.mode === mode.label ? "class=\"active\"" : ""} ${locked ? "disabled" : ""} title="${escapeHTML(mode.text ?? "")}">${escapeHTML(mode.label)}</button>`).join("")}</div>`;
}

function targetsHTML(state, { owner, locked, noRolls = false }) {
    const plan = state.plan;
    const attack = Boolean(plan.resolution.attack || (plan.resolution.blast && !plan.resolution.blast.native));
    // (Lightning Rod and Liberating Dive read PF2e's own blast: no attack button here.)
    const rollable = Boolean(plan.resolution.attack || plan.resolution.blast?.elements || plan.resolution.check);
    const rows = state.targets.map((target, index) => {
        const canRoll = !locked && !noRolls && rollable && (attack ? owner : canRollFor(target.actorUuid));
        const decisions = targetDecisions(plan, target);
        const degree = target.degree ? `<strong>${(attack ? ATTACK_LABEL : DEGREE_LABEL)[target.degree]}</strong> (${target.total ?? "?"})` : "";
        return `<li data-target="${target.id}" class="${target.excluded ? "excluded" : ""}">
            <img src="${escapeHTML(target.img)}" width="24" height="24"> ${escapeHTML(target.name)} ${degree}
            ${canRoll && !target.degree ? `<button type="button" data-kin="${attack ? "roll-attack" : "roll-save"}" data-index="${index}">${attack ? "Attack" : "Save"}</button>` : ""}
            ${decisions.map(decision => `<label title="${escapeHTML(decision.question)}"><input type="checkbox" data-kin="answer" data-id="${decision.id}" ${(state.answers[decision.id] ?? decision.default) ? "checked" : ""} ${locked || !game.user.isGM ? "disabled" : ""}> ${escapeHTML(shortQuestion(decision.question))}</label>`).join("")}
            ${!locked && game.user.isGM ? `<button type="button" data-kin="toggle-target" data-index="${index}" title="Exclude or include">${target.excluded ? "Include" : "Exclude"}</button>` : ""}
            ${!locked && game.user.isGM && !noRolls ? `<select data-kin="set-degree" data-index="${index}"><option value="">(set)</option>${DEGREES.map(degree => `<option value="${degree}" ${target.degree === degree ? "selected" : ""}>${(attack ? ATTACK_LABEL : DEGREE_LABEL)[degree]}</option>`).join("")}</select>` : ""}
        </li>`;
    }).join("");
    const who = { area: "Creatures in the area", "passed-through": "Creatures passed through", trigger: "The triggering creature", targets: "Targets", aura: "Creatures in your kinetic aura", chosen: "Chosen creatures" }[plan.targeting.who] ?? "Targets";
    return `<div class="pf2e-kin-targets"><p>${escapeHTML(who)}${plan.targeting.maxTargets ? ` (up to ${plan.targeting.maxTargets})` : ""}: ${!locked ? `<button type="button" data-kin="add-targets">Add current targets</button>` : ""}
        ${!locked && game.user.isGM && !noRolls && state.targets.some(t => !t.degree && !t.excluded) && !attack ? `<button type="button" data-kin="roll-all">Roll all saves</button>` : ""}</p><ul>${rows || "<li><em>Target the creatures, then “Add current targets”.</em></li>"}</ul></div>`;
}

const shortQuestion = question => question.replace(/^Is the (?:creature|target) /, "").replace(/\?$/, "?");

function junctionsHTML(state, { owner, locked }) {
    return `<div class="pf2e-kin-junctions"><p><strong>Impulse junction</strong> (once per round, optional):</p>${state.junctions.offers.map(offer => {
        const accepted = state.junctions.accepted?.includes(offer.element);
        return `<p>${offer.native ? `<em>${escapeHTML(offer.label)}</em>` : `<label><input type="checkbox" data-kin="junction" data-element="${offer.element}" ${accepted ? "checked" : ""} ${locked || !owner ? "disabled" : ""}> ${escapeHTML(offer.label)}</label>`}
            ${offer.choice ? `<select data-kin="junction-choice" data-element="${offer.element}" ${locked || !owner ? "disabled" : ""}>${offer.choice.options.map(option => `<option ${state.junctions.choices?.[offer.element] === option ? "selected" : ""}>${option}</option>`).join("")}</select>` : ""}</p>`;
    }).join("")}</div>`;
}

function terrainText(terrain) {
    const parts = [];
    if (terrain.difficult) parts.push("difficult terrain");
    if (terrain.hazardous) parts.push(`hazardous terrain${terrain.hazard ? ` (${componentsFormula(terrain.hazard)} per square)` : ""}`);
    if (terrain.concealment) parts.push("concealment");
    if (terrain.turnStart) parts.push("a save at the start of a creature's turn");
    if (terrain.endTurn) parts.push(`${componentsFormula(terrain.endTurn)} to a creature ending its turn there`);
    if (terrain.inArea) parts.push("damage while in the area (once per round)");
    if (terrain.until?.kind === "source-turn") parts.push(`until the ${terrain.until.edge} of the kineticist's next turn`);
    if (terrain.until?.kind === "time") parts.push(`for ${terrain.until.rounds} rounds`);
    if (terrain.until?.kind === "gm") parts.push(terrain.until.text);
    return parts.join(", ") || "lingering area";
}

function creationText(entry) {
    const stats = [entry.size, entry.ac ? `AC ${entry.ac}` : null, entry.hardness ? `Hardness ${entry.hardness}` : null, entry.hp ? `${entry.hp} HP` : null, entry.count ? `×${entry.count}` : null].filter(Boolean).join(", ");
    return `${entry.name}${stats ? ` (${stats})` : ""}`;
}

function lifecycleText(plan) {
    const l = plan.lifecycle;
    const parts = [];
    if (l.stance) parts.push("Stance: ends when the kinetic aura deactivates or another stance starts");
    if (l.duration?.kind === "source-turn") parts.push(`Lasts until the ${l.duration.edge} of your next turn`);
    if (l.duration?.kind === "time") parts.push(`Lasts ${l.duration.rounds} rounds`);
    if (l.duration?.kind === "unlimited") parts.push("Unlimited duration");
    if (l.sustained) parts.push(`Sustain${l.sustained.maxRounds ? ` up to ${l.sustained.maxRounds >= 600 ? `${l.sustained.maxRounds / 600} hour` : `${l.sustained.maxRounds / 10} minute${l.sustained.maxRounds === 10 ? "" : "s"}`}` : ""}`);
    if (l.dismissable) parts.push("Dismissable");
    if (l.replacesPrevious) parts.push("Using it again ends the previous one");
    return parts.join(" · ");
}

function bindCard(message, element, state) {
    const handle = (selector, fn) => element.querySelectorAll(selector).forEach(node => node.addEventListener(node.tagName === "SELECT" || node.type === "checkbox" ? "change" : "click", async event => {
        event.preventDefault();
        if (node.tagName === "BUTTON") node.disabled = true;
        try { await fn(node, event); } catch (error) { notifyError(state.itemName, error); }
        finally { if (node.tagName === "BUTTON") node.disabled = false; }
    }));
    handle('[data-kin="roll-save"]', (node, event) => rollSave(message, state, state.targets[Number(node.dataset.index)], event));
    handle('[data-kin="roll-attack"]', (node, event) => rollAttack(message, state, state.targets[Number(node.dataset.index)], Number(node.dataset.index), event));
    handle('[data-kin="roll-all"]', async (node, event) => { for (const target of state.targets) if (!target.degree && !target.excluded) await rollSave(message, stateOf(game.messages.get(message.id)), target, event); });
    handle('[data-kin="roll-damage"]', () => rollDamage(message, state, "damage"));
    handle('[data-kin="roll-healing"]', () => rollDamage(message, state, "healing"));
    handle('[data-kin="healing-variant"]', node => requestOp("update", { messageId: message.id, patch: { healingVariant: state.healingVariant === node.dataset.when ? null : node.dataset.when } }));
    handle('[data-kin="add-targets"]', () => requestOp("addTargets", { messageId: message.id, tokenUuids: [...game.user.targets].map(token => token.document.uuid) }));
    handle('[data-kin="toggle-target"]', node => { const target = state.targets[Number(node.dataset.index)]; return requestOp("target", { messageId: message.id, targetId: target.id, patch: { excluded: !target.excluded } }); });
    handle('[data-kin="set-degree"]', node => { const target = state.targets[Number(node.dataset.index)]; return requestOp("target", { messageId: message.id, targetId: target.id, patch: { degree: node.value || null } }); });
    handle('[data-kin="answer"]', node => requestOp("update", { messageId: message.id, patch: { answers: { [node.dataset.id]: node.checked } } }));
    handle('[data-kin="mode"]', node => requestOp("update", { messageId: message.id, patch: { mode: node.dataset.label, damage: null } }));
    handle('[data-kin="area-choice"]', node => requestOp("update", { messageId: message.id, patch: { areaChoice: Number(node.dataset.index) } }));
    handle('[data-kin="caster-choice"]', node => requestOp("update", { messageId: message.id, patch: { answers: { casterChoice: node.dataset.value } } }));
    handle('[data-kin="junction"]', node => requestOp("update", { messageId: message.id, patch: { junctions: { accepted: node.checked ? [...new Set([...(state.junctions.accepted ?? []), node.dataset.element])] : (state.junctions.accepted ?? []).filter(e => e !== node.dataset.element) } } }));
    handle('[data-kin="junction-choice"]', node => requestOp("update", { messageId: message.id, patch: { junctions: { choices: { [node.dataset.element]: node.value } } } }));
    handle('[data-kin="use-region"]', () => useLatestRegion(message, state));
    handle('[data-kin="place-creations"]', () => placeCreations(message, state));
    handle('[data-kin="resolve-spell"]', () => requestOp("spell", { messageId: message.id }));
    handle('[data-kin="counteract"]', () => rollCounteract(message, state));
    handle('[data-kin="summon"]', () => import("./creations.js").then(module => module.summonElemental(message, state)));
    handle('[data-kin="apply"]', () => requestOp("apply", { messageId: message.id }));
    handle('[data-kin="cancel"]', () => requestOp("cancel", { messageId: message.id }));
    blastFamily.bind?.(message, element, state, handle);
}

/** Counter Element, Purify Element: class DC − 10 against the effect's counteract DC; counteracted by PF2e's rank rule. */
async function rollCounteract(message, state) {
    const values = await foundry.applications.api.DialogV2.prompt({ window: { title: `${state.itemName}: counteract` },
        content: `<p>The effect's counteract DC and rank:</p><label>DC <input type="number" name="dc" value="20"></label> <label>Rank <input type="number" name="rank" value="1"></label>`,
        ok: { label: "Roll", callback: (_event, button) => ({ dc: Number(button.form.elements.dc.value), rank: Number(button.form.elements.rank.value)}) }, rejectClose: false });
    if (!values) return;
    const actor = await fromUuid(state.sourceActorUuid);
    const modifier = (state.dc ?? 10) - 10;
    const roll = await new Roll(`1d20 + ${modifier}`).evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${escapeHTML(state.itemName)}: counteract check (DC ${values.dc})` });
    let steps = roll.total >= values.dc + 10 ? 3 : roll.total >= values.dc ? 2 : roll.total <= values.dc - 10 ? 0 : 1;
    const natural = roll.dice[0].total;
    if (natural === 20) steps = Math.min(3, steps + 1);
    if (natural === 1) steps = Math.max(0, steps - 1);
    const degree = degreeKey(steps);
    const success = counteracts(degree, state.plan.resolution.counteract.rank, values.rank);
    await requestOp("update", { messageId: message.id, patch: { counteract: { degree, text: `${degree}: ${success ? "counteracted" : "not counteracted"}` } } });
}

/** The impulse's area: the Region the user just placed with the card's template button (the latest one they created on this scene). */
async function useLatestRegion(message, state) {
    const regions = [...(canvas.scene?.regions ?? [])].filter(region => !region.flags?.[MODULE_ID]?.instance).sort((a, b) => (b._stats?.createdTime ?? 0) - (a._stats?.createdTime ?? 0));
    const region = regions.find(entry => entry._stats?.lastModifiedBy === game.user.id || entry.author?.id === game.user.id) ?? regions[0];
    if (!region) throw new Error("Place the impulse's area first (its template button on the impulse card).");
    // (The creatures in it are the card's targets.)
    const tokens = (canvas.scene?.tokens ?? []).filter(token => token.actor && region.testPoint?.({ x: token.x + token.width * canvas.grid.size / 2, y: token.y + token.height * canvas.grid.size / 2, elevation: token.elevation ?? 0 }));
    await requestOp("update", { messageId: message.id, patch: { regionUuid: region.uuid, areaCenter: { x: region.shapes?.[0]?.x ?? null, y: region.shapes?.[0]?.y ?? null } } });
    if (tokens.length) await requestOp("addTargets", { messageId: message.id, tokenUuids: tokens.map(token => token.uuid) });
}

export { stateOf };

// (The blast family's handlers reach the card's operations through this, keeping blast.js free of a circular import.)
blastFamily.card = { requestOp, stateOf };
