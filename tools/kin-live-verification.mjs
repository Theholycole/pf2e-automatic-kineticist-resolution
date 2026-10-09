// Live verification in the pftest world, run in the browser console as the GM:
//   const t = await import("/modules/pf2e-automatic-kineticist-resolution/tools/kin-live-verification.mjs?" + Date.now());
//   await t.setup(); await t.run("scorchingColumn"); … await t.cleanup();
// Every document it makes is named "PFTEST KIN …" (scene, actors) and is deleted by cleanup(). Results: window.__kin.
const MODULE_ID = "pf2e-automatic-kineticist-resolution";
const BASE = `/modules/${MODULE_ID}`;
const PREFIX = "PFTEST KIN";
const YOON = "Compendium.pf2e.iconics.Actor.XaBCp3DygrjJaqR7";
const AURA = "Compendium.pf2e.feat-effects.Item.pLurcSPQb2gjAzoP";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = (globalThis.__kin ??= {});
const card = () => import(`${BASE}/scripts/card.js`);
const record = (name, ok, detail) => { results[name] = { ok, detail }; console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail); return results[name]; };

async function featByName(name) {
    const pack = game.packs.get("pf2e.feats-srd");
    const entry = pack.index.find(e => e.name === name) ?? (await pack.getIndex()).find(e => e.name === name);
    return entry ? (await pack.getDocument(entry._id)).toObject() : null;
}

export const state = { scene: null, yoon: null, yoonToken: null, targets: [] };

/** A scene, Yoon (level 5 fire kineticist) and three NPC targets. */
export async function setup({ level = 5 } = {}) {
    let scene = game.scenes.find(s => s.name === `${PREFIX} Scene`);
    scene ??= await Scene.create({ name: `${PREFIX} Scene`, width: 3000, height: 2000, padding: 0, grid: { size: 100, distance: 5, type: 1 } });
    await scene.view();
    await wait(1500);
    state.scene = scene;
    let folder = game.folders.find(f => f.type === "Actor" && f.name === PREFIX) ?? await Folder.create({ name: PREFIX, type: "Actor" });
    let yoon = game.actors.find(a => a.name === `${PREFIX} Yoon`);
    if (!yoon) {
        const source = (await fromUuid(YOON)).toObject();
        source.name = `${PREFIX} Yoon`;
        source.folder = folder.id;
        yoon = await Actor.create(source);
    }
    const extra = ["Torrent in the Blood", "Reach Spell", "Rain of Rust", "Scrap Barricade", "Fearsome Familiar", "Chain Infusion", "Rattle the Earth", "Counter Element", "Tidal Hands", "Glacial Prison", "Magnetic Pinions", "Ocean's Balm", "Armor in Earth", "Tremor", "Witchwood Seed", "Sand Snatcher", "Fresh Produce", "Burning Demand", "Architect of Flame", "Storm Spiral", "Drifting Pollen", "Winter Sleet", "Command Elemental"];
    const missing = [];
    for (const name of extra) if (!yoon.items.some(i => i.name === name)) { const feat = await featByName(name); if (feat) missing.push(feat); }
    if (missing.length) await yoon.createEmbeddedDocuments("Item", missing);
    state.yoon = yoon;
    const npc = async (name, extra = {}) => game.actors.find(a => a.name === `${PREFIX} ${name}`) ?? Actor.create(foundry.utils.mergeObject({ name: `${PREFIX} ${name}`, type: "npc", folder: folder.id,
        system: { attributes: { hp: { value: 120, max: 120 }, ac: { value: 18 } }, saves: { fortitude: { value: 5 }, reflex: { value: 5 }, will: { value: 5 } }, details: { level: { value: 3 } }, perception: { mod: 5 } } }, extra));
    const a = await npc("Target A"), b = await npc("Target B"), c = await npc("Metal C", { system: { traits: { value: ["metal"] } } });
    const place = async (actor, x, y) => scene.tokens.find(t => t.actorId === actor.id) ?? (await scene.createEmbeddedDocuments("Token", [(await actor.getTokenDocument({ x, y })).toObject()]))[0];
    state.yoonToken = await place(yoon, 500, 1000);
    state.targets = [await place(a, 800, 1000), await place(b, 900, 900), await place(c, 800, 1100)];
    await resetTargets();
    return state;
}

export async function resetTargets() {
    for (const token of state.targets) {
        const actor = token.actor;
        await actor.update({ "system.attributes.hp.value": 120 });
        const items = actor.items.filter(i => ["effect", "condition"].includes(i.type)).map(i => i.id);
        if (items.length) await actor.deleteEmbeddedDocuments("Item", items);
        if (token.x !== token._source.x) {}
    }
    await state.targets[0].update({ x: 800, y: 1000 }, { teleport: true, animate: false });
    await state.targets[1].update({ x: 900, y: 900 }, { teleport: true, animate: false });
    await state.targets[2].update({ x: 800, y: 1100 }, { teleport: true, animate: false });
}

export async function aura(on = true) {
    const yoon = state.yoon;
    const existing = yoon.itemTypes.effect.find(e => e.name === "Effect: Kinetic Aura");
    if (on && !existing) {
        const source = (await fromUuid(AURA)).toObject();
        for (const rule of source.system.rules) if (rule.key === "ChoiceSet") rule.selection = 10;
        foundry.utils.setProperty(source, "flags.pf2e.rulesSelections.auraRadius", 10);
        await yoon.createEmbeddedDocuments("Item", [source]);
    }
    if (!on && existing) await existing.delete();
    await wait(300);
}

/** Open a card for an impulse and return its message. */
async function open(name, targets = state.targets) {
    const { openCard } = await card();
    // (An impulse, not a passive feature of the same name: Extract Element is both a class feature and the action.)
    const item = state.yoon.items.find(i => i.name === name && (i.system?.traits?.value ?? []).includes("impulse")) ?? state.yoon.items.find(i => i.name === name);
    if (!item) throw new Error(`Yoon has no ${name}`);
    const before = game.messages.size;
    await openCard({ item, actor: state.yoon, token: state.yoonToken, targets: targets.map(t => t.object ?? t) });
    for (let i = 0; i < 20 && game.messages.size === before; i++) await wait(100);
    return game.messages.contents.findLast(m => m.flags?.[MODULE_ID]?.card?.itemName === name);
}
const cardState = message => game.messages.get(message.id).flags[MODULE_ID].card;
async function setDegrees(message, degrees) {
    const { requestOp } = await card();
    const s = cardState(message);
    for (const [i, degree] of degrees.entries()) if (s.targets[i]) await requestOp("target", { messageId: message.id, targetId: s.targets[i].id, patch: { degree } });
}
async function click(message, selector) {
    let element = null;
    for (let i = 0; i < 30 && !element; i++) { element = document.querySelector(`li.chat-message[data-message-id="${message.id}"] ${selector}`); if (!element) await wait(200); }
    if (!element) throw new Error(`No ${selector} on the card`);
    // (Shift-click: PF2e's skip-the-roll-dialog convention, as a player's shift-click would.)
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
    await wait(2000);
}
const hp = token => token.actor.system.attributes.hp.value;
const hasEffect = (actor, pattern) => actor.items.some(i => ["effect", "condition"].includes(i.type) && pattern.test(i.name));

export const CASES = {
    /** An area save with damage, overflow ending the aura, terrain and a tracker with Sustain. */
    async scorchingColumn() {
        await resetTargets(); await aura(true);
        const message = await open("Scorching Column");
        const region = (await state.scene.createEmbeddedDocuments("Region", [{ name: "PFTEST KIN template", shapes: [{ type: "circle", x: 850, y: 1050, radiusX: 150, radiusY: 150, radius: 150, rotation: 0, hole: false }] }]))[0];
        await click(message, '[data-kin="use-region"]');
        await setDegrees(message, ["criticalSuccess", "success", "failure", "criticalFailure"]);
        await click(message, '[data-kin="roll-damage"]');
        const damage = cardState(message).damage;
        const before = state.targets.map(hp);
        const { requestOp } = await card();
        await requestOp("apply", { messageId: message.id });
        await wait(1500);
        const after = state.targets.map(hp);
        const tracker = state.yoon.itemTypes.effect.find(e => e.name === "Impulse: Scorching Column");
        const auraGone = !state.yoon.itemTypes.effect.some(e => e.name === "Effect: Kinetic Aura");
        const tagged = game.scenes.get(state.scene.id).regions.get(region.id)?.flags?.[MODULE_ID]?.instance;
        return record("scorchingColumn", Boolean(damage && before[1] - after[1] === Math.floor(damage.total / 2) && before[2] - after[2] === damage.total && tracker && auraGone && tagged),
            { damage: damage?.total, before, after, tracker: Boolean(tracker), auraGone, regionTagged: Boolean(tagged), log: cardState(message).log });
    },
    /** A real save roll through PF2e (one target). */
    async realSave() {
        await resetTargets();
        const message = await open("Tidal Hands", [state.targets[0]]);
        await click(message, '[data-kin="roll-save"]');
        await wait(1000);
        const target = cardState(message).targets[0];
        return record("realSave", Boolean(target.degree && Number.isFinite(target.total)), target);
    },
    /** Tidal Hands: the critical failure's push away from Yoon. */
    async tidalPush() {
        await resetTargets();
        const message = await open("Tidal Hands", [state.targets[0]]);
        await setDegrees(message, ["criticalFailure"]);
        await click(message, '[data-kin="roll-damage"]');
        const x0 = state.targets[0].x;
        await (await card()).requestOp("apply", { messageId: message.id });
        await wait(1500);
        const moved = game.scenes.get(state.scene.id).tokens.get(state.targets[0].id).x - x0;
        return record("tidalPush", moved === 100, { moved, log: cardState(message).log });
    },
    /** A degree save: conditions with durations, an Effect and temporary immunity. */
    async glacialPrison() {
        await resetTargets();
        const message = await open("Glacial Prison", [state.targets[0], state.targets[1]]);
        await setDegrees(message, ["success", "criticalFailure"]);
        await (await card()).requestOp("apply", { messageId: message.id });
        await wait(1500);
        const a = state.targets[0].actor, b = state.targets[1].actor;
        const ok = hasEffect(a, /Slowed/) && hasEffect(b, /Frozen Solid/) && hasEffect(b, /Immune to Glacial Prison/) && Boolean(a.getCondition?.("slowed") ?? a.itemTypes.condition.find(c => c.slug === "slowed"));
        return record("glacialPrison", ok, { a: a.items.map(i => i.name), b: b.items.map(i => i.name) });
    },
    /** Impulse attacks: PF2e's impulse statistic against AC, MAP after all three. */
    async magneticPinions() {
        await resetTargets();
        const message = await open("Magnetic Pinions", state.targets.slice(0, 2));
        await click(message, '[data-kin="roll-attack"][data-index="0"]');
        await click(message, '[data-kin="roll-attack"][data-index="1"]');
        await click(message, '[data-kin="roll-damage"]');
        const s = cardState(message);
        const before = state.targets.slice(0, 2).map(hp);
        await (await card()).requestOp("apply", { messageId: message.id });
        await wait(1500);
        return record("magneticPinions", s.targets.every(t => t.degree) && Boolean(s.damage), { degrees: s.targets.map(t => t.degree), damage: s.damage?.total, before, after: state.targets.slice(0, 2).map(hp) });
    },
    /** Healing with PF2e's linked Effect and temporary immunity. */
    async oceansBalm() {
        await resetTargets();
        await state.targets[0].actor.update({ "system.attributes.hp.value": 50 });
        const message = await open("Ocean's Balm", [state.targets[0]]);
        await click(message, '[data-kin="roll-healing"]');
        const healing = cardState(message).healing?.total;
        await (await card()).requestOp("apply", { messageId: message.id });
        await wait(1500);
        const actor = state.targets[0].actor;
        return record("oceansBalm", hp(state.targets[0]) === 50 + healing && hasEffect(actor, /Ocean's Balm/) && hasEffect(actor, /Immune/), { healing, hp: hp(state.targets[0]), items: actor.items.map(i => i.name) });
    },
    /** Armor in Earth: the armor item replaces the worn one; ending the tracker restores it. */
    async armorInEarth() {
        const message = await open("Armor in Earth", []);
        await (await card()).requestOp("apply", { messageId: message.id });
        await wait(1500);
        const armor = state.yoon.itemTypes.armor.find(i => i.name === "Armor in Earth");
        const ac = state.yoon.armorClass?.value;
        const tracker = state.yoon.itemTypes.effect.find(e => e.name === "Impulse: Armor in Earth");
        await tracker?.delete();
        await wait(1500);
        const gone = !state.yoon.itemTypes.armor.some(i => i.name === "Armor in Earth");
        return record("armorInEarth", Boolean(armor?.isEquipped && tracker && gone), { equipped: armor?.isEquipped, ac, gone, worn: state.yoon.itemTypes.armor.filter(i => i.isEquipped).map(i => i.name) });
    },
    /** A stance: PF2e's Stance Effect; another stance replaces it; the aura's end ends it. */
    async stances() {
        await aura(true);
        const thermal = await open("Thermal Nimbus", []);
        await (await card()).requestOp("update", { messageId: thermal.id, patch: { answers: { casterChoice: "fire" } } });
        await (await card()).requestOp("apply", { messageId: thermal.id });
        await wait(1500);
        const first = state.yoon.itemTypes.effect.some(e => e.name.startsWith("Stance: Thermal Nimbus"));
        const pollen = await open("Drifting Pollen", []);
        await (await card()).requestOp("apply", { messageId: pollen.id });
        await wait(1500);
        const replaced = !state.yoon.itemTypes.effect.some(e => e.name.startsWith("Stance: Thermal Nimbus")) && state.yoon.itemTypes.effect.some(e => /Drifting Pollen/.test(e.name));
        await aura(false);
        await wait(1500);
        const ended = !state.yoon.itemTypes.effect.some(e => /^Stance:/.test(e.name));
        return record("stances", first && replaced && ended, { first, replaced, ended });
    },
    /** The earth impulse junction offered on a 2-action earth impulse (a RollOption Effect gives Yoon the junction). */
    async earthJunction() {
        await resetTargets(); await aura(true);
        const [junction] = await state.yoon.createEmbeddedDocuments("Item", [{ type: "effect", name: `${PREFIX} junction`, system: { rules: [{ key: "RollOption", option: "junction:earth:impulse" }], duration: { value: -1, unit: "unlimited", expiry: null, sustained: false } } }]);
        await wait(500);
        const message = await open("Tremor", [state.targets[0]]);
        const offers = cardState(message).junctions.offers.map(o => o.element);
        await (await card()).requestOp("update", { messageId: message.id, patch: { junctions: { accepted: ["earth"] } } });
        await setDegrees(message, ["success"]);
        await click(message, '[data-kin="roll-damage"]');
        await (await card()).requestOp("apply", { messageId: message.id });
        await wait(1500);
        const effect = state.yoon.itemTypes.effect.some(e => e.name === "Effect: Earth Impulse Junction");
        await junction.delete();
        return record("earthJunction", offers.includes("earth") && effect, { offers, effect });
    },
    /** Creations: Sand Snatcher's token placed (as the owner's clicks would), ended with its tracker. */
    async sandSnatcher() {
        const message = await open("Sand Snatcher", []);
        const { requestOp } = await card();
        const entry = cardState(message).plan.resolution.creations[0];
        await requestOp("placeCreations", { messageId: message.id, placements: [{ entry: { ...entry, size: "med" }, kind: "token", point: { x: 600, y: 800 } }] });
        await wait(1500);
        await requestOp("apply", { messageId: message.id });
        await wait(1500);
        const token = game.scenes.get(state.scene.id).tokens.find(t => t.flags?.[MODULE_ID]?.creation === "Sand Snatcher");
        const tracker = state.yoon.itemTypes.effect.find(e => e.name === "Impulse: Sand Snatcher");
        await tracker?.delete();
        await wait(1500);
        const gone = !game.scenes.get(state.scene.id).tokens.some(t => t.flags?.[MODULE_ID]?.creation === "Sand Snatcher");
        return record("sandSnatcher", Boolean(token && tracker && gone), { token: token?.name, tracker: Boolean(tracker), gone });
    },
    /** Burning Demand: the delayed sigil as a follow-up Effect. */
    async burningDemand() {
        await resetTargets();
        const message = await open("Burning Demand", [state.targets[0]]);
        await (await card()).requestOp("update", { messageId: message.id, patch: { answers: { casterChoice: "Drop prone" } } });
        await setDegrees(message, ["failure"]);
        await (await card()).requestOp("apply", { messageId: message.id });
        await wait(1500);
        return record("burningDemand", hasEffect(state.targets[0].actor, /pending/), { items: state.targets[0].actor.items.map(i => i.name) });
    },
    /** A spell-equivalent through the spell module (Architect of Flame → Wall of Fire). */
    async architectOfFlame() {
        const message = await open("Architect of Flame", []);
        await click(message, '[data-kin="resolve-spell"]');
        await wait(2500);
        const log = cardState(message).spellLog ?? "";
        return record("architectOfFlame", /Wall of Fire at rank 3, class DC 21/.test(log), { log });
    }
};

const coreItem = async (pack, name) => { const p = game.packs.get(pack); const entry = (await p.getIndex()).find(e => e.name === name); return entry ? (await p.getDocument(entry._id)).toObject() : null; };
const MID = MODULE_ID;
const lastWith = flag => game.messages.contents.findLast(m => m.flags?.[MID]?.[flag]);

Object.assign(CASES, {
    /** Hazardous terrain: a creature moving into Scorching Column's squares gets the GM's card; applying it deals the damage. */
    async hazardMove() {
        await resetTargets(); await aura(true);
        const message = await open("Scorching Column", [state.targets[0]]);
        await state.scene.createEmbeddedDocuments("Region", [{ name: "PFTEST KIN template 2", shapes: [{ type: "rectangle", x: 1200, y: 600, width: 300, height: 300, rotation: 0, hole: false }] }]);
        await click(message, '[data-kin="use-region"]');
        await setDegrees(message, ["success"]);
        await click(message, '[data-kin="roll-damage"]');
        await (await card()).requestOp("apply", { messageId: message.id });
        await wait(1500);
        await state.targets[1].update({ x: 1000, y: 700 }, { teleport: true, animate: false });
        await wait(500);
        const before = game.messages.size;
        await state.targets[1].update({ x: 1300, y: 700 });
        await wait(2500);
        const later = game.messages.contents.slice(before).find(m => m.flags?.[MID]?.later);
        const hp0 = hp(state.targets[1]);
        if (later) await click(later, '[data-kin="later-apply"]');
        await wait(1500);
        return record("hazardMove", Boolean(later) && hp(state.targets[1]) < hp0, { card: later?.content?.replace(/<[^>]+>/g, ""), hp: [hp0, hp(state.targets[1])] });
    },
    /** A lingering area's start-of-turn save (Rain of Rust on a metal creature), in combat. */
    async turnStartArea() {
        await resetTargets(); await aura(true);
        const message = await open("Rain of Rust", []);
        await state.scene.createEmbeddedDocuments("Region", [{ name: "PFTEST KIN template 3", shapes: [{ type: "circle", x: 850, y: 1150, radiusX: 200, radiusY: 200, radius: 200, rotation: 0, hole: false }] }]);
        await click(message, '[data-kin="use-region"]');
        await (await card()).requestOp("apply", { messageId: message.id });
        await wait(1500);
        const combat = await Combat.create({ scene: state.scene.id, active: true });
        await combat.createEmbeddedDocuments("Combatant", [{ tokenId: state.yoonToken.id, sceneId: state.scene.id, initiative: 20 }, { tokenId: state.targets[2].id, sceneId: state.scene.id, initiative: 10 }]);
        await combat.startCombat(); await wait(800);
        const before = game.messages.size;
        await combat.nextTurn(); await wait(2500);
        const later = game.messages.contents.slice(before).find(m => m.flags?.[MID]?.later);
        const hp0 = hp(state.targets[2]);
        if (later) await click(later, '[data-kin="later-apply"]');
        await wait(2000);
        await combat.delete();
        const status = later ? game.messages.get(later.id).flags[MID].later.status : null;
        return record("turnStartArea", Boolean(later) && /:/.test(status ?? ""), { status, hp: [hp0, hp(state.targets[2])] });
    },
    /** Fresh Produce: the food card; eating heals and gives PF2e's Effect. */
    async freshProduce() {
        await resetTargets();
        await state.targets[0].actor.update({ "system.attributes.hp.value": 60 });
        const message = await open("Fresh Produce", [state.targets[0]]);
        const entry = cardState(message).plan.resolution.creations[0];
        await (await card()).requestOp("placeCreations", { messageId: message.id, placements: [{ entry, kind: "food" }] });
        await wait(1500);
        const food = lastWith("food");
        const { eat } = await import(`${BASE}/scripts/creations.js`);
        await eat(food.id, state.targets[0].actor.uuid);
        await wait(1500);
        const actor = state.targets[0].actor;
        return record("freshProduce", hp(state.targets[0]) > 60 && hasEffect(actor, /Fresh Produce|Full/), { hp: hp(state.targets[0]), items: actor.items.map(i => i.name) });
    },
    /** Scrap Barricade: a Wall from two points, removed with its tracker. */
    async wallBarricade() {
        const message = await open("Scrap Barricade", []);
        const entry = cardState(message).plan.resolution.creations[0];
        await (await card()).requestOp("placeCreations", { messageId: message.id, placements: [{ entry, kind: "wall", points: [{ x: 1500, y: 500 }, { x: 1500, y: 800 }] }] });
        await wait(1500);
        await (await card()).requestOp("apply", { messageId: message.id });
        await wait(1500);
        const wall = game.scenes.get(state.scene.id).walls.find(w => w.flags?.[MID]?.creation === "Scrap Barricade");
        const tracker = state.yoon.itemTypes.effect.find(e => e.name === "Impulse: Scrap Barricade");
        await tracker?.delete(); await wait(1500);
        const gone = !game.scenes.get(state.scene.id).walls.some(w => w.flags?.[MID]?.creation === "Scrap Barricade");
        return record("wallBarricade", Boolean(wall && tracker && gone), { wall: Boolean(wall), tracker: Boolean(tracker), gone });
    },
    /** Critical blast junction (air): the GM's card on a critical blast, the push applied. */
    async critBlastJunction() {
        await resetTargets();
        const [junction] = await state.yoon.createEmbeddedDocuments("Item", [{ type: "effect", name: `${PREFIX} crit junction`, system: { rules: [{ key: "RollOption", option: "junction:air:critical" }], duration: { value: -1, unit: "unlimited", expiry: null, sustained: false } } }]);
        await wait(500);
        const { onAttackMessage } = await import(`${BASE}/scripts/blast.js`);
        const target = state.targets[0];
        await onAttackMessage({ actor: state.yoon, speaker: { actor: state.yoon.id }, flags: { pf2e: { context: { type: "attack-roll", options: ["action:elemental-blast", "item:trait:air", "action:cost:1"], outcome: "criticalSuccess", target: { actor: target.actor.uuid, token: target.uuid } } } } });
        await wait(1500);
        const crit = lastWith("critJunction");
        const x0 = target.x;
        if (crit) document.querySelector(`li.chat-message[data-message-id="${crit.id}"] .pf2e-kin-crit button`)?.click();
        await wait(2000);
        await junction.delete();
        const moved = game.scenes.get(state.scene.id).tokens.get(target.id).x - x0;
        return record("critBlastJunction", Boolean(crit) && moved > 0, { moved, status: crit ? game.messages.get(crit.id).flags[MID].critJunction.status : null });
    },
    /** Chain Infusion: posting the feat arms the next blast. */
    async chainInfusion() {
        await state.yoon.unsetFlag(MID, "nextBlast");
        const feat = state.yoon.items.find(i => i.name === "Chain Infusion");
        await feat.toMessage();
        await wait(2000);
        return record("chainInfusion", Boolean(state.yoon.flags?.[MID]?.nextBlast?.chain), { nextBlast: state.yoon.flags?.[MID]?.nextBlast });
    },
    /** Fearsome Familiar: an elemental summoned (level ≤ L−4) as a token, removed with the tracker. */
    async summon() {
        const message = await open("Fearsome Familiar", []);
        const summon = cardState(message).plan.resolution.summon;
        let uuid = null;
        for (const pack of game.packs.filter(p => p.documentName === "Actor" && p.metadata.packageName === "pf2e" && /bestiary|monster-core/.test(p.collection))) {
            const index = await pack.getIndex({ fields: ["system.traits.value", "system.details.level.value", "system.traits.rarity"] });
            const entry = index.find(e => (e.system?.traits?.value ?? []).includes("elemental") && Number(e.system?.details?.level?.value) <= summon.maxLevel);
            if (entry) { uuid = `Compendium.${pack.collection}.Actor.${entry._id}`; break; }
        }
        await (await card()).requestOp("summon", { messageId: message.id, uuid });
        await wait(2000);
        await (await card()).requestOp("apply", { messageId: message.id });
        await wait(1500);
        const token = game.scenes.get(state.scene.id).tokens.find(t => t.flags?.[MID]?.summoned);
        const tracker = state.yoon.itemTypes.effect.find(e => e.name === "Impulse: Fearsome Familiar");
        await tracker?.delete(); await wait(1500);
        const gone = !game.scenes.get(state.scene.id).tokens.some(t => t.flags?.[MID]?.summoned);
        return record("summon", Boolean(token && tracker && gone), { token: token?.name, maxLevel: summon.maxLevel, tracker: Boolean(tracker), gone });
    },
    /** Rattle the Earth: Earthquake through the spell module (a save spell). */
    async rattleTheEarth() {
        const message = await open("Rattle the Earth", [state.targets[0]]);
        await click(message, '[data-kin="resolve-spell"]');
        await wait(3000);
        const log = cardState(message).spellLog ?? "";
        return record("rattleTheEarth", /Earthquake at rank 3/.test(log) && !/couldn't be found/.test(log), { log });
    },
    /** Gate attenuator: its item bonus on impulse attacks (PF2e's rule) and its Elemental Spell through the spell module. */
    async gateAttenuator() {
        const source = await coreItem("pf2e.equipment-srd", "Gate Attenuator");
        source.system.equipped = { carryType: "worn", invested: true, inSlot: true };
        const [item] = await state.yoon.createEmbeddedDocuments("Item", [source]);
        await wait(1000);
        const impulse = state.yoon.getStatistic("impulse");
        const bonus = impulse.check.modifiers.find(m => m.enabled && m.type === "item")?.modifier ?? 0;
        const { castElementalSpell } = await import(`${BASE}/scripts/items.js`);
        const result = await castElementalSpell(item, undefined, { element: "fire", force: true });
        await wait(2500);
        await item.delete();
        return record("gateAttenuator", bonus === 1 && result?.stats?.dc >= 17 && /Dehydrate at rank 1/.test(result?.line ?? ""), { bonus, dc: result?.stats?.dc, usesImpulse: result?.stats?.usesImpulse, line: result?.line });
    },
    /** The option: a 2-action impulse counts as a spell (spell-DC modifiers apply), a 1-action one as a Strike (strike-damage modifiers apply). */
    async countsAs() {
        await resetTargets(); await aura(true);
        await game.settings.set(MID, "impulsesAsStrikesAndSpells", true);
        const [bonuses] = await state.yoon.createEmbeddedDocuments("Item", [{ type: "effect", name: `${PREFIX} bonuses`, system: { rules: [
            { key: "FlatModifier", selector: "spell-dc", type: "status", value: 2, slug: "kin-test-spell-dc" },
            { key: "FlatModifier", selector: "strike-damage", type: "status", value: 3, slug: "kin-test-strike-damage" }], duration: { value: -1, unit: "unlimited", expiry: null, sustained: false } } }]);
        await wait(800);
        const tidal = await open("Tidal Hands", [state.targets[0]]);
        const extract = await open("Extract Element", [state.targets[0]]);
        await click(extract, '[data-kin="roll-damage"]');
        const s1 = cardState(tidal), s2 = cardState(extract);
        const damageMessage = game.messages.contents.findLast(m => m.flags?.pf2e?.context?.type === "damage-roll" && m.speaker?.actor === state.yoon.id);
        const strikeBonus = (damageMessage?.flags?.pf2e?.modifiers ?? []).some(m => m.slug === "kin-test-strike-damage") || /\+ ?3|3\]/.test(damageMessage?.rolls?.[0]?.formula ?? "");
        await game.settings.set(MID, "impulsesAsStrikesAndSpells", false);
        await bonuses.delete();
        return record("countsAs", s1.countsAs === "spell" && s1.dc === 23 && s2.countsAs === "strike" && strikeBonus, { tidal: [s1.countsAs, s1.dc], extract: [s2.countsAs, damageMessage?.rolls?.[0]?.formula], strikeBonus });
    }
});

Object.assign(CASES, {
    /** Counting as a spell through the spell module: an armed Reach Spell shapes a 2-action impulse; restrained, a manipulate impulse is lost. */
    async spellLike() {
        await resetTargets(); await aura(true);
        await game.settings.set(MID, "impulsesAsStrikesAndSpells", true);
        const reach = state.yoon.items.find(i => i.name === "Reach Spell");
        await reach.toMessage(); await wait(1500);
        const armed = state.yoon.itemTypes.effect.some(e => e.flags?.["pf2e-automatic-resolution"]?.pendingSpellshape);
        const tidal = await open("Tidal Hands", [state.targets[0]]);
        await wait(2500);
        const s1 = cardState(tidal);
        const shaping = game.messages.get(tidal.id).getFlag("pf2e-automatic-resolution", "shaping");
        const shownShape = /Spellshapes: Reach Spell/.test(document.querySelector(`li.chat-message[data-message-id="${tidal.id}"] .pf2e-kin-card`)?.textContent ?? "");
        await state.yoon.increaseCondition("restrained"); await wait(500);
        const torrent = await open("Torrent in the Blood", [state.targets[0]]);
        await wait(2500);
        const lost = game.messages.get(torrent.id).getFlag("pf2e-automatic-resolution", "spellLost");
        const shownLost = /The impulse is lost/.test(document.querySelector(`li.chat-message[data-message-id="${torrent.id}"] .pf2e-kin-card`)?.textContent ?? "");
        await (await card()).requestOp("apply", { messageId: torrent.id }); await wait(1000);
        const s3 = cardState(torrent);
        await state.yoon.decreaseCondition("restrained", { forceRemove: true }).catch(() => null);
        await game.settings.set(MID, "impulsesAsStrikesAndSpells", false);
        return record("spellLike", armed && Boolean(shaping) && shownShape && Boolean(lost) && shownLost && s3.status !== "applied" && Boolean(s3.disrupted),
            { armed, shapes: (shaping?.shapes ?? []).map(x => x.name), shownShape, lost, shownLost, statusAfterApply: s3.status, disrupted: s3.disrupted });
    }
});

export async function run(name) {
    try { return await CASES[name](); }
    catch (error) { console.error(error); return record(name, false, { error: error.message }); }
}

export async function runAll() {
    for (const name of Object.keys(CASES)) await run(name);
    return results;
}

/** Delete everything the harness made: PFTEST KIN actors, the scene, the creations folder's PFTEST-made actors, the module's chat cards. */
export async function cleanup() {
    const actors = game.actors.filter(a => a.name.startsWith(PREFIX) || (a.folder?.name === "Kineticist creations"));
    if (actors.length) await Actor.deleteDocuments(actors.map(a => a.id));
    const scene = game.scenes.find(s => s.name === `${PREFIX} Scene`);
    if (scene) await scene.delete();
    for (const name of [PREFIX, "Kineticist creations"]) { const folder = game.folders.find(f => f.type === "Actor" && f.name === name); if (folder) await folder.delete(); }
    const messages = game.messages.filter(m => m.flags?.[MODULE_ID] || /PFTEST KIN/.test(m.speaker?.alias ?? "") || /PFTEST KIN/.test(m.content ?? ""));
    if (messages.length) await ChatMessage.deleteDocuments(messages.map(m => m.id));
}
