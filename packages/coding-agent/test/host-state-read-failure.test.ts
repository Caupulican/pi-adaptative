import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostStateStore } from "../src/core/models/host-state-store.ts";
import { nodeFs } from "../src/core/util/faultable-fs.ts";

const dirs: string[] = [];
const stores: HostStateStore<string[]>[] = [];
const host = { id: "fixture", cpu: "fixture", cores: 1, totalMemGb: 1 };

afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(writeBehind = false, readOnly = false) {
	const dir = fs.mkdtempSync(join(tmpdir(), "pi-host-read-failure-"));
	dirs.push(dir);
	const path = join(dir, "state.json");
	const store = new HostStateStore<string[]>({
		filePath: path,
		version: 1,
		readOnly,
		fingerprint: () => host,
		parseHost: (value) =>
			Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined,
		...(writeBehind ? { writeBehind: { debounceMs: 60_000 } } : {}),
	});
	stores.push(store);
	const append = (value: string) =>
		store.mutateCurrentHost(
			() => [],
			(data) => {
				data.push(value);
				return { result: data.length, changed: true };
			},
		);
	return { store, path, append };
}

describe("host-state read failure", () => {
	for (const writeBehind of [false, true]) {
		it.each(["EACCES", "EIO"])(`does not overwrite unreadable state, write-behind=${writeBehind}: %s`, (code) => {
			const { store, path, append } = fixture(writeBehind);
			append("seed");
			store.flush();
			const before = fs.readFileSync(path, "utf8");
			if (writeBehind) append("pending");
			const originalRead = fs.readFileSync;
			const read = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
				if (file === path) throw Object.assign(new Error("fixture read failure"), { code });
				return originalRead(file, options);
			});
			syncBuiltinESMExports();
			let caught: unknown;
			try {
				if (writeBehind) store.flush();
				else append("pending");
			} catch (error) {
				caught = error;
			} finally {
				read.mockRestore();
				syncBuiltinESMExports();
			}
			expect(fs.readFileSync(path, "utf8")).toBe(before);
			expect(caught).toMatchObject({ code });
			if (!writeBehind) append("pending");
			store.flush();
			expect(store.getHost()).toEqual(["seed", "pending"]);
		});
	}

	it("creates a genuinely absent state file", () => {
		const { path, append, store } = fixture();
		expect(fs.existsSync(path)).toBe(false);
		expect(append("first")).toBe(1);
		expect(store.getHost()).toEqual(["first"]);
	});

	it.each([false, true])("recovers a blocked parent path; write-behind=%s", (writeBehind) => {
		const { path, append, store } = fixture(writeBehind);
		const parent = dirname(path);
		fs.rmdirSync(parent);
		fs.writeFileSync(parent, "not a directory");
		try {
			expect(() => fs.readFileSync(path)).toThrow();
			if (writeBehind) {
				expect(append("first")).toBe(1);
				expect(() => store.flush()).toThrow();
			} else {
				expect(() => append("first")).toThrow();
			}
			fs.unlinkSync(parent);
			fs.mkdirSync(parent);
			if (!writeBehind) expect(append("first")).toBe(1);
			store.flush();
			expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual({ version: 1, hosts: { fixture: ["first"] } });
		} finally {
			fs.rmSync(parent, { recursive: true, force: true });
			fs.mkdirSync(parent);
		}
	});

	it("keeps a multi-observation batch to one durable replacement", () => {
		const { append, store } = fixture(true);
		const writes = vi.spyOn(nodeFs, "renameSync");
		for (let i = 0; i < 10; i++) append(`observation-${i}`);
		expect(writes).not.toHaveBeenCalled();
		store.flush();
		expect(writes).toHaveBeenCalledTimes(1);
		store.flush();
		expect(writes).toHaveBeenCalledTimes(1);
		expect(store.getHost()).toHaveLength(10);
	});

	it.each([false, true])("keeps advisory access available without changing the file; read-only=%s", (readOnly) => {
		const { path, append, store } = fixture(false, readOnly);
		fs.writeFileSync(path, JSON.stringify({ version: 1, hosts: { fixture: ["seed"] } }));
		const before = fs.readFileSync(path, "utf8");
		const originalRead = fs.readFileSync;
		const read = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
			if (file === path) throw Object.assign(new Error("fixture read failure"), { code: "EACCES" });
			return originalRead(file, options);
		});
		syncBuiltinESMExports();
		try {
			expect(store.getHost()).toBeUndefined();
			expect(store.getAllHosts()).toEqual([]);
			if (readOnly) expect(append("hypothetical")).toBe(1);
		} finally {
			read.mockRestore();
			syncBuiltinESMExports();
		}
		expect(fs.readFileSync(path, "utf8")).toBe(before);
		expect(store.getHost()).toEqual(["seed"]);
	});
});
