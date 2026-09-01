import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HostFingerprint, HostStateStore } from "../src/core/models/host-state-store.ts";

interface Counter {
	count: number;
	notes: string[];
}

const HOST: HostFingerprint = { id: "test-host-4c-16g", cpu: "test", cores: 4, totalMemGb: 16 };
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createStore(options: { writeBehind?: { debounceMs?: number; maxPending?: number } } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-host-state-"));
	dirs.push(dir);
	const filePath = join(dir, "state.json");
	const store = new HostStateStore<Counter>({
		filePath,
		version: 1,
		fingerprint: () => HOST,
		parseHost: (value) => (value && typeof value === "object" && "count" in value ? (value as Counter) : undefined),
		...options,
	});
	return { dir, filePath, store };
}

function persistedCount(filePath: string): number | undefined {
	try {
		const file = JSON.parse(readFileSync(filePath, "utf-8")) as { hosts: Record<string, Counter> };
		return file.hosts[HOST.id]?.count;
	} catch {
		return undefined;
	}
}

const increment = (store: HostStateStore<Counter>, note: string) =>
	store.mutateCurrentHost(
		() => ({ count: 0, notes: [] }),
		(data) => {
			data.count += 1;
			data.notes.push(note);
			return { result: data.count, changed: true };
		},
	);

describe("HostStateStore", () => {
	it("persists each mutation as its own transaction by default", () => {
		const { filePath, store } = createStore();
		expect(increment(store, "a")).toBe(1);
		expect(persistedCount(filePath)).toBe(1);
		expect(increment(store, "b")).toBe(2);
		expect(persistedCount(filePath)).toBe(2);
	});

	it("hands readers a frozen tree so a shared reference cannot corrupt the next write", () => {
		const { store } = createStore();
		increment(store, "a");
		const host = store.getHost();
		expect(host).toBeDefined();
		expect(() => {
			(host as Counter).count = 99;
		}).toThrow();
		expect(store.getHost()?.count).toBe(1);
	});

	describe("write-behind", () => {
		it("applies mutations in memory at once and persists them in one flush", () => {
			const { filePath, store } = createStore({ writeBehind: { debounceMs: 60_000 } });
			expect(increment(store, "a")).toBe(1);
			expect(increment(store, "b")).toBe(2);
			// This process reads its own pending mutations; the file has not been written yet.
			expect(store.getHost()?.count).toBe(2);
			expect(persistedCount(filePath)).toBeUndefined();
			store.flush();
			expect(persistedCount(filePath)).toBe(2);
			expect(store.getHost()?.notes).toEqual(["a", "b"]);
			// Flushing with nothing pending changes nothing.
			store.flush();
			expect(persistedCount(filePath)).toBe(2);
		});

		it("replays pending mutations onto what another process wrote in between", () => {
			const { filePath, store } = createStore({ writeBehind: { debounceMs: 60_000 } });
			increment(store, "seed");
			store.flush();
			expect(persistedCount(filePath)).toBe(1);

			increment(store, "mine-1");
			increment(store, "mine-2");
			// A foreign writer -- another process -- lands two observations of its own on the file.
			const other = new HostStateStore<Counter>({
				filePath,
				version: 1,
				fingerprint: () => HOST,
				parseHost: (value) =>
					value && typeof value === "object" && "count" in value ? (value as Counter) : undefined,
			});
			increment(other, "theirs-1");
			increment(other, "theirs-2");
			expect(persistedCount(filePath)).toBe(3);

			// The flush replays this process's two mutations after theirs: exactly what two individual
			// transactions run after the foreign writes would have produced.
			store.flush();
			expect(persistedCount(filePath)).toBe(5);
			const notes = (JSON.parse(readFileSync(filePath, "utf-8")) as { hosts: Record<string, Counter> }).hosts[
				HOST.id
			]?.notes;
			expect(notes).toEqual(["seed", "theirs-1", "theirs-2", "mine-1", "mine-2"]);
			expect(store.getHost()?.count).toBe(5);
		});

		it("flushes at the pending cap without waiting for the idle timer", () => {
			const { filePath, store } = createStore({ writeBehind: { debounceMs: 60_000, maxPending: 3 } });
			increment(store, "a");
			increment(store, "b");
			expect(persistedCount(filePath)).toBeUndefined();
			increment(store, "c");
			expect(persistedCount(filePath)).toBe(3);
		});

		it("flushes on the idle timer", async () => {
			const { filePath, store } = createStore({ writeBehind: { debounceMs: 20 } });
			increment(store, "a");
			expect(persistedCount(filePath)).toBeUndefined();
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(persistedCount(filePath)).toBe(1);
		});

		it("close flushes what is pending and returns the store to one transaction per mutation", () => {
			const { filePath, store } = createStore({ writeBehind: { debounceMs: 60_000 } });
			increment(store, "a");
			store.close();
			expect(persistedCount(filePath)).toBe(1);
			increment(store, "b");
			expect(persistedCount(filePath)).toBe(2);
		});

		it("keeps mutations pending when a flush cannot write, and persists them on the next flush", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-host-state-"));
			dirs.push(dir);
			const filePath = join(dir, "blocked", "state.json");
			const store = new HostStateStore<Counter>({
				filePath,
				version: 1,
				fingerprint: () => HOST,
				parseHost: (value) =>
					value && typeof value === "object" && "count" in value ? (value as Counter) : undefined,
				writeBehind: { debounceMs: 60_000 },
			});
			increment(store, "a");
			// A file where the state's parent directory must go makes every write there fail.
			writeFileSync(join(dir, "blocked"), "");
			expect(() => store.flush()).toThrow();
			expect(store.getHost()?.count).toBe(1);
			rmSync(join(dir, "blocked"));
			store.flush();
			expect(persistedCount(filePath)).toBe(1);
		});
	});
});
