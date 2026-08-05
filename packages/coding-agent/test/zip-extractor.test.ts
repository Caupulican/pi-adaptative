import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractZipFile, ZipExtractionError } from "../src/utils/zip-extractor.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function crc32(value: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of value) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: Array<{ name: string; content: string; deflated?: boolean }>): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let localOffset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const content = Buffer.from(entry.content, "utf8");
		const compressed = entry.deflated ? deflateRawSync(content) : content;
		const method = entry.deflated ? 8 : 0;
		const checksum = crc32(content);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(content.length, 22);
		local.writeUInt16LE(name.length, 26);
		localParts.push(local, name, compressed);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((3 << 8) | 20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(content.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
		central.writeUInt32LE(localOffset, 42);
		centralParts.push(central, name);
		localOffset += local.length + name.length + compressed.length;
	}
	const centralDirectory = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(localOffset, 16);
	return Buffer.concat([...localParts, centralDirectory, end]);
}

describe("extractZipFile", () => {
	it("extracts stored and deflated files without an external unzip command", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-native-zip-"));
		tempDirectories.push(root);
		const archive = join(root, "fixture.zip");
		const destination = join(root, "out");
		await writeFile(
			archive,
			createZip([
				{ name: "bw", content: "binary-marker", deflated: true },
				{ name: "nested/readme.txt", content: "stored-marker" },
			]),
		);

		await extractZipFile(archive, destination);

		await expect(readFile(join(destination, "bw"), "utf8")).resolves.toBe("binary-marker");
		await expect(readFile(join(destination, "nested", "readme.txt"), "utf8")).resolves.toBe("stored-marker");
	});

	it("rejects traversal entries before writing outside the destination", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-native-zip-"));
		tempDirectories.push(root);
		const archive = join(root, "traversal.zip");
		await writeFile(archive, createZip([{ name: "../escape.txt", content: "escape" }]));

		await expect(extractZipFile(archive, join(root, "out"))).rejects.toBeInstanceOf(ZipExtractionError);
		await expect(access(join(root, "escape.txt"))).rejects.toBeDefined();
	});

	it("rejects duplicate paths rather than overwriting an extracted file", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-native-zip-"));
		tempDirectories.push(root);
		const archive = join(root, "duplicate.zip");
		await writeFile(
			archive,
			createZip([
				{ name: "bw", content: "first" },
				{ name: "bw", content: "second" },
			]),
		);

		await expect(extractZipFile(archive, join(root, "out"))).rejects.toMatchObject({ code: "unsafe_entry" });
	});
});
