// Forced movement the module carries out: square by square in the nearest of the 8 directions away from (or toward) a point, stopping at walls and
// the scene's edge; diagonals cost 5 then 10 feet (PF2e). A creature never ends in another's space: it stops in the last free square before it.
import { MODULE_ID } from "./utils.js";
import { gridDirection, stepsWithin } from "../src/core/geometry.js";

const box = (token, x, y, size) => ({ x, y, w: Number(token.width ?? 1) * size, h: Number(token.height ?? 1) * size });
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const centre = (token, x, y, size) => ({ x: x + Number(token.width ?? 1) * size / 2, y: y + Number(token.height ?? 1) * size / 2 });

function occupied(token, x, y, size) {
    const here = box(token, x, y, size);
    return (token.parent?.tokens ?? []).some(other => other.id !== token.id && other.actor && !other.hidden && overlaps(here, box(other, other.x, other.y, size)));
}

function insideScene(token, x, y, size) {
    const rect = token.parent?.dimensions?.sceneRect ?? canvas?.dimensions?.sceneRect;
    if (!rect) return true;
    const b = box(token, x, y, size);
    return b.x >= rect.x && b.y >= rect.y && b.x + b.w <= rect.x + rect.width && b.y + b.h <= rect.y + rect.height;
}

function wallBetween(a, b) {
    try {
        const backend = CONFIG?.Canvas?.polygonBackends?.move;
        if (backend?.testCollision) return Boolean(backend.testCollision(a, b, { type: "move", mode: "any" }));
    } catch (_) {}
    return false;
}

/** Push (direction "away") or pull ("toward") a token up to `feet` from a point. Returns { moved, squares, stoppedBy }. */
export async function forcedMove(tokenDocument, { point, direction = "away", feet, reason = "" }) {
    const token = tokenDocument?.document ?? tokenDocument;
    if (!token?.parent || !point || !(Number(feet) > 0)) return { moved: false, reason: "nothing to move" };
    const size = token.parent.grid?.size ?? canvas.grid.size;
    const gridFeet = token.parent.grid?.distance ?? 5;
    const start = { x: token.x, y: token.y };
    const away = gridDirection(point, centre(token, start.x, start.y, size));
    const step = direction === "away" ? away : away && [-away[0], -away[1]];
    if (!step) return { moved: false, stoppedBy: "no direction" };
    const squares = stepsWithin(Number(feet), step[0] !== 0 && step[1] !== 0, gridFeet);
    let at = { ...start }, lastFree = { ...start }, stoppedBy = null, taken = 0;
    for (let i = 0; i < squares; i++) {
        const next = { x: at.x + step[0] * size, y: at.y + step[1] * size };
        if (!insideScene(token, next.x, next.y, size)) { stoppedBy = "edge"; break; }
        if (wallBetween(centre(token, at.x, at.y, size), centre(token, next.x, next.y, size))) { stoppedBy = "wall"; break; }
        at = next;
        taken += 1;
        if (!occupied(token, at.x, at.y, size)) lastFree = { ...at };
    }
    if (lastFree.x !== at.x || lastFree.y !== at.y) stoppedBy ??= "occupied";
    if (lastFree.x === start.x && lastFree.y === start.y) return { moved: false, squares: 0, stoppedBy };
    await token.update({ x: lastFree.x, y: lastFree.y }, { teleport: true, animate: false, [MODULE_ID]: { forcedMovement: true, reason } });
    return { moved: true, squares: taken, stoppedBy };
}
