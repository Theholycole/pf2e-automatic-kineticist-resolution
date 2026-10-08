// Reader coverage: every impulse in the fixture at its own level (or LEVEL=n), its plan kind, automation level and unread sentences.
// Run: node tools/coverage.mjs [--unread] [ONLY=name]
import { readFileSync } from "node:fs";
import { readImpulse, untokenize } from "../src/reader/impulse-reader.js";

const items = JSON.parse(readFileSync(".cache/kineticist-items.json", "utf8"));
const only = process.env.ONLY ?? null;
const showUnread = process.argv.includes("--unread");
const list = [...items.impulses, ...items.plus.filter(item => (item.system?.traits?.value ?? []).includes("impulse"))];
const tally = {};
let automatic = 0, unreadTotal = 0;
for (const item of list) {
    if (only && item.name !== only) continue;
    const level = Number(process.env.LEVEL ?? item.system?.level?.value ?? 1) || 1;
    let plan;
    try { plan = readImpulse(item, { level }); } catch (error) { console.log(`${item.name}: ERROR ${error.stack}`); continue; }
    const key = `${plan.resolution.kind}/${plan.automation.level}`;
    tally[key] = (tally[key] ?? 0) + 1;
    if (plan.automation.level === "automatic") automatic++;
    const unread = plan.resolution.notes.filter(entry => entry.where === "body" || entry.where === "degree");
    unreadTotal += unread.length;
    if (only) console.log(JSON.stringify(plan, null, 1));
    else if (!showUnread || unread.length) console.log(`${item.name} [${key}]${unread.length ? ` unread ${unread.length}` : ""}${plan.automation.pendingCapabilities.length ? ` pending ${plan.automation.pendingCapabilities}` : ""}`);
    if (showUnread) for (const entry of unread) console.log(`    · ${entry.text}`);
}
console.log(tally, `automatic ${automatic}/${list.length}, unread sentences ${unreadTotal}`);
