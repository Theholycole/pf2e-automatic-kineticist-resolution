// The impulse text layer: PF2e's description HTML as sentences, and its inline tags (@Damage, @Check, @Template, @UUID, [[/r]]) read at the
// kineticist's level. Pure: no Foundry, so it runs in Node tests and in a worker.

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ", "&ndash;": "–", "&mdash;": "—", "&rsquo;": "’", "&lsquo;": "‘" };

/** Description HTML → paragraphs of plain text (inline tags kept verbatim). */
export function paragraphs(html) {
    const text = String(html ?? "")
        .replace(/<hr\s*\/?>/gi, "\n")
        .replace(/<\/(p|li|h\d|tr|div)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&[a-z#0-9]+;/gi, entity => ENTITIES[entity.toLowerCase()] ?? entity);
    return text.split(/\n+/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** The end of a bracketed tag body that starts at `start` (just after its "["): nested brackets allowed. Returns the index of its "]". */
function closeBracket(text, start) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === "[") depth++;
        else if (text[i] === "]") { if (depth === 0) return i; depth--; }
    }
    return -1;
}

/** Every inline tag in a text: { kind: "damage"|"check"|"template"|"uuid"|"roll"|"act", body, label, start, end, raw }. */
export function inlineTags(text) {
    const tags = [];
    const pattern = /@(Damage|Check|Template|UUID)\[|\[\[\/(r|act|br) /g;
    let m;
    while ((m = pattern.exec(text))) {
        if (m[1]) {
            const open = m.index + m[0].length;
            const close = closeBracket(text, open);
            if (close < 0) break;
            let end = close + 1, label = null;
            if (text[end] === "{") {
                const labelEnd = text.indexOf("}", end);
                if (labelEnd > 0) { label = text.slice(end + 1, labelEnd); end = labelEnd + 1; }
            }
            tags.push({ kind: m[1].toLowerCase() === "uuid" ? "uuid" : m[1].toLowerCase(), body: text.slice(open, close), label, start: m.index, end, raw: text.slice(m.index, end) });
            pattern.lastIndex = end;
        } else {
            const close = text.indexOf("]]", m.index);
            if (close < 0) break;
            let end = close + 2, label = null;
            if (text[end] === "{") {
                const labelEnd = text.indexOf("}", end);
                if (labelEnd > 0) { label = text.slice(end + 1, labelEnd); end = labelEnd + 1; }
            }
            tags.push({ kind: m[2] === "r" || m[2] === "br" ? "roll" : "act", body: text.slice(m.index + m[0].length, close).trim(), label, start: m.index, end, raw: text.slice(m.index, end) });
            pattern.lastIndex = end;
        }
    }
    return tags;
}

const FUNCTIONS = {
    floor: Math.floor, ceil: Math.ceil, round: Math.round, max: Math.max, min: Math.min, abs: Math.abs,
    ternary: (condition, a, b) => (condition ? a : b), gte: (a, b) => a >= b, gt: (a, b) => a > b, lte: (a, b) => a <= b, lt: (a, b) => a < b, eq: (a, b) => a === b
};

/**
 * A PF2e roll-data expression at a level ("floor((@actor.level -1)/2)+1", "ternary(gte(@actor.level,20),10,9)"): a number, or null.
 * Only numbers, the listed functions, arithmetic and parentheses are accepted.
 */
export function evaluate(expression, level, data = {}) {
    let code = String(expression)
        .replace(/@actor\.level|@item\.level|@item\.rank|@actor\.system\.details\.level\.value/g, String(level));
    for (const [path, value] of Object.entries(data)) code = code.split(path).join(String(value));
    if (/@/.test(code)) return null;
    const identifiers = code.match(/[A-Za-z_]+/g) ?? [];
    if (identifiers.some(name => !(name in FUNCTIONS))) return null;
    if (!/^[\d\s+\-*/().,A-Za-z_]*$/.test(code)) return null;
    try {
        const value = Function(...Object.keys(FUNCTIONS), `"use strict"; return (${code});`)(...Object.values(FUNCTIONS));
        return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "boolean" ? Number(value) : null;
    } catch {
        return null;
    }
}

/**
 * A damage formula at a level: "(floor((@actor.level -1)/2)+1)d6" → "1d6"; "((…)d4+(…))" → "2d4+6"; "(2*floor((@actor.level -1)/3)+1)" → "3".
 * Dice counts and flat terms are evaluated; the result is a plain "NdX+M" formula, or null when it can't be read.
 */
export function formulaAt(formula, level, data = {}) {
    let out = String(formula).trim();
    // (Each "(expression)dN": its count. The innermost group before "dN" is the whole balanced parenthesis.)
    for (let guard = 0; guard < 12; guard++) {
        const at = out.search(/\)\s*d\d+/);
        if (at < 0) break;
        let depth = 0, open = -1;
        for (let i = at; i >= 0; i--) {
            if (out[i] === ")") depth++;
            else if (out[i] === "(") { depth--; if (depth === 0) { open = i; break; } }
        }
        if (open < 0) return null;
        // ("ceil(@actor.level/2)d8": the function the parenthesis belongs to is part of the count.)
        const call = /[A-Za-z_]+$/.exec(out.slice(0, open));
        if (call) {
            const count = evaluate(out.slice(call.index, at + 1), level, data);
            if (count == null) return null;
            out = `${out.slice(0, call.index)}${Math.max(0, Math.floor(count))}${out.slice(at + 1).replace(/^\s+/, "")}`;
            continue;
        }
        const count = evaluate(out.slice(open + 1, at), level, data);
        if (count == null) return null;
        out = `${out.slice(0, open)}${Math.max(0, Math.floor(count))}${out.slice(at + 1).replace(/^\s+/, "")}`;
    }
    // ("floor(@actor.level/4)d8": a function call before "dN".)
    out = out.replace(/([a-z]+\([^()]*(?:\([^()]*\)[^()]*)*\))\s*d(\d+)/gi, (whole, call, faces) => {
        const count = evaluate(call, level, data);
        return count == null ? whole : `${Math.max(0, Math.floor(count))}d${faces}`;
    });
    // (What's left: dice terms and arithmetic. Pure arithmetic becomes one number; "NdX + (expr)" keeps the dice and evaluates the rest.)
    const stripped = out.replace(/^\((.*)\)$/, "$1");
    if (!/\d+d\d+/.test(stripped)) {
        const value = evaluate(stripped, level, data);
        return value == null ? null : String(Math.floor(value));
    }
    const terms = splitTopLevel(stripped, "+");
    const parts = [];
    for (const term of terms) {
        const t = term.trim().replace(/^\((.*)\)$/, "$1");
        if (/^\d+d\d+$/.test(t)) parts.push(t);
        else {
            const value = evaluate(t, level, data);
            if (value == null) return null;
            parts.push(String(Math.floor(value)));
        }
    }
    // (0d6 terms vanish; "0" flat terms too.)
    const kept = parts.filter(part => !/^0d\d+$/.test(part) && part !== "0");
    return kept.length ? kept.join("+") : "0";
}

/** Split a string on a separator at bracket depth 0 (parentheses and square brackets). */
export function splitTopLevel(text, separator) {
    const parts = [];
    let depth = 0, current = "";
    for (const ch of text) {
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        if (ch === separator && depth === 0) { parts.push(current); current = ""; }
        else current += ch;
    }
    parts.push(current);
    return parts;
}

const DAMAGE_CATEGORIES = new Set(["persistent", "splash", "precision"]);

/**
 * An @Damage body at a level → { components: [{ formula, type, category, healing }], options: [] }, or null.
 * "(…)d4[piercing],(…)d4[persistent,bleed]|options:area-damage" → two components.
 */
export function readDamage(body, level, data = {}) {
    const [main, ...params] = splitTopLevel(body, "|");
    const options = params.flatMap(param => (/^options:(.*)$/.exec(param.trim())?.[1] ?? "").split(",").map(option => option.trim()).filter(Boolean));
    const components = [];
    for (let piece of splitTopLevel(main, ",")) {
        piece = piece.trim().replace(/^\{(.*)\}$/, "$1");
        const m = /^(.*)\[([a-z,@.\s]+)\]\s*$/i.exec(piece);
        if (!m) return null;
        const tags = m[2].split(",").map(tag => tag.trim());
        const formula = formulaAt(m[1], level, data);
        if (formula == null) return null;
        const healing = tags.includes("healing");
        const category = tags.find(tag => DAMAGE_CATEGORIES.has(tag)) ?? null;
        const type = tags.filter(tag => !DAMAGE_CATEGORIES.has(tag) && tag !== "healing").at(-1) ?? (healing ? null : "untyped");
        components.push({ formula, type: type && type.startsWith("@") ? null : type, typeFrom: type && type.startsWith("@") ? type : null, category, healing });
    }
    return components.length ? { components, options } : null;
}

/** An @Check body → { statistic, basic, against, dc, adjustment, options, traits }. */
export function readCheck(body) {
    const [statistic, ...params] = splitTopLevel(body, "|").map(part => part.trim());
    const out = { statistic: statistic.toLowerCase(), basic: false, against: null, dc: null, adjustment: 0, defense: null, options: [], traits: [], rollerRole: null };
    for (const param of params) {
        const [key, value = ""] = param.split(/:(.*)/s);
        if (key === "basic") out.basic = true;
        else if (key === "against") out.against = value;
        else if (key === "dc") out.dc = Number(value);
        else if (key === "adjustment") out.adjustment = Number(value);
        else if (key === "defense") out.defense = value;
        else if (key === "options") out.options = value.split(",");
        else if (key === "traits") out.traits = value.split(",");
        else if (key === "rollerRole") out.rollerRole = value;
    }
    return out;
}

/** A @Template body → { type, distance, width }. ("cone|distance:15", "type:cone|distance:15", "line|distance:30|width:10".) */
export function readTemplate(body) {
    const parts = splitTopLevel(body, "|").map(part => part.trim());
    const out = { type: null, distance: null, width: null };
    for (const part of parts) {
        const [key, value] = part.includes(":") ? part.split(/:(.*)/s) : ["type", part];
        if (key === "type") out.type = value;
        else if (key === "distance") out.distance = Number(value);
        else if (key === "width") out.width = Number(value);
    }
    return out;
}

/** A @UUID body → { uuid, pack, id, kind } ("Compendium.pf2e.conditionitems.Item.xYTAsEpcJE1Ccni3"). */
export function readUuid(body) {
    const m = /^Compendium\.pf2e\.([a-z0-9-]+)\.(?:Item|JournalEntry)\.([A-Za-z0-9]+)/.exec(body);
    return { uuid: body, pack: m?.[1] ?? null, id: m?.[2] ?? null };
}

/** Replace each inline tag in a text by readable words at a level (for card text and pattern matching). */
export function readable(text, level, data = {}) {
    let out = "", at = 0;
    for (const tag of inlineTags(text)) {
        out += text.slice(at, tag.start);
        out += tagWords(tag, level, data);
        at = tag.end;
    }
    return out + text.slice(at);
}

function tagWords(tag, level, data) {
    if (tag.kind === "damage") {
        const damage = readDamage(tag.body, level, data);
        if (!damage) return tag.label ?? tag.raw;
        if (tag.label && !/^\d|d\d/.test(tag.label)) return tag.label;
        return damage.components.map(c => c.healing ? `${c.formula}` : `${c.formula}${c.category ? ` ${c.category}` : ""}${c.type && c.type !== "untyped" ? ` ${c.type}` : ""}`).join(" plus ");
    }
    if (tag.kind === "check") {
        const check = readCheck(tag.body);
        if (tag.label) return tag.label;
        if (["fortitude", "reflex", "will"].includes(check.statistic)) return `${check.basic ? "basic " : ""}${capitalize(check.statistic)}`;
        if (check.statistic === "flat") return `DC ${check.dc} flat check`;
        return `${capitalize(check.statistic)}${check.dc ? ` (DC ${check.dc})` : ""}`;
    }
    if (tag.kind === "template") {
        const template = readTemplate(tag.body);
        return tag.label ?? `${template.distance}-foot ${template.type}`;
    }
    if (tag.kind === "uuid") return tag.label ?? tag.body.split(".").at(-1);
    if (tag.kind === "roll") return tag.label ?? tag.body;
    return tag.label ?? tag.body;
}

export const capitalize = word => word ? `${word[0].toUpperCase()}${word.slice(1)}` : word;

/** Sentences of a paragraph (inline tags never split). */
export function sentences(paragraph) {
    const masked = [];
    const text = paragraph.replace(/@(?:Damage|Check|Template|UUID)\[[^\]]*(?:\[[^\]]*\][^\]]*)*\](?:\{[^}]*\})?|\[\[[^\]]*\]\](?:\{[^}]*\})?/g, match => { masked.push(match); return `\u0000${masked.length - 1}\u0000`; });
    return text.split(/(?<=[.!?])\s+(?=[A-Z@\u0000⟦(])/).map(sentence => sentence.replace(/\u0000(\d+)\u0000/g, (_, i) => masked[Number(i)]).trim()).filter(Boolean);
}
