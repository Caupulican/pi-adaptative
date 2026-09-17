import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ToolPerformanceKey, ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";
import { nodeFs } from "../src/core/util/faultable-fs.ts";

const host = { id: "fixture", cpu: "fixture", cores: 2, totalMemGb: 8 };
const key: ToolPerformanceKey = { modelRef: "faux/model", intentClass: "read", tool: "read" };
const selection = {
	firstTool: true,
	disposition: "abstain" as const,
	shortlist: [],
	ranked: [],
	entropy: 0,
	margin: 0,
};
const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(writeBehind = false) {
	const dir = mkdtempSync(join(tmpdir(), "pi-performance-byte-"));
	const path = join(dir, "state", "tool-performance.json");
	const store = ToolPerformanceStore.forAgentDir(dir, {
		fingerprint: () => host,
		...(writeBehind ? { writeBehind: { maxPending: 64 } } : {}),
	});
	cleanups.push(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { dir, path, store };
}

interface StoredHost {
	stats: Record<string, Record<string, unknown>>;
	intentAgreement: Record<string, Record<string, unknown>>;
	statsBytes: number;
	intentAgreementBytes: number;
}

function maps(path: string): StoredHost {
	const file = JSON.parse(readFileSync(path, "utf8")) as { hosts: { fixture: StoredHost } };
	return file.hosts.fixture;
}

describe("tool evidence map byte retention", () => {
	it.each(["stats", "intentAgreement"] as const)("enforces the exact encoded-byte boundary for %s", (field) => {
		const { path, store } = fixture();
		store.recordExecution({ key, success: true, latencyMs: 1, selection });
		const original = readFileSync(path, "utf8");
		for (const offset of [-1, 0, 1]) {
			const file = JSON.parse(original) as { hosts: { fixture: StoredHost } };
			const records = file.hosts.fixture[field];
			const record = Object.values(records)[0]!;
			record.padding = "";
			record.padding = "x".repeat(256 * 1024 + offset - Buffer.byteLength(JSON.stringify(records)));
			expect(Buffer.byteLength(JSON.stringify(records))).toBe(256 * 1024 + offset);
			writeFileSync(path, JSON.stringify(file));
			const count =
				field === "stats"
					? store.get(key).sampleCount
					: store.getIntentAgreement(key.modelRef, key.intentClass).sampleCount;
			expect(count).toBe(offset <= 0 ? 1 : 0);
		}
	});

	it.each([false, true])("bounds encoded maps on execution (writeBehind=%s)", (writeBehind) => {
		const { path, store } = fixture(writeBehind);
		for (let index = 0; index < 40; index++) {
			store.recordExecution({
				key: { ...key, modelRef: `${index}-${"界".repeat(2_000)}` },
				success: true,
				latencyMs: 1,
				selection,
			});
		}
		store.recordExecution({ key, success: true, latencyMs: 1, selection });
		store.flush();
		const data = maps(path);
		expect(Buffer.byteLength(JSON.stringify(data.stats))).toBeLessThanOrEqual(256 * 1024);
		expect(Buffer.byteLength(JSON.stringify(data.intentAgreement))).toBeLessThanOrEqual(256 * 1024);
		expect(data.statsBytes).toBe(Buffer.byteLength(JSON.stringify(data.stats)));
		expect(data.intentAgreementBytes).toBe(Buffer.byteLength(JSON.stringify(data.intentAgreement)));
		expect(store.get(key).sampleCount).toBe(1);
		expect(store.getIntentAgreement(key.modelRef, key.intentClass).sampleCount).toBe(1);
	});

	it("bounds validation-only writes without requiring an execution", () => {
		const { path, store } = fixture();
		for (let index = 0; index < 30; index++) {
			store.recordValidation({ ...key, tool: `${index}-${"x".repeat(6_000)}` }, "repaired");
		}
		store.recordValidation(key, "bounced");
		expect(Buffer.byteLength(JSON.stringify(maps(path).stats))).toBeLessThanOrEqual(256 * 1024);
		expect(store.get(key).bounceCount).toBe(1);
	});

	it.each(["stats", "intentAgreement"] as const)(
		"trims oversized loaded %s without trusting stored byte counts",
		(field) => {
			const { dir, path, store } = fixture();
			store.recordExecution({ key, success: true, latencyMs: 1, selection });
			const file = JSON.parse(readFileSync(path, "utf8")) as { hosts: { fixture: StoredHost } };
			const records = file.hosts.fixture[field];
			const original = Object.values(records)[0] as Record<string, unknown>;
			for (let index = 0; index < 30; index++) {
				const modelRef = `${index}-${"界".repeat(2_000)}`;
				records[field === "stats" ? `${modelRef}\0read\0read` : `${modelRef}\0read`] = { ...original, modelRef };
			}
			file.hosts.fixture.statsBytes = 2;
			file.hosts.fixture.intentAgreementBytes = 2;
			writeFileSync(path, JSON.stringify(file));
			const reader = ToolPerformanceStore.forAgentDir(dir, {
				fingerprint: () => host,
				readOnly: true,
			});
			try {
				const loaded =
					field === "stats"
						? Object.keys(records).flatMap((entry) => reader.getStatsForModel(entry.split("\0")[0]))
						: reader.getAllIntentAgreements();
				const loadedMap = Object.fromEntries(
					loaded.map((entry) => [
						"tool" in entry
							? `${entry.modelRef}\0${entry.intentClass}\0${entry.tool}`
							: `${entry.modelRef}\0${entry.intentClass}`,
						entry,
					]),
				);
				expect(Buffer.byteLength(JSON.stringify(loadedMap))).toBeLessThanOrEqual(256 * 1024);
				expect(loaded.length).toBeLessThan(31);
				expect(loaded.length).toBeGreaterThan(0);
			} finally {
				reader.close();
			}
		},
	);

	it("keeps ordinary evidence when an individually oversized record is offered", () => {
		const { path, store } = fixture();
		store.recordExecution({ key, success: true, latencyMs: 1, selection });
		store.recordExecution({ key: { ...key, modelRef: "x".repeat(300_000) }, success: true, latencyMs: 1, selection });
		const data = maps(path);
		expect(Buffer.byteLength(JSON.stringify(data.stats))).toBeLessThanOrEqual(256 * 1024);
		expect(Buffer.byteLength(JSON.stringify(data.intentAgreement))).toBeLessThanOrEqual(256 * 1024);
		expect(store.get(key).sampleCount).toBe(1);
		expect(store.getIntentAgreement(key.modelRef, key.intentClass).sampleCount).toBe(1);
	});

	it("measures only the changed aggregate records on an ordinary batched update", () => {
		const { store, path } = fixture(true);
		for (let index = 0; index < 30; index++)
			store.recordExecution({ key: { ...key, tool: `read_${index}` }, success: true, latencyMs: 1, selection });
		const stringify = vi.spyOn(JSON, "stringify");
		let encoded: unknown[];
		try {
			store.recordExecution({ key: { ...key, tool: "read_0" }, success: true, latencyMs: 1, selection });
			encoded = stringify.mock.calls.map((call) => call[0]);
		} finally {
			stringify.mockRestore();
		}
		expect(encoded.filter((value) => typeof value === "object" && value !== null && "alpha" in value)).toHaveLength(
			2,
		);
		expect(
			encoded.filter((value) => typeof value === "object" && value !== null && "lastUpdatedAt" in value),
		).toHaveLength(2);
		store.flush();
		const data = maps(path);
		expect(data.statsBytes).toBe(Buffer.byteLength(JSON.stringify(data.stats)));
		expect(data.intentAgreementBytes).toBe(Buffer.byteLength(JSON.stringify(data.intentAgreement)));
	});

	it.each([false, true])("recomputes byte accounting on foreign rebase (failed flush=%s)", (failFlush) => {
		const { dir, store, path } = fixture(true);
		store.recordExecution({ key, success: true, latencyMs: 1, selection, at: "2026-09-17T03:00:00.000Z" });
		const foreign = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host });
		try {
			for (let index = 0; index < 30; index++)
				foreign.recordExecution({
					key: { ...key, modelRef: `${index}-${"界".repeat(2_000)}` },
					success: true,
					latencyMs: 1,
					selection,
					at: "2026-09-17T02:00:00.000Z",
				});
			if (failFlush) {
				const before = readFileSync(path, "utf8");
				vi.spyOn(nodeFs, "renameSync").mockImplementationOnce(() => {
					throw new Error("injected map flush failure");
				});
				expect(() => store.flush()).toThrow("injected map flush failure");
				expect(readFileSync(path, "utf8")).toBe(before);
			}
			foreign.recordValidation(key, "bounced", "2026-09-17T02:30:00.000Z");
			store.flush();
			const data = maps(path);
			expect(data.statsBytes).toBe(Buffer.byteLength(JSON.stringify(data.stats)));
			expect(data.intentAgreementBytes).toBe(Buffer.byteLength(JSON.stringify(data.intentAgreement)));
			expect(data.statsBytes).toBeLessThanOrEqual(256 * 1024);
			expect(data.intentAgreementBytes).toBeLessThanOrEqual(256 * 1024);
			expect(foreign.get(key).sampleCount).toBe(1);
			expect(foreign.get(key).bounceCount).toBe(1);
			expect(Object.keys(data.stats).length).toBeGreaterThan(1);
		} finally {
			foreign.close();
		}
	});

	it("retains all normal records below the byte and count limits", () => {
		const { store } = fixture(true);
		for (let index = 0; index < 20; index++)
			store.recordExecution({ key: { ...key, tool: `read_${index}` }, success: true, latencyMs: 1, selection });
		store.flush();
		expect(store.getStatsForModel(key.modelRef)).toHaveLength(20);
		expect(store.getIntentAgreement(key.modelRef, key.intentClass).sampleCount).toBe(20);
	});

	it("avoids a second key enumeration just to detect a nonempty aggregate map", () => {
		const { store } = fixture(true);
		store.recordExecution({ key, success: true, latencyMs: 1, selection });
		const keys = vi.spyOn(Object, "keys");
		let enumerated: object[];
		try {
			store.recordExecution({ key: { ...key, tool: "read_next" }, success: true, latencyMs: 1, selection });
			enumerated = keys.mock.calls.map((call) => call[0]);
		} finally {
			keys.mockRestore();
		}
		expect(enumerated.filter((value) => Object.hasOwn(value, "faux/model\0read\0read"))).toHaveLength(0);
	});

	it("retains a recently updated bucket over newer insertions with older timestamps", () => {
		const { store } = fixture(true);
		const keys = Array.from({ length: 40 }, (_, index) => ({ ...key, modelRef: `${index}-${"x".repeat(5_000)}` }));
		for (let index = 0; index < 20; index++)
			store.recordExecution({
				key: keys[index],
				success: true,
				latencyMs: 1,
				selection,
				at: new Date(index * 1_000).toISOString(),
			});
		store.recordExecution({
			key: keys[0],
			success: true,
			latencyMs: 1,
			selection,
			at: new Date(100_000).toISOString(),
		});
		for (let index = 20; index < 40; index++)
			store.recordExecution({
				key: keys[index],
				success: true,
				latencyMs: 1,
				selection,
				at: new Date(index * 1_000).toISOString(),
			});
		store.flush();
		expect(store.get(keys[0]).sampleCount).toBe(2);
		expect(store.getIntentAgreement(keys[0].modelRef, "read").sampleCount).toBe(2);
		expect(store.get(keys[1]).sampleCount).toBe(0);
		expect(store.getIntentAgreement(keys[1].modelRef, "read").sampleCount).toBe(0);
	});

	it("keeps exact byte counters through deterministic mixed updates and repeated eviction", () => {
		const { store, path } = fixture(true);
		for (let index = 0; index < 180; index++) {
			const current = { ...key, modelRef: `${index % 17}-${'界\\"'.repeat(1_200)}`, tool: `read_${index % 7}` };
			if (index % 7 === 0) store.recordValidation(current, "repaired");
			else store.recordExecution({ key: current, success: index % 3 !== 0, latencyMs: index, selection });
			if (index % 23 !== 0 && index !== 179) continue;
			store.flush();
			const data = maps(path);
			expect(data.statsBytes).toBe(Buffer.byteLength(JSON.stringify(data.stats)));
			expect(data.intentAgreementBytes).toBe(Buffer.byteLength(JSON.stringify(data.intentAgreement)));
			expect(data.statsBytes).toBeLessThanOrEqual(256 * 1024);
			expect(data.intentAgreementBytes).toBeLessThanOrEqual(256 * 1024);
			expect(Object.keys(data.stats).length).toBeLessThanOrEqual(500);
			expect(Object.keys(data.intentAgreement).length).toBeLessThanOrEqual(500);
		}
	});

	it.each(["get", "model", "intent", "agreement", "agreements", "execution-result", "validation-result"] as const)(
		"isolates unrecognized mutable payloads returned by %s",
		(method) => {
			const field = method === "agreement" || method === "agreements" ? "intentAgreement" : "stats";
			const { path, store } = fixture(true);
			store.recordExecution({ key, success: true, latencyMs: 1, selection });
			store.flush();
			const file = JSON.parse(readFileSync(path, "utf8")) as { hosts: { fixture: StoredHost } };
			Object.values(file.hosts.fixture[field])[0].extra = { payload: "small" };
			writeFileSync(path, JSON.stringify(file));
			const executionResult = store.recordExecution({ key, success: true, latencyMs: 1, selection });
			const outputs = {
				get: () => store.get(key),
				model: () => store.getStatsForModel(key.modelRef)[0],
				intent: () => store.getStatsForIntent(key.modelRef, "read")[0],
				agreement: () => store.getIntentAgreement(key.modelRef, "read"),
				agreements: () => store.getAllIntentAgreements()[0],
				"execution-result": () => executionResult,
				"validation-result": () => store.recordValidation(key, "repaired"),
			};
			const snapshot = outputs[method]() as unknown as { extra: { payload: string } };
			expect(snapshot.extra.payload).toBe("small");
			snapshot.extra.payload = "x".repeat(300_000);
			store.recordValidation(key, "repaired");
			store.flush();
			const data = maps(path);
			expect(Buffer.byteLength(JSON.stringify(data[field]))).toBeLessThanOrEqual(256 * 1024);
			expect(field === "stats" ? data.statsBytes : data.intentAgreementBytes).toBe(
				Buffer.byteLength(JSON.stringify(data[field])),
			);
			expect(store.get(key).sampleCount).toBe(2);
			expect(store.getIntentAgreement(key.modelRef, "read").sampleCount).toBe(2);
			expect(Object.values(data[field])[0].extra).toEqual({ payload: "small" });
		},
	);
});
