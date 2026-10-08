// Creations: what an impulse conjures, placed by its owner and ended with the impulse (its tracker).
//   creatures and objects with statistics → a token of a world NPC actor in the "Kineticist creations" folder, built from the text (AC, HP, saves,
//     size, Strikes); the actor is reused, the token ends with the impulse (decision "conjured: token", 2026-10-01)
//   walls (Scrap Barricade, Wooden Palisade) → Wall segments drawn with two clicks
//   hedges (Hedge Maze) → difficult-terrain Regions
//   food (Fresh Produce, a bladderwort's fruit) → an "Eat" card for the creature
import { MODULE_ID, escapeHTML, notifyError, tokenOf, isActiveGM, DamageRollClass, componentsFormula, distanceBetween } from "./utils.js";
import { requestOp, stateOf } from "./card.js";
import { createEffect, applyHealing } from "./apply.js";

const FOLDER = "Kineticist creations";
const SIZES = { tiny: "tiny", sm: "sm", med: "med", lg: "lg", huge: "huge", grg: "grg" };
const SQUARES = { tiny: 0.5, sm: 1, med: 1, lg: 2, huge: 3, grg: 4 };

/** One click on the canvas: its point (Escape cancels). */
function clickPoint(prompt) {
    ui.notifications.info(prompt);
    return new Promise(resolve => {
        const stage = canvas.stage;
        const onDown = event => {
            const point = event.data?.getLocalPosition?.(stage) ?? event.getLocalPosition?.(stage) ?? null;
            cleanup();
            resolve(point ? canvas.grid.getTopLeftPoint?.(point) ?? point : null);
        };
        const onKey = event => { if (event.key === "Escape") { cleanup(); resolve(null); } };
        const cleanup = () => { stage.off("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
        stage.once("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
    });
}

/** Place every creation the card's impulse makes. Runs on the owner's client (clicks), the documents are made by the GM. */
export async function placeCreations(message, state) {
    const actor = await fromUuid(state.sourceActorUuid);
    const sourceToken = state.sourceTokenUuid ? await fromUuid(state.sourceTokenUuid).catch(() => null) : tokenOf(actor);
    const placements = [];
    for (const entry of state.plan.resolution.creations) {
        if (entry.item || entry.food) { placements.push({ entry, kind: "food" }); continue; }
        if (entry.wall && (entry.length || entry.straight) && !entry.count) {
            const a = await clickPoint(`${entry.name}: click the wall's start.`); if (!a) return;
            const b = await clickPoint(`${entry.name}: click the wall's end (up to ${entry.length ?? "?"} feet).`); if (!b) return;
            placements.push({ entry, kind: "wall", points: [a, b] });
            continue;
        }
        if (entry.perTarget) {
            for (const target of state.targets.filter(t => !t.excluded)) placements.push({ entry, kind: "token", point: (() => { const token = fromUuidSync(target.tokenUuid); return token ? { x: token.x, y: token.y } : null; })(), mount: target.tokenUuid });
            continue;
        }
        if (entry.path || (entry.wall && entry.count)) {
            const count = entry.count ?? 1;
            for (let i = 0; i < count; i++) {
                const point = await clickPoint(`${entry.name} ${i + 1}/${count}: click its square (Escape to stop).`);
                if (!point) break;
                placements.push({ entry, kind: "region", point });
            }
            continue;
        }
        const count = entry.count ?? 1;
        let size = entry.size ?? "med";
        if (entry.sizes?.length) size = await chooseSize(entry) ?? size;
        for (let i = 0; i < count; i++) {
            const point = await clickPoint(`${entry.name}${count > 1 ? ` ${i + 1}/${count}` : ""}: click where it appears${entry.range ? ` (within ${entry.range} feet)` : ""}.`);
            if (!point) break;
            if (entry.range && sourceToken) {
                const feet = canvas.grid.measurePath([sourceToken.object?.center ?? sourceToken.center, point]).distance;
                if (feet > entry.range + 5) ui.notifications.warn(`${entry.name}: that's ${Math.round(feet)} feet away (the text says within ${entry.range}).`);
            }
            placements.push({ entry: { ...entry, size }, kind: "token", point });
        }
    }
    await requestOp("placeCreations", { messageId: message.id, placements });
}

async function chooseSize(entry) {
    return foundry.applications.api.DialogV2.wait({ window: { title: `${entry.name} — size` }, content: "<p>Choose its size.</p>",
        buttons: entry.sizes.map(size => ({ action: size, label: { sm: "Small", med: "Medium", lg: "Large", huge: "Huge" }[size] ?? size })), rejectClose: false, close: () => null });
}

/** The GM's side: tokens, walls, regions and food cards. Registered as a card operation. */
export async function placeCreationsOp({ messageId, placements }) {
    const message = game.messages.get(messageId);
    const state = stateOf(message);
    if (!state) return { status: "missing" };
    const actor = await fromUuid(state.sourceActorUuid);
    const scene = canvas.scene;
    const made = [];
    for (const placement of placements) {
        try {
            if (placement.kind === "token" && placement.point) {
                const base = await creationActor(placement.entry, state, actor);
                const tokenSource = (await base.getTokenDocument({ x: placement.point.x, y: placement.point.y, actorLink: false, name: `${placement.entry.name} (${actor.name})`,
                    disposition: actor.prototypeToken?.disposition ?? 1, flags: { [MODULE_ID]: { instance: state.id, creation: placement.entry.name, source: actor.uuid, ...(placement.mount ? { mountFor: placement.mount } : {}) } } })).toObject();
                const [token] = await scene.createEmbeddedDocuments("Token", [tokenSource]);
                // (The kineticist's owners control their creation.)
                if (token?.actor) await token.actor.update(Object.fromEntries(Object.entries(actor.ownership ?? {}).filter(([id, level]) => id !== "default" && level >= 3).map(([id]) => [`ownership.${id}`, 3]))).catch(() => null);
                made.push(token?.name);
            } else if (placement.kind === "wall") {
                const [a, b] = placement.points;
                const [wall] = await scene.createEmbeddedDocuments("Wall", [{ c: [a.x, a.y, b.x, b.y], move: CONST.WALL_MOVEMENT_TYPES?.NORMAL ?? 20, sight: placement.entry.name === "Scrap Barricade" ? CONST.WALL_SENSE_TYPES?.NORMAL ?? 20 : CONST.WALL_SENSE_TYPES?.NORMAL ?? 20, light: CONST.WALL_SENSE_TYPES?.NORMAL ?? 20, sound: CONST.WALL_SENSE_TYPES?.LIMITED ?? 10,
                    flags: { [MODULE_ID]: { instance: state.id, creation: placement.entry.name, sections: placement.entry.ac ? { ac: placement.entry.ac, hardness: placement.entry.hardness, hp: placement.entry.hp } : null, onDestroyed: placement.entry.onDestroyed ?? null } } }]);
                made.push(`${placement.entry.name} (wall)`);
                if (placement.entry.onDestroyed?.collapse) await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: ChatMessage.getWhisperRecipients("GM").map(user => user.id),
                    content: `<p><strong>${escapeHTML(placement.entry.name)}</strong>: each 10-foot section has AC ${placement.entry.ac}, Hardness ${placement.entry.hardness}, ${placement.entry.hp} HP. If any section is destroyed, the wall collapses: ${escapeHTML(componentsFormula(placement.entry.onDestroyed.damage))} (basic Reflex, class DC) to each adjacent creature — target them and use the impulse's card again, or roll it from here.</p>`,
                    flags: { [MODULE_ID]: { collapse: { wallUuid: wall?.uuid ?? null, damage: placement.entry.onDestroyed.damage, save: placement.entry.onDestroyed.save, sourceActorUuid: actor.uuid, dc: state.dc } } } });
            } else if (placement.kind === "region") {
                const size = canvas.grid.size, feet = canvas.grid.distance;
                const width = (placement.entry.length ?? 5) / feet * size, height = (placement.entry.width ?? 5) / feet * size;
                await scene.createEmbeddedDocuments("Region", [{ name: `${placement.entry.name} (${actor.name})`, color: "#55aa55", shapes: [{ type: "rectangle", x: placement.point.x, y: placement.point.y, width, height, rotation: 0, hole: false }],
                    behaviors: placement.entry.difficult ? [{ name: `${placement.entry.name}: difficult terrain`, type: "modifyMovementCost", system: { difficulties: { walk: 2, travel: 2 } } }] : [],
                    flags: { [MODULE_ID]: { instance: state.id, creation: placement.entry.name, cover: placement.entry.cover ?? null, climbDc: placement.entry.climbDc ?? null } } }]);
                made.push(placement.entry.name);
            } else if (placement.kind === "food") {
                await foodCard(placement.entry, state, actor);
                made.push(placement.entry.name);
            }
        } catch (error) { notifyError(`Placing ${placement.entry?.name}`, error); }
    }
    state.creationsPlaced = true;
    state.log = [...(state.log ?? []), `Placed: ${made.join(", ")}`];
    await message.update({ [`flags.${MODULE_ID}.card`]: state });
    return { status: "placed", made };
}

/** The world NPC actor a creation's tokens come from (made once per creation and level, updated to the text's statistics). */
async function creationActor(entry, state, sourceActor) {
    let folder = game.folders.find(f => f.type === "Actor" && f.name === FOLDER);
    folder ??= await Folder.create({ name: FOLDER, type: "Actor", color: "#4a6" });
    const name = `${entry.name} (L${state.level})`;
    const existing = game.actors.find(actor => actor.folder?.id === folder.id && actor.name === name);
    const sizeKey = SIZES[entry.size] ?? "med";
    // (A creation that "uses your statistics for defenses" — Crawling Fire — copies the kineticist's AC and saves.)
    const defenses = entry.usesSourceDefenses ? { ac: sourceActor.armorClass?.value ?? sourceActor.system.attributes.ac.value, saves: Object.fromEntries(["fortitude", "reflex", "will"].map(save => [save, sourceActor.saves?.[save]?.mod ?? 0])), hp: sourceActor.hitPoints?.max ?? 1 } : null;
    const system = {
        attributes: { ac: { value: defenses?.ac ?? entry.ac ?? 10 }, hp: { value: defenses?.hp ?? entry.hp ?? 1, max: defenses?.hp ?? entry.hp ?? 1, temp: 0 }, ...(entry.hardness ? { hardness: { value: entry.hardness } } : {}),
            immunities: (entry.immune ?? []).map(type => ({ type })) , speed: { value: entry.immobile ? 0 : 30, otherSpeeds: [] } },
        saves: Object.fromEntries(["fortitude", "reflex", "will"].map(save => [save, { value: defenses?.saves?.[save] ?? entry.saves?.[save] ?? 0 }])),
        details: { level: { value: Math.max(-1, state.level) }, publicNotes: `<p>Created by ${escapeHTML(state.itemName)}.</p>${entry.object ? "<p>An object.</p>" : ""}${entry.damageTo === "source" ? "<p>Any damage that would be dealt to it is dealt to the kineticist instead.</p>" : ""}` },
        traits: { size: { value: sizeKey }, value: [...new Set([...(entry.traits ?? []), ...(entry.object ? [] : ["elemental"]), ...(state.plan.kineticist.elements ?? [])])], rarity: "common" }
    };
    const items = (entry.strikes ?? []).map(strike => ({
        type: "melee", name: strike.name, img: "systems/pf2e/icons/default-icons/melee.svg",
        system: { bonus: { value: strike.attack ?? 0 }, damageRolls: { main: { damage: (strike.damage ?? []).map(c => c.formula).join("+") || "1d4", damageType: strike.damage?.[0]?.type ?? "bludgeoning" } },
            attackEffects: { value: strike.onHit?.condition?.slug === "grabbed" ? ["grab"] : [] }, traits: { value: [...(strike.melee && strike.reach ? [`reach-${strike.reach}`] : []), ...(!strike.melee && strike.rangeIncrement ? [`range-increment-${strike.rangeIncrement}`] : [])] },
            weaponType: { value: strike.melee ? "melee" : "ranged" } }
    }));
    if (existing) { await existing.update({ system }); return existing; }
    return Actor.create({ name, type: "npc", folder: folder.id, img: state.plan.source.image ?? "icons/svg/mystery-man.svg", system, items, prototypeToken: { name: entry.name, width: SQUARES[sizeKey] ?? 1, height: SQUARES[sizeKey] ?? 1 } });
}

/** A food card (Fresh Produce, the bladderwort's fruit): the creature eats it with an Interact action to regain HP and get its Effect. */
async function foodCard(entry, state, actor) {
    const recipient = state.targets.find(t => !t.excluded);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<p><strong>${escapeHTML(entry.name)}</strong>${recipient ? ` for ${escapeHTML(recipient.name)}` : ""}: eat it (Interact) to regain ${escapeHTML(componentsFormula(entry.food?.components ?? []))} HP.${entry.food?.spoils ? " It withers at the start of the kineticist's next turn." : ""}</p>`,
        flags: { [MODULE_ID]: { food: { name: entry.name, components: entry.food?.components ?? [], immunityRounds: entry.food?.immunityRounds ?? null, effectUuid: state.plan.resolution.effects.find(effect => effect.uuid && effect.linked)?.uuid ?? null,
            recipientActorUuid: recipient?.actorUuid ?? null, sourceActorUuid: actor.uuid, instance: state.id, eaten: false, itemName: state.itemName, slug: state.plan.source.slug } } }
    });
}

export function renderFoodCard(message, html) {
    const data = message.flags?.[MODULE_ID]?.food;
    if (!data) return;
    const root = html.querySelector?.(".message-content") ?? html;
    root.querySelector(".pf2e-kin-food")?.remove();
    const element = document.createElement("div");
    element.className = "pf2e-kin-food";
    element.innerHTML = data.eaten ? `<p><em>Eaten by ${escapeHTML(data.eaten)}.</em></p>` : `<button type="button" data-kin="eat">Eat (Interact)</button>`;
    root.appendChild(element);
    element.querySelector('[data-kin="eat"]')?.addEventListener("click", async () => {
        const eater = [...canvas.tokens.controlled][0]?.actor ?? (data.recipientActorUuid ? fromUuidSync(data.recipientActorUuid) : null) ?? game.user.character;
        if (!eater) return ui.notifications.warn("Select the creature that eats it.");
        game.socket.emit(`module.${MODULE_ID}`, { type: "eat", messageId: message.id, eaterUuid: eater.uuid });
        if (isActiveGM()) await eat(message.id, eater.uuid);
    });
}

export async function eat(messageId, eaterUuid) {
    if (!isActiveGM()) return;
    const message = game.messages.get(messageId);
    const data = message?.flags?.[MODULE_ID]?.food;
    const eater = await fromUuid(eaterUuid);
    if (!data || data.eaten || !eater) return;
    if (eater.itemTypes?.effect?.some(effect => effect.flags?.[MODULE_ID]?.immunity?.source === data.slug)) return ui.notifications.warn(`${eater.name} is full (temporarily immune).`);
    const roll = await new (DamageRollClass())(componentsFormula(data.components)).evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: eater }), flavor: `${escapeHTML(data.name)}: healing` });
    await applyHealing(eater, roll.total, {});
    const source = await fromUuid(data.sourceActorUuid);
    const context = { sourceActor: source, plan: { source: { name: data.itemName, slug: data.slug }, level: source?.level }, instanceId: null };
    if (data.effectUuid) await createEffect(eater, { uuid: data.effectUuid, name: data.name, duration: data.immunityRounds ? { kind: "time", rounds: data.immunityRounds } : null }, context).catch(() => null);
    if (data.immunityRounds) await createEffect(eater, { generated: "immunity", name: `Full (${data.name})`, duration: { kind: "time", rounds: data.immunityRounds }, flags: { immunity: { source: data.slug, scope: "target" } } }, context);
    await message.update({ [`flags.${MODULE_ID}.food.eaten`]: eater.name });
}

/** Fearsome Familiar: pick a common elemental (level limit from the text) from PF2e's bestiaries; it appears in the familiar's space while Sustained. */
export async function summonElemental(message, state) {
    const summon = state.plan.resolution.summon;
    const actor = await fromUuid(state.sourceActorUuid);
    const packs = game.packs.filter(pack => pack.documentName === "Actor" && pack.metadata.packageName === "pf2e" && /bestiary|monster-core/.test(pack.collection));
    const options = [];
    for (const pack of packs) {
        const index = await pack.getIndex({ fields: ["system.traits.value", "system.traits.rarity", "system.details.level.value", "type"] });
        for (const entry of index) {
            const traits = entry.system?.traits?.value ?? [];
            if (entry.type !== "npc" || !traits.includes("elemental") || (entry.system?.traits?.rarity ?? "common") !== "common") continue;
            if (Number(entry.system?.details?.level?.value ?? 99) > summon.maxLevel) continue;
            if (!options.some(option => option.name === entry.name)) options.push({ name: entry.name, uuid: `Compendium.${pack.collection}.Actor.${entry._id}`, level: entry.system.details.level.value });
        }
    }
    if (!options.length) throw new Error(`No common elemental of level ${summon.maxLevel} or lower was found.`);
    options.sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
    const uuid = await foundry.applications.api.DialogV2.prompt({ window: { title: `${state.itemName}: summon` },
        content: `<select name="uuid">${options.map(option => `<option value="${option.uuid}">${escapeHTML(option.name)} (level ${option.level})</option>`).join("")}</select>`,
        ok: { label: "Summon", callback: (_event, button) => button.form.elements.uuid.value }, rejectClose: false });
    if (!uuid) return;
    await requestOp("summon", { messageId: message.id, uuid });
}

export async function summonOp({ messageId, uuid }) {
    const message = game.messages.get(messageId);
    const state = stateOf(message);
    const actor = await fromUuid(state.sourceActorUuid);
    const source = await fromUuid(uuid);
    if (!source || !actor) return { status: "missing" };
    let folder = game.folders.find(f => f.type === "Actor" && f.name === FOLDER) ?? await Folder.create({ name: FOLDER, type: "Actor", color: "#4a6" });
    const base = game.actors.find(entry => entry.folder?.id === folder.id && entry.name === source.name) ?? await Actor.create({ ...source.toObject(), folder: folder.id });
    const familiar = game.actors.find(entry => entry.type === "familiar" && entry.system?.master?.id === actor.id);
    const familiarToken = familiar?.getActiveTokens?.(true, true)?.[0] ?? null;
    const at = familiarToken ?? tokenOf(actor);
    const tokenSource = (await base.getTokenDocument({ x: at?.x ?? 0, y: at?.y ?? 0, actorLink: false, flags: { [MODULE_ID]: { instance: state.id, creation: source.name, summoned: true, familiar: familiarToken?.uuid ?? null } } })).toObject();
    const [token] = await canvas.scene.createEmbeddedDocuments("Token", [tokenSource]);
    if (token?.actor) await token.actor.update({ "system.traits.value": [...new Set([...(token.actor.system.traits.value ?? []), "summoned"])], ...Object.fromEntries(Object.entries(actor.ownership ?? {}).filter(([id, level]) => id !== "default" && level >= 3).map(([id]) => [`ownership.${id}`, 3])) }).catch(() => null);
    if (familiarToken) await familiarToken.update({ hidden: true, [`flags.${MODULE_ID}.hiddenBy`]: state.id });
    state.summoned = source.name;
    await message.update({ [`flags.${MODULE_ID}.card`]: state });
    return { status: "summoned" };
}
