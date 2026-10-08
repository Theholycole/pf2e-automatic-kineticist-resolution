// Export the Kineticist content the tests read: PF2e's impulses, Kineticist feats, class features, actions and their Effects, plus the
// "+" modules' Kineticist content (Alchemists+ Chrysopoet, Barbarians+ Elemental Instinct). Read-only (tools/leveldb.mjs never writes).
// Run: node tools/export-fixtures.mjs  →  .cache/kineticist-items.json
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readDocuments } from "./leveldb.mjs";

const DATA = path.join(process.env.HOME, ".local/share/FoundryVTT/Data");
const PACKS = path.join(DATA, "systems/pf2e/packs");
const items = pack => readDocuments(path.join(PACKS, pack)).filter(doc => doc.collection === "items");
const traits = doc => doc.system?.traits?.value ?? [];
const mentions = doc => /kineticist|kinetic aura|kinetic gate|impulse|elemental blast/i.test(`${doc.name} ${doc.system?.description?.value ?? ""}`);

const out = { pf2e: JSON.parse(readFileSync(path.join(DATA, "systems/pf2e/system.json"), "utf8")).version, impulses: [], feats: [], classFeatures: [], actions: [], effects: [], spells: [], plus: [] };
const feats = items("feats");
out.impulses = [...feats, ...items("class-features"), ...items("actions")].filter(doc => traits(doc).includes("impulse"));
out.feats = feats.filter(doc => !traits(doc).includes("impulse") && (traits(doc).includes("kineticist")
    || (doc.system?.prerequisites?.value ?? []).some(p => /kineticist dedication/i.test(p.value)) || /^Kineticist Dedication$/.test(doc.name)));
out.classFeatures = items("class-features").filter(doc => !traits(doc).includes("impulse") && (traits(doc).includes("kineticist") || (doc.system?.traits?.otherTags ?? []).includes("kineticist-kinetic-gate")));
out.actions = items("actions").filter(doc => !traits(doc).includes("impulse") && (traits(doc).includes("kineticist") || /^Pacifying Infusion$/.test(doc.name)));
out.effects = items("feat-effects").filter(doc => /kinetic|impulse|junction|kineticist/i.test(JSON.stringify(doc)));
// (The spells impulses refer to: "has the effects of the @UUID[…spells-srd…]{Wall of Fire} spell".)
const spellIds = new Set([...out.impulses, ...out.feats].flatMap(doc => [...(doc.system?.description?.value ?? "").matchAll(/Compendium\.pf2e\.spells-srd\.Item\.([A-Za-z0-9]{16})/g)].map(m => m[1])));
out.spells = items("spells").filter(doc => spellIds.has(doc._id));

const MODULES = path.join(DATA, "modules");
for (const module of ["pf2e-team-plus-alchemists", "pf2e-team-plus-barbarians"]) {
    const packs = path.join(MODULES, module, "packs");
    if (!existsSync(packs)) continue;
    for (const pack of readdirSync(packs)) {
        if (/^sf2e/.test(pack)) continue;
        let docs;
        try { docs = readDocuments(path.join(packs, pack)); } catch { continue; }
        for (const doc of docs) if (doc.system && (traits(doc).includes("impulse") || mentions(doc))) out.plus.push({ ...doc, module, pack });
    }
}
mkdirSync(".cache", { recursive: true });
writeFileSync(".cache/kineticist-items.json", JSON.stringify(out));
console.log(Object.fromEntries(Object.entries(out).map(([key, value]) => [key, Array.isArray(value) ? value.length : value])));
