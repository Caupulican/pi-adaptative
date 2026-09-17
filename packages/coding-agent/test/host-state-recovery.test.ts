import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostStateStore } from "../src/core/models/host-state-store.ts";
import { nodeFs } from "../src/core/util/faultable-fs.ts";

const dirs: string[] = [];
const stores: HostStateStore<string[]>[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(maxPending = 64) {
	const dir = mkdtempSync(join(tmpdir(), "pi-host-recovery-"));
	dirs.push(dir);
	const path = join(dir, "state.json");
	const store = new HostStateStore<string[]>({
		filePath: path,
		version: 1,
		fingerprint: () => ({ id: "host", cpu: "test", cores: 1, totalMemGb: 1 }),
		parseHost: (value) =>
			Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined,
		writeBehind: { debounceMs: 60_000, maxPending },
	});
	stores.push(store);
	return { store, path };
}

function append(store: HostStateStore<string[]>, value: string) {
	return store.mutateCurrentHost(
		() => [],
		(data) => {
			data.push(value);
			return { result: data.length, changed: true };
		},
	);
}

function persisted(path: string): string[] {
	return (JSON.parse(readFileSync(path, "utf8")) as { hosts: { host: string[] } }).hosts.host;
}

describe("host batch recovery", () => {
	it.each([false, true])("retains foreign writes across a flush failure: %s", (failFirstWrite) => {
		const { store, path } = fixture();
		append(store, "seed");
		store.flush();
		append(store, "pending");
		writeFileSync(path, JSON.stringify({ version: 1, hosts: { host: ["seed", "foreign"] } }));
		if (failFirstWrite) {
			vi.spyOn(nodeFs, "renameSync").mockImplementationOnce(() => {
				throw new Error("injected write failure after fresh state was loaded");
			});
			expect(() => store.flush()).toThrow("injected write failure");
			expect(persisted(path)).toEqual(["seed", "foreign"]);
		}
		store.flush();
		expect(persisted(path)).toEqual(["seed", "foreign", "pending"]);
		store.flush();
		expect(persisted(path)).toEqual(["seed", "foreign", "pending"]);
	});

	it.each([false, true])("preserves mutation order after close failure: %s", (failClose) => {
		const { store, path } = fixture();
		append(store, "first");
		if (failClose) {
			vi.spyOn(nodeFs, "renameSync").mockImplementationOnce(() => {
				throw new Error("injected close failure");
			});
			expect(() => store.close()).toThrow("injected close failure");
		} else {
			store.close();
		}
		append(store, "second");
		store.close();
		expect(persisted(path)).toEqual(["first", "second"]);
	});

	it("rejects an over-cap callback before invoking it, then admits it after recovery", () => {
		const { store, path } = fixture(1);
		const write = vi.spyOn(nodeFs, "renameSync").mockImplementation(() => {
			throw new Error("injected disk failure");
		});
		expect(() => append(store, "admitted")).toThrow("injected disk failure");
		const mutate = vi.fn((data: string[]) => {
			data.push("next");
			return { result: data.length, changed: true };
		});
		for (let attempt = 0; attempt < 10; attempt++) {
			expect(() => store.mutateCurrentHost(() => [], mutate)).toThrow("injected disk failure");
		}
		expect(mutate).not.toHaveBeenCalled();
		expect(store.getHost()).toEqual(["admitted"]);
		write.mockRestore();
		expect(store.mutateCurrentHost(() => [], mutate)).toBe(2);
		expect(mutate).toHaveBeenCalledTimes(1);
		expect(persisted(path)).toEqual(["admitted", "next"]);
	});
});
