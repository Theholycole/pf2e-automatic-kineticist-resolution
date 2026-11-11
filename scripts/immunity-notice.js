// (2026-11-11, Cole: "any time an effect wouldn't be applied due to an immunity on a creature, make sure there is a message to the GM".)
// The core's GM-only immunity notice (pf2e-resolution-core scripts/immunity-notice.js): { actor?, token?, target?, blocked, why?, source?, once? }.
// This module doesn't need the core: without it, the active GM's client whispers the GMs itself (a player's client says nothing then).
// Never throws, never needs awaiting.

import { escapeHTML } from "./utils.js";

export function noticeImmunity(fields) {
    try {
        const notify = game.modules?.get?.("pf2e-resolution-core")?.active ? game.modules.get("pf2e-resolution-core").api?.immunity?.notify : null;
        if (notify) return Promise.resolve(notify(fields)).catch(() => null);
        if (!game.user?.isGM) return Promise.resolve(null);
        const { actor = null, token = null, target = null, blocked, why = null, source = null } = fields ?? {};
        const name = target ?? token?.name ?? actor?.name ?? "A creature";
        const content = `<p><strong>Immunity</strong>: ${escapeHTML(name)} isn't affected by ${escapeHTML(blocked ?? "an effect")}${source ? ` from ${escapeHTML(source)}` : ""}${why ? ` (${escapeHTML(why)})` : ""}.</p>`;
        return ChatMessage.create({ content, whisper: ChatMessage.getWhisperRecipients("GM").map((user) => user.id), speaker: ChatMessage.getSpeaker({ actor: actor ?? undefined }) }).catch(() => null);
    } catch {
        return Promise.resolve(null);
    }
}
