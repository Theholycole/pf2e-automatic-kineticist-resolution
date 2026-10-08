import assert from "node:assert/strict";
import test from "node:test";

// Every Foundry script loads (imports and exports line up) with stub globals; nothing runs until Foundry's hooks fire.
const hooks = [];
globalThis.Hooks = { on: (name, fn) => hooks.push(name), once: (name, fn) => hooks.push(name), off() {}, callAll() {} };
globalThis.foundry = { utils: { deepClone: value => structuredClone(value), randomID: () => "x", mergeObject: Object.assign, setProperty() {} }, applications: { api: {} } };
globalThis.game = {}; globalThis.CONFIG = {}; globalThis.ui = {};

test("the Foundry scripts load and register their hooks", async () => {
    await import("../scripts/main.js");
    for (const name of ["init", "ready", "renderChatMessageHTML", "createChatMessage", "createItem", "deleteItem", "updateCombat", "preUpdateToken", "updateToken"]) assert.ok(hooks.includes(name), name);
    const card = await import("../scripts/card.js");
    const blast = await import("../scripts/blast.js");
    assert.equal(typeof blast.blastFamily.card.requestOp, "function");
    assert.equal(typeof card.repeatPlan, "function");
});
