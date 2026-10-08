// More sentence forms: creations (conjured creatures, objects and walls), armor impulses, lingering areas, Sustain repeats, summons, food,
// forced movement and the rest of the official impulses' wordings. Read before the core forms (src/reader/forms.js).
import {
    re, tag, damageTag, checkTag, conditionTag, uuidTag, templateTag, setSave, setDamage, setWho, outcomesFor, addCondition, setLifecycle, sustain,
    note, areaFrom, areaOf, terrain, auraTrigger, stanceRule, linkedEffect, movement, creation, immunity
} from "./forms.js";
import { readDuration, number } from "./phrases.js";

const SIZES = { tiny: "tiny", small: "sm", medium: "med", large: "lg", huge: "huge", gargantuan: "grg" };

/** "AC Bonus +4; Dex Cap +1; Check Penalty –2; Speed Penalty –10 feet; Strength +3; Bulk 1; Group plate; Armor Traits noisy." */
export function readArmorStatistics(text) {
    const out = {};
    for (const part of text.split(/;\s*/)) {
        const [key, ...rest] = part.split(/\s(?=[+\-–\d]|[a-z])/);
        const value = rest.join(" ").replace(/\.$/, "").trim();
        const n = Number(value.replace("–", "-").replace(/ feet$/, ""));
        if (/^AC Bonus/.test(part)) out.acBonus = Number(/[+\-–]?\d+/.exec(part)[0].replace("–", "-"));
        else if (/^Dex Cap/.test(part)) out.dexCap = Number(/[+\-–]?\d+/.exec(part)[0].replace("–", "-"));
        else if (/^Check Penalty/.test(part)) out.checkPenalty = Number(/[+\-–]?\d+/.exec(part)[0].replace("–", "-"));
        else if (/^Speed Penalty/.test(part)) out.speedPenalty = Number(/[+\-–]?\d+/.exec(part)[0].replace("–", "-"));
        else if (/^Strength/.test(part)) out.strength = Number(/[+\-–]?\d+/.exec(part)[0].replace("–", "-"));
        else if (/^Bulk/.test(part)) out.bulk = /L|light/.test(part) ? 0.1 : Number(/\d+/.exec(part)[0]);
        else if (/^Group/.test(part)) out.group = part.replace(/^Group\s+/, "").replace(/\.$/, "").trim().split(" ")[0].toLowerCase();
        else if (/^Armor Traits/.test(part)) out.traits = part.replace(/^Armor Traits\s+/, "").replace(/\.$/, "").split(/,\s*/).map(trait => trait.trim().toLowerCase());
        else if (key && Number.isFinite(n)) out[key] = n;
    }
    return out.acBonus != null ? out : null;
}

function setCreation(context, patch) {
    const list = context.plan.resolution.creations;
    if (!list.length) list.push({ name: context.plan.source.name });
    Object.assign(list.at(-1), patch);
    if (context.plan.resolution.kind === "note") context.plan.resolution.kind = "creation";
    return true;
}

function sustainRepeat(context, patch) {
    context.plan.resolution.sustainRepeat = { ...(context.plan.resolution.sustainRepeat ?? {}), ...patch };
    return true;
}

export const MORE_FORMS = [
    // ---- Sections: "The first time you Sustain it each round, …" — the next save sentence is the Sustain's repeat.
    [/^The first time you Sustain (?:it|the impulse)(?: each round| on subsequent turns)?, (lightning crisscrosses the needles|you can repeat the effect)\.$/, (m, context) => {
        context.section = "sustain";
        return sustainRepeat(context, { firstEachRound: true, text: m[1], repeatPlan: /repeat the effect/.test(m[1]) });
    }],
    [re("^Each creature in the area takes ⟦T⟧ damage with an? ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        if (context.section !== "sustain") return false;
        const check = checkTag(context, m[2]);
        return sustainRepeat(context, { damage: damageTag(context, m[1]).components, save: { statistic: check.statistic, basic: check.basic }, who: "area" });
    }],
    [re("^The first time you Sustain the impulse each round, the weeping willow attacks again, dealing ⟦T⟧ damage to all enemies in the area with a basic reflex save\\.$"), (m, context) =>
        sustainRepeat(context, { firstEachRound: true, damage: damageTag(context, m[1]).components, save: { statistic: "reflex", basic: true }, who: "area", enemiesOnly: true })],
    [re("^On subsequent turns, the first time you Sustain the impulse that turn, you can roll the grindstone up to (\\d+) feet and can repeat the attack\\.$"), (m, context) =>
        sustainRepeat(context, { firstEachRound: true, move: { feet: Number(m[1]), what: "grindstone" }, repeatAttack: true })],
    [re("^Each time you Sustain (?:it|the impulse), you can (?:roll the ballista up to (\\d+) feet, shoot it if it's loaded, or contribute 1 action toward reloading it|have the crawling fire Stride up to (\\d+) feet|have the sand snatcher either (?:⟦T⟧|Grapple) again or Burrow, Climb, or Stride up to (\\d+) feet|have one tree make a Strike)\\.$"), (m, context, sentence) => {
        if (/ballista/.test(sentence)) return sustainRepeat(context, { options: ["Roll the ballista up to 20 feet", "Shoot it if it's loaded (impulse attack)", "Contribute 1 action toward reloading it"], move: { feet: Number(m[1]), what: "ballista" }, repeatAttack: "if-loaded" });
        if (/crawling fire/.test(sentence)) return sustainRepeat(context, { move: { feet: Number(m[2]), what: "crawling fire", action: "Stride" } });
        if (/sand snatcher/.test(sentence)) return sustainRepeat(context, { options: ["Grapple again (impulse attack)", "Burrow, Climb, or Stride up to 20 feet"], repeatGrapple: true, move: { feet: Number(m[4]), what: "sand snatcher" } });
        return sustainRepeat(context, { creationStrike: { count: 1 } });
    }],
    [re("^When you conjure the sphere and the first time you Sustain the impulse on subsequent rounds, you can either have it Fly up to (\\d+) feet or deal ⟦T⟧ damage to an adjacent creature with a ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        const check = checkTag(context, m[3]);
        setDamage(context, damageTag(context, m[2]));
        setSave(context, check);
        setWho(context, { kind: "targets" });
        context.plan.resolution.optional = { label: "Deal damage to an adjacent creature (instead of flying the sphere up to 20 feet)" };
        return sustainRepeat(context, { firstEachRound: true, repeatPlan: true, alternative: `Fly the sphere up to ${m[1]} feet` });
    }],

    // ---- Conjured creatures, objects and walls.
    [/^A figure of sand with grasping arms arises in an unoccupied square within (\d+) feet\.$/, (m, context) => setCreation(context, { name: "Sand Snatcher", range: Number(m[1]), creature: true })],
    [/^(?:A|An) ([a-z ,]+?) (?:arises|appears|forms|travels from the Plane of Wood|bursts forth)(?:,? (?:in|floating on air in) an? (?:unoccupied )?(?:space|square)(?: of your choice)?)? within (\d+) feet(?:, flashing with electricity)?\.$/, (m, context) =>
        setCreation(context, { name: m[1].trim(), range: Number(m[2]) })],
    [/^You can choose to make it (Small) or (Medium) size, and it can flank\.$/, (m, context) => setCreation(context, { sizes: [SIZES.small, SIZES.medium], flanks: true, creature: true })],
    [re("^When the sand snatcher appears, you can have it attempt to ⟦T⟧ one creature adjacent to it that's no more than one size larger than it\\.$"), (m, context) => setCreation(context, { onAppear: { action: "grapple", maxSizeAbove: 1 } })],
    [/^This Grapple uses your impulse attack roll instead of an Athletics check and shares your multiple attack penalty\.$/, (m, context) => setCreation(context, { grapple: { roll: "impulse", against: "fortitude", map: "shared" } })],
    [re("^Attempts to ⟦T⟧ its grasp use your class DC\\.$|^The ⟦T⟧ DC is also your class DC\\.$"), (m, context) => setCreation(context, { escapeDc: "class" })],
    [/^The ballista is (Medium|Small|Large) and appears in an unoccupied space within (\d+) feet\.$/, (m, context) => setCreation(context, { name: "Ballista", size: SIZES[m[1].toLowerCase()], range: Number(m[2]), object: true })],
    [/^It immediately shoots a bolt with a jagged tip of elemental metal\.$|^Spinning wood and metal together, you create a rugged wooden ballista\.$/, () => true],
    [/^The ballista can be shot again, but it must first be reloaded with two Interact actions\.$/, (m, context) => setCreation(context, { reload: { actions: 2 } })],
    [/^A whirling grindstone made of flint appears in an unoccupied square within (\d+) feet\.$/, (m, context) => setCreation(context, { name: "Whirling Grindstone", range: Number(m[1]), object: true })],
    [/^The grindstone shreds flesh and shoots sparks\.$/, () => true],
    [/^A creature within reach of the grindstone can Interact with it to sharpen a metal weapon\.$/, (m, context) => setCreation(context, { interact: { label: "Sharpen a metal weapon", effect: { name: "Sharpened Weapon", rules: [], duration: { kind: "time", rounds: 10 } } } })],
    [/^This grants a \+2 circumstance bonus to the next damage roll made with that weapon within 1 minute\.$/, (m, context) => {
        const creations = context.plan.resolution.creations;
        const interact = creations.at(-1)?.interact;
        if (!interact) return false;
        interact.effect.rules = [{ key: "FlatModifier", selector: "strike-damage", type: "circumstance", value: 2, removeAfterRoll: true, predicate: ["item:material:metal"] }];
        return true;
    }],
    [/^It is Small and appears in an unoccupied space within (\d+) feet\.$/, (m, context) => setCreation(context, { name: "Crawling Fire", size: "sm", range: Number(m[1]), creature: true, usesSourceDefenses: true, immune: ["fire"] })],
    [/^You mimic the motions of a beast of your devising, and it becomes real, with a flaming pelt and searing claws\.$/, () => true],
    [/^You can sense from the crawling fire's space as well as your own, using your senses\.$/, (m, context) => setCreation(context, { senses: "shared" })],
    [/^When you use a fire impulse, you can have it originate from the crawling fire instead of you \(with the exception of impulses that affect your kinetic aura\)\.$/, (m, context) => setCreation(context, { originates: { traits: ["fire"], exceptAura: true } })],
    [/^The crawling fire can be attacked\.$|^It uses your statistics for defenses but is immune to fire\.$/, () => true],
    [/^Any damage that would be dealt to the crawling fire is dealt to you instead, though you take damage only once from any ability that includes both you and the creation in the area of effect\.$/, (m, context) => setCreation(context, { damageTo: "source" })],
    [/^You conjure up to (six|\w+) cube-shaped mounds of packed earth\.$/, (m, context) => setCreation(context, { name: "Mound", count: number(m[1]) ?? 6, object: true })],
    [/^Each appears in an unoccupied square within (\d+) feet, fills its square, and provides cover\.$/, (m, context) => setCreation(context, { range: Number(m[1]), cover: "standard" })],
    [/^If destroyed, a mound becomes difficult terrain\.$/, (m, context) => setCreation(context, { onDestroyed: { difficult: true } })],
    [/^Sharpened wooden stakes protrude from each mound into adjacent squares\.$|^They can project from any of its sides; you choose which sides for each mound\.$|^Destroying a mound also destroys its stakes\.$/, () => true],
    [re("^For each square of wooden stakes a creature enters, that creature takes ⟦T⟧ damage\\.$"), (m, context) => terrain(context, { hazardous: true, hazard: damageTag(context, m[1]).components, where: "stakes" })],
    [/^The mounds last for an unlimited duration, but if you use the impulse again, any previous one ends\.$/, (m, context) => setLifecycle(context, { duration: { kind: "unlimited" }, replacesPrevious: true })],
    [/^You conjure metal elemental mounts made of interlocking metal pieces\.$/, (m, context) => setCreation(context, { name: "Metal Mount", size: "lg", creature: true, mount: true })],
    [/^Target up to (\d+|five|four) (Medium or smaller )?willing creatures within (\d+) feet(?: of you)?\.$/, (m, context) => {
        context.plan.targeting.target = { count: number(m[1]) ?? Number(m[1]), willing: true, range: Number(m[3]), ...(m[2] ? { maxSize: "med" } : {}) };
        context.plan.targeting.who = "targets";
        context.plan.targeting.maxTargets = context.plan.targeting.target.count;
        return true;
    }],
    [re("^Large mounts appear underneath them, and the targets can immediately ⟦T⟧ the creatures\\.$"), (m, context) => setCreation(context, { perTarget: true })],
    [/^Each mount can take four different forms\.$/, () => true],
    [/^One form has only a land Speed of (\d+) feet, and the other forms each have a land Speed of (\d+) feet with a climb, fly, or swim Speed of (\d+) feet\.$/, (m, context) =>
        setCreation(context, { forms: [{ label: "Runner", speeds: { land: Number(m[1]) } }, ...["climb", "fly", "swim"].map(type => ({ label: type, speeds: { land: Number(m[2]), [type]: Number(m[3]) } }))] })],
    [/^Each rider chooses the initial form and can change the form as a single action, which has the concentration trait\.$/, () => true],
    [/^The mounts have AC (\d+), Fortitude \+(\d+), Reflex \+(\d+), Will \+(\d+), and (\d+) Hit Points\.$/, (m, context) => setCreation(context, { ac: Number(m[1]), saves: { fortitude: Number(m[2]), reflex: Number(m[3]), will: Number(m[4]) }, hp: Number(m[5]) })],
    [re("^They're mindless and immune to bleed, healing, ⟦T⟧, poison, and sleep\\.$"), (m, context) => setCreation(context, { traits: ["mindless"], immune: ["bleed", "healing", "paralyzed", "poison", "sleep"] })],
    [/^They can't attack\.$/, (m, context) => setCreation(context, { noAttacks: true })],
    [/^They remain for (\d+) minutes? or until you use this impulse again\.$/, (m, context) => setLifecycle(context, { duration: { kind: "time", rounds: Number(m[1]) * 10 }, replacesPrevious: true })],
    [/^You can use this impulse as a 1-minute exploration activity to make the duration 1 hour, but this halves the mounts' defenses and HP\.$/, (m, context) => {
        context.plan.resolution.exploration = { label: "1-minute exploration activity: 1 hour, half defenses and HP", duration: { kind: "time", rounds: 600 }, halve: ["ac", "saves", "hp"] };
        return true;
    }],
    [/^Three Large trees appear in unoccupied spaces within (\d+) feet, at least (\d+) feet from one another\.$/, (m, context) => setCreation(context, { name: "Furious Tree", count: 3, size: "lg", range: Number(m[1]), spacing: Number(m[2]), creature: true, immobile: true })],
    [/^Each tree has AC (\d+), Fortitude \+(\d+), Reflex \+(\d+), Will \+(\d+), and (\d+) HP\.$/, (m, context) => setCreation(context, { ac: Number(m[1]), saves: { fortitude: Number(m[2]), reflex: Number(m[3]), will: Number(m[4]) }, hp: Number(m[5]) })],
    [/^The trees can flank, but are unable to move\.$/, (m, context) => setCreation(context, { flanks: true, immobile: true })],
    [/^When the trees appear, each makes a Strike; they share a multiple attack penalty\.$/, (m, context) => setCreation(context, { onAppear: { action: "strike", each: true, sharedMap: true } })],
    [re("^The tree's melee Strike is a branch that has reach (\\d+) feet; on a hit, the target is ⟦T⟧ by the tree \\(⟦T⟧\\)\\.$"), (m, context) => {
        const escape = /dc=(\d+)/.exec(tag(context, m[3])?.body ?? "")?.[1];
        return setCreation(context, { strikes: [...(context.plan.resolution.creations.at(-1)?.strikes ?? []), { name: "Branch", melee: true, reach: Number(m[1]), onHit: { condition: conditionTag(context, m[2])?.condition, escapeDc: escape ? Number(escape) : null } }] });
    }],
    [/^The ranged Strike is a hurled fruit, gourd, seed, or stone with a range increment of (\d+) feet\.$/, (m, context) => setCreation(context, { strikes: [...(context.plan.resolution.creations.at(-1)?.strikes ?? []), { name: "Hurled Fruit", melee: false, rangeIncrement: Number(m[1]) }] })],
    [re("^Either Strike has a ⟦T⟧ attack modifier and deals ⟦T⟧ damage\\.$"), (m, context) => {
        const modifier = Number(/\+(\d+)/.exec(tag(context, m[1])?.body ?? "")?.[1]);
        const damage = damageTag(context, m[2]);
        const creationEntry = context.plan.resolution.creations.at(-1);
        for (const strike of creationEntry?.strikes ?? []) Object.assign(strike, { attack: modifier, damage: damage?.components });
        return !!creationEntry;
    }],
    [/^You plant the seed of a giant bladderwort in an unoccupied square of ground or water within (\d+) feet\.$/, (m, context) => setCreation(context, { name: "Bladderwort Seed", range: Number(m[1]), object: true, hidden: true })],
    [re("^If a creature enters its square, the seed erupts into a voluminous, translucent plant that seals tight around the triggering creature and fills with water\\.$"), (m, context) => setCreation(context, { trigger: { event: "enter-square" } })],
    [re("^Unless the creature succeeds at a ⟦T⟧ save against your class DC, it's ⟦T⟧ within the bladderwort and must hold its breath or begin drowning\\.$"), (m, context) => {
        const check = checkTag(context, m[1]);
        const condition = conditionTag(context, m[2])?.condition;
        return setCreation(context, { trigger: { event: "enter-square", save: { statistic: check.statistic, basic: false }, outcomes: { failure: [{ ...condition, duration: { kind: "escape" } }], criticalFailure: [{ ...condition, duration: { kind: "escape" } }] }, note: "It must hold its breath or begin drowning." } });
    }],
    [/^The plant has AC (\d+) and (\d+) Hit Points\.$/, (m, context) => setCreation(context, { ac: Number(m[1]), hp: Number(m[2]) })],
    [/^If a creature dies inside it, the plant shrinks down, converting itself and the remains into a watery fruit\.$/, (m, context) => setCreation(context, { onDeathInside: "fruit" })],
    [re("^A creature can eat this consumable to regain ⟦T⟧ HP, after which that creature is temporarily immune for (\\d+) minutes\\.$"), (m, context) =>
        setCreation(context, { food: { components: damageTag(context, m[1]).components, immunityRounds: Number(m[2]) * 10, spoilsRounds: 600 } })],
    [/^This fruit rots after 1 hour\.$/, () => true],
    [/^A floating metal ball forms in a space within (\d+) feet, flashing with electricity\.$/, (m, context) => setCreation(context, { name: "Conductive Sphere", range: Number(m[1]), object: true, untargetable: true, adjacentAllies: true })],
    [/^It can't be targeted or damaged\.$/, () => true],
    [/^You conjure a bonfire in an unoccupied ⟦\d+⟧ space within (\d+) feet\.$/, (m, context, sentence) => setCreation(context, { name: "Living Bonfire", range: Number(m[1]), object: true, squares: 4 })],
    [/^The bonfire burns for (\d+) hours, providing all the benefits of a normal campfire\.$/, (m, context) => setLifecycle(context, { duration: { kind: "time", rounds: Number(m[1]) * 600 } })],
    [re("^When you make a wood ranged Elemental Blast, you can have it come from the bonfire instead of you, flinging burning logs\\.$"), (m, context) => setCreation(context, { blastFrom: { element: "wood", ranged: true } })],
    [re("^This blast deals an additional ⟦T⟧ damage\\.$"), (m, context) => { const creationEntry = context.plan.resolution.creations.at(-1); if (!creationEntry?.blastFrom) return false; creationEntry.blastFrom.extraDamage = damageTag(context, m[1]).components; return true; }],
    [/^Each time you do this, the size of the bonfire is reduced by one 5-foot square\.$|^If all the squares are removed, the impulse ends\.$/, (m, context) => setCreation(context, { shrinksOnBlast: true })],
    [/^An ephemeral tree bursts forth, floating on air in an unoccupied square of your choice within (\d+) feet\.$/, (m, context) => setCreation(context, { name: "Tree of Duality", range: Number(m[1]), object: true, center: true })],
    [/^Blooming flowers and fungal growths shed pollen and spores, which a swirling gust of air spreads in a ⟦\d+⟧ around it\.$/, (m, context, sentence) => { areaFrom(context, templateTag(context, /⟦(\d+)⟧/.exec(sentence)[1]), null); context.plan.targeting.area.centredOn = "creation"; return true; }],
    [/^This has both of the following effects\.$/, () => true],
    [re("^The trunk of the weeping willow tree is 10-feet in diameter and appears in an unoccupied space within (\\d+) feet\\.$"), (m, context) => setCreation(context, { name: "Weeping Willow", size: "lg", range: Number(m[1]), object: true, center: true })],
    [re("^The tree whips its branches at all your enemies within a ⟦T⟧ centered on the willow's trunk, dealing ⟦T⟧ damage with a ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        areaFrom(context, templateTag(context, m[1]), null);
        context.plan.targeting.area.centredOn = "creation";
        setDamage(context, damageTag(context, m[2]));
        return setWho(context, { kind: "area", enemiesOnly: true }) && setSave(context, checkTag(context, m[3]));
    }],
    [/^The willow doesn't target you or your allies\.$/, () => true],
    // (Walls: Scrap Barricade, Wooden Palisade, Hedge Maze.)
    [/^(?:Ragged pieces of metal weld together into a ramshackle structure|Planks of wood, embellished with carvings, spring forth to form a wall within (\d+) feet)\.$/, (m, context) => setCreation(context, { name: /metal/.test(m[0]) ? "Scrap Barricade" : "Wooden Palisade", wall: true, ...(m[1] ? { range: Number(m[1]) } : {}) })],
    [/^The (?:barricade|palisade) is up to (\d+) feet long, (\d+) feet high, and ([\d/]+) inch(?:es)? thick\.$/, (m, context) => setCreation(context, { wall: true, length: Number(m[1]), height: Number(m[2]), thickness: m[3] })],
    [/^It must form in a straight line(?: within (\d+) feet)? in an unbroken open space that doesn't pass through any creatures or objects, or the impulse fails\.$/, (m, context) => setCreation(context, { wall: true, straight: true, ...(m[1] ? { range: Number(m[1]) } : {}) })],
    [re("^If any section is destroyed, the entire wall collapses, and each creature adjacent to the wall takes ⟦T⟧ damage with a ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        const check = checkTag(context, m[2]);
        return setCreation(context, { onDestroyed: { collapse: true, damage: damageTag(context, m[1]).components, save: { statistic: check.statistic, basic: check.basic }, who: "adjacent" } });
    }],
    [/^When you create the wall, you can choose to create ledges on one side of the wall, 4 feet from the top, with ladders reaching to them from the bottom of the wall\.$/, (m, context) => setCreation(context, { options: ["Ledges with ladders on one side"] })],
    [/^You sculpt a manicured maze of hedges\.$/, () => true],
    [/^Up to (\d+) hedges spring from the ground where you choose in a (\d+)-foot-square area within (\d+) feet\.$/, (m, context) => setCreation(context, { name: "Hedge", wall: true, count: Number(m[1]), areaSquare: Number(m[2]), range: Number(m[3]) })],
    [/^Each is (\d+) feet long, (\d+) feet wide, and (\d+) feet tall\.$/, (m, context) => setCreation(context, { length: Number(m[1]), width: Number(m[2]), height: Number(m[3]) })],
    [/^The hedges grant standard cover, are difficult terrain, and have a Climb DC of (\d+)\.$/, (m, context) => setCreation(context, { cover: "standard", difficult: true, climbDc: Number(m[1]) })],
    [/^They last until the end of your next turn, and you can Sustain the impulse up to 1 minute\.$/, (m, context) => setLifecycle(context, { duration: { kind: "source-turn", edge: "end" }, sustained: { maxRounds: 10 } })],
    [/^You can spend 10 minutes using this impulse as an exploration activity to instead create a cozy cabin with hedges for walls\.$/, (m, context) => { context.plan.resolution.exploration = { label: "10-minute exploration activity: a cozy cabin of hedges (12 hours)", duration: { kind: "time", rounds: 7200 } }; return true; }],
    [/^It lasts for 12 hours, but ends if you use the impulse again\.$/, (m, context) => setLifecycle(context, { replacesPrevious: true })],
    // (Stepping Stones, Igneogenesis, Flashforge, Eternal Torch: objects the owner places; the card records them.)
    [/^Disks of rock fly to points that you designate to make a new path\.$/, (m, context) => setCreation(context, { name: "Stepping Stones", object: true, path: true })],
    [/^You can set them horizontally to make a path across the ground or atop a liquid, or anchor them into a vertical surface to make steps\.$/, () => true],
    [/^The path can be up to (\d+) feet \(\d+ squares\) long, and steps can extend up to (\d+) feet up the side of the surface\.$/, (m, context) => setCreation(context, { length: Number(m[1]), stepsHeight: Number(m[2]) })],
    [/^All squares must be contiguous and within (\d+) feet of you\.$/, (m, context) => setCreation(context, { range: Number(m[1]) })],
    [/^Moving across the path lets a creature ignore difficult terrain and hazardous terrain from the ground beneath it\.$/, (m, context) => setCreation(context, { ignoresGroundTerrain: true })],
    [/^The disks last until the end of your next turn, but you can Sustain the impulse\.$/, (m, context) => setLifecycle(context, { duration: { kind: "source-turn", edge: "end" }, sustained: { maxRounds: null } })],
    [/^You can create a permanent stone object, either sculpting stone pulled directly from your kinetic gate or manipulating earth and stone around you\.$/, (m, context) => setCreation(context, { name: "Stone Object", object: true })],
    [/^It must fit within one 5-foot cube that's adjacent to you and on solid ground, and you can make the object large enough to occupy the square\.$/, (m, context) => setCreation(context, { cubes: 1, adjacent: true })],
    [/^If you create the object underneath you or another willing creature, you cause the target to rise on top of the object; you can't create it under an unwilling creature\.$/, (m, context) => note(context, m[0], "owner")],
    [/^This impulse has an unlimited duration, but if you use Igneogenesis again, the object returns to its original location or form\.$/, (m, context) => setLifecycle(context, { duration: { kind: "unlimited" }, replacesPrevious: true })],
    [/^You can spend 1 hour to use Igneogenesis as an exploration activity; in this case, the object is permanent and non-magical\.$/, (m, context) => { context.plan.resolution.exploration = { label: "1-hour exploration activity: permanent and non-magical" }; return true; }],
    [/^The object can't include any intricate parts or moving pieces\.$|^You can attempt a Crafting skill check as part of using this impulse to add details to your creation, such as a symbol, short message, or pattern \(with the DC determined by the GM\)\.$/, (m, context) => note(context, m[0], "owner")],
    [/^An artificial metal object forms in the hands of you or a willing ally within (\d+) feet\.$/, (m, context) => { context.plan.targeting.target = { count: 1, willing: true, range: Number(m[1]), includesSelf: true }; return setCreation(context, { name: "Flashforged Item", item: true }); }],
    [/^You can choose a level 0, common, handheld weapon or piece of adventuring gear of 1 Bulk or less\.$/, (m, context) => setCreation(context, { itemChoice: { maxLevel: 0, rarity: "common", maxBulk: 1, kinds: ["weapon", "adventuring gear"] } })],
    [/^The item is entirely made from metal, making some items impossible or impractical to use \(if it's unclear, the GM decides\)\.$|^You can make items with simple moving parts or magnetism, like a compass, poor lock, or merchant's scale\.$/, (m, context) => note(context, m[0], "gm")],
    [re("^The item lasts for (\\d+) minutes, but each time it's used, the user must succeed at a ⟦T⟧ or the item is destroyed after the action is completed\\.$"), (m, context) => {
        setLifecycle(context, { duration: { kind: "time", rounds: Number(m[1]) * 10 } });
        return setCreation(context, { onUse: { flatCheck: 5, failure: "destroyed" } });
    }],
    [/^You open a connection to your kinetic gate, large enough for a torch flame to flow\.$/, () => true],
    [/^You create a magical, torch-like flame within (\d+) feet in any color you choose\.$/, (m, context) => setCreation(context, { name: "Eternal Torch", range: Number(m[1]), light: { bright: 20, dim: 40 } })],
    [/^It's as bright and hot as a torch\.$/, () => true],
    [/^You can have it orbit a target willing creature or emit from a target object that's unattended or attended by a willing creature\.$/, (m, context) => { context.plan.targeting.target = { count: 1, willing: true, orObject: true, range: 120 }; context.plan.targeting.who = "targets"; return true; }],
    [/^If you create a flame on a weapon, you still need to use it as an improvised weapon to attack with the flame, just as with a torch\.$/, (m, context) => note(context, m[0], "owner")],
    [/^The flame has an unlimited duration\.$/, (m, context) => setLifecycle(context, { duration: { kind: "unlimited" } })],
    [/^You can have a maximum number of Eternal Torches equal to your Constitution modifier, and you can Dismiss each torch individually\.$/, (m, context) => setLifecycle(context, { dismissable: true, maxInstances: "con" })],
    // (Living produce and summons.)
    [/^You grow a nourishing nut, vegetable, seed, or fruit\.$/, () => true],
    [/^Choose a creature in your kinetic aura\.$/, (m, context) => { context.plan.targeting.target = { count: 1, inAura: true }; context.plan.targeting.who = "targets"; return true; }],
    [/^The produce grows in their open hand, or at their feet if they have no open hands\.$/, () => true],
    [/^The produce has light Bulk\.$/, () => true],
    [re("^A creature can eat it with an Interact action to regain ⟦T⟧ HP; this is a healing vitality effect\\.$"), (m, context) => setCreation(context, { name: "Fresh Produce", item: true, food: { components: damageTag(context, m[1]).components, action: "Interact" } })],
    [/^The creature feels full for (\d+) minutes, during which it has resistance (\d+) to void damage and can't eat another piece of produce\.$/, (m, context) => {
        const entry = context.plan.resolution.creations.at(-1);
        if (!entry?.food) return false;
        entry.food.immunityRounds = Number(m[1]) * 10;
        entry.food.effect = "linked";
        return true;
    }],
    [/^Produce not consumed by the start of your next turn withers away\.$/, (m, context) => { context.plan.resolution.creations.at(-1).food.spoils = { kind: "source-turn", edge: "start" }; return true; }],
    [/^Your familiar trades places with an elemental from its elemental plane\.$/, () => true],
    [/^Summon a common creature that has the elemental trait and a level no greater than your level - (\d+)\.$/, (m, context) => {
        context.plan.resolution.kind = "summon";
        context.plan.resolution.summon = { traits: ["elemental"], rarity: "common", maxLevel: context.level - Number(m[1]), at: "familiar", replacesFamiliar: true };
        return true;
    }],
    [/^This creature appears in the same space as your familiar, which disappears for the duration of this impulse\.$|^The elemental can appear in a space it can't normally reach\.$/, () => true],
    [/^A creature you summon with the Fearsome Familiar feat gains the summoned trait\.$/, (m, context) => { context.plan.resolution.summon.addTraits = ["summoned"]; return true; }],
    [/^You can Sustain this impulse up to (\d+) minutes?\.$/, (m, context) => setLifecycle(context, { sustained: { maxRounds: Number(m[1]) * 10 } })],
    [/^When the impulse ends, the familiar appears in the space the summoned elemental occupied\.$/, () => true],
    [/^A familiar can endure this process only so often-if you use this impulse on your familiar more than once per day, it dies as soon as it returns the second time\.$/, (m, context) => { context.plan.resolution.summon.oncePerDayWarning = true; return true; }],

    // ---- Armor impulses (Armor in Earth, Hardwood Armor, Metal Carapace).
    [/^(?:Stone encases you like armor|Wood and bark grow over your body like armor|Sheets of bent and rusted metal cover you in an armored shell)\.$/, () => true],
    [/^(?:The|This) (?:stone armor|hardwood armor|carapace|wooden armor) is medium armor but uses your highest armor proficiency\.$/, (m, context) => {
        context.plan.resolution.armor = { ...(context.plan.resolution.armor ?? {}), category: "medium", proficiency: "highest" };
        if (context.plan.resolution.kind === "note") context.plan.resolution.kind = "armor";
        return true;
    }],
    [/^The (?:stone armor|wooden armor|carapace)'s statistics are: (.+)$/, (m, context) => {
        const stats = readArmorStatistics(m[1]);
        if (!stats) return false;
        context.plan.resolution.armor = { ...(context.plan.resolution.armor ?? {}), ...stats };
        return true;
    }],
    [/^You gain its armor specialization effect\.$/, (m, context) => { context.plan.resolution.armor.specialization = true; return true; }],
    [/^Any bonuses, runes, and magical abilities of your actual armor are suppressed, but any (?:runes )?that could apply to the [\w ]+ are replicated onto it\.$/, (m, context) => { context.plan.resolution.armor.replicateRunes = true; return true; }],
    [/^When you use this impulse, you can also create (?:a rusty steel shield|a wooden shield) in a free hand(?:, which uses the statistics of a regular steel shield)?\.$/, (m, context) => {
        context.plan.resolution.armor.shield = /steel/.test(m[0]) ? { base: "steel-shield", hardness: 5, hp: 20, bt: 10, material: "steel" } : { base: "wooden-shield", hardness: 3, hp: 12, bt: 6, material: "wood" };
        return true;
    }],
    [/^You can Shield Block with this shield even if you don't have that feat\.$|^The hand wielding this shield counts as a free hand for using impulses\.$/, (m, context) => { context.plan.resolution.armor.shield.shieldBlock = true; return true; }],
    [/^The shield (?:crumbles to flakes of rust|decays in an instant) if it becomes broken or leaves your grasp\.$/, (m, context) => { context.plan.resolution.armor.shield.endsWhen = ["broken", "dropped"]; return true; }],
    [/^The impulse lasts for (\d+) minutes, and you can Dismiss this impulse\.$|^The armor lasts for (\d+) minutes, and you can Dismiss this impulse\.$/, (m, context) => setLifecycle(context, { duration: { kind: "time", rounds: Number(m[1] ?? m[2]) * 10 }, dismissable: true })],
    [/^The metal is rusted and fragile\.$/, () => true],
    [/^If you take damage from a critical hit, the metal shatters and the impulse ends\.$/, (m, context) => setLifecycle(context, { ends: [...context.plan.lifecycle.ends, "critical-hit-damage"] })],

    // ---- Forced movement, jumps and other movement.
    [/^It Flies from you up to (\d+) feet in a path you choose\.$/, (m, context) => { context.plan.targeting.path = { feet: Number(m[1]), from: "self" }; return true; }],
    [/^Choose a creature within (\d+) feet of you\.$/, (m, context) => { context.plan.targeting.target = { count: 1, range: Number(m[1]) }; context.plan.targeting.who = "targets"; return true; }],
    [/^The target jumps in any direction, up to a maximum of (\d+) feet\.$/, (m, context) => { context.plan.resolution.forcedJump = { maxFeet: Number(m[1]) }; return true; }],
    [/^If the target doesn't land on a space of solid ground within 30 feet of where it started, it falls unless it has a fly Speed but doesn't take any damage from the fall\.$|^You choose the distance and direction of the jump\.$/, (m, context) => note(context, m[0], "owner")],
    [re("^If you target an unwilling creature, it attempts a ⟦T⟧ save against your class DC with the following results\\.$"), (m, context) => {
        setSave(context, checkTag(context, m[1]), { basic: false });
        context.plan.resolution.check.onlyIf = { question: "Is the target unwilling?", otherwise: "full-effect" };
        context.degreeMode = true;
        return true;
    }],
    [/^Mimicking the anemoi-monarchs of the four winds-you propel four creatures\.$/, () => true],
    [/^Each of those creatures can Stride up to half its Speed\.$|^If it has a fly Speed, it can instead Fly up to half its fly Speed\.$/, (m, context, sentence) => movement(context, sentence, { forTargets: true })],
    [/^Target up to four willing creatures within (\d+) feet of you\.$/, (m, context) => { context.plan.targeting.target = { count: 4, willing: true, range: Number(m[1]) }; context.plan.targeting.who = "targets"; context.plan.targeting.maxTargets = 4; return true; }],
    [/^After the impulse deals damage, you can Swim in a straight line to any point in its area before the water disappears\.$/, (m, context, sentence) => movement(context, sentence, { after: "damage" })],
    [/^Air currents flow upward to slow the target's fall to 60 feet per round\.$|^The cushion ends when the target reaches the ground, and the creature takes no damage from the fall\.$|^The cushion expires if the creature doesn't reach the ground within 1 minute, but any distance it fell during that minute doesn't count for any damage the creature would take from the fall\.$/, (m, context) => {
        context.plan.resolution.effects.push(...(context.plan.resolution.effects.some(effect => effect.generated === "air-cushion") ? [] : [{ generated: "air-cushion", name: "Air Cushion", recipient: "targets", duration: { kind: "time", rounds: 10 }, rules: [], text: "Falls at 60 feet per round and takes no damage from the fall; ends when it reaches the ground (or after 1 minute, with no falling damage for that minute)." }]));
        context.plan.targeting.who ??= "targets";
        if (context.plan.resolution.kind === "note" || context.plan.resolution.kind === "reaction") context.plan.resolution.kind = "effect";
        return true;
    }],
    [/^This impulse weakens if you use it too frequently\.$/, (m, context) => { context.plan.resolution.repeatWithin ??= { rounds: 100 }; return true; }],
    [/^As the wave crashes down, you can catch it to your destination\.$/, (m, context, sentence) => movement(context, sentence, { after: "damage" })],
    [/^While you're wearing or holding an item of light Bulk or greater that's Plated in Treasure, any metal created by one of your impulses is plated with the metal\.$/, (m, context) => note(context, m[0], "owner")],
    [/^You can use Body of Air as a reaction only when the trigger is met, but you can use it as a 2-action activity without the trigger being met\.$/, (m, context) => { context.plan.activation.alternative = { time: "2", withoutTrigger: true }; return true; }],
    [/^If you activate your kinetic aura, [A-Z][\w ]+ ends\.$/, (m, context) => setLifecycle(context, { ends: [...context.plan.lifecycle.ends, "aura-activated"] })],

    // ---- Targets.
    [/^Target a willing creature within (\d+) feet\.$/, (m, context) => { context.plan.targeting.target = { count: 1, willing: true, range: Number(m[1]) }; context.plan.targeting.who = "targets"; return true; }],
    [/^Target a creature within (\d+) feet that has a trait matching one of your kinetic elements or is made of one of your kinetic elements\.$/, (m, context) => {
        context.plan.targeting.target = { count: 1, range: Number(m[1]), elementTrait: true };
        context.plan.targeting.who = "targets";
        return true;
    }],
    [/^Target a creature you can observe within (\d+) feet\.$/, (m, context) => { context.plan.targeting.target = { count: 1, range: Number(m[1]) }; context.plan.targeting.who = "targets"; return true; }],
    [/^You touch a creature to implant a malignant seed in its body\.$/, (m, context) => { context.plan.targeting.target = { count: 1, range: "touch" }; context.plan.targeting.who = "targets"; return true; }],

    // ---- Command Elemental.
    [/^The elemental becomes controlled by you if its level is equal to or lower than your level - (\d+), or ⟦\d+⟧ for as long as you Sustain the effect if its level is equal to your level - (\d+) or higher\.$/, (m, context) => {
        context.plan.resolution.control = { controlledAtMost: context.level - Number(m[1]), slowedAtLeast: context.level - Number(m[2]) };
        return true;
    }],
    [re("^It can attempt a ⟦T⟧ saving throw against your class DC to resist being ⟦T⟧ by you or to end the slowed effect\\.$"), (m, context) => {
        setSave(context, checkTag(context, m[1]), { basic: false });
        context.degreeMode = true;
        return setWho(context, { kind: "targets" });
    }],
    [/^If the target is already under someone else's command, it can't be slowed by this ability, and the controlling creature also rolls a saving throw, with the elemental using the better result\.$/, (m, context) => {
        context.plan.resolution.check.alreadyControlled = { question: "Is the elemental already under someone else's command?", rollTwiceBetter: true, noSlow: true };
        return true;
    }],

    // ---- Extract Element's success.
    [/^You can't target a creature with Extract Element if elemental matter you extracted from it is already in your kinetic aura\.$/, (m, context) => { context.plan.targeting.actorConstraints.predicates.push({ kind: "not-extracted" }); return true; }],

    // ---- Burning Demand, Wiles on the Wind, Infinite Expanse, Whisper on the Wind and other choices.
    [re("^You create a faintly glowing sigil \\(shedding normal light in a 5-foot radius\\) on the target's body, after which you command the target to approach you, run away \\(as if it had the ⟦T⟧ condition\\), release what it's holding, drop ⟦T⟧, or stand in place\\.$"), (m, context) => {
        context.plan.resolution.casterChoice = { label: "Command", options: ["Approach you", "Run away (as if fleeing)", "Release what it's holding", "Drop prone", "Stand in place"] };
        context.plan.targeting.who = "targets";
        return true;
    }],
    [/^You create an auditory illusion that comes from a square within (\d+) feet and can be as loud as four normal humans talking\.$/, (m, context) => setCreation(context, { name: "Auditory Illusion", range: Number(m[1]), object: true, illusion: true })],
    [/^The sound can be intricate, including speech or music, though the GM might require you to attempt a check or know a language for it to be convincing\.$/, (m, context) => note(context, m[0], "gm")],
    [re("^You can have any creature within (\\d+) feet of the illusion, or that comes within \\1 feet of it during the duration, attempt a ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        setSave(context, checkTag(context, m[2]), { basic: false });
        context.degreeMode = true;
        context.plan.targeting.who = "chosen";
        context.plan.targeting.near = { feet: Number(m[1]), of: "creation", onEnter: true };
        return true;
    }],
    [/^This is a mental effect\.$/, (m, context) => { context.plan.resolution.check.traits = [...(context.plan.resolution.check.traits ?? []), "mental"]; return true; }],
    [/^Any effect of the illusion ends for a creature as soon as it leaves the illusion's area or the impulse ends, and the creature then becomes temporarily immune for 1 hour\.$/, (m, context) => {
        context.plan.resolution.areaBound = { endsOnLeave: true, endsWithImpulse: true, immunityAfterRounds: 600 };
        return true;
    }],
    [/^If you start your message with the target's name, you and the target don't need to be able to see each other, nor do you need line of effect\.$/, (m, context) => { context.plan.resolution.spell?.adjustments.push(m[0]); return !!context.plan.resolution.spell; }],
    [/^If you suspend any conditions with Alloy Flesh and Steel, when it ends, you're temporarily immune to Alloy Flesh and Steel for 1 hour\.$/, (m, context) => setLifecycle(context, { onEnd: { question: "Did it suspend any conditions?", immunityRounds: 600 } })],
    [/^For (\d+) minutes, it gains the effects of a ⟦\d+⟧ spell, can breathe water, and gets a \+1 status bonus to AC and saves against any creature with the amphibious, aquatic, or water trait\.$/, (m, context, sentence) => {
        const spell = uuidTag(context, /⟦(\d+)⟧/.exec(sentence)[1]);
        context.plan.resolution.effects.push({ recipient: "targets", generated: "return-to-the-sea", name: "Return to the Sea", duration: { kind: "time", rounds: Number(m[1]) * 10 }, spellEffects: spell ? { uuid: spell.uuid, name: spell.label } : null,
            rules: [{ key: "FlatModifier", selector: ["ac", "saving-throw"], type: "status", value: 1, predicate: [{ or: ["origin:trait:amphibious", "origin:trait:aquatic", "origin:trait:water"] }] }],
            text: "It gains the effects of Feet to Fins, can breathe water, and its attacks ignore the effects water normally has on bludgeoning and slashing attacks." });
        if (context.plan.resolution.kind === "note") context.plan.resolution.kind = "effect";
        return true;
    }],
    [/^In addition, its attacks ignore the effects water normally has on bludgeoning and slashing attacks\.$/, () => true],
    [/^You adapt a creature to living and moving in water\.$/, () => true],
    [/^Rock overflows from within you to consume your form before cracking open to reveal your body transformed into living stone\.$|^You're immune to critical hits and precision damage\.$|^You can't be pushed, pulled, or tripped while you're standing on earth or stone\.$/, (m, context) => linkedEffect(context, { recipient: "self" })],
    [/^These benefits last until the end of your next turn, but you can Sustain them up to (\d+) minutes?\.$/, (m, context) => setLifecycle(context, { duration: { kind: "source-turn", edge: "end" }, sustained: { maxRounds: Number(m[1]) * 10 } })],

    // ---- Lingering areas: Rain of Rust, Ignite the Sun, Sanguivolent Roots.
    [/^You conjure a red raincloud in a ⟦\d+⟧ within (\d+) feet, which pours rust-colored rain directly below it\.$/, (m, context, sentence) => { areaFrom(context, templateTag(context, /⟦(\d+)⟧/.exec(sentence)[1]), Number(m[1])); return terrain(context, { lingering: true }); }],
    [/^Any creature in the rain with the metal trait, that is made of metal, or is wearing metal armor is covered in corrosive build-up\.$/, (m, context) => terrain(context, { affects: { question: "Does it have the metal trait, is it made of metal, or is it wearing metal armor?", metal: true } })],
    [re("^Any such creature is ⟦T⟧ as long as it remains in the area\\.$"), (m, context) => terrain(context, { inAreaConditions: [conditionTag(context, m[1]).condition] })],
    [re("^If such a creature is in the rain at the start of its turn, it takes ⟦T⟧ damage with a ⟦T⟧ save against your class DC, plus ⟦T⟧ damage if it fails\\.$"), (m, context) => {
        const check = checkTag(context, m[2]);
        return terrain(context, { turnStart: { damage: damageTag(context, m[1]).components, save: { statistic: check.statistic, basic: check.basic }, persistentOnFailure: damageTag(context, m[3]).components } });
    }],
    [/^You create a miniature sun in a ⟦\d+⟧ within (\d+) feet\.$/, (m, context, sentence) => { areaFrom(context, templateTag(context, /⟦(\d+)⟧/.exec(sentence)[1]), Number(m[1])); return terrain(context, { lingering: true }); }],
    [re("^A creature takes ⟦T⟧ damage any time it's in the miniature sun, with a ⟦T⟧ save against your class DC\\.$"), (m, context) => {
        const check = checkTag(context, m[2]);
        setDamage(context, damageTag(context, m[1]));
        setSave(context, check);
        setWho(context, { kind: "area" });
        return terrain(context, { inArea: { damage: true, oncePerRound: true, events: ["enter", "turn-start", "cast"] } });
    }],
    [re("^The sun sheds bright light in a ⟦T⟧ \\(and dim light for another (\\d+) feet\\); this is sunlight for creatures with a particular vulnerability to sunlight\\.$"), (m, context) => terrain(context, { light: { bright: templateTag(context, m[1]).distance, dim: Number(m[2]), sunlight: true } })],
    [/^The first time you Sustain the impulse each round, you can choose to increase the size of the sun's burst by 5 feet, then make it Fly up to 30 feet\.$/, (m, context) => sustainRepeat(context, { firstEachRound: true, grow: 5, move: { feet: 30, what: "sun" } })],
    [/^The sun can move through creatures, damaging them as described above\.$/, () => true],
    [/^The sun continually channels fire into you and your allies\.$/, () => true],
    [re("^You and each of your allies within the sun's light deal an additional ⟦T⟧ damage with all Strikes, spells that deal fire damage, and impulses that deal fire damage \\(except for Ignite the Sun itself\\)\\.$"), (m, context) => {
        context.plan.resolution.effects.push({ recipient: "allies-in-light", generated: "sunfire", name: "Ignite the Sun", rules: [{ key: "DamageDice", selector: ["strike-damage"], diceNumber: 1, dieSize: "d6", damageType: "fire" }], text: "An additional 1d6 fire damage with all Strikes, spells that deal fire damage, and impulses that deal fire damage (except Ignite the Sun). Not cumulative with multiple suns.", duration: { kind: "impulse" } });
        return true;
    }],
    [/^These aren't cumulative with multiple suns\.$/, () => true],
    [/^Each time the vines drink blood, living creatures in the area who aren't your enemies regain HP equal to half the damage a single creature took; calculate this using the highest damage a single creature took\.$/, (m, context) => { context.plan.resolution.drainHeal = { fraction: 0.5, of: "highest-damage", recipients: "living-non-enemies-in-area" }; return true; }],
    [/^This is a healing vitality effect\.$/, () => true],
    [/^Your enemies with void healing in the area take vitality damage in the same amount as the healing\.$/, (m, context) => { context.plan.resolution.drainHeal.voidEnemies = "vitality-damage"; return true; }],
    [/^Blood-drinking vines grow from the ground in a ⟦\d+⟧ within (\d+) feet\.$/, (m, context, sentence) => areaFrom(context, templateTag(context, /⟦(\d+)⟧/.exec(sentence)[1]), Number(m[1]))],
    // (Aerial Boomerang: the line, the whirling square, the return.)
    [/^In the final square of the line, the boomerang whirls in place until the end of your next turn\.$/, (m, context) => terrain(context, { lingering: true, square: "end-of-line", until: { kind: "source-turn", edge: "end" } })],
    [/^Any creature that ends its turn in that square has to save against the boomerang\.$/, (m, context) => terrain(context, { turnEnd: { usesPlan: true } })],
    [/^On your next turn, you can use a single action, which has the concentrate trait, to return the boomerang to you\.$/, (m, context) => { context.plan.resolution.followUp = { label: "Return the boomerang", actions: 1, traits: ["concentrate"], when: "source-next-turn", repeatPlan: true, area: "line-back" }; return true; }],
    [/^It returns in a line from its square to your current location, with the same effect as the initial line, then the impulse ends\.$|^You must have line of effect to the boomerang and be within 60 feet of it\.$/, () => true],

    // ---- Stance texts PF2e's Stance Effect carries.
    [/^You direct waves of warmth into or out of your kinetic gate to drastically shift the temperature around you\.$|^You shape your kinetic aura into swirling armor of steam that scalds your enemies and propels you on super-heated jet streams\.$|^Your steam armor has the following effects\.$/, () => true],
    [/^If you don't have a fly Speed, you gain a 20-foot fly Speed\.$|^If you have the Cyclonic Ascent impulse, you instead gain that fly Speed and the extra benefits\.$|^Your air Elemental Blasts deal an additional ⟦\d+⟧ damage\.$|^You become one with a devastating thunderstorm from the Plane of Air, placing a crown of lightning upon your brow\.$|^Sparks flash in your eyes, and lightning strikes constantly in the air around you as howling winds lift you from the ground\.$/, (m, context) => stanceRule(context)],
    [/^You become Large if you were smaller\.$|^This increases your reach by 5 feet \(or by 10 feet if you started out Tiny\)\.$|^You gain a climb Speed equal to your land Speed, but you can use it only to climb surfaces of earthen matter\.$|^The armor grants you a \+1 circumstance bonus to your Fortitude saves and a \+2 circumstance bonus to your Fortitude or Reflex DCs against attempts to ⟦\d+⟧ you, ⟦\d+⟧ you, or knock you ⟦\d+⟧\.$|^If your Strength is below \+4, this armor raises your Strength to \+4\.$|^If your Strength is \+4 or higher, this armor grants you a \+1 item bonus to your Strength\.$|^Enormous pieces of rock cluster around your body\.$/, (m, context) => stanceRule(context)],
    [re("^If you have the ⟦T⟧ impulse, you can add its effects to Assume Earth's Mantle\\.$"), (m, context) => { context.plan.resolution.combine = { impulse: uuidTag(context, m[1])?.label, question: "Add Armor in Earth's effects?" }; return true; }],
    [/^Your elemental gate exudes a faint mist that feels as thick as standing water\.$|^Though not unique to Chelaxian kineticists, this sarglagoninspired technique floods enemies' lungs\.$|^The moisture doesn't just tug at limbs; it forcibly seeps into the nostrils and lungs of air-breathing creatures\.$/, () => true],
    [/^As a candle can light another, you awaken the latent potential to channel fire in other creatures\.$/, () => true],
    [/^Eerily beautiful elemental water beings race around you, eager to protect and heal you and your allies\.$|^Their forms vary and might include eels formed of undulating water or ice crystals whirling in the shape of a jellyfish\.$/, () => true],
    [/^A magnetic field surrounds you\.$/, () => true],

    // ---- Elemental Blast / Matter Blast openings.
    [/^With a wave of your hand, you collect elemental matter from your aura and swing or hurl it\.$/, () => true],
    [/^1 to 2$/, (m, context) => { context.plan.activation.variableActions = "1 to 2"; return true; }],
    [/^You extract elemental matter from a creature's body to weaken it and take its power for your own\.$/, () => true],
    [/^For example, air can be breathed by an air-breathing creature, and fire casts light and can ignite flammable substances\.$/, () => true],
    [/^It's trivial for you to create some of your element or alter a portion of it that already exists\.$|^Choose one of your kinetic elements to affect\.$/, () => true],
    [/^You turn an element into its purest form\.$|^Choose one of your kinetic elements and target up to 1 cubic foot of that element within (\d+) feet\.$|^\(One cubic foot of liquid is roughly 8 gallons\.\)|^You remove toxins and pollutants from the element as well as anything intruding into the element, such as plant roots in soil\.$|^This can't change the grade of a material, alter the form of a manufactured object, or change the structural integrity of the element\.$/, (m, context, sentence) => note(context, sentence, "owner")],
    [/^You grasp the animating force within an elemental creature and bend it to your will\.$/, () => true],
    [/^Lava reflexively explodes underneath you and the creature that hurt you\.$|^A slew of logs eject from the Plane of Wood and slam into your enemies\.$|^Your flesh gives way as you're struck, becoming coarse sand that can magically turn your enemy to stone\.$|^A cascade of water blunts or disperses the incoming attack\.$|^Terrifying trees attack your enemies\.$|^An illusion of a limitless expanse with an impossibly blue sky makes all within feel the sensation of falling\.\.\. forever\.$|^A hurricane lifts your enemies into the air before bringing them crashing down in a bloody rain\.$|^You fall through your own kinetic gate, leaving behind an effigy of flame and reappearing majestically near another fire\.$|^You touch a creature to implant a malignant seed in its body\.$|^You wreath yourself in molten stone and hurtle toward your enemy\.$/, () => true],
    [/^You conjure a massive willow tree, which lashes your foes with a thousand branches\.$|^The landscape fills with monumental filaments of metal\.$|^You adapt a creature to live among the trees, improving its ability to climb, balance, and leap\.$|^Speaking lies, you set them loose upon a drifting wind\.$|^Mimicking/, () => true],
    [/^You choose shards or spines, which changes the area, damage type, and critical failure effect\.$/, (m, context) => { context.plan.resolution.modeChoice = { label: "Form", required: true }; return true; }],
    [re("^A healing wave splashes across creatures in a ⟦T⟧, its cleansing water driving afflictions from the body\\.$"), (m, context) => areaFrom(context, templateTag(context, m[1]), null)],
    [/^Modulate and slow last until the end of your next turn, but you can Sustain the impulse to continue them\.$/, (m, context) => setLifecycle(context, { duration: { kind: "source-turn", edge: "end" }, sustained: { maxRounds: null, modes: ["Modulate", "Slow"] } })],
    [/^The moon has always been connected to the tides, and now you can grasp that connection\.$|^You can create massive amounts of water and control these tides, subverting even the moon's sovereignty over the oceans and seas\.$/, () => true],
    [re("^Choose an area ⟦T⟧ within (\\d+) feet, and choose two different effects from the options provided below\\.$"), (m, context) => { areaFrom(context, templateTag(context, m[1]), Number(m[2])); context.plan.resolution.modeChoice = { label: "Effects", count: 2, ordered: true }; return true; }],
    [/^The effects take place in the listed order\.$|^Flood and control are permanent and non-magical\.$/, () => true],
    [/^Choose the starting season\.$/, (m, context) => { context.plan.resolution.modeChoice = { label: "Starting season", cycle: true }; return true; }],
    [/^The seasons shift rapidly\.$/, () => true]
];

export const MORE_OPTION_FORMS = [
    // (Magnetic Field's polarities: the stance's choice, read by PF2e's Stance Effect.)
    [/^(Attract|Repel) A creature that is wearing metal armor, has the metal trait, or is made of metal treats squares in your kinetic aura as difficult terrain when moving (?:away from|closer to) you\. You (?:pull|push) unattended metal objects of light Bulk or less in your kinetic aura (?:to you|away)\.(?: They (?:gather in your space and move with you|stop moving once they're outside your aura)\.)?$/, (m, context) => {
        context.plan.resolution.stanceChoice ??= { label: "Polarity", options: [] };
        if (!context.plan.resolution.stanceChoice.options.includes(m[1])) context.plan.resolution.stanceChoice.options.push(m[1]);
        return true;
    }],
    // (Base Kinesis' Move option.)
    [/^Move Move an existing piece of the element up to (\d+) feet in any direction\. If you bring it into your space, you can catch it in an open hand\. You can Sustain the impulse to keep moving the element\.$/, (m, context) => {
        context.modes.push({ label: "Move", text: m[0].replace(/^Move /, ""), sustained: true });
        context.plan.resolution.modes = context.modes;
        return true;
    }],
    // (Tree of Duality, its two effects on separate lines.)
    [re("^Cleansing Pollen \\(healing, vitality\\) Each living ally that's in the area or enters it regains ⟦T⟧ HP and is then temporarily immune to regaining HP from [A-Z][\\w ]+ for (\\d+) minutes\\.$"), (m, context) => {
        context.plan.resolution.healing = { components: damageTag(context, m[1]).components, recipients: "living-allies-in-area", immunityRounds: Number(m[2]) * 10, onEnter: true };
        if (context.plan.resolution.kind === "note" || context.plan.resolution.kind === "creation") context.plan.resolution.kind = "area";
        return true;
    }],
    [re("^Hallucinogenic Spores \\(mental\\) Enemies in the area are ⟦T⟧\\. An enemy that leaves the area remains dazzled until the start of its next turn\\.$"), (m, context) => {
        context.plan.resolution.areaConditions = [{ who: "enemies", condition: conditionTag(context, m[1]).condition, duration: { kind: "area", lingerUntil: { kind: "target-turn", edge: "start" } } }];
        return true;
    }]
];
