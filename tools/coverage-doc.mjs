// Regenerate docs/coverage.md: every impulse (official and "+"), its family and automation at its own level, and every other Kineticist feature
// with who handles it. Run: node tools/coverage-doc.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { readImpulse } from "../src/reader/impulse-reader.js";
import { impulseLifecycle } from "../src/core/resolve.js";

const items = JSON.parse(readFileSync(".cache/kineticist-items.json", "utf8"));
const FAMILY = { save: "save", attack: "impulse attack", blast: "blast", heal: "healing", effect: "Effect", stance: "stance", area: "lingering area", creation: "creation", summon: "summon", spell: "spell (via the spell module)",
    armor: "armor", modes: "options", counteract: "counteract", movement: "movement", reaction: "reaction (PF2e's rules)", note: "notes", "use-stance": "stance prompt" };

const rows = [];
for (const item of [...items.impulses, ...items.plus.filter(entry => (entry.system?.traits?.value ?? []).includes("impulse"))].sort((a, b) => (a.system?.level?.value ?? 0) - (b.system?.level?.value ?? 0) || a.name.localeCompare(b.name))) {
    const plan = readImpulse(item, { level: Number(item.system?.level?.value ?? 1) || 1 });
    const r = plan.resolution;
    const life = impulseLifecycle(plan);
    const parts = [];
    if (r.check) parts.push(`${r.check.basic ? "basic " : ""}${r.check.statistic}`);
    if (r.attack) parts.push(`attack ×${r.attack.maxTargets}`);
    if (r.sharedDamage) parts.push(r.sharedDamage.components.map(c => `${c.formula} ${c.category ? `${c.category} ` : ""}${c.type}`).join(" + "));
    if (r.healing) parts.push(`heals ${r.healing.components.map(c => c.formula).join("+")}`);
    if (r.terrain) parts.push("terrain");
    if (r.creations?.length) parts.push(`creates ${r.creations.map(c => c.name).join(", ")}`);
    if (r.armor) parts.push(`armor AC +${r.armor.acBonus}`);
    if (r.spell) parts.push(`= ${r.spell.name}`);
    if (r.aura?.triggers?.length) parts.push(`aura triggers ×${r.aura.triggers.length}`);
    if (life.sustainable) parts.push("Sustain");
    if (plan.kineticist.overflow) parts.push("overflow");
    const effects = r.effects.filter(effect => effect.uuid).map(effect => effect.name);
    rows.push(`| ${item.name}${item.module ? ` (${item.module.replace("pf2e-team-plus-", "")}+)` : ""} | ${plan.itemLevel} | ${plan.activation.time ?? "—"} | ${FAMILY[r.kind] ?? r.kind} | ${plan.automation.level} | ${parts.join("; ")}${effects.length ? `; PF2e: ${effects.join(", ")}` : ""} |`);
}

const FEATURES = [
    ["Elemental Blast", "PF2e", "Attack and damage rolls, elements, 1/2 actions, die every 4 levels. The module adds critical blast junctions (air, earth, wood, metal rust) and infusions."],
    ["Channel Elements / Kinetic Aura", "PF2e + module", "PF2e's self-effect is the aura; the module ends it on overflow and when knocked out, and ends stances with it."],
    ["Overflow (trait)", "module", "Deactivates the aura when the impulse's card is applied."],
    ["Stances", "PF2e + module", "PF2e's Stance Effects; the module ends other stances, ends stances with the aura, and runs their aura triggers."],
    ["Gate junctions: impulse", "module", "Offered on the card for 2+-action impulses of the element, once per round (earth, wood: PF2e's Effects; metal: retaliation; water: a push; air: a reminder). Fire's die step is PF2e's."],
    ["Gate junctions: critical blast", "PF2e + module", "Fire, metal, water damage: PF2e. Air push, earth prone or descent, wood roots, metal rust: the module's GM card on a critical hit."],
    ["Gate junctions: aura, resistance, skill", "PF2e", "Aura rules, Resistance/Immunity, skill rank and feat."],
    ["Kinetic Gate, Gate's Threshold (all four), Fork the Path, Expand the Portal", "PF2e", "Choice sets and granted impulses."],
    ["Extract Element", "module", "A save card; on a success or worse, the target's Effect (−1 vs your impulses), ended with the aura; IWR bypass on the impulse's damage."],
    ["Base Kinesis", "module", "Options card (Generate, Move, Suppress); Extended Kinesis' options are PF2e's text."],
    ["Final Gate, Effortless Impulse, Imperious Aura", "module", "Start-of-turn reminders whispered to the owner."],
    ["Safe Elements", "module", "Designate targeted creatures on Channel Elements' or a stance's card; the aura's damage triggers skip them."],
    ["Pacifying Infusion, Chain Infusion, Two-Element Infusion", "module", "Arms the next blast: nonlethal note, chain reminder after a hit, half-and-half damage split."],
    ["Weapon Infusion, Versatile Blasts, Improved Elemental Blast, Kinetic Pinnacle, Kinetic Durability, Kinetic Quickness, Voice of Elements, Elemental Apotheosis, Nourishing Gate, Aura Shaping", "PF2e", "Rule elements."],
    ["Elemental Transformation", "module", "Elemental Form at a chosen rank up to ⌈level/2⌉ through the spell module."],
    ["Reflow Elements, Double Reflow, Rapid Reattunement, Omnikinesis", "GM", "Retraining between impulse feats: character building, not resolution."],
    ["Kineticist Dedication, Through the Gate, Expert Kinetic Control, Base Kinesis (archetype), Elemental Familiar, Elemental Overlap", "PF2e", "Granted features and proficiencies; their impulses resolve like the class's."],
    ["Alchemists+ Chrysopoet: Render Circle", "module", "Its Effect counts as the kinetic aura (overflow ends it, stances end with it)."],
    ["Alchemists+ Chrysopoet: Matter Blast", "module", "The module's impulse attack from its element table (Intelligence on 2 actions)."],
    ["Barbarians+ Elemental Instinct", "module", "While raging, impulses of the instinct's element (and Sustaining them) gain the rage trait: noted on the card."]
];

const out = `# Coverage

Generated by \`node tools/coverage-doc.mjs\` from PF2e ${items.pf2e} (impulses read at their own level). "automatic": every sentence read; "guided": a GM note remains.

## Impulses (${rows.length})

| Impulse | Level | Actions | Family | Automation | What the card does |
|---|---|---|---|---|---|
${rows.join("\n")}

## Other Kineticist features

| Feature | Handled by | How |
|---|---|---|
${FEATURES.map(([name, by, how]) => `| ${name} | ${by} | ${how} |`).join("\n")}
`;
writeFileSync("docs/coverage.md", out);
console.log(`docs/coverage.md: ${rows.length} impulses, ${FEATURES.length} features`);
