// The pure resolver: a plan and what happened at the table (each target's degree, the answers to the card's questions) → Change ops and the
// decisions still open, in the shared plan model's format (PF2e RESOLUTION CORE/docs/plan-model.md §3–4). No Foundry: the card applies the
// changes, the Combat Simulator could too.

export const DEGREES = Object.freeze(["criticalSuccess", "success", "failure", "criticalFailure"]);
const ATTACK_MULTIPLIER = { criticalSuccess: 2, success: 1, failure: 0, criticalFailure: 0 };

/** Is an actor "metal" for the texts' "wearing metal armor, has the metal trait, or is made of metal": a guess the card pre-ticks. */
export function looksMetal(target) {
    return Boolean(target?.traits?.includes?.("metal") || target?.wearsMetalArmor);
}

/** The decisions a plan asks per target before applying (the card shows them; a default comes from the target's data). */
export function targetDecisions(plan, target) {
    const out = [];
    const r = plan.resolution;
    const metalQuestion = r.check?.targetAdjustments?.find(adjustment => adjustment.when === "metal") ?? r.attack?.targetBonus
        ?? (DEGREES.some(degree => r.outcomes?.[degree]?.persistent?.some(component => component.onlyIf === "metal")) ? { question: "Is the creature made of metal?" } : null)
        ?? (r.terrain?.affects?.metal ? { question: r.terrain.affects.question } : null)
        ?? (r.onHit?.effect?.metalQuestion ? { question: "Does the creature have the metal trait, is it made of metal, or is it wearing metal armor?" } : null);
    if (metalQuestion) out.push({ id: `metal:${target.id}`, phase: metalQuestion === r.check?.targetAdjustments?.[0] || metalQuestion === r.attack?.targetBonus ? "pre-roll" : "apply", audience: "gm",
        question: metalQuestion.question, options: [{ value: true, label: "Yes" }, { value: false, label: "No" }], default: looksMetal(target) });
    if (r.check?.onlyIf) out.push({ id: `unwilling:${target.id}`, phase: "pre-roll", audience: "gm", question: r.check.onlyIf.question, options: [{ value: true, label: "Unwilling: it saves" }, { value: false, label: "Willing: no save" }], default: !target.ally });
    if (r.check?.alreadyControlled) out.push({ id: `controlled:${target.id}`, phase: "pre-roll", audience: "gm", question: r.check.alreadyControlled.question, options: [{ value: true, label: "Yes" }, { value: false, label: "No" }], default: false });
    for (const degree of DEGREES) for (const effect of r.outcomes?.[degree]?.effects ?? []) {
        if (effect.question) out.push({ id: `effect:${effect.generated}:${target.id}`, phase: "apply", audience: "gm", question: effect.question, options: [{ value: true, label: "Yes" }, { value: false, label: "No" }], default: false });
    }
    return out;
}

/** The save's circumstance adjustment for a target (Storm Spiral's −1 for metal), from the answers. */
export function saveAdjustment(plan, target, answers = {}) {
    let total = Number(plan.resolution.check?.adjustment ?? 0);
    for (const adjustment of plan.resolution.check?.targetAdjustments ?? []) if (answers[`metal:${target.id}`] ?? looksMetal(target)) total += adjustment.value;
    return total;
}

/** A plan's own condition, with its duration resolved to the clock the card uses. */
function conditionChange(target, condition, plan, source) {
    return { op: "condition", target, slug: condition.slug, value: condition.value ?? null, duration: condition.duration ?? null, source: source ?? plan.source.name, ...(condition.escapeDc ? { escapeDc: condition.escapeDc } : {}) };
}

/**
 * Resolve a save plan for its targets.
 * @param plan     the impulse plan
 * @param context  { targets: [{ id, degree, traits, level, ally, enemy, living, voidHealing }], damage: { total, instances } | null, answers: { id: value },
 *                   source: { id, level, classDc }, mode: the chosen option (Shard Strike) }
 * @returns { changes, decisions, perTarget }
 */
export function resolveSave(plan, context) {
    const r = plan.resolution;
    const mode = context.mode ? (r.modes ?? []).find(entry => entry.label === context.mode) : null;
    const changes = [], decisions = [], perTarget = {};
    for (const target of context.targets ?? []) {
        const answers = context.answers ?? {};
        decisions.push(...targetDecisions(plan, target).filter(decision => !(decision.id in answers)));
        const list = perTarget[target.id] = [];
        if (target.excluded) continue;
        // (Willing targets of Flinging Updraft don't save: they take the full effect.)
        const willing = r.check?.onlyIf && answers[`unwilling:${target.id}`] === false;
        const degree = willing ? "criticalFailure" : target.degree;
        if (!degree) continue;
        const outcome = r.outcomes?.[degree];
        if (!outcome) continue;
        const metal = answers[`metal:${target.id}`] ?? looksMetal(target);
        // Damage: the shared roll × the degree's multiplier; persistent riders as their own instances.
        const multiplier = outcome.damage?.multiplier ?? 0;
        if (multiplier && (mode?.sharedDamage ?? r.sharedDamage)) list.push({ op: "damage", target: target.id, multiplier, roll: "shared", skipIwr: Boolean(target.extracted) });
        const persistent = [...(outcome.persistent ?? []), ...(degree === "criticalFailure" ? mode?.criticalFailure?.persistent ?? [] : [])].filter(component => !component.onlyIf || (component.onlyIf === "metal" && metal));
        if (persistent.length) list.push({ op: "damage", target: target.id, multiplier: 1, components: persistent, roll: "rider" });
        // Conditions, Effects, forced movement, notes.
        const conditions = [...(outcome.conditions ?? []), ...(degree === "criticalFailure" ? mode?.criticalFailure?.conditions ?? [] : [])];
        for (const condition of conditions) list.push(conditionChange(target.id, condition, plan));
        for (const effect of outcome.effects ?? []) {
            if (effect.question && !answers[`effect:${effect.generated}:${target.id}`]) continue;
            list.push({ op: "effect", target: target.id, effect });
        }
        if (outcome.forcedMovement) list.push({ op: "move", target: target.id, kind: outcome.forcedMovement.kind, distance: outcome.forcedMovement.distance, text: outcome.forcedMovement.text ?? null, noFallDamage: !!outcome.forcedMovement.noFallDamage });
        if (outcome.forcedJump) list.push({ op: "note", audience: "owner", target: target.id, text: `Jump: up to ${outcome.forcedJump === 1 ? "the maximum" : "half the maximum"} distance (${Math.round((r.forcedJump?.maxFeet ?? 0) * outcome.forcedJump)} feet).` });
        if (outcome.control) {
            const controlled = Number(target.level) <= outcome.control.byLevel.controlledAtMost;
            list.push(controlled ? { op: "ownership", target: target.id, owner: "source", until: "impulse" } : { op: "condition", target: target.id, slug: "slowed", value: 1, duration: { kind: "impulse" }, source: plan.source.name });
        }
        if (outcome.delayed) list.push({ op: "followUp", target: target.id, when: outcome.delayed.event, plan: { question: outcome.delayed.question, unless: outcome.delayed.unless, damage: outcome.delayed.damage, persistent: outcome.delayed.persistent } });
        if (outcome.recurringSave) list.push({ op: "followUp", target: target.id, when: outcome.recurringSave.event, plan: { recurringSave: true, statistic: r.check?.statistic, endsOn: outcome.recurringSave.endsOn } });
        for (const text of outcome.notes ?? []) list.push({ op: "note", audience: "gm", target: target.id, text });
        if (plan.resolution.fallDamage?.degrees?.includes(degree)) list.push({ op: "note", audience: "gm", target: target.id, text: "Falling damage for the drop, unless it has a fly Speed." });
        // Temporary immunity: the target's own marker, whatever the degree (Glacial Prison, Witchwood Seed), or Solar Detonation's per-condition one.
        const immunity = outcome.immunity ?? plan.trigger?.immunity;
        if (immunity?.rounds) list.push({ op: "effect", target: target.id, effect: { generated: "immunity", name: `Immune to ${plan.source.name}`, duration: { kind: "time", rounds: immunity.rounds }, immunity: { source: plan.source.slug, scope: immunity.scope ?? "target", conditions: immunity.conditions ?? null } } });
        changes.push(...list);
    }
    // (Sanguivolent Roots: half the highest damage a single creature took, as healing to the living non-enemies in the area; the card supplies the totals.)
    if (r.drainHeal && context.damageTaken) {
        const highest = Math.max(0, ...Object.values(context.damageTaken));
        const amount = Math.floor(highest * r.drainHeal.fraction);
        for (const target of context.areaCreatures ?? []) {
            if (target.enemy && target.voidHealing) changes.push({ op: "damage", target: target.id, amount, type: "vitality" });
            else if (!target.enemy && target.living) changes.push({ op: "heal", target: target.id, amount });
        }
    }
    return { changes, decisions, perTarget };
}

/**
 * Resolve an impulse attack: each target's attack degree → damage (double on a critical hit) and the on-hit rider.
 * context: { targets: [{ id, degree }], answers }
 */
export function resolveAttack(plan, context) {
    const changes = [], decisions = [];
    for (const target of context.targets ?? []) {
        decisions.push(...targetDecisions(plan, target).filter(decision => !(decision.id in (context.answers ?? {}))));
        const multiplier = ATTACK_MULTIPLIER[target.degree] ?? 0;
        if (!multiplier) continue;
        const r = plan.resolution;
        if (r.sharedDamage || r.blast?.extraDamage || r.blast?.elements) changes.push({ op: "damage", target: target.id, multiplier: r.blast?.extraDamage && !r.blast?.elements ? 1 : multiplier, roll: target.rollId ?? "shared" });
        const effect = plan.resolution.onHit?.effect;
        if (effect) {
            const metal = (context.answers ?? {})[`metal:${target.id}`] ?? looksMetal(target);
            changes.push({ op: "effect", target: target.id, effect: effect.metalRules && metal ? { ...effect, rules: effect.metalRules } : effect });
        }
    }
    return { changes, decisions };
}

/** Resolve healing: one roll for the recipients (Torrent in the Blood's area, Ocean's Balm's touch). */
export function resolveHealing(plan, context) {
    const changes = [];
    const r = plan.resolution;
    for (const target of context.targets ?? []) {
        if (target.excluded) continue;
        if (target.immune) { changes.push({ op: "note", audience: "gm", target: target.id, text: `Temporarily immune to ${plan.source.name}.` }); continue; }
        changes.push({ op: "heal", target: target.id, roll: "healing" });
        for (const effect of r.effects ?? []) if (effect.recipient === "targets" && (effect.rules?.length || effect.uuid)) changes.push({ op: "effect", target: target.id, effect });
        if (plan.trigger?.immunity?.rounds) changes.push({ op: "effect", target: target.id, effect: { generated: "immunity", name: `Immune to ${plan.source.name}`, duration: { kind: "time", rounds: plan.trigger.immunity.rounds }, immunity: { source: plan.source.slug, scope: "target" } } });
        if (r.healing?.afflictionSave) changes.push({ op: "note", audience: "owner", target: target.id, text: "It can attempt a new save against one poison or disease affliction affecting it; on a failed save, the condition doesn't worsen." });
        if (r.healing?.maladySave) changes.push({ op: "note", audience: "owner", target: target.id, text: "It can attempt a new save against one malady of the chosen kind." });
        if (r.healing?.persistentHelp) changes.push({ op: "note", audience: "owner", target: target.id, text: `If it has persistent ${r.healing.persistentHelp} damage, it can attempt a flat check to remove it with especially appropriate help.` });
    }
    return { changes, decisions: [] };
}

/** Which degree an aura trigger's save gives, and the changes for it (Drifting Pollen, Winter Sleet). */
export function resolveAuraTrigger(trigger, target, degree) {
    const changes = [];
    if (trigger.damage && trigger.save?.basic) {
        const multiplier = { criticalSuccess: 0, success: 0.5, failure: 1, criticalFailure: 2 }[degree];
        if (multiplier) changes.push({ op: "damage", target: target.id, multiplier, components: trigger.damage });
    } else if (trigger.damage && !trigger.save) changes.push({ op: "damage", target: target.id, multiplier: 1, components: trigger.damage });
    for (const condition of trigger.outcomes?.[degree] ?? []) changes.push({ op: "condition", target: target.id, slug: condition.slug, value: condition.value ?? null, duration: condition.duration ?? null });
    if (trigger.push && trigger.push[degree]) changes.push({ op: "move", target: target.id, kind: "push", distance: trigger.push[degree] });
    return changes;
}

/** The duration as rounds on PF2e's clock (for Effects), with the turn edge where it has one. */
export function effectDuration(duration) {
    if (!duration) return { value: -1, unit: "unlimited", expiry: null, sustained: false };
    switch (duration.kind) {
        case "time": return { value: duration.rounds, unit: "rounds", expiry: "turn-start", sustained: false };
        case "source-turn": return { value: duration.current ? 0 : 1, unit: "rounds", expiry: duration.edge === "start" ? "turn-start" : "turn-end", sustained: false, clock: "source" };
        case "target-turn": return { value: duration.current ? 0 : 1, unit: "rounds", expiry: duration.edge === "start" ? "turn-start" : "turn-end", sustained: false, clock: "target" };
        case "unlimited": return { value: -1, unit: "unlimited", expiry: null, sustained: false };
        default: return { value: -1, unit: "unlimited", expiry: null, sustained: false, tracked: duration.kind };
    }
}

/** The impulse's lifecycle on the kineticist: its tracking Effect's duration and Sustain limit. */
export function impulseLifecycle(plan) {
    const lifecycle = plan.lifecycle ?? {};
    return {
        // (A stance's own Stance Effect is its lifetime: it ends with the aura or the next stance, so it gets no separate tracker.)
        tracked: Boolean(lifecycle.duration || lifecycle.sustained || plan.resolution.terrain || plan.resolution.creations?.length || plan.resolution.sustainRepeat || plan.resolution.armor),
        duration: effectDuration(lifecycle.duration),
        sustainMaxRounds: lifecycle.sustained?.maxRounds ?? null,
        sustainable: Boolean(lifecycle.sustained),
        dismissable: Boolean(lifecycle.dismissable),
        replacesPrevious: Boolean(lifecycle.replacesPrevious),
        endsWithAura: Boolean(lifecycle.endsWithAura),
        stance: Boolean(lifecycle.stance),
        ends: lifecycle.ends ?? []
    };
}

/**
 * The plan for a chosen option (Shard Strike's shards or spines, Turn the Wheel of Seasons' season, Usurp the Lunar Reins' Slow): the option's own
 * area, damage, save and rows replace the impulse's.
 */
export function modePlan(plan, label) {
    const mode = (plan.resolution.modes ?? []).find(entry => entry.label === label);
    if (!mode) return plan;
    const out = structuredClone(plan);
    const r = out.resolution;
    if (mode.area) out.targeting.area = mode.area;
    if (mode.sharedDamage) r.sharedDamage = mode.sharedDamage;
    if (mode.save) {
        r.kind = "save";
        r.check = { roll: "save", statistic: mode.save.statistic, basic: Boolean(mode.save.basic), against: { dc: "source", statistic: "class" }, adjustment: 0, options: ["area-effect"], traits: mode.save.traits ?? [] };
        r.outcomes = Object.fromEntries(DEGREES.map((degree, index) => [degree, { damage: { multiplier: mode.save.basic && mode.sharedDamage ? [0, 0.5, 1, 2][index] : 0 }, conditions: [], effects: [], persistent: [], forcedMovement: null, notes: [], unaffected: false }]));
        for (const [degree, conditions] of Object.entries(mode.outcomes ?? {})) r.outcomes[degree].conditions.push(...conditions.map(condition => ({ ...condition, duration: condition.duration ?? mode.duration ?? null })));
        for (const [degree, components] of Object.entries(mode.persistent ?? {})) r.outcomes[degree].persistent.push(...components);
        if (mode.who) { out.targeting.who = mode.who.kind; if (mode.who.enemiesOnly) out.targeting.actorConstraints.predicates.push({ kind: "enemy" }); if (mode.who.traits) out.targeting.actorConstraints.predicates.push({ kind: "trait", traits: mode.who.traits }); }
    }
    if (mode.criticalFailure && r.outcomes) {
        r.outcomes.criticalFailure.conditions.push(...(mode.criticalFailure.conditions ?? []));
        r.outcomes.criticalFailure.persistent.push(...(mode.criticalFailure.persistent ?? []));
    }
    if (mode.tempHp) r.modeTempHp = mode.tempHp;
    if (mode.terrain) r.terrain = { ...(r.terrain ?? {}), ...mode.terrain };
    r.modeLabel = mode.label;
    return out;
}

/** PF2e counteracting: whether a counteract check's degree counteracts an effect of a rank (Player Core: counteract rank against target rank). */
export function counteracts(degree, ownRank, targetRank) {
    if (degree === "criticalSuccess") return targetRank <= ownRank + 3;
    if (degree === "success") return targetRank <= ownRank + 1;
    if (degree === "failure") return targetRank < ownRank;
    return false;
}
