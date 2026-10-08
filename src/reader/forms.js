// The sentence forms the impulse reader knows. Each form: [pattern over a tokenized sentence (inline tags are "⟦n⟧"), (match, context, sentence) =>
// false to decline, anything else to claim]. A form writes plan parts; finishPlan() completes the plan once every sentence is read.
import { DEGREES, readDuration, conditionFromLabel, number, feet } from "./phrases.js";

export const T = "⟦(\\d+)⟧";
export const re = (source, flags = "") => new RegExp(source.replaceAll("⟦T⟧", T), flags);
export const tag = (context, index) => context.tags[Number(index)];
export const damageTag = (context, index) => { const t = tag(context, index); return t?.kind === "damage" && t.components ? t : null; };
export const checkTag = (context, index) => { const t = tag(context, index); return t?.kind === "check" ? t : null; };
export const conditionTag = (context, index) => { const t = tag(context, index); return t?.kind === "uuid" && t.condition ? t : null; };
export const uuidTag = (context, index) => { const t = tag(context, index); return t?.kind === "uuid" ? t : null; };
export const templateTag = (context, index) => { const t = tag(context, index); return t?.kind === "template" ? t : null; };

// ---------------------------------------------------------------- plan helpers

export function emptyOutcome() {
    return { damage: { multiplier: 0 }, conditions: [], effects: [], persistent: [], forcedMovement: null, notes: [], unaffected: false };
}

/** The save: its statistic and basic flag from the @Check; DC is the kineticist's class DC. */
export function setSave(context, check, { basic = check.basic } = {}) {
    const { plan } = context;
    if (!["fortitude", "reflex", "will"].includes(check.statistic)) return false;
    if (plan.resolution.check && plan.resolution.check.statistic !== check.statistic) {
        // (A second save: kept as a secondary check the card offers — Rain of Rust's start-of-turn save, a sustained repeat.)
        plan.resolution.secondaryChecks = [...(plan.resolution.secondaryChecks ?? []), { roll: "save", statistic: check.statistic, basic }];
        return true;
    }
    plan.resolution.check = { roll: "save", statistic: check.statistic, basic, against: { dc: "source", statistic: check.against === "class" || check.against === "kineticist" || !check.against ? "class" : check.against },
        adjustment: check.adjustment || 0, options: check.options ?? [], traits: check.traits ?? [] };
    plan.resolution.outcomes ??= Object.fromEntries(DEGREES.map(degree => [degree, emptyOutcome()]));
    if (basic) Object.assign(plan.resolution.outcomes.criticalSuccess.damage, { multiplier: 0 }), Object.assign(plan.resolution.outcomes.success.damage, { multiplier: 0.5 }),
    Object.assign(plan.resolution.outcomes.failure.damage, { multiplier: 1 }), Object.assign(plan.resolution.outcomes.criticalFailure.damage, { multiplier: 2 });
    if (plan.resolution.kind === "note") plan.resolution.kind = "save";
    return true;
}

export function setDamage(context, damage) {
    const { plan } = context;
    if (!damage?.components) return false;
    const healing = damage.components.every(component => component.healing);
    if (healing) {
        plan.resolution.healing = { components: damage.components, raw: damage.body ?? null, recipients: plan.resolution.healing?.recipients ?? null };
        if (plan.resolution.kind === "note") plan.resolution.kind = "heal";
        return true;
    }
    if (plan.resolution.sharedDamage && context.currentMode == null) {
        plan.resolution.extraDamage = [...(plan.resolution.extraDamage ?? []), { components: damage.components }];
        return true;
    }
    const target = context.currentMode ? context.currentMode : plan.resolution;
    target.sharedDamage = { mode: "text", rollOnce: true, components: damage.components, options: damage.options ?? [], raw: damage.body ?? null };
    return true;
}

export function who(text) {
    const t = String(text).trim().replace(/^(?:then |and )/i, "");
    if (/^(?:each|all|any) (?:living )?(?:creatures?|enem(?:y|ies)) (?:in|inside) (?:the|a|your|its) (?:area|wave|aura|fog|cylinder|column|rain|line)|^(?:each|all) (?:creatures?|enem(?:y|ies)) in (?:a|the) ⟦\d+⟧|^creatures in (?:the area|a ⟦\d+⟧)|^each creature in the area/i.test(t)) return { kind: "area", enemiesOnly: /enem/i.test(t), living: /living/i.test(t) };
    if (/^each creature (?:it passes through|you move through|you pass through)|^the first creature you pass through/i.test(t)) return { kind: "passed-through", first: /^the first/i.test(t) };
    if (/^the triggering (?:enemy|creature)|^the attacking creature/i.test(t)) return { kind: "trigger" };
    if (/^(?:the|that) (?:target|creature)$|^it$|^the elemental$/i.test(t)) return { kind: "targets" };
    if (/^each creature (?:in your kinetic aura|inside your kinetic aura)/i.test(t)) return { kind: "aura" };
    return null;
}

export function setWho(context, w) {
    if (!w) return false;
    context.plan.targeting.who ??= w.kind;
    if (w.enemiesOnly) context.plan.targeting.actorConstraints.predicates.push({ kind: "enemy" });
    if (w.living) context.plan.targeting.actorConstraints.predicates.push({ kind: "living" });
    if (w.first) context.plan.targeting.maxTargets = 1;
    return true;
}

export function outcomesFor(context) {
    const { plan } = context;
    plan.resolution.outcomes ??= Object.fromEntries(DEGREES.map(degree => [degree, emptyOutcome()]));
    return plan.resolution.outcomes;
}

/** The degrees a rider names: "fails" → failure + critical failure; "critically fails" → critical failure; "succeeds" → success + critical success. */
export function riderDegrees(phrase) {
    if (/critically fail/i.test(phrase)) return ["criticalFailure"];
    if (/fail/i.test(phrase)) return ["failure", "criticalFailure"];
    if (/critically succeed/i.test(phrase)) return ["criticalSuccess"];
    if (/succeed/i.test(phrase)) return ["success", "criticalSuccess"];
    return null;
}

export function addCondition(context, degrees, condition, duration = null, extra = {}) {
    const outcomes = outcomesFor(context);
    for (const degree of degrees) outcomes[degree].conditions.push({ ...condition, duration, ...extra });
    return true;
}

export function setLifecycle(context, patch) {
    Object.assign(context.plan.lifecycle, patch);
    return true;
}

export function sustain(text) {
    const m = /you can Sustain (?:the impulse|it|them|the form|the effect|the effects)(?: up to (\d+|one|a) (minute|hour)s?)?/i.exec(text);
    if (!m) return null;
    return { maxRounds: m[1] ? number(m[1]) * (m[2].toLowerCase() === "minute" ? 10 : 600) : null };
}

const NARRATIVE_BLOCK = /\d|⟦|save|damage|Speed|bonus|penalty|resistance|weakness|immune|Hit Points|\bHP\b|Sustain|Dismiss|lasts|until|action|Stride|Strike|Fly|Leap|target|within|creature|ally|allies|enem|difficult terrain|hazardous|concealed|invisible|\barea\b|aura|condition|DC|check|attack|regain|heal|feet|foot|Blast|impulse|Grapple|Escape|Interact|cover|light|flank|Swim|Burrow|Climb|Mount|Shield|armor|you can|can't|must|[Cc]hoose/;
const isNarrative = sentence => !NARRATIVE_BLOCK.test(sentence);

// ---------------------------------------------------------------- the forms

export const FORMS = [
    // ---- Pure narration (no number, tag or rules word): claimed as flavor.
    [/^[^⟦]+$/, (m, context, sentence) => isNarrative(sentence) ? true : false],

    // ---- Saves with damage: "<who> takes ⟦D⟧ damage with a ⟦C⟧ save against your class DC."
    [re("^(.+?) (?:takes?|taking) ⟦T⟧ damage,? with an? ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        const w = who(m[1].replace(/ has its blood drained$/i, ""));
        const check = checkTag(context, m[3]);
        if (!w || !check || !setDamage(context, damageTag(context, m[2]))) return false;
        return setWho(context, w) && setSave(context, check);
    }],
    [re("^(.+?) has its blood drained, taking ⟦T⟧ damage with an? ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        const w = who(m[1]); const check = checkTag(context, m[3]);
        if (!w || !check || !setDamage(context, damageTag(context, m[2]))) return false;
        return setWho(context, w) && setSave(context, check);
    }],
    [re("^This deals ⟦T⟧ damage with an? ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        const check = checkTag(context, m[2]);
        if (!check || !setDamage(context, damageTag(context, m[1]))) return false;
        return setWho(context, { kind: "area" }) && setSave(context, check);
    }],
    // ("It deals ⟦D⟧ damage to each creature in your kinetic aura with a ⟦C⟧ save": Steam Knight's steam, a start-of-turn option.)
    [re("^It deals ⟦T⟧ damage to each creature in your kinetic aura with an? ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        const check = checkTag(context, m[2]);
        const damage = damageTag(context, m[1]);
        if (!check || !damage) return false;
        auraTrigger(context).push({ event: "source-turn-start", optional: true, cost: "free", damage: damage.components, save: { statistic: check.statistic, basic: check.basic } });
        return true;
    }],
    // ("…takes ⟦D⟧ damage and might be pushed …, depending on its ⟦C⟧ save against your class DC." — a degree table follows.)
    [re("^(.+?) takes? ⟦T⟧ damage(?:,)? and (?:might be|can become|becomes|other effects) .*?depending on (?:the result of )?its ⟦T⟧ save(?: against your class DC)?\\.$"), (m, context) => {
        const w = who(m[1]); const check = checkTag(context, m[3]);
        if (!w || !check || !setDamage(context, damageTag(context, m[2]))) return false;
        context.degreeMode = true;
        return setWho(context, w) && setSave(context, check, { basic: false });
    }],
    // ("The creature takes ⟦D⟧ damage and other effects depending on its ⟦C⟧ save against your class DC.")
    [re("^(.+?) takes? ⟦T⟧ damage and other effects depending on its ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        const w = who(m[1]); const check = checkTag(context, m[3]);
        if (!w || !check || !setDamage(context, damageTag(context, m[2]))) return false;
        context.degreeMode = true;
        return setWho(context, w) && setSave(context, check, { basic: false });
    }],
    // ("The target takes ⟦D⟧ damage (with no damage type) and becomes susceptible to your impulses, depending on its ⟦C⟧ save against your class DC.")
    [re("^The target takes ⟦T⟧ damage \\(with no damage type\\) and becomes susceptible to your impulses, depending on its ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        const check = checkTag(context, m[2]);
        if (!check || !setDamage(context, damageTag(context, m[1]))) return false;
        context.degreeMode = true;
        return setWho(context, { kind: "targets" }) && setSave(context, check, { basic: false });
    }],
    // (A save with no damage: "It must attempt a ⟦C⟧ save against your class DC." / "Each creature in the area attempts a ⟦C⟧ save…")
    [re("^(?:It|The target|The creature|The attacking creature|(Each creature in the area|Each creature in the area or that later enters it|Each creature in a wave)) (?:must )?attempts? an? ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        const check = checkTag(context, m[2]);
        if (!check) return false;
        if (m[1]) setWho(context, { kind: "area" });
        else setWho(context, { kind: context.plan.trigger.event === "reaction" ? "trigger" : "targets" });
        context.degreeMode = !check.basic;
        return setSave(context, check);
    }],
    [re("^The target then attempts an? ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        const check = checkTag(context, m[1]);
        if (!check) return false;
        context.degreeMode = true;
        return setWho(context, { kind: "targets" }) && setSave(context, check, { basic: false });
    }],
    [re("^Target a creature you can observe within (\\d+) feet\\. It must attempt an? ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        context.plan.targeting.range = { feet: Number(m[1]) };
        return setSave(context, checkTag(context, m[2]), { basic: false }) && setWho(context, { kind: "targets" });
    }],
    [re("^It must attempt an? ⟦T⟧ save against your class DC\\.$"), (m, context) => setSave(context, checkTag(context, m[1]), { basic: false }) && setWho(context, { kind: "targets" })],

    // ---- Save riders.
    [re("^(?:A|Any) creature that (critically fails|fails)(?: its save)? is (?:also )?knocked ⟦T⟧\\.$"), (m, context) => {
        const condition = conditionTag(context, m[2]);
        return !!condition && addCondition(context, riderDegrees(m[1]), condition.condition);
    }],
    [re("^Those who (fail|critically fail) are knocked ⟦T⟧\\.$"), (m, context) => {
        const condition = conditionTag(context, m[2]);
        return !!condition && addCondition(context, riderDegrees(m[1]), condition.condition);
    }],
    [/^If a creature critically fails, you also push that creature (\d+) feet\.$/, (m, context) => push(context, { criticalFailure: Number(m[1]) })],
    [/^A creature that fails(?: its save)? is (?:battered by the waves and |also )?pushed (\d+) feet \(or (\d+) feet on a critical failure\)\.$/, (m, context) => push(context, { failure: Number(m[1]), criticalFailure: Number(m[2]) })],
    [/^A creature that fails(?: its save)? is (?:also )?pushed (\d+) feet\.$/, (m, context) => push(context, { failure: Number(m[1]), criticalFailure: Number(m[1]) })],
    [/^A creature that fails is also pushed (\d+) feet \(or (\d+) feet on a critical failure\) and coated in mud until the end of its next turn\.$/, (m, context) => {
        push(context, { failure: Number(m[1]), criticalFailure: Number(m[2]) });
        for (const degree of ["failure", "criticalFailure"]) outcomesFor(context)[degree].effects.push({ generated: "coated-in-mud", name: "Coated in Mud", duration: { kind: "target-turn", edge: "end" },
            text: "While coated in mud, the creature falls prone at the end of its movement any time it ends a move action other than a Crawl or Step. It can attempt an Acrobatics check or Reflex save against the kineticist's class DC, avoiding the fall if it succeeds." });
        return true;
    }],
    [re("^While coated in mud, the creature falls ⟦T⟧ at the end of its movement any time it ends a move action other than a ⟦T⟧ or Step\\.$"), () => true],
    [re("^The creature can attempt an Acrobatics check or ⟦T⟧ save against your class DC, avoiding the fall if it succeeds\\.$"), () => true],
    // ("A creature that critically fails takes ⟦D⟧ damage" inside an option; "A creature that fails its save also takes ⟦D⟧ damage.")
    [re("^A (metal )?creature that (fails|critically fails)(?: its save)? also takes ⟦T⟧ damage\\.$"), (m, context) => {
        const damage = damageTag(context, m[3]);
        if (!damage) return false;
        for (const degree of riderDegrees(m[2])) outcomesFor(context)[degree].persistent.push(...damage.components.map(component => ({ ...component, ...(m[1] ? { onlyIf: "metal" } : {}) })));
        return true;
    }],
    [re("^A creature that (fails|critically fails)(?: its save)? is (?:also )?⟦T⟧ (until the (?:start|end) of (?:its|your) next turn)(?: \\(or (for \\d+ minutes?|for \\d+ rounds?) on a critical failure\\))?\\.$"), (m, context) => {
        const condition = conditionTag(context, m[2]);
        if (!condition) return false;
        const base = readDuration(m[3]);
        if (m[4]) {
            addCondition(context, ["failure"], condition.condition, base);
            return addCondition(context, ["criticalFailure"], condition.condition, readDuration(m[4]));
        }
        return addCondition(context, riderDegrees(m[1]), condition.condition, base);
    }],
    [re("^A creature that fails its save is also overcome with sorrow, becoming ⟦T⟧ for as long as the willow remains, as it weeps uncontrollably\\.$"), (m, context) => {
        const condition = conditionTag(context, m[1]);
        return !!condition && addCondition(context, ["failure", "criticalFailure"], condition.condition, { kind: "impulse" });
    }],
    [re("^Each creature that fails its save is impaled, becoming ⟦T⟧ until it ⟦T⟧ \\(the DC is your class DC\\); a creature that critically failed is also off-guard as long as it's impaled\\.$"), (m, context) => {
        const condition = conditionTag(context, m[1]);
        if (!condition) return false;
        addCondition(context, ["failure", "criticalFailure"], condition.condition, { kind: "escape" }, { escapeDc: "class" });
        return addCondition(context, ["criticalFailure"], { slug: "off-guard", value: null }, { kind: "linked", to: condition.condition.slug });
    }],
    [/^A creature wearing metal armor or made of metal takes a -1 circumstance penalty to its save\.$/, (m, context) => {
        context.plan.resolution.check.targetAdjustments = [...(context.plan.resolution.check.targetAdjustments ?? []), { when: "metal", value: -1, type: "circumstance", question: "Is the creature wearing metal armor or made of metal?" }];
        return true;
    }],
    [/^Lift any creature that fails its save to any height you choose within the area, move it up to 5 feet in any direction, then drop it\.$/, (m, context) => {
        for (const degree of ["failure", "criticalFailure"]) outcomesFor(context)[degree].notes.push("Lifted to any height in the area, moved up to 5 feet, then dropped: it takes falling damage unless it has a fly Speed.");
        context.plan.resolution.fallDamage = { degrees: ["failure", "criticalFailure"], unlessFly: true };
        return true;
    }],
    [/^It takes falling damage normally unless it has a fly Speed\.$/, () => true],
    [/^Any creature dropped to 0 HP by this fire dies, reduced to a pile of ash\.$/, (m, context) => { context.plan.resolution.deathAtZero = true; return true; }],
    [/^If you die to this impulse, you return to life at the start of your next turn in the same space\.$|^When you return, you have Hit Points equal to double your level\.$/, (m, context) => { context.plan.resolution.selfRevive = { hp: 2 * context.level }; return true; }],
    [/^A creature attempts only one save, even if the flame passes through it multiple times\.$|^A creature can take (?:this )?damage (?:from [A-Z][a-z]+(?: [A-Z][a-z]+)* )?(?:only )?(?:no more than )?once per round\.$|^A creature can take damage from [A-Z][\w ]+ only once per round\.$/, (m, context) => { context.plan.resolution.oncePerRound = true; return true; }],
    [/^Damage from this impulse ignores Hardness\.$/, (m, context) => { context.plan.resolution.ignoresHardness = true; return true; }],
    [/^(?:The creature|The target) is then temporarily immune for (\d+) (hour|minute)s\.$/, (m, context) => immunity(context, m)],
    [/^Regardless of the result, that creature can't trigger [A-Z][\w ]+ again for (\d+) (hour|minute)s?\.$/, (m, context) => immunity(context, m)],
    [/^Each creature that attempts a save becomes temporarily immune to being dazzled or blinded by [A-Z][\w ]+ for (\d+) (minute|hour)s, but not the impulse's other effects\.$/, (m, context) => immunity(context, m, { scope: "conditions", conditions: ["dazzled", "blinded"] })],
    [/^Creatures with the ([a-z]+(?:, [a-z]+)*,? or [a-z]+|[a-z]+) traits? are immune\.$/, (m, context) => {
        context.plan.targeting.actorConstraints.predicates.push({ kind: "not-trait", traits: m[1].split(/,\s*(?:or\s+)?|\s+or\s+/).filter(Boolean) });
        return true;
    }],
    [/^The light from [A-Z][\w ]+ is sunlight for creatures with a particular vulnerability to sunlight\.$/, (m, context) => note(context, m[0], "owner")],
    [/^You and your space are unaffected by the quake\.$/, () => true],

    // ---- Areas: the area sentence (a template, maybe "within N feet"), with no other rules.
    [re("^(?:[^⟦]*?)⟦T⟧(?: [^⟦.]*?)?(?: within (\\d+) feet(?: of you)?)?\\.$"), (m, context, sentence) => {
        const template = templateTag(context, m[1]);
        if (!template) return false;
        const rest = sentence.replace(/⟦\d+⟧/, "AREA");
        if (/save|damage|regain|takes?|bonus|penalty|difficult|hazard|conceal|Sustain|lasts|until/i.test(rest)) return false;
        areaFrom(context, template, m[2] ? Number(m[2]) : rangeIn(sentence));
        return true;
    }],
    // ("The cylinder is ⟦T⟧ and 30 feet high, and the bottom must be within 60 feet of you.")
    [re("^The (?:cylinder|rain of stone falls in a|storm appears in a) ?⟦T⟧(?: and| in) .*?(\\d+) feet (?:high|tall)?.*?within (\\d+) feet of you\\.$"), (m, context) => {
        areaFrom(context, templateTag(context, m[1]), Number(m[3]));
        context.plan.targeting.area.height = Number(m[2]);
        return true;
    }],
    [re("^The rain of stone falls in a ⟦T⟧ and (\\d+) feet high, and the bottom must be within (\\d+) feet of you\\.$"), (m, context) => {
        areaFrom(context, templateTag(context, m[1]), Number(m[3]));
        context.plan.targeting.area.height = Number(m[2]);
        return true;
    }],
    [re("^Your hurricane appears in a cylinder that's (\\d+) feet tall, has a ⟦T⟧, and is within (\\d+) feet\\.$"), (m, context) => {
        areaFrom(context, templateTag(context, m[2]), Number(m[3]));
        context.plan.targeting.area.height = Number(m[1]);
        return true;
    }],
    [re("^You either form two ⟦T⟧ that don't overlap or you combine the hands into one ⟦T⟧\\.$"), (m, context) => {
        context.plan.targeting.areaChoices = [{ ...areaOf(templateTag(context, m[1])), count: 2, label: "two 15-foot cones that don't overlap" }, { ...areaOf(templateTag(context, m[2])), count: 1, label: "one 30-foot cone" }];
        context.plan.targeting.area = context.plan.targeting.areaChoices[1];
        return true;
    }],
    [re("^The waves move forward in your choice of a ⟦T⟧ or ⟦T⟧\\.$|^The fire fills your choice of a ⟦T⟧ within (\\d+) feet or a ⟦T⟧\\.$|^The waves appear in a ⟦T⟧, or a ⟦T⟧ if you're in a body of water\\.$"), (m, context, sentence) => {
        const templates = [...sentence.matchAll(/⟦(\d+)⟧/g)].map(x => templateTag(context, x[1])).filter(Boolean);
        context.plan.targeting.areaChoices = templates.map(t => areaOf(t));
        context.plan.targeting.area = context.plan.targeting.areaChoices[0];
        const within = /within (\d+) feet/.exec(sentence);
        if (within) context.plan.targeting.area.within = Number(within[1]);
        if (/body of water/.test(sentence)) context.plan.targeting.areaChoices[1].label = "if you're in a body of water";
        return true;
    }],
    [re("^If you're in water, you can increase these waves to a ⟦T⟧ or ⟦T⟧\\.$"), (m, context) => {
        context.plan.targeting.areaChoices.push({ ...areaOf(templateTag(context, m[1])), label: "in water" }, { ...areaOf(templateTag(context, m[2])), label: "in water" });
        return true;
    }],
    [/^This impulse affects a cube (\d+) feet in each dimension within ([\d,]+) feet\.$/, (m, context) => { context.plan.targeting.area = { type: "cube", value: Number(m[1]), within: Number(m[2].replace(",", "")) }; return true; }],
    [/^The needles lance into a cube (\d+) feet on a side within (\d+) feet\.$/, (m, context) => { context.plan.targeting.area = { type: "cube", value: Number(m[1]), within: Number(m[2]) }; return true; }],

    // ---- Terrain left by the impulse.
    [/^The ground in the area is covered in a snow drift, which is difficult terrain\.$/, (m, context) => terrain(context, { difficult: true })],
    [/^Each square of the drift lasts until it melts, either naturally or until fire damage is dealt in that square\.$/, (m, context) => terrain(context, { until: { kind: "gm", text: "until it melts naturally or fire damage is dealt in that square" } })],
    [/^Earth and stone in the area is difficult terrain until the (start|end) of your next turn\.$/, (m, context) => terrain(context, { difficult: true, until: { kind: "source-turn", edge: m[1] } })],
    [/^The flame remains briefly, making all squares in the column hazardous terrain until the end of your next turn, and you can Sustain the impulse up to 1 minute\.$/, (m, context) => {
        terrain(context, { hazardous: true, until: { kind: "source-turn", edge: "end" } });
        return setLifecycle(context, { duration: { kind: "source-turn", edge: "end" }, sustained: { maxRounds: 10 } });
    }],
    [re("^A creature takes ⟦T⟧ damage (?:each time it moves into one of these squares|for every square of the area it moves through)\\.$"), (m, context) => terrain(context, { hazardous: true, hazard: damageTag(context, m[1])?.components ?? null })],
    [re("^A creature that moves through this hazardous terrain takes ⟦T⟧ damage for every square of the area it moves into\\.$"), (m, context) => terrain(context, { hazardous: true, hazard: damageTag(context, m[1])?.components ?? null })],
    [/^The razors embed in all surfaces in the area, making them hazardous terrain for (\d+) minutes?\.$/, (m, context) => terrain(context, { hazardous: true, until: { kind: "time", rounds: Number(m[1]) * 10 } })],
    [/^Squares in the area are hazardous terrain\.$/, (m, context) => terrain(context, { hazardous: true })],
    [re("^For the next minute, rocks continue to fall, making the area difficult terrain and dealing ⟦T⟧ damage to any creature that ends its turn in the area\\.$"), (m, context) => terrain(context, { difficult: true, until: { kind: "time", rounds: 10 }, endTurn: damageTag(context, m[1])?.components ?? null })],
    [re("^Until the start of your next turn, all creatures are ⟦T⟧ while in the area, and all creatures outside the area are concealed to creatures within it\\.$"), (m, context) => terrain(context, { concealment: "both-ways", until: { kind: "source-turn", edge: "start" } })],
    [re("^All creatures in the fog are ⟦T⟧, and all creatures outside the fog become concealed to creatures within it\\.$"), (m, context) => terrain(context, { concealment: "both-ways" })],
    [/^The fog is so magically dense it impedes movement, making the area difficult terrain\.$/, (m, context) => terrain(context, { difficult: true })],
    [/^Non-magical difficult terrain on any ground the logs roll over is smashed flat; greater difficult terrain remains\.$/, (m, context) => note(context, m[0], "gm")],
    [/^The sheer mass of water extinguishes all non-magical flames in the area\.$|^Any unattended object of 1 Bulk or less in the area is pushed to the far edge of the area\.$/, (m, context) => note(context, m[0], "gm")],

    // ---- Lifecycle: durations, Sustain, Dismiss, using it again.
    [/^(?:The|Your|This|Its|These) [\w' ]+? (?:lasts?|remains?|burns|appears?) (?:for )?(until the end of your next turn|\d+ (?:rounds?|minutes?|hours?))(?:, (?:and|but) you can Sustain (?:the impulse|it|them|the form)(?: up to (?:\d+|one) (?:minute|hour)s?)?)?\.$/, (m, context, sentence) => {
        const duration = readDuration(m[1]);
        if (!duration) return false;
        return setLifecycle(context, { duration, ...(sustain(sentence) ? { sustained: sustain(sentence) } : {}) });
    }],
    [/^The [\w' ]+? (?:lasts|remains) until the end of your next turn, but you can Sustain (?:the impulse|it|them)(?: up to (\d+) (minute|hour)s?)?\.$/, (m, context, sentence) => setLifecycle(context, { duration: { kind: "source-turn", edge: "end" }, sustained: sustain(sentence) })],
    [/^(?:The impulse|It|These benefits|The effect) (?:ends|last) (?:at )?(?:the end of your next turn|until the end of your next turn), but you can Sustain (?:it|them|the impulse|the form)(?: up to (\d+) (minute|hour)s?)?\.$/, (m, context, sentence) => setLifecycle(context, { duration: { kind: "source-turn", edge: "end" }, sustained: sustain(sentence) })],
    [/^The (?:impulse|stone armor|armor|flame) (?:lasts|has) (?:for )?(\d+ (?:minutes?|hours?)|an unlimited duration)(?:, and you can Dismiss (?:this|the) impulse)?\.$/, (m, context, sentence) => setLifecycle(context, { duration: /unlimited/.test(m[1]) ? { kind: "unlimited" } : readDuration(m[1]), dismissable: /Dismiss/.test(sentence) })],
    [/^It lasts for (\d+) (minute|hour)s?\.$/, (m, context) => setLifecycle(context, { duration: readDuration(`${m[1]} ${m[2]}`) })],
    [/^The cloud lasts (\d+) minutes? but ends if you use the impulse again\.$/, (m, context) => setLifecycle(context, { duration: { kind: "time", rounds: Number(m[1]) * 10 }, replacesPrevious: true })],
    [/^(?:You can Dismiss this impulse|You can Dismiss each torch individually)\.$/, (m, context) => setLifecycle(context, { dismissable: true })],
    [/^(?:If you use (?:this impulse|[A-Z][\w' ]+) again, (?:any|the) (?:existing|previous) one ends(?:, and an ordinary tree remains)?|Using (?:this impulse|it) again (?:ends any previous one|makes)|Using this impulse again ends any previous one|If you use this impulse again, the previous one ends)\.$/, (m, context) => setLifecycle(context, { replacesPrevious: true })],
    [/^You can't use this impulse again until the previous one ends\.$|^You can't use [A-Z][\w ]+ again while you have one in effect\.$/, (m, context) => setLifecycle(context, { singleInstance: true })],
    [/^The impulse lasts for (\d+) rounds, proceeding to the next season at the start of each of your turns\.$/, (m, context) => setLifecycle(context, { duration: { kind: "time", rounds: Number(m[1]) }, advancesEachTurn: true })],
    [/^These effects last for (\d+) minutes or until your kinetic aura ends, whichever comes first$/, (m, context) => setLifecycle(context, { duration: { kind: "time", rounds: Number(m[1]) * 10 }, endsWithAura: true })],
    [/^The (?:willow tree|sun|vines|illusion|trees|hell|fog|bonfire|sphere|creation|wall|barricade|palisade|hedges|guardians) (?:remains|lasts) until the end of your next turn, (?:but|and) you can Sustain (?:it|the impulse)(?: up to (\d+) (minute|hour)s?)?\.$/, (m, context, sentence) => setLifecycle(context, { duration: { kind: "source-turn", edge: "end" }, sustained: sustain(sentence) })],
    [/^You can Sustain the impulse(?: up to (\d+) (minute|hour)s?)?\.$|^You can Sustain the impulse to (?:continue them|keep moving the element)\.$/, (m, context, sentence) => setLifecycle(context, { sustained: sustain(sentence) ?? { maxRounds: null } })],

    // ---- Impulse attacks.
    [re("^Make (?:a |an )?(melee |ranged )?⟦T⟧ rolls? against (?:up to (three|two|\\d+) creatures within (\\d+) feet of you|(?:the AC of )?(?:a|one) (?:creature|target) within (\\d+) feet)(?:; you gain a \\+1 circumstance bonus to your attack roll against any target wearing metal armor or made of metal)?\\.$"), (m, context, sentence) => {
        const check = checkTag(context, m[2]);
        if (check?.statistic !== "impulse") return false;
        context.plan.resolution.kind = "attack";
        context.plan.resolution.attack = { statistic: "impulse", against: "ac", melee: m[1]?.trim() === "melee", ranged: m[1]?.trim() === "ranged" || !m[1], maxTargets: m[3] ? number(m[3]) : 1, range: Number(m[4] ?? m[5]) || null, mapAfterAll: false,
            ...(/metal armor/.test(sentence) ? { targetBonus: { when: "metal", value: 1, type: "circumstance", question: "Is the target wearing metal armor or made of metal?" } } : {}) };
        context.plan.targeting.who = "targets";
        context.plan.targeting.maxTargets = context.plan.resolution.attack.maxTargets;
        return true;
    }],
    [re("^Attempt an ⟦T⟧ roll against the AC of a creature adjacent to the (grindstone|ballista|[a-z]+)\\.$"), (m, context) => {
        if (checkTag(context, m[1])?.statistic !== "impulse") return false;
        context.plan.resolution.kind = "attack";
        context.plan.resolution.attack = { statistic: "impulse", against: "ac", ranged: false, melee: false, maxTargets: 1, range: null, from: m[2] };
        context.plan.targeting.who = "targets";
        return true;
    }],
    [re("^Make an ⟦T⟧ roll against the AC of a target within (\\d+) feet\\.$"), (m, context) => {
        if (checkTag(context, m[1])?.statistic !== "impulse") return false;
        context.plan.resolution.kind = "attack";
        context.plan.resolution.attack = { statistic: "impulse", against: "ac", ranged: true, maxTargets: 1, range: Number(m[2]) };
        context.plan.targeting.who = "targets";
        return true;
    }],
    [/^All three attacks count toward your multiple attack penalty, but it doesn't increase until after all the attacks\.$/, (m, context) => { context.plan.resolution.attack.mapAfterAll = true; return true; }],
    [re("^(?:The metal pieces deal|The target takes|On a hit, the (?:creature|target) takes) ⟦T⟧ damage(?: on a hit)? \\(or double damage on a critical hit\\)\\.$"), (m, context) => attackDamage(context, damageTag(context, m[1]))],
    [re("^On a (?:success|hit), the target takes ⟦T⟧ damage and is wrapped in molten wire for (\\d+) minutes?\\.$"), (m, context) => {
        attackDamage(context, damageTag(context, m[1]), { critical: "double" });
        context.plan.resolution.onHit = { effect: { generated: "molten-wire", name: "Wrapped in Molten Wire", duration: { kind: "time", rounds: Number(m[2]) * 10 } } };
        return true;
    }],
    [re("^It is ⟦T⟧ and takes ⟦T⟧ damage at the start of each of its turns, with a basic Reflex save\\.$"), (m, context) => {
        const hit = context.plan.resolution.onHit?.effect;
        if (!hit) return false;
        hit.conditions = [conditionTag(context, m[1])?.condition].filter(Boolean);
        hit.turnStart = { damage: damageTag(context, m[2])?.components, save: { statistic: "reflex", basic: true } };
        return true;
    }],
    [re("^The wire's ⟦T⟧ DC is your class DC\\.$"), (m, context) => { context.plan.resolution.onHit.effect.escapeDc = "class"; return true; }],
    [/^The wire has AC (\d+) and (\d+) HP\.$/, (m, context) => { context.plan.resolution.onHit.effect.object = { ac: Number(m[1]), hp: Number(m[2]) }; return true; }],
    [re("^The impulse ends if the creature (?:⟦T⟧|Escapes) or the wire is destroyed\\.$"), (m, context) => { context.plan.resolution.onHit.effect.endsOn = ["escape", "destroyed"]; return true; }],
    // (Elemental Blast inside another impulse: Lightning Rod.)
    [/^Attempt a (\d)-action (melee or ranged|melee|ranged) Elemental Blast using the ([a-z]+) element\.$/, (m, context) => {
        context.plan.resolution.kind = "blast";
        context.plan.resolution.blast = { actions: Number(m[1]), element: m[3], mode: m[2] };
        context.plan.targeting.who = "targets";
        return true;
    }],
    [re("^On a hit, the target takes an additional ⟦T⟧ damage and is skewered with a metal rod, which gives it a –1 circumstance penalty to AC and saves against electricity; the penalty is –2 if the creature also has the metal trait, is made of metal, or is wearing metal armor\\.$"), (m, context) => {
        context.plan.resolution.blast.extraDamage = damageTag(context, m[1])?.components;
        context.plan.resolution.onHit = { effect: { generated: "skewered", name: "Skewered by a Metal Rod", duration: null, metalQuestion: true,
            rules: [{ key: "FlatModifier", selector: "ac", type: "circumstance", value: -1 }, { key: "FlatModifier", selector: "saving-throw", type: "circumstance", value: -1, predicate: ["electricity"] }],
            metalRules: [{ key: "FlatModifier", selector: "ac", type: "circumstance", value: -2 }, { key: "FlatModifier", selector: "saving-throw", type: "circumstance", value: -2, predicate: ["electricity"] }],
            endsOn: ["check"], check: { statistic: "athletics", dc: 10, action: "Interact" } } };
        return true;
    }],
    [re("^The creature can attempt to pull the rod free using an Interact action, but must succeed at a ⟦T⟧ check\\.$"), () => true],

    // ---- Healing.
    [/^Touch a willing living creature\.$|^You touch a willing creature, causing its skin to harden and form spiky protrusions\.$/, (m, context) => { context.plan.targeting.target = { count: 1, willing: true, living: /living/.test(m[0]), range: "touch" }; context.plan.targeting.who ??= "targets"; return true; }],
    [re("^It regains ⟦T⟧ HP and gains resistance (\\d+) to ([a-z]+) for (\\d+) minutes?\\.$"), (m, context) => {
        setDamage(context, damageTag(context, m[1]));
        context.plan.resolution.effects.push({ recipient: "targets", linked: true, generated: "resistance", rules: [{ key: "Resistance", type: m[3], value: Number(m[2]) }], duration: { kind: "time", rounds: Number(m[4]) * 10 } });
        return true;
    }],
    [/^If it has persistent fire damage, it can attempt a flat check to remove it with especially appropriate help\.$/, (m, context) => { context.plan.resolution.healing.persistentHelp = "fire"; return true; }],
    [/^The target is temporarily immune to healing from [A-Z][\w' ]+ for (\d+) (minute|hour)s\.$|^The creature becomes temporarily immune to [A-Z][\w' ]+ for (\d+) (minute|hour)s\.$|^Each creature that benefited from this impulse becomes temporarily immune to [A-Z][\w' ]+ for (\d+) (minute|hour)s\.$|^The target is temporarily immune to this impulse for (\d+) (hour|minute)s?\.$/, (m, context) => {
        const amount = Number(m[1] ?? m[3] ?? m[5] ?? m[7]); const unit = m[2] ?? m[4] ?? m[6] ?? m[8];
        context.plan.trigger.immunity = { scope: "target", rounds: amount * (unit === "hour" ? 600 : 10) };
        return true;
    }],
    [re("^Each creature in the area regains ⟦T⟧ HP and can attempt a new save against one poison or disease affliction affecting it; on a failed save, the condition doesn't worsen\\.$"), (m, context) => {
        setDamage(context, damageTag(context, m[1]));
        context.plan.resolution.healing.recipients = "area";
        context.plan.resolution.healing.afflictionSave = { kinds: ["poison", "disease"], failNoWorse: true };
        context.plan.targeting.who = "area";
        return true;
    }],
    [re("^Target one living creature within (\\d+) feet, who regains ⟦T⟧ HP and can attempt a new save against one malady of the chosen kind\\.$"), (m, context) => {
        setDamage(context, damageTag(context, m[2]));
        context.plan.targeting.target = { count: 1, living: true, range: Number(m[1]) };
        context.plan.targeting.who = "targets";
        context.plan.resolution.healing.maladySave = true;
        return true;
    }],
    [re("^If you chose injuries, instead increase the healing dice to ⟦T⟧\\.$"), (m, context) => {
        const injuries = damageTag(context, m[1]);
        if (!injuries) return false;
        context.plan.resolution.healing.variants = [{ when: "injuries", components: injuries.components }];
        return true;
    }],
    [re("^A small cloud of medicinal herbs heal a creature\\. The type of herbs depends on which malady you decide to treat: ⟦T⟧, disease, poison, ⟦T⟧, or injuries\\.$|^The type of herbs depends on which malady you decide to treat: ⟦T⟧, disease, poison, ⟦T⟧, or injuries\\.$"), (m, context) => {
        context.plan.resolution.casterChoice = { label: "Malady", options: ["confused", "disease", "poison", "sickened", "injuries"] };
        return true;
    }],
    [/^Alternatively, you can add the herbs to a dish of food being prepared for up to six people\.$|^Creatures who partake in the meal gain the benefits\.$|^The herbs' healing effects wear off if not eaten within an hour, though their flavor remains\.$/, (m, context) => note(context, m[0], "owner")],

    // ---- Effects on self or a target (PF2e's Effect, or one generated from the text).
    [re("^(?:For (\\d+) minutes, )?it gains a climb Speed equal to its Speed and a \\+1 circumstance bonus to Acrobatics checks to ⟦T⟧ and Athletics checks to ⟦T⟧ and ⟦T⟧\\.$"), (m, context) => linkedEffect(context, { duration: { kind: "time", rounds: Number(m[1] ?? 10) * 10 } })],
    [re("^When it Leaps, it increases the distance it can ⟦T⟧ horizontally by 5 feet and vertically by 2 feet\\.$"), () => true],
    [/^You gain resistance to damage from the triggering effect equal to your level if it's bludgeoning or slashing, or double your level if it's acid or fire damage\.$|^If the effect deals more than one applicable type of damage, apply the highest resistance, but apply it only once\.$/, (m, context) => {
        context.plan.resolution.reaction = { kind: "item-rules" };
        if (context.plan.resolution.kind === "note") context.plan.resolution.kind = "reaction";
        return true;
    }],
    [/^You gain resistance equal to your level to the triggering damage—choose one eligible type of resistance\.$|^If this reaction prevents any damage, you gain a status bonus equal to half your level to the damage roll of the next metal impulse you use before the end of your next turn\.$/, (m, context) => {
        context.plan.resolution.reaction = { kind: "item-rules" };
        if (context.plan.resolution.kind === "note") context.plan.resolution.kind = "reaction";
        return true;
    }],
    [/^You gain resistance equal to your level to physical damage from the triggering attack\.$/, (m, context) => {
        context.plan.resolution.reaction = { kind: "resistance", types: ["physical"], value: context.level, scope: "triggering-attack" };
        return true;
    }],
    [/^You become ⟦\d+⟧ until the end of your next turn\.$/, (m, context, sentence) => {
        const condition = conditionTag(context, /⟦(\d+)⟧/.exec(sentence)[1]);
        if (!condition) return false;
        context.plan.resolution.effects.push({ recipient: "self", conditions: [condition.condition], duration: { kind: "source-turn", edge: "end" } });
        if (context.plan.resolution.kind === "note") context.plan.resolution.kind = "effect";
        return true;
    }],
    [re("^Using it again within 10 minutes makes you ⟦T⟧ instead of invisible\\.$"), (m, context) => {
        context.plan.resolution.repeatWithin = { rounds: 100, replace: { from: "invisible", to: conditionTag(context, m[1])?.condition } };
        return true;
    }],
    [/^If you use a hostile action, the impulse ends after that action is completed\.$/, (m, context) => setLifecycle(context, { ends: [...context.plan.lifecycle.ends, "hostile-action"] })],
    [/^If you activate your kinetic aura, the impulse conceals its elements, though any special effects of your aura might give away your location\.$/, (m, context) => note(context, m[0], "owner")],
    [/^You gain 40 temporary Hit Points\.$|^You gain (\d+) temporary Hit Points\.$/, (m, context) => {
        context.plan.resolution.tempHp = { amount: Number(/\d+/.exec(m[0])[0]), recipient: "self" };
        return true;
    }],
    [/^After you gain temporary Hit Points from this impulse, you can't do so again for (\d+) minutes\.$/, (m, context) => { context.plan.resolution.tempHp.cooldownRounds = Number(m[1]) * 10; return true; }],
    [/^The target gains resistance (\d+) to all physical damage \(except adamantine\)\.$/, (m, context) => linkedEffect(context, {})],
    [re("^Whenever a creature damages the target with an unarmed attack or non-reach melee weapon, the attacking creature takes ⟦T⟧ damage\\.$"), (m, context) => {
        context.plan.resolution.retaliation = { damage: damageTag(context, m[1])?.components, trigger: "unarmed-or-nonreach-melee-damage", bearer: "targets" };
        return true;
    }],
    [/^This impulse lasts for (\d+) minutes, but each time the target takes physical damage, the duration decreases by 1 minute\.$/, (m, context) => setLifecycle(context, { duration: { kind: "time", rounds: Number(m[1]) * 10 }, shortensOn: { event: "physical-damage", rounds: 10 } })],
    [/^You gain a fly Speed equal to your land Speed or 30 feet, whichever is greater, for (\d+) minutes\.$/, (m, context) => linkedEffect(context, { recipient: "self", duration: { kind: "time", rounds: Number(m[1]) * 10 } })],
    [/^Unlike with a normal fly Speed, you can move upward without treating it as difficult terrain\.$|^In addition, you can remain in the air at the end of your turn if you used an air impulse during that turn, even if you didn't use a Fly action that turn\.$/, () => true],
    [/^You gain a burrow Speed equal to your land Speed and can immediately Burrow once\.$/, (m, context) => {
        context.plan.resolution.effects.push({ recipient: "self", generated: "speed", name: "Swim Through Earth", rules: [{ key: "BaseSpeed", selector: "burrow", value: "@actor.system.movement.speeds.land.value" }] });
        context.plan.movement = { kind: "burrow", now: true };
        return true;
    }],
    [/^You don't gain the ability to breathe while in the earth, so you must hold your breath\.$/, (m, context) => note(context, m[0], "owner")],
    [re("^If you're inside the earth when the impulse ends, you immediately return to the surface directly above you, fall ⟦T⟧ when you reach the surface, and are ⟦T⟧ until the end of your next turn\\.$"), (m, context) => {
        context.plan.lifecycle.onEnd = { question: "Were you inside the earth when the impulse ended?", conditions: [conditionTag(context, m[1])?.condition, { ...conditionTag(context, m[2])?.condition, duration: { kind: "target-turn", edge: "end" } }].filter(Boolean) };
        return true;
    }],
    [re("^The cooling remains of the lava form a temporary protective shell around you, granting you a \\+2 circumstance bonus to AC until the start of your next turn\\.$"), (m, context) => linkedEffect(context, { recipient: "self" })],
    [/^Ash lingers around you after your movement is complete, making you ⟦\d+⟧ until the start of your next turn\.$/, (m, context, sentence) => {
        const condition = conditionTag(context, /⟦(\d+)⟧/.exec(sentence)[1]);
        context.plan.resolution.effects.push({ recipient: "self", conditions: [condition.condition], duration: { kind: "source-turn", edge: "start" } });
        return true;
    }],

    // ---- Spells an impulse has the effects of.
    [re("^(?:This has|You gain|It gains|This impulse has) (?:the |the same )?(?:effects?|benefits) (?:of|on you as) (?:the |a |an )?⟦T⟧(?: spell)?(.*)\\.$"), (m, context) => spellEquivalent(context, uuidTag(context, m[1]), m[2])],
    [re("^You conjure a tree within (\\d+) feet, as a ⟦T⟧ spell of a rank equal to half your level rounded up\\.$"), (m, context) => spellEquivalent(context, uuidTag(context, m[2]), "", { range: Number(m[1]) })],
    [re("^You create a ⟦T⟧ within (\\d+) feet\\.$"), (m, context) => spellEquivalent(context, uuidTag(context, m[1]), "", { range: Number(m[2]) })],
    [re("^You're affected by an ⟦T⟧ spell with the same trait as your kinetic element\\.$"), (m, context) => spellEquivalent(context, uuidTag(context, m[1]), "", { traitFromElement: true })],
    [/^You can heighten it to any spell rank up to half your level rounded up\.$/, (m, context) => { if (context.plan.resolution.spell) context.plan.resolution.spell.rankChoice = { max: Math.ceil(context.level / 2) }; return true; }],
    [/^In addition to the normal choices, you can make the wall up to 10 feet long and 60 feet high\.$|^It can only be a wall \(not a hemisphere\), and you choose whether the ice is transparent or opaque\.$|^The fissures are only 10 feet deep, and the DC of the flat check for a collapse is 4 higher\.$/, (m, context) => {
        if (!context.plan.resolution.spell) return false;
        context.plan.resolution.spell.adjustments.push(m[0]);
        return true;
    }],
    [/^Your (fire|metal|earth|air) Elemental Blasts deal an additional (?:die of damage|1d10 damage of their normal type)\.$/, (m, context) => {
        context.plan.resolution.blastBonus = { element: m[1], dice: /die of damage/.test(m[0]) ? 1 : null, extra: /1d10/.test(m[0]) ? { formula: "1d10" } : null };
        return true;
    }],
    [/^You can Sustain the impulse up to 1 minute, and when you do, you can (?:Fly up to half your fly Speed|Raise a metal Shield if you're wielding one)\.$/, (m, context, sentence) => setLifecycle(context, { sustained: { maxRounds: 10, onSustain: sentence.replace(/^.*?when you do, /, "") } })],

    // ---- Stances and the kinetic aura.
    [re("^Any creature that (starts its turn in your kinetic aura or moves into your aura during its turn|enters your kinetic aura or ends its turn there) takes ⟦T⟧ damage\\.$"), (m, context) => {
        const damage = damageTag(context, m[2]);
        if (!damage) return false;
        const events = /starts its turn/.test(m[1]) ? ["turn-start", "enter"] : ["enter", "turn-end"];
        auraTrigger(context).push({ events, damage: damage.components, who: "any" });
        return true;
    }],
    [re("^A creature in your kinetic aura when you enter the stance, or who later enters the aura or ends its turn in the aura, attempts at a ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        const check = checkTag(context, m[1]);
        auraTrigger(context).push({ events: ["stance", "enter", "turn-end"], save: { statistic: check.statistic, basic: false }, outcomes: {} });
        return true;
    }],
    [re("^On a failure, it's ⟦T⟧ \\(⟦T⟧ on a critical failure\\) and ⟦T⟧ until it's no longer sickened\\.$"), (m, context) => {
        const trigger = auraTrigger(context).at(-1);
        if (!trigger?.save) return false;
        const dazzled = conditionTag(context, m[3]).condition;
        trigger.outcomes.failure = [conditionTag(context, m[1]).condition, { ...dazzled, duration: { kind: "linked", to: "sickened" } }];
        trigger.outcomes.criticalFailure = [conditionTag(context, m[2]).condition, { ...dazzled, duration: { kind: "linked", to: "sickened" } }];
        return true;
    }],
    [/^A creature attempts this save no more than once per round and doesn't attempt a new save if already affected\.$/, (m, context) => { const trigger = auraTrigger(context).at(-1); trigger.oncePerRound = true; trigger.skipIfAffected = true; return true; }],
    [/^A creature that starts its turn in the thorns takes a –10-foot circumstance penalty to its Speeds until it leaves the area\.$/, (m, context) => { auraTrigger(context).push({ events: ["turn-start"], effect: { name: "Ravel of Thorns", rules: [{ key: "FlatModifier", selector: "all-speeds", type: "circumstance", value: -10 }], duration: { kind: "area" } } }); return true; }],
    [/^The thorns are hazardous terrain\.$/, (m, context) => { context.plan.resolution.aura = { ...(context.plan.resolution.aura ?? {}), hazardous: true }; return true; }],
    [re("^A creature takes ⟦T⟧ damage each time it moves into one of these squares\\.$"), (m, context) => { context.plan.resolution.aura = { ...(context.plan.resolution.aura ?? {}), hazard: damageTag(context, m[1])?.components }; return true; }],
    [/^If any square the thorns grow on is water or soil, double the hazardous terrain damage for all thorns\.$/, (m, context) => { context.plan.resolution.aura.hazardDoubleQuestion = "Is any square the thorns grow on water or soil?"; return true; }],
    [/^If you move, the thorns disappear; new thorns grow at the end of your turn\.$/, (m, context) => note(context, m[0], "gm")],
    [/^Thorny vines grow in geometric patterns on surfaces in your kinetic aura\.$/, () => true],
    [/^At the start of each of your turns, you can emit steam as a free action\.$/, () => true],
    [/^You gain a \+10-foot status bonus to your Speed\.$|^You gain a \+10-foot status bonus to all your Speeds\.$/, (m, context) => stanceRule(context)],
    [re("^When you ⟦T⟧, you can jump up to your Speed\\.$"), (m, context) => stanceRule(context)],
    [/^You don't immediately fall at the end of a jump, provided you Leap again with your next action\.$/, () => true],
    [re("^If you Leap over a creature and come within 10 feet, that creature takes ⟦T⟧ damage with a ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        auraTrigger(context).push({ events: ["leap-over"], damage: damageTag(context, m[1])?.components, save: { statistic: checkTag(context, m[2]).statistic, basic: true }, manual: true });
        return true;
    }],
    [/^A creature that fails is also pushed 5 feet\.$/, (m, context) => {
        const trigger = auraTrigger(context).findLast(entry => entry.event === "source-turn-start");
        if (!trigger) return false;
        trigger.push = { failure: 5, criticalFailure: 5 };
        return true;
    }],
    [/^Choose (cold) or (fire)\.$/, (m, context) => { context.plan.resolution.stanceChoice = { label: "Damage type", options: [m[1], m[2]], flag: "thermalNimbus" }; return stanceRule(context); }],
    [/^You and allies in your kinetic aura gain resistance equal to your level to damage of that type\.$|^Elemental resistance from a gate junction is cumulative with resistance from Thermal Nimbus\.$/, (m, context) => stanceRule(context)],
    [/^Choose a trait matching one of your kinetic elements and target an elemental creature within (\d+) feet that has the chosen trait\.$/, (m, context) => { context.plan.targeting.target = { count: 1, range: Number(m[1]), traits: ["elemental"], elementTrait: true }; context.plan.targeting.who = "targets"; return true; }],
    [/^Choose a polarity when you take this action\.$|^You can switch the polarity as a free action at the start of each of your turns while you remain in this stance\.$/, (m, context) => { context.plan.resolution.stanceChoice = { label: "Polarity", options: ["Attract", "Repel"] }; return true; }],
    [/^Turbulent air suffuses your kinetic aura\.$|^This doesn't displace other matter but provides air for creatures in your kinetic aura that need air to breathe\.$|^Attacks with ranged weapons take a -1 circumstance penalty to their attack rolls if their paths pass through your kinetic aura\.$|^Air in your kinetic aura is difficult terrain for flying creatures other than yourself\.$/, (m, context) => stanceRule(context)],
    [/^You gain tremorsense \(imprecise\) in your kinetic aura\.$/, (m, context) => stanceRule(context)],
    [re("^Once per round, you can ⟦T⟧ a creature you can sense with tremorsense as a free action\\.$"), (m, context) => stanceRule(context)],
    [/^You and allies in your kinetic aura gain a \+1 circumstance bonus to AC\.$/, (m, context) => stanceRule(context)],
    [/^When any creature with this bonus would take damage from a physical attack, one of the plates reduces the damage by its Hardness of (\d+)\.$/, (m, context) => {
        context.plan.resolution.aura = { ...(context.plan.resolution.aura ?? {}), plates: { count: 4, hardness: Number(m[1]) } };
        return true;
    }],
    [/^If the damage exceeds the Hardness, that plate is destroyed\.$|^You can replenish all destroyed plates as a single action that has the concentrate trait\.$|^Four plates of pitted metal float around you to intercept attacks\.$/, () => true],
    [/^You and your allies in your kinetic aura gain resistance (\d+) to bludgeoning and piercing damage\.$|^In addition, you and your affected allies roll flat checks to recover from persistent damage twice and take the higher result; this is a fortune effect\.$|^Patches of bark appear on the skin of you and your nearby allies\.$/, (m, context) => stanceRule(context)],
    [/^They attempt to intercept all dangers, granting you and your allies within your kinetic aura a \+1 status bonus to AC and saving throws\.$|^The guardians flow around combatants and don't occupy a space\.$/, (m, context) => stanceRule(context)],
    [re("^If any creature affected is critically hit or critically fails at a saving throw against an attack, effect from an enemy, or hazard and remains above 0 HP, the guardians reach out to heal that creature\\.$"), (m, context) => { auraTrigger(context).push({ events: ["critically-hit-or-failed"], heal: null, endsImpulse: true }); return true; }],
    [re("^The creature regains ⟦T⟧ HP, and the impulse ends\\.$"), (m, context) => { const trigger = auraTrigger(context).at(-1); if (!trigger) return false; trigger.heal = damageTag(context, m[1])?.components; return true; }],
    [/^If the creature is in water, the healing dice are d10s instead of d8s\.$/, (m, context) => { const trigger = auraTrigger(context).at(-1); trigger.waterDie = "d10"; return true; }],
    [/^You shed faint, glowing embers, as do your allies while they're in your kinetic aura\.$|^Anyone shedding these embers gains a \+1 status bonus to Reflex saves and Acrobatics checks and can Step as a free action once per round\.$/, (m, context) => stanceRule(context)],
    [re("^When an affected creature takes a move action, its Strikes deal an extra ⟦T⟧ damage until the end of its turn\\.$"), (m, context) => { auraTrigger(context).push({ events: ["ally-move"], strikeDamage: damageTag(context, m[1])?.components, until: { kind: "target-turn", edge: "end", current: true } }); return true; }],
    [/^Fast-moving gray clouds surround you, as well as your allies while they're in your kinetic aura\.$|^Anyone surrounded by these clouds gains a \+2 status bonus to Reflex saves and Acrobatics checks\.$/, (m, context) => stanceRule(context)],
    [re("^Until the start of its next turn, it's ⟦T⟧, and its Strikes gain the ⟦T⟧ rune\\.$"), (m, context) => { auraTrigger(context).push({ events: ["ally-move"], linkedEffect: true }); return true; }],
    [/^When an affected creature uses a move action, clouds dance around it\.$/, () => true],
    [re("^Each creature inside your kinetic aura \\(including you\\) is ⟦T⟧ from any creature outside your kinetic aura, and creatures outside the aura are concealed from creatures inside the aura other than you\\.$"), (m, context) => { context.plan.resolution.aura = { ...(context.plan.resolution.aura ?? {}), concealment: "both-ways" }; return true; }],
    [/^Your air impulses carry sands that cut at great speed\.$|^When you use a damaging air impulse that affects at least one creature in your kinetic aura, that impulse deals 1 additional slashing damage, or 2 if the impulse has a single target\.$/, (m, context) => stanceRule(context)],
    [/^Surfaces in your kinetic aura are coated in slippery ice\.$/, () => true],
    [re("^A creature that moves on the ice immediately falls unless it succeeds at an ⟦T⟧ check or ⟦T⟧ save against your impulse DC – 2\\.$"), (m, context) => { auraTrigger(context).push({ events: ["move-in-aura"], save: { statistic: "reflex", alternative: "acrobatics", adjustment: -2 }, outcomes: { failure: [{ slug: "prone", value: null }], criticalFailure: [{ slug: "prone", value: null }] }, exceptSelf: true, exceptActions: ["step", "crawl"] }); return true; }],
    [/^A creature that Steps or Crawls doesn't have to attempt a check or save\.$|^You're immune to this effect\.$|^You're immune to the effects of your own Drowning Mist\.$/, () => true],
    [re("^If a creature on the ice is critically hit by one of your water impulses or critically fails at a save against one, that creature is ⟦T⟧ until the end of its next turn\\.$"), (m, context) => { context.plan.resolution.aura = { ...(context.plan.resolution.aura ?? {}), waterCritical: { condition: conditionTag(context, m[1])?.condition, duration: { kind: "target-turn", edge: "end" } } }; return true; }],
    [/^While in this stance, your aura is difficult terrain for any creature that doesn't have a swim Speed\.$/, (m, context) => stanceRule(context)],
    [re("^Creatures that can't breathe water must hold their breath while in the aura, and when such creatures take an action that reduces their remaining air by 1 or more rounds, they must also attempt a ⟦T⟧ save against your class DC \\(maximum once per round\\)\\.$"), (m, context) => {
        setSave(context, checkTag(context, m[1]), { basic: false });
        context.degreeMode = true;
        auraTrigger(context).push({ events: ["air-reduced"], usesPlanOutcomes: true, oncePerRound: true, manual: true });
        context.plan.targeting.who = "aura";
        return true;
    }],
    [/^Any of your allies adjacent to it gain resistance to electricity equal to your level and add the ⟦\d+⟧ rune to all their Strikes with metal objects\.$/, (m, context) => linkedEffect(context, { recipient: "allies-adjacent" })],
    [/^Clouds, like eager pets, are drawn to you and to those in your good graces\.$/, () => true],

    // ---- Movement (the owner moves the token; the card says how).
    [/^(?:Stride|You Stride|Fly|You Fly|Swim|You (?:then )?Fly) up to (\d+ feet|your Speed|half your (?:fly )?Speed)(?: in a straight line)?(?:, and this movement doesn't trigger reactions)?\.$|^Movement from this impulse ignores difficult terrain and doesn't trigger reactions\.$|^⟦\d+⟧ up to your Speed\.$|^You can move through creatures during this movement, and this movement doesn't trigger reactions that are triggered by movement\.$|^You return to your normal form in the final square of the line\.$|^If you're in the air, you fall unless you have a fly Speed\.$/, (m, context, sentence) => movement(context, sentence)],
    [re("^You ⟦T⟧ up to half your Speed in any direction; this movement doesn't trigger reactions\\.$"), (m, context, sentence) => movement(context, sentence)],
    [re("^You propel yourself forward in a ⟦T⟧\\.$"), (m, context, sentence) => { areaFrom(context, templateTag(context, m[1]), null); return movement(context, sentence); }],
    [/^You discorporate into a cloud of whirling ash and Stride\.$|^If you have a fly Speed, you can Fly instead\.$|^This movement doesn't trigger reactions, you can move through occupied spaces and tiny cracks, and you ignore any difficult terrain and greater difficult terrain that wouldn't impede smoke\.$/, (m, context, sentence) => movement(context, sentence)],
    [/^At the end of your Leap, a wave of lava crashes onto all creatures in a ⟦\d+⟧\.$/, (m, context, sentence) => { areaFrom(context, templateTag(context, /⟦(\d+)⟧/.exec(sentence)[1]), 0); return movement(context, "Leap up to your Speed; the area centres where you land."); }],
    [/^Until the end of your turn, you gain a fly Speed equal to your land Speed or (\d+) feet, whichever is greater\.$/, (m, context, sentence) => movement(context, sentence)],
    [/^You instantly transport yourself, and any items you're wearing and holding, from your current space to a clear space within (\d+) feet you can observe that's adjacent to an open flame or a creature taking persistent fire damage\.$|^If this would bring another creature with you—even if you're carrying it in an extradimensional container—the action fails\.$/, (m, context, sentence) => movement(context, sentence, { teleport: true })],
    [re("^A whorl of fire surrounds you in a ⟦T⟧ either before you depart or after you arrive\\.$"), (m, context) => { areaFrom(context, templateTag(context, m[1]), 0); context.plan.targeting.area.choice = "before departing or after arriving"; return true; }],
    [/^Choose one foe and one ally you're adjacent to at any point during this movement\.$/, () => true],
    [/^Using one wing's sharpened edge, you can use a 1-action Elemental Blast as a melee Strike using the metal element against the foe\.$/, (m, context) => { context.plan.resolution.kind = "blast"; context.plan.resolution.blast = { actions: 1, element: "metal", mode: "melee", optional: true }; return true; }],
    [/^With the other wing, you can help the ally break free of an effect grabbing, restraining, immobilizing, or paralyzing them; they either attempt a new save against one such effect that allows a save, or they attempt to Escape as a free action\.$|^The ally can use your impulse attack modifier in place of their unarmed attack modifier or skill check modifier\.$/, (m, context) => { context.plan.resolution.allyHelp = { kind: "break-free", modifier: "impulse" }; return true; }],

    // ---- Kineticist-specific.
    [/^Choose one of your kinetic elements and a damage type listed for that element, then make a melee or ranged impulse attack against the AC of one creature\.$/, (m, context) => { context.plan.resolution.kind = "blast"; context.plan.resolution.blast = { actions: null, element: null, mode: "melee or ranged", native: true }; return true; }],
    [/^Add your Strength modifier to the damage roll for a melee Elemental Blast\.$|^If you make a 2-action Elemental Blast, you gain a status bonus to the damage roll equal to your Constitution modifier\.$|^The element determines the damage die, damage type, and range \(for a ranged blast\)\.$|^A damage type other than a physical damage type adds its trait to the blast\.$/, (m, context) => context.plan.resolution.blast ? true : false],
    [/^Add your Strength modifier to the damage roll for a melee Matter Blast\.$|^If you make a 2-action Matter Blast, you gain a status bonus to the damage roll equal to your Intelligence modifier\.$|^This activity counts as Elemental Blast for the purposes of impulses, feats, and prerequisites\.$|^Drawing power from your circle, you rearrange matter from nearby and weaponize it against a foe\.$/, (m, context) => {
        context.plan.resolution.kind = "blast";
        context.plan.resolution.blast ??= { actions: null, element: null, mode: "melee or ranged", native: false, attribute: "int", strengthMelee: true };
        if (/Intelligence/.test(m[0])) context.plan.resolution.blast.twoActionAttribute = "int";
        return true;
    }],
    [/^Make a melee or ranged impulse attack against the AC of one creature using the element for your transmutation circle\.$/, (m, context) => {
        context.plan.resolution.kind = "blast";
        context.plan.resolution.blast = { ...(context.plan.resolution.blast ?? {}), elementFrom: "circle", mode: "melee or ranged", native: false };
        return true;
    }],
    [/^You attempt to counteract the effect, using your kineticist class DC - 10 as your counteract check modifier and half this impulse's level rounded up as the counteract rank\.$/, (m, context) => {
        context.plan.resolution.kind = "counteract";
        context.plan.resolution.counteract = { modifier: "class-dc-10", rank: Math.ceil(context.level / 2), target: "triggering-effect" };
        return true;
    }],
    [/^If you counteract the effect, you protect only yourself unless you got a critical success on your counteract check\.$/, (m, context) => { context.plan.resolution.counteract.selfOnlyUnless = "criticalSuccess"; return true; }],
    [/^Your absolute dedication to a single element lets you attempt to gain control over it, even when the element is in service to another entity\.$/, () => true],
    [/^If the purification would remove an alchemical or magical pollutant \(such as a poison or curse\), Purify Element attempts to counteract that impurity, using your class DC - 10 for the counteract check\.$/, (m, context) => {
        context.plan.resolution.counteract = { modifier: "class-dc-10", rank: Math.ceil(context.level / 2), target: "impurity", optional: true };
        return true;
    }],
    [/^If it fails to counteract a particular impurity, any further attempt you make to counteract that impurity with Purify Element fails as well\.$/, (m, context) => { context.plan.resolution.counteract.failLocks = true; return true; }],
    [/^Use a stance impulse that affects your kinetic aura\.$/, (m, context) => { context.plan.resolution.kind = "use-stance"; return true; }],
    [/^Your glowing and majestic kinetic aura marks you as a true child of the elements\.$/, () => true],

    // ---- Creations with statistics (summoned or conjured objects and creatures).
    [/^(?:The plant|The wire|A mound|The ballista|Each tree|The mounts) has AC (\d+)(?:, Hardness (\d+),)? and (\d+) (?:Hit Points|HP)(?:, and is immune to critical hits and precision damage)?\.$/, (m, context) => creation(context, { ac: Number(m[1]), hardness: m[2] ? Number(m[2]) : null, hp: Number(m[3]), immune: /immune/.test(m[0]) ? ["critical-hits", "precision"] : [] })],
    [/^Each 10-foot-by-10-foot section of the wall has AC (\d+), Hardness (\d+), and (\d+) Hit Points, and (?:it's |is )?immune to critical hits and precision damage\.$/, (m, context) => creation(context, { kind: "wall", sectionFeet: 10, ac: Number(m[1]), hardness: Number(m[2]), hp: Number(m[3]), immune: ["critical-hits", "precision"] })],

    // ---- What the forms above can't automate, but the card can show the right person: claimed as owner/GM notes.
    [/^You can't affect an element that's magical, secured in place \(like a stone mortared in a wall\), or attended by a creature unwilling to let you\.$|^The GM decides what Bulk the element is\.$|^This impulse has a range of (\d+) feet, and the Bulk of the target must be negligible or light\.$|^Base Kinesis can't deal damage or cause conditions unless otherwise noted\.$|^Choose one of the following options, though the GM might allow you to make similar small alterations\.$/, (m, context, sentence) => { if (/^Choose one of the following/.test(sentence)) context.modes = []; return note(context, sentence, "owner"); }]
];

// ---------------------------------------------------------------- options ("Shards …", "Spring …", "Air 1d6 …")

export const OPTION_FORMS = [
    // (Shard Strike: "Shards Shards deal ⟦D⟧ damage in a ⟦T⟧, and a creature that critically fails takes ⟦D⟧ damage.")
    [re("^([A-Z][a-z]+) \\1 deal ⟦T⟧ damage in a ⟦T⟧, and a creature that critically fails (?:takes ⟦T⟧ damage|is ⟦T⟧ until the start of your next turn)\\.$"), (m, context, line) => {
        const mode = { label: m[1], area: areaOf(templateTag(context, m[3])), sharedDamage: { mode: "text", rollOnce: true, components: damageTag(context, m[2])?.components }, criticalFailure: { conditions: [], persistent: [] } };
        const last = tag(context, m[4] ?? m[5]);
        if (last?.kind === "damage") mode.criticalFailure.persistent.push(...last.components);
        else if (last?.condition) mode.criticalFailure.conditions.push({ ...last.condition, duration: { kind: "source-turn", edge: "start" } });
        else return false;
        context.modes.push(mode);
        context.plan.resolution.modes = context.modes;
        return true;
    }],
    // (Base Kinesis, Usurp the Lunar Reins, Turn the Wheel of Seasons: option entries the owner chooses; read as notes unless they hold a save.)
    [/^(Generate|Move|Suppress|Proliferate|Regulate|Sculpt|Flood|Control|Modulate) (.+)$/, (m, context) => {
        context.modes.push({ label: m[1], text: m[2] });
        context.plan.resolution.modes = context.modes;
        return true;
    }],
    [re("^Slow By exercising your rightful control over all water, each creature with the water trait in the area must succeed at a ⟦T⟧ save against your class DC or be ⟦T⟧ \\(or ⟦T⟧ on a critical failure\\)\\.$"), (m, context) => {
        context.modes.push({ label: "Slow", save: { statistic: checkTag(context, m[1]).statistic, basic: false }, who: { kind: "area", traits: ["water"] },
            outcomes: { failure: [conditionTag(context, m[2]).condition], criticalFailure: [conditionTag(context, m[3]).condition] }, duration: { kind: "source-turn", edge: "end" } });
        context.plan.resolution.modes = context.modes;
        return true;
    }],
    [re("^Spring Each ally in the cube gains (\\d+) temporary HP that last until the start of your next turn\\. Any dying ally rolls a recovery check, but can't get worse than a success\\.$"), (m, context) => {
        context.modes.push({ label: "Spring", tempHp: { amount: Number(m[1]), recipients: "allies-in-area", duration: { kind: "source-turn", edge: "start" } }, dyingRecovery: { atWorst: "success" } });
        context.plan.resolution.modes = context.modes;
        return true;
    }],
    [re("^Summer \\(light\\) Each enemy in the area is exposed to sunlight and must attempt a ⟦T⟧ save against your class DC\\. It's unaffected on a critical success, ⟦T⟧ until the start of your next turn on a success, or ⟦T⟧ until the start of your next turn on a failure\\.$"), (m, context) => {
        const dazzled = conditionTag(context, m[2]).condition, blinded = conditionTag(context, m[3]).condition;
        const until = { kind: "source-turn", edge: "start" };
        context.modes.push({ label: "Summer", save: { statistic: checkTag(context, m[1]).statistic, basic: false, traits: ["light"] }, who: { kind: "area", enemiesOnly: true },
            outcomes: { success: [{ ...dazzled, duration: until }], failure: [{ ...blinded, duration: until }], criticalFailure: [{ ...blinded, duration: until }] } });
        context.plan.resolution.modes = context.modes;
        return true;
    }],
    [re("^Autumn Leaves and rain make everything in the area ⟦T⟧ until the start of your next turn, and a cold wind makes each enemy in the area ⟦T⟧ until the start of your next turn unless it succeeds at a ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        const until = { kind: "source-turn", edge: "start" };
        context.modes.push({ label: "Autumn", terrain: { concealment: "all", until }, save: { statistic: checkTag(context, m[3]).statistic, basic: false }, who: { kind: "area", enemiesOnly: true },
            outcomes: { failure: [{ ...conditionTag(context, m[2]).condition, duration: until }], criticalFailure: [{ ...conditionTag(context, m[2]).condition, duration: until }] } });
        context.plan.resolution.modes = context.modes;
        return true;
    }],
    [re("^Winter Each enemy in the aura takes ⟦T⟧ damage with a ⟦T⟧ save against your class DC\\. A creature that fails its save also takes ⟦T⟧ damage\\.$"), (m, context) => {
        context.modes.push({ label: "Winter", sharedDamage: { mode: "text", rollOnce: true, components: damageTag(context, m[1]).components }, save: { statistic: checkTag(context, m[2]).statistic, basic: true }, who: { kind: "area", enemiesOnly: true },
            persistent: { failure: damageTag(context, m[3]).components, criticalFailure: damageTag(context, m[3]).components } });
        context.plan.resolution.modes = context.modes;
        return true;
    }],
    // (Tree of Duality: both effects, each its own part.)
    [re("^Cleansing Pollen \\(healing, vitality\\) Each living ally that's in the area or enters it regains ⟦T⟧ HP and is then temporarily immune to regaining HP from [A-Z][\\w ]+ for (\\d+) minutes\\.Hallucinogenic Spores \\(mental\\) Enemies in the area are ⟦T⟧\\. An enemy that leaves the area remains dazzled until the start of its next turn\\.Level \\(\\+(\\d+)\\) .*$"), (m, context) => {
        context.plan.resolution.healing = { components: damageTag(context, m[1]).components, recipients: "living-allies-in-area", immunityRounds: Number(m[2]) * 10, onEnter: true };
        context.plan.resolution.areaConditions = [{ who: "enemies", condition: conditionTag(context, m[3]).condition, duration: { kind: "area", lingerUntil: { kind: "target-turn", edge: "start" } } }];
        context.plan.resolution.kind = "area";
        return true;
    }],
    // (Elemental Blast's / Matter Blast's element table.)
    [/^(Air|Earth|Fire|Metal|Water|Wood) (1d\d+) ([a-z]+)(?: or ([a-z]+))?, (?:range )?(\d+) feet$/, (m, context) => {
        context.plan.resolution.blast ??= { native: false };
        (context.plan.resolution.blast.elements ??= []).push({ element: m[1].toLowerCase(), die: m[2], damageTypes: [m[3], m[4]].filter(Boolean), range: Number(m[5]) });
        return true;
    }]
];

// ---------------------------------------------------------------- degree entries

/** A degree entry's text → the outcome, or false. */
export function readDegreeEntry(degree, text, context) {
    const outcome = outcomesFor(context)[degree];
    const body = text.trim().replace(/\.$/, "");
    const parts = body.split(/\. (?=[A-Z])/);
    for (const part of parts) if (!readDegreePart(degree, part.trim().replace(/\.$/, ""), outcome, context)) return false;
    return true;
}

function readDegreePart(degree, body, outcome, context) {
    let m;
    if (readFreeOutcome(degree, body, outcome, context)) return true;
    if (/^The (?:creature|target) is unaffected(?: and is temporarily immune for (\d+) hours)?$/.test(body) || /^The sigil immediately vanishes, and the creature is unaffected$/.test(body)) {
        outcome.unaffected = true; outcome.damage.multiplier = 0;
        const immune = /immune for (\d+) hours/.exec(body);
        if (immune) outcome.immunity = { rounds: Number(immune[1]) * 600 };
        return true;
    }
    if ((m = /^The creature is unaffected(?:,)? (?:and becomes temporarily immune to the effects of this impulse for (\d+) hours|disbelieves the illusion, and is temporarily immune for (\d+) hours?)$/.exec(body))) {
        outcome.unaffected = true; outcome.immunity = { rounds: Number(m[1] ?? m[2]) * 600 }; return true;
    }
    if (/^The (?:creature|target) takes half damage$/.test(body)) { outcome.damage.multiplier = 0.5; return true; }
    if (/^The (?:creature|target) takes full damage$/.test(body)) { outcome.damage.multiplier = 1; return true; }
    if (/^The (?:creature|target) takes double damage$/.test(body)) { outcome.damage.multiplier = 2; return true; }
    if ((m = /^As (success|failure), but (?:the creature takes )?(full|double) damage$/i.exec(body))) {
        copyOutcome(context, m[1].toLowerCase(), outcome);
        outcome.damage.multiplier = m[2] === "full" ? 1 : 2;
        return true;
    }
    if ((m = /^The (?:creature|target) takes (half|full|double) damage(?:,)? and (.+)$/.exec(body))) {
        outcome.damage.multiplier = { half: 0.5, full: 1, double: 2 }[m[1]];
        return readDegreePart(degree, `The creature ${m[2].replace(/^(?:is )/, "is ")}`, outcome, context) || readConditionsText(m[2], outcome, context);
    }
    if ((m = /^The creature is ⟦(\d+)⟧(?: ([^⟦]+))?$/.exec(body)) || (m = /^The target is ⟦(\d+)⟧(?: ([^⟦]+))?$/.exec(body))) {
        const condition = conditionTag(context, m[1]);
        if (!condition) return false;
        const duration = m[2] ? readDuration(m[2]) : null;
        if (m[2] && !duration) return false;
        outcome.conditions.push({ ...condition.condition, duration });
        return true;
    }
    if (readConditionsText(body, outcome, context)) return true;
    if ((m = /^As failure, but (.+)$/.exec(body))) {
        copyOutcome(context, "failure", outcome);
        return readAsBut(m[1], outcome, context);
    }
    if ((m = /^As success, but (.+)$/.exec(body))) {
        copyOutcome(context, "success", outcome);
        return readAsBut(m[1], outcome, context);
    }
    return false;
}

function copyOutcome(context, from, outcome) {
    const source = context.plan.resolution.outcomes[from];
    outcome.conditions.push(...structuredClone(source.conditions));
    outcome.effects.push(...structuredClone(source.effects));
    outcome.persistent.push(...structuredClone(source.persistent));
    outcome.notes.push(...source.notes);
    if (source.forcedMovement && !outcome.forcedMovement) outcome.forcedMovement = structuredClone(source.forcedMovement);
    if (source.damage.multiplier && !outcome.damage.multiplier) outcome.damage.multiplier = source.damage.multiplier;
}

function readAsBut(text, outcome, context) {
    let m;
    if ((m = /^the creature takes (double|full) damage$/.exec(text))) { outcome.damage.multiplier = m[1] === "double" ? 2 : 1; return true; }
    if ((m = /^double damage and the distance the creature is pushed is (\d+) feet$/.exec(text))) {
        outcome.damage.multiplier = 2;
        if (outcome.forcedMovement) outcome.forcedMovement.distance = Number(m[1]);
        return true;
    }
    if ((m = /^you can Sustain the impulse up to (\d+) (hour|minute)s?$/.exec(text))) { outcome.notes.push(`The kineticist can Sustain the impulse up to ${m[1]} ${m[2]}${m[1] === "1" ? "" : "s"}.`); outcome.sustainMaxRounds = Number(m[1]) * (m[2] === "hour" ? 600 : 10); return true; }
    if ((m = /^after becoming unfrozen, the creature is (?:⟦(\d+)⟧|(slowed) (\d)) until the end of its next turn$/.exec(text))) {
        const condition = m[1] ? conditionTag(context, m[1]).condition : { slug: m[2], value: Number(m[3]) };
        outcome.conditions.push({ ...condition, duration: { kind: "target-turn", edge: "end" }, after: "frozen" });
        return true;
    }
    if ((m = /^the creature is fascinated for 1 minute or until it disbelieves$/.exec(text))) {
        for (const condition of outcome.conditions) if (condition.slug === "fascinated") condition.duration = { kind: "time", rounds: 10, orUntil: "disbelieves" };
        return true;
    }
    if ((m = /^⟦(\d+)⟧$/.exec(text)) || (m = /^⟦(\d+)⟧ instead$/.exec(text))) {
        const condition = conditionTag(context, m[1]);
        if (!condition) return false;
        outcome.conditions = outcome.conditions.filter(entry => entry.slug !== condition.condition.slug);
        outcome.conditions.push({ ...condition.condition, duration: null });
        return true;
    }
    if ((m = /^the creature takes double damage and is blinded for (\d+) minutes?$/.exec(text))) return false;
    return false;
}

/** "⟦Clumsy 2⟧ and ⟦Immobilized⟧ until the end of its next turn", "is clumsy 2 and immobilized", "blinded until the start of your next turn". */
function readConditionsText(text, outcome, context) {
    let body = text.replace(/^(?:is |becomes )/, "").replace(/^(?:is )?knocked /, "");
    let m;
    // ("⟦A⟧ and ⟦B⟧ until …" / "is ⟦A⟧ until …")
    if ((m = /^(?:is )?⟦(\d+)⟧(?: and ⟦(\d+)⟧)?(?: (until the (?:start|end) of (?:its|your) next turn|for \d+ (?:minutes?|rounds?)))?$/.exec(body))) {
        const duration = m[3] ? readDuration(m[3]) : null;
        for (const index of [m[1], m[2]].filter(Boolean)) {
            const condition = conditionTag(context, index);
            if (!condition) return false;
            outcome.conditions.push({ ...condition.condition, duration });
        }
        return true;
    }
    // ("dazzled until the start of your next turn", "blinded for 1 minute", "is clumsy 2 and immobilized")
    if ((m = /^(?:is )?([a-z-]+)(?: (\d))?(?: and ([a-z-]+)(?: (\d))?)?(?: (until the (?:start|end) of (?:its|your) next turn|for \d+ (?:minutes?|rounds?)))?$/.exec(body))) {
        const names = [[m[1], m[2]], [m[3], m[4]]].filter(([name]) => name);
        const known = ["dazzled", "blinded", "clumsy", "immobilized", "slowed", "off-guard", "sickened", "fascinated", "frightened", "stunned", "prone", "deafened", "concealed"];
        if (!names.every(([name]) => known.includes(name))) return false;
        const duration = m[5] ? readDuration(m[5]) : null;
        for (const [name, value] of names) outcome.conditions.push({ slug: name, value: value ? Number(value) : ["clumsy", "slowed", "sickened", "frightened", "stunned"].includes(name) ? 1 : null, duration });
        return true;
    }
    if ((m = /^dazzled until the start of your next turn$/.exec(body))) { outcome.conditions.push({ slug: "dazzled", value: null, duration: { kind: "source-turn", edge: "start" } }); return true; }
    if ((m = /^takes a –10-foot status penalty to all its Speeds until the end of its next turn$/.exec(body))) {
        outcome.effects.push({ generated: "speed-penalty", name: "Speed Penalty", rules: [{ key: "FlatModifier", selector: "all-speeds", type: "status", value: -10 }], duration: { kind: "target-turn", edge: "end" } });
        return true;
    }
    return false;
}

function readFreeOutcome(degree, body, outcome, context) {
    let m;
    // (Extract Element's success: the target's matter in the kineticist's aura — an Effect the impulses read.)
    if (/^The creature takes half damage, and you add some of its elemental matter to your kinetic aura$/.test(body)) {
        outcome.damage.multiplier = 0.5;
        outcome.effects.push({ generated: "extracted", name: "Elemental Matter Extracted", duration: { kind: "time", rounds: 50 }, endsWithSourceAura: true, againstSource: { traits: ["impulse"] },
            rules: [{ key: "FlatModifier", selector: ["saving-throw", "ac"], type: "circumstance", value: -1, predicate: ["origin:item:trait:impulse", "origin:signature:{item|origin.signature}"] }],
            bypassIwr: { immunityToElementTraits: true, resistance: "ignore", immunityBecomesResistance: "level" },
            text: "The kineticist's impulses bypass its immunity to their elemental traits; it takes a -1 circumstance penalty to saves and AC against them. A resistance that would apply to the impulse's damage is ignored; an immunity to that damage type becomes resistance equal to its level. Lasts 5 minutes or until the kineticist's aura ends." });
        return true;
    }
    if (/^Your impulses bypass any immunity the creature has to their elemental trait or traits, and the target takes a -1 circumstance penalty to its saves and AC against your impulses$|^If the target normally has a resistance that would apply to damage from one of your impulses, ignore that resistance; if it normally would be immune to that damage type, it instead has resistance equal to its level to damage from the impulse$|^You can't target a creature with Extract Element if elemental matter you extracted from it is already in your kinetic aura$|^These effects last for 5 minutes or until your kinetic aura ends, whichever comes first$/.test(body)) {
        return outcome.effects.some(effect => effect.generated === "extracted");
    }
    if ((m = /^You make the creature jump up to (half the maximum distance|the maximum distance)$/.exec(body))) { outcome.notes.push(`You make the creature jump up to ${m[1]}.`); outcome.forcedJump = m[1].startsWith("half") ? 0.5 : 1; return true; }
    if (/^Moisture seeps into the creature's lungs, making the creature ⟦(\d+)⟧$/.test(body)) {
        m = /⟦(\d+)⟧/.exec(body);
        outcome.conditions.push({ ...conditionTag(context, m[1]).condition, duration: null });
        return true;
    }
    if (/^The target is frozen solid/.test(body)) {
        outcome.effects.push({ generated: "frozen-solid", name: "Frozen Solid", duration: { kind: "source-turn", edge: "end" }, endsOn: ["hostile-action"],
            rules: [{ key: "ActiveEffectLike", mode: "override", path: "system.attributes.ac.value", value: 9 }, { key: "Immunity", type: ["cold", "critical-hits", "precision"] }],
            grants: [{ slug: "paralyzed", value: null, label: "can't act" }], hardness: 5,
            text: "It can't act, its AC is 9, it has Hardness 5, and it's immune to other cold effects, critical hits, and precision damage. This lasts until the end of your next turn, but if the target is affected by a hostile action, this effect ends immediately after that action." });
        return true;
    }
    if (/^It can't act, its AC is 9|^This lasts until the end of your next turn, but if the target is affected by a hostile action/.test(body)) return true;
    if ((m = /^The creature is off-guard$/.exec(body))) { outcome.conditions.push({ slug: "off-guard", value: null, duration: { kind: "area" } }); return true; }
    if ((m = /^The creature takes full damage and is pushed out of the line in the most direct path available$/.exec(body))) { outcome.damage.multiplier = 1; outcome.forcedMovement = { kind: "push", distance: null, text: "out of the line in the most direct path available" }; return true; }
    if ((m = /^The creature takes full damage and is pushed downward (\d+) feet without taking falling damage$/.exec(body))) { outcome.damage.multiplier = 1; outcome.forcedMovement = { kind: "push-down", distance: Number(m[1]), noFallDamage: true }; return true; }
    if (/^If it reaches the bottom of the cylinder or the ground, the push ends$/.test(body)) return true;
    if (/^If the creature is pushed to the ground, it can't Fly, ⟦\d+⟧, or otherwise leave the ground for 1 round$/.test(body)) { outcome.effects.push({ generated: "grounded", name: "Grounded", duration: { kind: "time", rounds: 1 }, question: "Was the creature pushed to the ground?", text: "It can't Fly, Levitate, or otherwise leave the ground for 1 round." }); return true; }
    if ((m = /^It is ⟦(\d+)⟧ from the illusory sky but is also disoriented; any time it uses an action to attempt to flee, it must succeed at a ⟦(\d+)⟧ or flee to a space that's still within the illusion$/.exec(body))) {
        outcome.conditions.push({ ...conditionTag(context, m[1]).condition, duration: { kind: "area" } });
        outcome.notes.push("Disoriented: any time it uses an action to attempt to flee, it must succeed at a DC 11 flat check or flee to a space that's still within the illusion.");
        return true;
    }
    if (/^The GM determines where the creatures ends up, but the creature can't stay stationary if it's able to move$/.test(body)) return true;
    if ((m = /^The creature is ⟦(\d+)⟧ with the source of the sound until the end of its next turn$/.exec(body))) { outcome.conditions.push({ ...conditionTag(context, m[1]).condition, duration: { kind: "target-turn", edge: "end" } }); return true; }
    if (/^When the fascination ends, the creature is temporarily immune for 1 hour$/.test(body)) { outcome.immunity = { rounds: 600, after: "fascination" }; return true; }
    if (/^The sigil acts as a magnet for your fiery attacks, granting the creature a –1 penalty to its saves and AC against your fire impulses$/.test(body)) {
        outcome.effects.push({ generated: "sigil", name: "Burning Demand Sigil", duration: { kind: "source-turn", edge: "end" }, endsOn: ["obeys"], againstSource: { traits: ["fire", "impulse"] },
            rules: [{ key: "FlatModifier", selector: ["saving-throw", "ac"], value: -1, predicate: ["origin:trait:fire", "origin:trait:impulse"] }] });
        return true;
    }
    if (/^The sigil lasts until the end of your next turn or until the creature spends at least 1 action obeying your command, whichever happens first$/.test(body)) return true;
    if (/^At the start of the creature's next turn, if it doesn't use their first action to obey the command, the sigil ignites as it vanishes, dealing ⟦\d+⟧ damage and ⟦\d+⟧ damage to the creature$/.test(body)) {
        const [a, b] = [...body.matchAll(/⟦(\d+)⟧/g)].map(x => damageTag(context, x[1]));
        outcome.delayed = { event: "target-turn-start", question: "Did the creature use its first action to obey the command?", unless: "yes", damage: a.components, persistent: b.components };
        return true;
    }
    if (/^The creature must spend the first action of its next turn to obey your command; it can't Delay$/.test(body)) { outcome.notes.push("It must spend the first action of its next turn to obey the command; it can't Delay."); return true; }
    if (/^The sigil vanishes at the end of its turn; it ignites if the creature didn't use all its remaining actions to continue to obey your command, dealing ⟦\d+⟧ damage and ⟦\d+⟧ damage to the creature$/.test(body)) {
        const [a, b] = [...body.matchAll(/⟦(\d+)⟧/g)].map(x => damageTag(context, x[1]));
        outcome.delayed = { event: "target-turn-end", question: "Did the creature use all its remaining actions to obey the command?", unless: "yes", damage: a.components, persistent: b.components };
        return true;
    }
    if ((m = /^The elemental creature is controlled or slowed as long as you Sustain the impulse, up to (\d+) minutes?$/.exec(body))) {
        outcome.control = { byLevel: { controlledAtMost: context.level - 3, slowedAtLeast: context.level - 2 }, duration: { kind: "impulse" }, maxRounds: Number(m[1]) * 10, endsOn: ["attacked-by-source-or-ally"] };
        return true;
    }
    if (/^This effect ends if you or an ally attacks the elemental$/.test(body)) return true;
    if (/^It attempts a new save at the end of each of its turns, ending the effect if it succeeds$/.test(body)) { outcome.recurringSave = { event: "target-turn-end", endsOn: "success" }; return true; }
    return false;
}

// ---------------------------------------------------------------- helpers used by forms

export function push(context, distances) {
    const outcomes = outcomesFor(context);
    for (const [degree, distance] of Object.entries(distances)) outcomes[degree].forcedMovement = { kind: "push", distance };
    return true;
}

export function immunity(context, m, extra = {}) {
    const amount = Number(m[1]); const unit = m[2];
    context.plan.trigger.immunity = { scope: "target", rounds: amount * (unit === "hour" ? 600 : 10), ...extra };
    return true;
}

export function note(context, text, audience) {
    context.plan.resolution.notes.push({ text: text.replace(/⟦(\d+)⟧/g, (_, i) => context.tags[Number(i)]?.label ?? ""), audience, where: "claimed" });
    return true;
}

export function areaOf(template) {
    return { type: template.type === "cylinder" ? "burst" : template.type, value: template.distance, ...(template.width ? { width: template.width } : {}), ...(template.type === "cylinder" ? { cylinder: true } : {}) };
}

export function areaFrom(context, template, within) {
    if (!template) return false;
    const area = { ...areaOf(template), ...(within != null ? { within } : {}) };
    if (!context.plan.targeting.area) context.plan.targeting.area = area;
    else if (context.plan.targeting.area.type !== area.type || context.plan.targeting.area.value !== area.value) context.plan.targeting.areaChoices = [...(context.plan.targeting.areaChoices ?? [context.plan.targeting.area]), area];
    return true;
}

export function rangeIn(sentence) {
    const m = /within (\d+) feet/.exec(sentence);
    return m ? Number(m[1]) : null;
}

export function terrain(context, patch) {
    context.plan.resolution.terrain = { ...(context.plan.resolution.terrain ?? {}), ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value != null)) };
    return true;
}

export function attackDamage(context, damage, { critical = "double" } = {}) {
    if (!damage || !context.plan.resolution.attack) return false;
    context.plan.resolution.sharedDamage = { mode: "text", rollOnce: false, components: damage.components, options: damage.options ?? [], raw: damage.body ?? null };
    context.plan.resolution.attack.critical = critical;
    return true;
}

export function auraTrigger(context) {
    context.plan.resolution.aura ??= {};
    return (context.plan.resolution.aura.triggers ??= []);
}

/** A stance rule PF2e's own Stance Effect carries: claimed when the impulse links a stance Effect (checked in finishPlan). */
export function stanceRule(context) {
    context.stanceRules = (context.stanceRules ?? 0) + 1;
    return true;
}

/** A benefit PF2e's linked Effect carries (Born to the Trees, Spike Skin, Cyclonic Ascent): claimed; finishPlan requires the link. */
export function linkedEffect(context, { recipient = null, duration = null } = {}) {
    context.linkedEffectClaims = [...(context.linkedEffectClaims ?? []), { recipient, duration }];
    return true;
}

export function movement(context, sentence, extra = {}) {
    context.plan.movement = { ...(context.plan.movement ?? {}), steps: [...(context.plan.movement?.steps ?? []), sentence.replace(/⟦(\d+)⟧/g, (_, i) => context.tags[Number(i)]?.label ?? "")], ...extra };
    return true;
}

export function creation(context, stats) {
    const list = context.plan.resolution.creations;
    if (list.length && !list.at(-1).ac) Object.assign(list.at(-1), stats);
    else list.push({ name: context.plan.source.name, ...stats });
    return true;
}

export function spellEquivalent(context, uuid, rest, extra = {}) {
    if (!uuid || uuid.pack !== "spells-srd") return false;
    context.plan.resolution.kind = "spell";
    context.plan.resolution.spell = { uuid: uuid.uuid, name: uuid.label, rank: Math.ceil(context.level / 2), adjustments: rest?.trim() ? [rest.trim().replace(/^,\s*/, "")] : [], ...extra };
    return true;
}

// ---------------------------------------------------------------- completing the plan

export function finishPlan(context) {
    const { plan } = context;
    const resolution = plan.resolution;
    // PF2e's own Effects: the linked ones in the text (a lone "@UUID[…]{Effect: …}"), and the item's self-effect. A generated Effect standing for the
    // same benefit (Ocean's Balm's "resistance 2 to fire for 1 minute") gives way to PF2e's.
    if (context.effectLinks.some(link => !link.self)) resolution.effects = resolution.effects.filter(effect => !(effect.generated && effect.linked));
    for (const link of context.effectLinks) {
        const stance = /^Stance:/.test(link.name);
        const recipient = stance || plan.lifecycle.stance ? "self" : context.linkedEffectClaims?.[0]?.recipient ?? (plan.targeting.who === "targets" || plan.targeting.target ? "targets" : "self");
        resolution.effects.push({ uuid: link.uuid, name: link.name, recipient, linked: true, duration: context.linkedEffectClaims?.[0]?.duration ?? plan.lifecycle.duration ?? null });
    }
    // (Stance rules and linked-Effect claims need PF2e's Effect: without it they're GM notes.)
    if ((context.stanceRules || context.linkedEffectClaims?.length) && !context.effectLinks.length && !plan.selfEffect) {
        // (No PF2e Effect carries these rules: the module's own Stance Effect holds the text, and the GM applies what it can't.)
        if (plan.lifecycle.stance) resolution.notes.push({ text: "PF2e has no Stance Effect for this impulse: its aura rules are shown on the module's Stance Effect for the GM.", audience: "gm", where: "stance" });
        else plan.automation.pendingCapabilities.push("linked-effect-without-pf2e-effect");
    }
    if (plan.lifecycle.stance && !context.effectLinks.some(link => /^Stance:/.test(link.name))) {
        resolution.effects.push({ recipient: "self", generated: "stance", name: `Stance: ${plan.source.name}`, linked: false, stance: true, duration: null, rules: [], text: null });
    }
    if (plan.lifecycle.stance) {
        resolution.kind = resolution.kind === "note" || resolution.kind === "effect" ? "stance" : resolution.kind;
        plan.lifecycle.endsWithAura = true;
    }
    if (resolution.kind === "note" && resolution.effects.length) resolution.kind = "effect";
    if (resolution.kind === "note" && resolution.terrain) resolution.kind = "area";
    if (resolution.kind === "note" && resolution.creations.length) resolution.kind = "creation";
    if (resolution.kind === "note" && plan.movement) resolution.kind = "movement";
    if (resolution.kind === "note" && resolution.tempHp) resolution.kind = "effect";
    if (resolution.kind === "note" && resolution.modes?.some(mode => mode.save || mode.sharedDamage || mode.tempHp)) resolution.kind = "modes";
    // A basic save with no explicit degree rows keeps its standard multipliers; a non-basic one without rows falls back to "affected on a failure".
    if (resolution.check && !resolution.check.basic && resolution.outcomes) {
        const rows = DEGREES.filter(degree => resolution.outcomes[degree].damage.multiplier || resolution.outcomes[degree].conditions.length || resolution.outcomes[degree].effects.length || resolution.outcomes[degree].unaffected);
        if (!rows.length && resolution.sharedDamage) Object.assign(resolution.outcomes.failure.damage, { multiplier: 1 }), Object.assign(resolution.outcomes.criticalFailure.damage, { multiplier: 1 });
        // (An omitted critical success is "unaffected"; an omitted critical failure is the failure.)
        if (!resolution.outcomes.criticalSuccess.conditions.length && !resolution.outcomes.criticalSuccess.unaffected && !resolution.outcomes.criticalSuccess.damage.multiplier) resolution.outcomes.criticalSuccess.unaffected = true;
        const cf = resolution.outcomes.criticalFailure;
        if (!cf.conditions.length && !cf.effects.length && !cf.damage.multiplier && !cf.unaffected && !cf.notes.length) {
            const f = resolution.outcomes.failure;
            Object.assign(cf, structuredClone(f));
        }
    }
    // The level entries: a "Level (Nth)" entry the kineticist has reached is shown on the card; "+N" ones are already in the formulas.
    for (const entry of plan.levelEntries) if (entry.active && entry.at != null) resolution.notes.push({ text: `At level ${entry.at}: ${entry.text}`, audience: "owner", where: "level" });
    plan.automation.level = plan.automation.unclaimed.length || resolution.notes.some(entry => !["claimed", "level"].includes(entry.where)) || plan.automation.pendingCapabilities.length ? "guided" : "automatic";
    if (resolution.kind === "note" && plan.automation.level === "automatic" && !resolution.notes.length) plan.automation.level = "automatic";
}
