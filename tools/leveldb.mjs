// Read-only reader for Foundry compendium packs (LevelDB), with no
// dependencies: SSTable files (.ldb) with Snappy blocks, plus the write-ahead
// log (.log). It never writes, so it is safe while Foundry has the pack open.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const MAGIC = 0xdb4775248b80fb57n;

function readVarint(buffer, position) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
        byte = buffer[position++];
        result += (byte & 0x7f) * 2 ** shift;
        shift += 7;
    } while (byte & 0x80);
    return [result, position];
}

export function snappyDecompress(input) {
    let [length, position] = readVarint(input, 0);
    const output = Buffer.allocUnsafe(length);
    let out = 0;
    while (position < input.length) {
        const tag = input[position++];
        const kind = tag & 3;
        if (kind === 0) {
            let size = tag >> 2;
            if (size >= 60) {
                const bytes = size - 59;
                size = 0;
                for (let i = 0; i < bytes; i++) size |= input[position + i] << (8 * i);
                position += bytes;
            }
            size += 1;
            input.copy(output, out, position, position + size);
            position += size;
            out += size;
            continue;
        }
        let size;
        let offset;
        if (kind === 1) {
            size = ((tag >> 2) & 7) + 4;
            offset = ((tag >> 5) << 8) | input[position++];
        } else if (kind === 2) {
            size = (tag >> 2) + 1;
            offset = input.readUInt16LE(position);
            position += 2;
        } else {
            size = (tag >> 2) + 1;
            offset = input.readUInt32LE(position);
            position += 4;
        }
        // Copies may overlap their own output, so go byte by byte.
        for (let i = 0; i < size; i++, out++) output[out] = output[out - offset];
    }
    if (out !== length) throw new Error(`Snappy length mismatch: ${out} of ${length}`);
    return output;
}

function readBlock(file, offset, size) {
    const raw = file.subarray(offset, offset + size);
    const type = file[offset + size];
    if (type === 0) return raw;
    if (type === 1) return snappyDecompress(raw);
    throw new Error(`Unsupported block compression ${type}`);
}

function* blockEntries(block) {
    const restarts = block.readUInt32LE(block.length - 4);
    const end = block.length - 4 - restarts * 4;
    let position = 0;
    let key = Buffer.alloc(0);
    while (position < end) {
        let shared;
        let unshared;
        let valueLength;
        [shared, position] = readVarint(block, position);
        [unshared, position] = readVarint(block, position);
        [valueLength, position] = readVarint(block, position);
        key = Buffer.concat([key.subarray(0, shared), block.subarray(position, position + unshared)]);
        position += unshared;
        const value = block.subarray(position, position + valueLength);
        position += valueLength;
        yield [key, value];
    }
}

function* tableEntries(file) {
    const footer = file.subarray(file.length - 48);
    if (footer.readBigUInt64LE(40) !== MAGIC) throw new Error("Not a LevelDB table");
    let position = 0;
    [, position] = readVarint(footer, position); // metaindex offset
    [, position] = readVarint(footer, position); // metaindex size
    let indexOffset;
    let indexSize;
    [indexOffset, position] = readVarint(footer, position);
    [indexSize, position] = readVarint(footer, position);
    for (const [, handle] of blockEntries(readBlock(file, indexOffset, indexSize))) {
        const [offset, next] = readVarint(handle, 0);
        const [size] = readVarint(handle, next);
        for (const [internalKey, value] of blockEntries(readBlock(file, offset, size))) {
            const userKey = internalKey.subarray(0, internalKey.length - 8).toString("utf8");
            const trailer = internalKey.readBigUInt64LE(internalKey.length - 8);
            yield { key: userKey, sequence: trailer >> 8n, type: Number(trailer & 0xffn), value };
        }
    }
}

function* logEntries(file) {
    const BLOCK = 32768;
    let pending = [];
    for (let blockStart = 0; blockStart < file.length; blockStart += BLOCK) {
        let position = blockStart;
        const blockEnd = Math.min(blockStart + BLOCK, file.length);
        while (position + 7 <= blockEnd) {
            const length = file.readUInt16LE(position + 4);
            const type = file[position + 6];
            if (type === 0 && length === 0) break;
            const data = file.subarray(position + 7, position + 7 + length);
            position += 7 + length;
            if (type === 1) yield* batchEntries(data);
            else if (type === 2) pending = [data];
            else if (type === 3) pending.push(data);
            else if (type === 4) {
                pending.push(data);
                yield* batchEntries(Buffer.concat(pending));
                pending = [];
            }
        }
    }
}

function* batchEntries(batch) {
    const sequence = batch.readBigUInt64LE(0);
    const count = batch.readUInt32LE(8);
    let position = 12;
    for (let i = 0; i < count; i++) {
        const type = batch[position++];
        let length;
        [length, position] = readVarint(batch, position);
        const key = batch.subarray(position, position + length).toString("utf8");
        position += length;
        let value = null;
        if (type === 1) {
            [length, position] = readVarint(batch, position);
            value = batch.subarray(position, position + length);
            position += length;
        }
        yield { key, sequence: sequence + BigInt(i), type, value };
    }
}

// Every live key in a pack directory, newest version wins.
export function readPack(directory) {
    const latest = new Map();
    const files = readdirSync(directory).filter((name) => name.endsWith(".ldb") || name.endsWith(".log"));
    for (const name of files) {
        const full = path.join(directory, name);
        if (!statSync(full).size) continue;
        const file = readFileSync(full);
        const entries = name.endsWith(".ldb") ? tableEntries(file) : logEntries(file);
        for (const entry of entries) {
            const previous = latest.get(entry.key);
            if (!previous || entry.sequence > previous.sequence) latest.set(entry.key, entry);
        }
    }
    const result = new Map();
    for (const [key, entry] of latest) if (entry.type === 1) result.set(key, JSON.parse(entry.value.toString("utf8")));
    return result;
}

// Documents of a pack with their embedded items joined back in.
export function readDocuments(directory) {
    const entries = readPack(directory);
    const documents = new Map();
    const embedded = [];
    for (const [key, value] of entries) {
        const match = key.match(/^!([a-z]+)(?:\.([a-z]+))?!(.+)$/i);
        if (!match) continue;
        const [, collection, child, id] = match;
        if (!child) documents.set(id, { collection, ...value });
        else embedded.push({ collection: child, parentId: id.split(".")[0], value });
    }
    for (const { collection, parentId, value } of embedded) {
        const parent = documents.get(parentId);
        if (!parent) continue;
        if (!Array.isArray(parent[collection]) || typeof parent[collection][0] === "string") parent[collection] = [];
        parent[collection].push(value);
    }
    return [...documents.values()];
}
