// PF2e Automatic Kineticist Resolution: hooks and API. No PF2e prototype is wrapped: the module works through hooks, PF2e's public methods and
// its own chat cards. Conventions shared with the other PF2e modules: only the active GM acts on hooks; handlers of chat cards skip messages
// carrying flags.pf2e.context.type; hooks on every Combat update return at once when nothing of the module's is on the scene.
import { MODULE_ID, SOCKET, escapeHTML, isActiveGM, notifyError, actorFromMessage, tokenOf } from "./utils.js";
import { openCard, renderCard, onSocket, isImpulse, planFor, registerOp } from "./card.js";
import { renderTrackerCard, trackerEnded, trackersOf } from "./tracker.js";
import * as aura from "./aura.js";
import * as triggers from "./triggers.js";
import { placeCreationsOp, summonOp, renderFoodCard, eat } from "./creations.js";
import { onAttackMessage, onInfusionMessage, renderCritJunctionCard, applySplit } from "./blast.js";
import { readImpulse } from "../src/reader/impulse-reader.js";
import { addItemButtons } from "./items.js";
import { resolveSave, resolveAttack, resolveHealing } from "../src/core/resolve.js";

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "resolveButton", {
        name: "Add “Resolve impulse” to impulse cards",
        hint: "Adds the module's resolution button to the chat card of every impulse (official PF2e and the Alchemists+ Chrysopoet's). Resolution stays confirmation-first: the GM applies.",
        scope: "world", config: true, type: Boolean, default: true
    });
    game.settings.register(MODULE_ID, "auraTriggers", {
        name: "Stance aura triggers",
        hint: "Whisper the GM a card when a creature enters, starts or ends its turn in a kineticist's aura with a stance that does something then (Thermal Nimbus, Drifting Pollen…).",
        scope: "world", config: true, type: Boolean, default: true
    });
    registerOp("placeCreations", placeCreationsOp);
    registerOp("summon", summonOp);
});

Hooks.once("ready", () => {
    game.socket.on(SOCKET, data => {
        if (data?.type === "card-op") void onSocket(data);
        else if (data?.type === "eat") void eat(data.messageId, data.eaterUuid).catch(error => notifyError("Eating", error));
    });
    const module = game.modules.get(MODULE_ID);
    if (module) module.api = {
        /** The plan of an impulse at a kineticist's level (pure reader). */
        readImpulse: (source, options) => readImpulse(source, options),
        planFor: (item, actor) => planFor(item, actor ?? item.actor),
        /** Open a resolution card for an impulse item (scripted runs and macros). */
        resolve: (item, options = {}) => openCard({ item, actor: options.actor ?? item.actor, token: options.token ?? null, targets: options.targets ?? null, repeat: options.repeat ?? null }),
        /** The pure resolver, for the simulator and tests. */
        core: { resolveSave, resolveAttack, resolveHealing },
        trackers: actor => trackersOf(actor),
        applySplit
    };
});

// ---------------------------------------------------------------- chat cards

Hooks.on("renderChatMessageHTML", (message, html) => {
    try {
        const flags = message.flags?.[MODULE_ID];
        if (flags?.card) return renderCard(message, html);
        if (flags?.tracker) return renderTrackerCard(message, html);
        if (flags?.trigger) return aura.renderTriggerCard(message, html);
        if (flags?.later) return triggers.renderLaterCard(message, html);
        if (flags?.followUpCard) return triggers.renderFollowUpCard(message, html);
        if (flags?.endImpulse) return triggers.renderEndImpulseCard(message, html);
        if (flags?.critJunction) return renderCritJunctionCard(message, html);
        if (flags?.food) return renderFoodCard(message, html);
        addResolveButton(message, html);
    } catch (error) { console.error(`${MODULE_ID} | rendering a chat card`, error); }
});

/** The impulse's own PF2e chat card: a "Resolve impulse" button for its owner and the GM (and Safe Elements' designation on aura cards). */
function addResolveButton(message, html) {
    if (message.flags?.pf2e?.context?.type) return;
    if (!game.settings.get(MODULE_ID, "resolveButton")) return;
    let item = null;
    try { item = message.item ?? null; } catch (_) { item = null; }
    addSafeElementsButton(message, html, item);
    addItemButtons(message, html, item);
    if (!item || !isImpulse(item)) return;
    const actor = item.actor ?? actorFromMessage(message);
    if (!actor || !(game.user.isGM || actor.isOwner)) return;
    const root = html.querySelector?.(".message-content") ?? html;
    if (root.querySelector(".pf2e-kin-resolve")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pf2e-kin-resolve";
    button.innerHTML = `<i class="fa-solid fa-wind"></i> Resolve impulse`;
    (root.querySelector(".card-buttons") ?? root).appendChild(button);
    button.addEventListener("click", async () => {
        button.disabled = true;
        try { await openCard({ item, actor, token: tokenOf(actor, message.speaker?.token), message }); }
        catch (error) { notifyError(`${item.name}`, error); }
        finally { button.disabled = false; }
    });
}

Hooks.on("createChatMessage", message => {
    if (!isActiveGM()) return;
    const type = message.flags?.pf2e?.context?.type;
    if (type === "attack-roll") void onAttackMessage(message).catch(error => notifyError("Elemental Blast", error));
    else if (type === "damage-roll") void triggers.onDamageMessage(message).catch(error => notifyError("Retaliation", error));
    else if (!type && message.flags?.pf2e?.origin?.type === "feat") void onInfusionMessage(message).catch(error => notifyError("Infusion", error));
});

// ---------------------------------------------------------------- the aura, trackers, conditions

Hooks.on("createItem", item => {
    if (item.type !== "effect" && item.type !== "condition") return;
    void aura.onCreateItem(item).catch(error => notifyError("The kinetic aura", error));
});
Hooks.on("deleteItem", item => {
    if (item.type === "effect") {
        void aura.onDeleteItem(item).catch(error => notifyError("The kinetic aura", error));
        void trackerEnded(item).catch(error => notifyError("An impulse's end", error));
    } else if (item.type === "condition") void triggers.onConditionDeleted(item).catch(error => notifyError("A linked condition", error));
});

// ---------------------------------------------------------------- turns and movement (cheap unless something of the module's is on the scene)

Hooks.on("updateCombat", (combat, changes) => {
    if (!isActiveGM() || !("turn" in changes || "round" in changes)) return;
    if (game.settings.get(MODULE_ID, "auraTriggers")) void aura.onTurnChange(combat, changes).catch(error => notifyError("Aura triggers", error));
    void triggers.onTurnChange(combat, changes).catch(error => notifyError("Lingering impulses", error));
});
Hooks.on("preUpdateToken", (token, changes, options) => triggers.onPreUpdateToken(token, changes, options));
Hooks.on("updateToken", (token, changes, options) => {
    if (!isActiveGM() || !("x" in changes || "y" in changes)) return;
    void triggers.onTokenMoved(token, changes, options).catch(error => notifyError("A lingering area", error));
    if (game.settings.get(MODULE_ID, "auraTriggers")) void aura.onTokenMove(token, changes).catch(error => notifyError("Aura triggers", error));
});

/** Safe Elements: on Channel Elements' card and a stance impulse's, designate the targeted creatures. */
function addSafeElementsButton(message, html, item) {
    const actor = item?.actor;
    if (!actor || !(game.user.isGM || actor.isOwner)) return;
    const auraCard = item.system?.slug === "channel-elements" || (item.system?.traits?.value ?? []).includes("stance");
    if (!auraCard || !actor.itemTypes?.feat?.some(feat => feat.slug === "safe-elements")) return;
    const root = html.querySelector?.(".message-content") ?? html;
    if (root.querySelector(".pf2e-kin-safe")) return;
    const wrap = document.createElement("div");
    wrap.className = "pf2e-kin-safe";
    wrap.innerHTML = `<button type="button" data-group="damage">Safe Elements: targeted creatures immune to the aura's damage</button><button type="button" data-group="benefits">…immune to its benefits</button>`;
    root.appendChild(wrap);
    wrap.querySelectorAll("button").forEach(node => node.addEventListener("click", async () => {
        try {
            const uuids = await aura.designateSafeElements(actor, [...game.user.targets], node.dataset.group);
            ui.notifications.info(`Safe Elements (${node.dataset.group}): ${uuids.length} creature(s) designated.`);
        } catch (error) { notifyError("Safe Elements", error); }
    }));
}
