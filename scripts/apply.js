// The apply layer: Change ops (src/core/resolve.js) → PF2e documents. Runs on the active GM's client only (cards route their Apply here).
import { MODULE_ID, clone, escapeHTML, systemDuration, DamageRollClass, componentsFormula, tokenOf } from "./utils.js";
import { forcedMove } from "./movement.js";

const ICON = "systems/pf2e/icons/default-icons/effect.svg";

/** The condition item's compendium UUID for a slug (PF2e's ConditionManager). */
export function conditionUuid(slug) {
    const condition = game.pf2e?.ConditionManager?.getCondition?.(slug);
    return condition?.sourceId ?? condition?._stats?.compendiumSource ?? condition?.uuid ?? null;
}

/** The context PF2e reads from an Effect's origin ("origin:signature", the origin actor's initiative for turn-based expiry). */
function originContext(context) {
    const actor = context.sourceActor, token = context.sourceToken, item = context.item;
    return { origin: { actor: actor?.uuid ?? null, token: token?.uuid ?? null, item: item?.uuid ?? null, spellcasting: null, rollOptions: [...(item?.getRollOptions?.("origin:item") ?? []), ...(actor?.getSelfRollOptions?.("origin") ?? [])] }, target: null, roll: null };
}

/** The initiative a turn-edged duration counts from: the source's for "your next turn", the target's for "its next turn". */
function startInitiative(duration, context, targetActor) {
    const combat = game.combat;
    if (!combat?.started || !duration) return null;
    const actor = duration.kind === "target-turn" ? targetActor : context.sourceActor;
    return combat.combatants.find(combatant => combatant.actor?.uuid === actor?.uuid || combatant.actorId === actor?.id)?.initiative ?? null;
}

/**
 * A generated Effect's source: its rules, granted conditions, duration and the module's flags (the impulse instance it belongs to, how it ends).
 * spec: { name, rules, conditions: [{slug, value}], duration, text, img, flags }
 */
export function effectSource(spec, context, targetActor) {
    const rules = clone(spec.rules ?? []);
    for (const condition of spec.conditions ?? []) {
        const uuid = conditionUuid(condition.slug);
        if (!uuid) continue;
        rules.push({ key: "GrantItem", uuid, onDeleteActions: { grantee: "restrict" }, ...(condition.value != null ? { alterations: [{ mode: "override", property: "badge-value", value: condition.value }] } : {}) });
    }
    const duration = systemDuration(spec.duration);
    const description = [spec.text ? `<p>${escapeHTML(spec.text)}</p>` : "", `<p>From <strong>${escapeHTML(context.item?.name ?? context.plan?.source?.name ?? "an impulse")}</strong> (${escapeHTML(context.sourceActor?.name ?? "")}).</p>`, untilText(spec.duration)].join("");
    return {
        type: "effect",
        name: spec.name ?? context.plan?.source?.name ?? "Impulse",
        img: spec.img ?? context.item?.img ?? ICON,
        system: {
            description: { value: description },
            duration,
            rules,
            level: { value: Number(context.plan?.level ?? context.sourceActor?.level ?? 1) },
            tokenIcon: { show: true },
            unidentified: false,
            start: { value: game.time.worldTime, initiative: startInitiative(spec.duration, context, targetActor) },
            context: originContext(context),
            traits: { value: [...(spec.traits ?? [])], otherTags: [] }
        },
        flags: { [MODULE_ID]: { instance: context.instanceId ?? null, impulse: context.plan?.source?.slug ?? null, sourceActor: context.sourceActor?.uuid ?? null, duration: spec.duration ?? null,
            ...(spec.immunity ? { immunity: spec.immunity } : {}), ...(spec.endsWithSourceAura ? { endsWithSourceAura: true } : {}), ...(spec.generated ? { generated: spec.generated } : {}), ...(spec.flags ?? {}) } }
    };
}

function untilText(duration) {
    if (!duration) return "";
    const text = {
        "source-turn": `Until the ${duration.edge} of the kineticist's next turn.`,
        "target-turn": `Until the ${duration.edge} of its next turn.`,
        impulse: "As long as the impulse lasts (ends with it).",
        area: "As long as it remains in the area.",
        escape: "Until it Escapes (DC: the kineticist's class DC).",
        linked: `Until it's no longer ${duration.to}.`
    }[duration.kind];
    return text ? `<p><em>${escapeHTML(text)}</em></p>` : "";
}

/** Create an Effect (PF2e's by UUID, or a generated one) on an actor. Returns the created item. */
export async function createEffect(actor, spec, context) {
    let source;
    if (spec.uuid) {
        const found = await fromUuid(spec.uuid).catch(() => null);
        if (!found) throw new Error(`${spec.name ?? spec.uuid} couldn't be found.`);
        source = found.toObject();
        source.system.context = originContext(context);
        source.system.level = { value: Number(context.plan?.level ?? context.sourceActor?.level ?? 1) };
        source.system.start = { value: game.time.worldTime, initiative: startInitiative(spec.duration, context, actor) };
        if (spec.duration && source.system.duration?.unit === "unlimited") source.system.duration = systemDuration(spec.duration);
        source._stats = { ...(source._stats ?? {}), compendiumSource: spec.uuid };
        source.flags = foundry.utils.mergeObject(source.flags ?? {}, { [MODULE_ID]: { instance: context.instanceId ?? null, impulse: context.plan?.source?.slug ?? null, sourceActor: context.sourceActor?.uuid ?? null, duration: spec.duration ?? null, ...(spec.flags ?? {}) } });
        // (A stance Effect's ChoiceSet answered on the card: Thermal Nimbus' cold or fire. PF2e reads the selection from the rule and the item's flags.)
        if (spec.choices) for (const rule of source.system.rules ?? []) if (rule.key === "ChoiceSet" && rule.flag && spec.choices[rule.flag] != null) {
            rule.selection = spec.choices[rule.flag];
            foundry.utils.setProperty(source, `flags.pf2e.rulesSelections.${rule.flag}`, spec.choices[rule.flag]);
        }
    } else source = effectSource(spec, context, actor);
    const [created] = await actor.createEmbeddedDocuments("Item", [source]);
    // (PF2e sets start.initiative from the origin actor's combatant; a target-turn duration counts from the target's.)
    const wanted = startInitiative(spec.duration, context, actor);
    if (created && wanted != null && created.system?.start?.initiative !== wanted) await created.update({ "system.start.initiative": wanted }).catch(() => null);
    return created ?? null;
}

/** A condition: an untimed one directly (PF2e's own condition), a timed or linked one inside a module Effect. */
export async function applyCondition(actor, change, context) {
    const duration = change.duration;
    if (!duration) {
        // (PF2e's increaseCondition ADDS its value: a new valued condition is created from its source at the text's value; a higher one stays.)
        const existing = actor.getCondition?.(change.slug) ?? actor.itemTypes?.condition?.find(item => item.slug === change.slug) ?? null;
        if (existing) {
            if (change.value != null && Number(existing.value ?? 0) < change.value) return existing.update({ "system.value.value": change.value });
            return existing;
        }
        const condition = game.pf2e?.ConditionManager?.getCondition?.(change.slug);
        if (!condition) throw new Error(`PF2e has no "${change.slug}" condition.`);
        const source = condition.toObject();
        if (change.value != null && source.system?.value) source.system.value.value = change.value;
        const [created] = await actor.createEmbeddedDocuments("Item", [source]);
        return created ?? null;
    }
    const label = `${change.slug.replace(/(^|-)([a-z])/g, (_, dash, letter) => `${dash ? " " : ""}${letter.toUpperCase()}`)}${change.value != null ? ` ${change.value}` : ""}`;
    return createEffect(actor, { name: `${context.plan?.source?.name ?? "Impulse"}: ${label}`, conditions: [{ slug: change.slug, value: change.value }], duration,
        flags: { kind: "condition", linkedTo: duration.kind === "linked" ? duration.to : null, areaBound: duration.kind === "area" ? context.regionUuid ?? true : null, escapeDc: duration.kind === "escape" ? context.dc : null } }, context);
}

/** The shared damage roll from a card's stored JSON, altered by a multiplier (PF2e's own half/double). */
export function storedRoll(json) {
    if (!json) return null;
    const DamageRoll = DamageRollClass();
    try { return DamageRoll.fromData(typeof json === "string" ? JSON.parse(json) : json); } catch (_) { return null; }
}

export async function applyDamageChange(actor, change, context) {
    const token = tokenOf(actor, change.tokenId);
    let damage;
    if (change.amount != null) {
        const DamageRoll = DamageRollClass();
        damage = await new DamageRoll(`${change.amount}[${change.type ?? "untyped"}]`).evaluate();
    } else if (change.components) {
        const formula = componentsFormula(change.components, { multiplier: change.multiplier ?? 1 });
        damage = await new (DamageRollClass())(formula).evaluate();
        if (context.postRiderRolls !== false) await damage.toMessage({ speaker: ChatMessage.getSpeaker({ actor: context.sourceActor }), flavor: `${escapeHTML(context.plan?.source?.name ?? "")}: ${escapeHTML(actor.name)}` }).catch(() => null);
    } else {
        const roll = storedRoll(context.damageJSON);
        if (!roll) throw new Error("Roll the damage first.");
        damage = change.multiplier === 1 ? roll : typeof roll.alter === "function" ? roll.alter(change.multiplier, 0) : Math.floor(roll.total * change.multiplier);
    }
    const rollOptions = new Set([...(context.plan?.resolution?.check ? ["area-damage"].filter(() => !!context.plan.targeting?.area) : []), ...(context.plan?.traits ?? []).map(trait => `item:trait:${trait}`), "item:trait:impulse",
        ...(context.countsAs === "spell" ? ["item:type:spell", "spell", "magical"] : context.countsAs === "strike" ? ["action:strike", "strike"] : [])]);
    return actor.applyDamage({ damage, token: token?.object ?? token ?? undefined, item: context.item ?? undefined, rollOptions, skipIWR: Boolean(change.skipIwr) });
}

export async function applyHealing(actor, amount, context) {
    if (!(amount > 0)) return null;
    const token = tokenOf(actor);
    return actor.applyDamage({ damage: -amount, token: token?.object ?? token ?? undefined, skipIWR: true, rollOptions: new Set(["item:trait:healing", "item:trait:impulse"]) });
}

export async function applyTempHp(actor, amount) {
    const current = Number(actor.system?.attributes?.hp?.temp ?? 0);
    if (amount > current) await actor.update({ "system.attributes.hp.temp": amount });
}

/**
 * Apply a list of Change ops. context: { sourceActor, sourceToken, item, plan, instanceId, damageJSON, healingTotal, dc, regionUuid, targets: Map(id → { actor, token }) }.
 * Returns a log of what was done (for the card).
 */
export async function applyChanges(changes, context) {
    const log = [];
    for (const change of changes) {
        const entry = change.target === "source" ? { actor: context.sourceActor, token: context.sourceToken } : context.targets?.get?.(change.target) ?? null;
        const actor = entry?.actor ?? null;
        try {
            switch (change.op) {
                case "damage": if (actor) { await applyDamageChange(actor, { ...change, tokenId: entry.token?.id }, context); log.push(`${actor.name}: damage ×${change.multiplier ?? 1}${change.components ? ` (${componentsFormula(change.components)})` : ""}`); } break;
                case "heal": if (actor) { const amount = change.amount ?? context.healingTotal; await applyHealing(actor, amount, context); log.push(`${actor.name}: regains ${amount} HP`); } break;
                case "tempHp": if (actor) { await applyTempHp(actor, change.amount); log.push(`${actor.name}: ${change.amount} temporary HP`); } break;
                case "condition": if (actor) { await applyCondition(actor, change, context); log.push(`${actor.name}: ${change.slug}${change.value != null ? ` ${change.value}` : ""}`); } break;
                case "effect": if (actor) { await createEffect(actor, change.effect, context); log.push(`${actor.name}: ${change.effect.name ?? "Effect"}`); } break;
                case "move": if (entry?.token) { const result = await applyMove(entry.token, change, context); log.push(`${actor?.name}: ${result}`); } break;
                case "ownership": if (actor) { await grantControl(actor, context); log.push(`${actor.name}: controlled by ${context.sourceActor?.name}`); } break;
                case "followUp": if (actor) { await createEffect(actor, { name: `${context.plan?.source?.name}: pending`, duration: null, rules: [], text: change.plan?.question ?? "A follow-up at its turn.", flags: { kind: "followUp", followUp: { when: change.when, ...change.plan, dc: context.dc } } }, context); log.push(`${actor.name}: follow-up at ${change.when}`); } break;
                case "note": log.push(`${actor?.name ? `${actor.name}: ` : ""}${change.text}`); break;
                default: log.push(`(${change.op} left to the GM)`);
            }
        } catch (error) {
            console.error(`${MODULE_ID} | ${change.op} failed`, error);
            log.push(`${actor?.name ?? "?"}: ${change.op} failed — ${error.message}`);
        }
    }
    return log;
}

async function applyMove(token, change, context) {
    const document = token.document ?? token;
    if (change.kind === "push" || change.kind === "shift") {
        const from = context.areaCenter ?? context.sourceToken?.object?.center ?? context.sourceToken?.center ?? null;
        if (!from) return `push ${change.distance} feet (no source point: move it by hand)`;
        if (!change.distance) return `pushed: ${change.text ?? "the GM moves it"}`;
        const result = await forcedMove(document, { point: from, direction: "away", feet: change.distance, reason: context.plan?.source?.name });
        return result.moved ? `pushed ${change.distance} feet${result.stoppedBy ? ` (stopped: ${result.stoppedBy})` : ""}` : `not moved (${result.stoppedBy ?? result.reason})`;
    }
    if (change.kind === "push-down" || change.kind === "descend") {
        const now = Number(document.elevation ?? 0);
        const to = Math.max(0, now - Number(change.distance ?? 0));
        if (to !== now) await document.update({ elevation: to }, { [MODULE_ID]: { forcedMovement: true } });
        return `down ${now - to} feet${change.noFallDamage ? " (no falling damage)" : ""}`;
    }
    return `${change.kind} ${change.distance ?? ""} (the GM moves it)`;
}

/** Command Elemental: the kineticist's owners control the elemental while the impulse lasts (restored when it ends). */
async function grantControl(actor, context) {
    const owners = Object.entries(context.sourceActor?.ownership ?? {}).filter(([id, level]) => id !== "default" && level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER).map(([id]) => id);
    const before = clone(actor.ownership ?? {});
    const update = Object.fromEntries(owners.map(id => [`ownership.${id}`, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER]));
    await actor.update({ ...update, [`flags.${MODULE_ID}.controlledBy`]: { instance: context.instanceId, before } });
}

/** Restore an actor's ownership after Command Elemental ends. */
export async function releaseControl(actor) {
    const record = actor?.flags?.[MODULE_ID]?.controlledBy;
    if (!record) return;
    const update = { [`flags.${MODULE_ID}.-=controlledBy`]: null };
    for (const id of Object.keys(actor.ownership ?? {})) {
        if (id === "default") continue;
        if (record.before?.[id] == null) update[`ownership.-=${id}`] = null;
        else if (record.before[id] !== actor.ownership[id]) update[`ownership.${id}`] = record.before[id];
    }
    await actor.update(update);
}
