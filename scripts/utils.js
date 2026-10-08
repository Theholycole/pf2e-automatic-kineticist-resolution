// Foundry helpers shared by the runtime. Conventions agreed with the other PF2e modules: only the active GM acts on hooks; chat-card handlers skip
// messages carrying flags.pf2e.context.type; hooks on every Combat update return at once when nothing of ours is recorded.

export const MODULE_ID = "pf2e-automatic-kineticist-resolution";
export const SOCKET = `module.${MODULE_ID}`;

export const isActiveGM = () => Boolean(game.users?.activeGM?.isSelf);
export const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
export const clone = value => (value == null ? value : foundry.utils.deepClone(value));
export const randomID = () => foundry.utils.randomID();

export function notifyError(context, error) {
    console.error(`${MODULE_ID} | ${context}`, error);
    ui.notifications?.error(`${context}: ${error?.message ?? error}`);
}

/** The actor that posted a chat message (a token's actor first). */
export function actorFromMessage(message) {
    try { if (message.actor) return message.actor; } catch (_) {}
    const speaker = message.speaker ?? {};
    if (speaker.scene && speaker.token) {
        const actor = game.scenes.get(speaker.scene)?.tokens.get(speaker.token)?.actor;
        if (actor) return actor;
    }
    return speaker.actor ? game.actors.get(speaker.actor) ?? null : null;
}

/** The token document of an actor on the viewed scene (the speaker's, when it's that actor's). */
export function tokenOf(actor, speakerTokenId = null) {
    if (!actor) return null;
    const tokens = actor.getActiveTokens?.(true, true) ?? [];
    return tokens.find(token => token.id === speakerTokenId) ?? tokens[0] ?? null;
}

/** "rounds"-style durations for a PF2e Effect (system.duration) from a plan duration and its clock. */
export function systemDuration(duration) {
    if (!duration) return { value: -1, unit: "unlimited", expiry: null, sustained: false };
    if (duration.kind === "time") return { value: duration.rounds >= 14400 && duration.rounds % 14400 === 0 ? duration.rounds / 14400 : duration.rounds >= 600 && duration.rounds % 600 === 0 ? duration.rounds / 600 : duration.rounds >= 10 && duration.rounds % 10 === 0 ? duration.rounds / 10 : duration.rounds,
        unit: duration.rounds >= 14400 && duration.rounds % 14400 === 0 ? "days" : duration.rounds >= 600 && duration.rounds % 600 === 0 ? "hours" : duration.rounds >= 10 && duration.rounds % 10 === 0 ? "minutes" : "rounds", expiry: "turn-start", sustained: false };
    if (duration.kind === "source-turn" || duration.kind === "target-turn") return { value: duration.current ? 0 : 1, unit: "rounds", expiry: duration.edge === "start" ? "turn-start" : "turn-end", sustained: false };
    return { value: -1, unit: "unlimited", expiry: null, sustained: false };
}

/** The kineticist's class DC (the impulse statistic's, which PF2e builds on the kineticist class DC). */
export function classDC(actor) {
    const candidates = [actor?.getStatistic?.("impulse")?.dc?.value, actor?.getStatistic?.("kineticist")?.dc?.value, actor?.classDC?.dc?.value, actor?.system?.attributes?.classDC?.value, actor?.system?.attributes?.classOrSpellDC?.value];
    return candidates.map(Number).find(value => Number.isFinite(value) && value > 0) ?? null;
}

/** A save or check's degree as the plan's key. */
export function degreeKey(value) {
    if (typeof value === "string" && ["criticalSuccess", "success", "failure", "criticalFailure"].includes(value)) return value;
    return ["criticalFailure", "failure", "success", "criticalSuccess"][Number(value)] ?? null;
}

/** PF2e's DamageRoll class. */
export function DamageRollClass() {
    return CONFIG.Dice?.rolls?.find(candidate => candidate?.name === "DamageRoll") ?? Roll;
}

/** A plan's damage components → one PF2e damage formula: "{2d6[fire],1d4[persistent,bleed]}". */
export function componentsFormula(components, { multiplier = 1, dieStep = null } = {}) {
    const parts = (components ?? []).map(component => {
        let formula = String(component.formula);
        if (dieStep && component.type === dieStep.type) formula = formula.replace(/d(\d+)/g, (_, faces) => `d${dieStep.next(Number(faces))}`);
        const tags = [component.category, component.type === "untyped" ? null : component.type].filter(Boolean);
        return `${/[+\-*]/.test(formula) && tags.length ? `(${formula})` : formula}${tags.length ? `[${tags.join(",")}]` : ""}`;
    });
    if (!parts.length) return null;
    const body = parts.length === 1 && multiplier === 1 ? parts[0] : `{${parts.join(",")}}`;
    return multiplier === 1 ? body : `(${body}) * ${multiplier}`;
}

/** Ask a yes/no or pick question (DialogV2). */
export async function ask(title, question, options) {
    return foundry.applications.api.DialogV2.wait({
        window: { title }, content: `<p>${escapeHTML(question)}</p>`,
        buttons: options.map((option, index) => ({ action: String(index), label: option.label, default: index === 0 })), rejectClose: false, close: () => null
    }).then(choice => (choice == null ? null : options[Number(choice)]?.value ?? null));
}

/** Every token document on the viewed scene whose centre lies within a Region. */
export function tokensInRegion(region) {
    const scene = region?.parent ?? canvas.scene;
    return (scene?.tokens ?? []).filter(token => {
        try { return region.testPoint?.({ x: token.x + (token.width * scene.grid.size) / 2, y: token.y + (token.height * scene.grid.size) / 2, elevation: token.elevation ?? 0 }) ?? token.regions?.has?.(region); }
        catch (_) { return token.regions?.has?.(region) ?? false; }
    });
}

/** The distance in feet between two tokens (Foundry's grid measure). */
export function distanceBetween(a, b) {
    try {
        const ta = a?.object ?? a, tb = b?.object ?? b;
        if (ta?.distanceTo && tb) return ta.distanceTo(tb);
        return canvas.grid.measurePath([ta.center, tb.center]).distance;
    } catch (_) { return null; }
}

/** Is a token within an actor's kinetic aura (the Aura rule's radius, from the aura's centre)? */
export function inKineticAura(kineticistToken, token) {
    const actor = kineticistToken?.actor;
    const radius = Number(actor?.flags?.system?.kineticist?.auraRadius ?? actor?.auras?.get?.("kinetic-aura")?.radius ?? 10);
    const distance = distanceBetween(kineticistToken, token);
    return distance != null && distance <= radius;
}
