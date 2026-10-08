// Grid geometry, pure.

const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** The nearest of the 8 grid directions from one point to another (null when they coincide). */
export function gridDirection(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return null;
    const index = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
    return DIRECTIONS[index];
}

/** The squares a move of `feet` covers: diagonals alternate 5 and 10 feet (PF2e). */
export function stepsWithin(feet, diagonal, gridFeet = 5) {
    if (!diagonal) return Math.floor(feet / gridFeet);
    let used = 0, steps = 0;
    while (true) {
        const cost = steps % 2 === 0 ? gridFeet : 2 * gridFeet;
        if (used + cost > feet) return steps;
        used += cost;
        steps += 1;
    }
}

/** Is a point inside a circle (burst/emanation) of `radius` pixels? */
export const inCircle = (point, centre, radius) => Math.hypot(point.x - centre.x, point.y - centre.y) <= radius + 1e-6;
