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
    const extra = ["Tidal Hands", "Glacial Prison", "Magnetic Pinions", "Ocean's Balm", "Armor in Earth", "Tremor", "Witchwood Seed", "Sand Snatcher", "Fresh Produce", "Burning Demand", "Architect of Flame", "Storm Spiral", "Drifting Pollen", "Winter Sleet", "Command Elemental"];
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
    const item = state.yoon.items.find(i => i.name === name);
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
