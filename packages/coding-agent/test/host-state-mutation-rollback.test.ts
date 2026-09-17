import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostStateStore } from "../src/core/models/host-state-store.ts";
import {
	type ToolExecutionObservation,
	ToolPerformanceStore,
} from "../src/core/tool-selection/tool-performance-store.ts";

const dirs: string[] = [];
const stores: HostStateStore<string[]>[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(batched = true) {
	const dir = mkdtempSync(join(tmpdir(), "pi-host-rollback-"));
	dirs.push(dir);
	const path = join(dir, "state.json");
	const store = new HostStateStore<string[]>({
		filePath: path,
		version: 1,
		fingerprint: () => ({ id: "host", cpu: "test", cores: 1, totalMemGb: 1 }),
		parseHost: (value) =>
			Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined,
		...(batched ? { writeBehind: { debounceMs: 60_000 } } : {}),
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

describe("host-state mutation rollback", () => {
	for (const batched of [false, true]) {
		it.each([false, true])(`isolates a callback failure, batched=${batched}, throws=%s`, (throws) => {
			const { store, path, append } = fixture(batched);
			append("seed");
			store.flush();
			append("accepted");
			const mutate = () =>
				store.mutateCurrentHost(
					() => [],
					(data) => {
						data.push("partial");
						if (throws) throw new Error("fixture callback failure");
						return { result: data.length, changed: true };
					},
				);
			if (throws) expect(mutate).toThrow("fixture callback failure");
			else expect(mutate()).toBe(3);
			const expected = throws ? ["seed", "accepted"] : ["seed", "accepted", "partial"];
			expect(store.getHost()).toEqual(expected);
			expect(store.getAllHosts()).toEqual([expected]);
			append("later");
			store.flush();
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
				version: 1,
				hosts: { host: [...expected, "later"] },
			});
		});
	}

	it("does not retain a newly created host when its first callback throws", () => {
		const { store, append } = fixture();
		expect(() =>
			store.mutateCurrentHost(
				() => [],
				(data) => {
					data.push("partial");
					throw new Error("fixture first callback failure");
				},
			),
		).toThrow("fixture first callback failure");
		expect(store.getHost()).toBeUndefined();
		expect(append("accepted")).toBe(1);
		store.flush();
		expect(store.getHost()).toEqual(["accepted"]);
	});

	it.each([false, true])("discards changes reported as a no-op; earlier pending mutation=%s", (pending) => {
		const { store, append } = fixture();
		if (pending) append("accepted");
		expect(
			store.mutateCurrentHost(
				() => [],
				(data) => {
					data.push("unreported");
					return { result: "ignored", changed: false };
				},
			),
		).toBe("ignored");
		expect(store.getHost()).toEqual(pending ? ["accepted"] : undefined);
		append("later");
		store.flush();
		expect(store.getHost()).toEqual(pending ? ["accepted", "later"] : ["later"]);
	});

	it("retains the batch if replay itself throws, then retries without partial durable changes", () => {
		const { store, path, append } = fixture();
		append("seed");
		store.flush();
		let failReplay = false;
		store.mutateCurrentHost(
			() => [],
			(data) => {
				data.push("accepted");
				if (failReplay) throw new Error("fixture replay failure");
				return { result: undefined, changed: true };
			},
		);
		const foreign = JSON.stringify({ version: 1, hosts: { host: ["seed", "foreign"] } });
		writeFileSync(path, foreign);
		failReplay = true;
		try {
			expect(() => store.flush()).toThrow("fixture replay failure");
			expect(readFileSync(path, "utf8")).toBe(foreign);
		} finally {
			failReplay = false;
		}
		store.flush();
		expect(store.getHost()).toEqual(["seed", "foreign", "accepted"]);
	});

	it("does not clone the host tree per successful mutation", () => {
		const { store, append } = fixture();
		const clones = vi.spyOn(globalThis, "structuredClone");
		for (let i = 0; i < 20; i++) append(`accepted-${i}`);
		expect(clones).toHaveBeenCalledTimes(1);
		store.flush();
		expect(clones).toHaveBeenCalledTimes(1);
		expect(store.getHost()).toHaveLength(20);
	});

	it("rebuilds accepted in-memory state after rejection even while the disk is unreadable", () => {
		const { store, path, append } = fixture();
		append("seed");
		store.flush();
		append("accepted");
		expect(() =>
			store.mutateCurrentHost(
				() => [],
				(data) => {
					data.push("partial");
					throw new Error("fixture callback failure");
				},
			),
		).toThrow("fixture callback failure");
		const originalRead = fs.readFileSync;
		const read = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
			if (file === path) throw Object.assign(new Error("fixture unreadable disk"), { code: "EACCES" });
			return originalRead(file, options);
		});
		syncBuiltinESMExports();
		try {
			expect(store.getHost()).toEqual(["seed", "accepted"]);
			expect(store.getAllHosts()).toEqual([["seed", "accepted"]]);
			expect(read.mock.calls.filter(([file]) => file === path)).toHaveLength(0);
			expect(() => store.flush()).toThrow("fixture unreadable disk");
			expect(read.mock.calls.filter(([file]) => file === path)).toHaveLength(1);
		} finally {
			read.mockRestore();
			syncBuiltinESMExports();
		}
		store.flush();
		expect(store.getHost()).toEqual(["seed", "accepted"]);
	});

	it("does not publish partial tool statistics when malformed selection data throws", () => {
		const { path } = fixture();
		const toolsPath = join(dirname(path), "tools.json");
		const store = new ToolPerformanceStore(toolsPath, {
			readOnly: false,
			writeBehind: { debounceMs: 60_000 },
		});
		const observation: ToolExecutionObservation = {
			key: { modelRef: "fixture/model", intentClass: "read", tool: "read" },
			success: true,
			latencyMs: 10,
			selection: { firstTool: true, disposition: "abstain", shortlist: [], ranked: [], entropy: 0, margin: 0 },
		};
		try {
			store.recordExecution(observation);
			const malformed = {
				...observation,
				selection: { ...observation.selection, ranked: null },
			} as unknown as ToolExecutionObservation;
			expect(() => store.recordExecution(malformed)).toThrow();
			expect(store.get(observation.key).sampleCount).toBe(1);
			store.recordExecution(observation);
			store.flush();
			expect(store.get(observation.key).sampleCount).toBe(2);
			expect(store.getObservations()).toHaveLength(2);
			expect(store.getIntentAgreement("fixture/model", "read").sampleCount).toBe(2);
			const freshReader = new ToolPerformanceStore(toolsPath, { readOnly: true });
			expect(freshReader.get(observation.key).sampleCount).toBe(2);
			expect(freshReader.getObservations()).toHaveLength(2);
			expect(freshReader.getIntentAgreement("fixture/model", "read").sampleCount).toBe(2);
			freshReader.close();
		} finally {
			store.close();
		}
	});
});
