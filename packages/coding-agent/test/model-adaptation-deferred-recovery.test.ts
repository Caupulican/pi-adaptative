import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import { nodeFs } from "../src/core/util/faultable-fs.ts";

const dirs: string[] = [];
const stores: ModelAdaptationStore[] = [];
const fingerprint = () => ({ id: "fixture", cpu: "fixture", cores: 1, totalMemGb: 1 });
const at = "2026-09-17T00:00:00.000Z";
const sample = { promptTokens: 1_000, completionTokens: 100, headersToFirstTokenMs: 2_000, firstTokenToDoneMs: 1_000 };

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	syncBuiltinESMExports();
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-adaptation-recovery-"));
	dirs.push(dir);
	const path = join(dir, "adaptation.json");
	const store = new ModelAdaptationStore(path, { fingerprint, readOnly: false, deferPerfSamples: true });
	stores.push(store);
	const read = (model = "model") => new ModelAdaptationStore(path, { fingerprint, readOnly: true }).get(model);
	return { store, read, path };
}

describe("deferred model performance recovery", () => {
	it.each(["EACCES", "EIO"])("retains queued samples and foreign state after %s reads", (code) => {
		const { store, read, path } = fixture();
		store.recordPerfSample("model", { loadMs: 100 }, at);
		store.flush();
		store.recordPerfSample("model", { loadMs: 200 }, at);
		const before = fs.readFileSync(path, "utf8");
		const originalRead = fs.readFileSync;
		const failedRead = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
			if (file === path) throw Object.assign(new Error("fixture inaccessible adaptation"), { code });
			return originalRead(file, options);
		});
		syncBuiltinESMExports();
		const writes = vi.spyOn(nodeFs, "renameSync");
		try {
			expect(() => store.flush()).toThrow("fixture inaccessible adaptation");
			expect(writes).not.toHaveBeenCalled();
		} finally {
			failedRead.mockRestore();
			syncBuiltinESMExports();
		}
		expect(fs.readFileSync(path, "utf8")).toBe(before);
		const foreign = new ModelAdaptationStore(path, { fingerprint, readOnly: false });
		stores.push(foreign);
		foreign.recordPerfSample("model", { loadMs: 300 }, at);
		foreign.recordPerfSample("foreign", { loadMs: 999 }, at);
		writes.mockClear();
		store.flush();
		expect(writes).toHaveBeenCalledTimes(1);
		// The durable order is seed 100, foreign 300, then the recovered pending 200.
		expect(read().perf).toEqual({ samples: 3, updatedAt: at, loadMs: 172 });
		expect(read("foreign").perf).toEqual({ samples: 1, updatedAt: at, loadMs: 999 });
		store.flush();
		expect(writes).toHaveBeenCalledTimes(1);
		expect(read().perf?.samples).toBe(3);
	});

	it.each([false, true])("retains a batch until flush succeeds; injected failure: %s", (fail) => {
		const { store, read } = fixture();
		store.recordPerfSample("model", sample, at);
		store.recordPerfSample("model", sample, at);
		if (fail) {
			vi.spyOn(nodeFs, "renameSync").mockImplementationOnce(() => {
				throw new Error("fixture disk failure");
			});
			expect(() => store.flush()).toThrow("fixture disk failure");
			expect(read().perf).toBeUndefined();
		}
		store.flush();
		expect(read().perf?.samples).toBe(2);
		store.flush();
		expect(read().perf?.samples).toBe(2);
	});

	it("retries only uncommitted models after a partial multi-model flush", () => {
		const { store, read } = fixture();
		for (const model of ["a", "b", "c"]) store.recordPerfSample(model, sample, at);
		const rename = nodeFs.renameSync;
		let writes = 0;
		vi.spyOn(nodeFs, "renameSync").mockImplementation((from, to) => {
			if (++writes === 2) throw new Error("fixture second model failure");
			rename(from, to);
		});
		expect(() => store.flush()).toThrow("fixture second model failure");
		expect(read("a").perf?.samples).toBe(1);
		expect(read("b").perf).toBeUndefined();
		store.flush();
		for (const model of ["a", "b", "c"]) expect(read(model).perf?.samples).toBe(1);
		expect(writes).toBe(4);
	});

	it.each([false, true])("folds samples with a following probe transaction; injected failure: %s", (fail) => {
		const { store, read } = fixture();
		store.recordPerfSample("model", sample, at);
		store.recordPerfSample("model", sample, at);
		const probe = { version: 1, status: "native" as const, probedAt: at };
		const writes = vi.spyOn(nodeFs, "renameSync");
		if (fail) {
			writes.mockImplementationOnce(() => {
				throw new Error("fixture transaction failure");
			});
			expect(() => store.setToolProbe("model", probe)).toThrow("fixture transaction failure");
			expect(read()).toEqual({ rules: [], teachStats: {} });
		}
		writes.mockClear();
		store.setToolProbe("model", probe);
		expect(read().perf?.samples).toBe(2);
		expect(read().toolProbe).toEqual(probe);
		expect(writes).toHaveBeenCalledTimes(1);
		store.flush();
		expect(read().perf?.samples).toBe(2);
	});

	it("stops admission at the failed 16-sample cap and resumes without losing accepted samples", () => {
		const { store, read } = fixture();
		const writes = vi.spyOn(nodeFs, "renameSync").mockImplementation(() => {
			throw new Error("fixture full disk");
		});
		for (let i = 0; i < 15; i++) store.recordPerfSample("model", sample, at);
		expect(() => store.recordPerfSample("model", sample, at)).toThrow("fixture full disk");
		for (let i = 0; i < 10; i++) {
			expect(() => store.recordPerfSample("model", sample, at)).toThrow("fixture full disk");
		}
		writes.mockRestore();
		store.flush();
		expect(read().perf?.samples).toBe(16);
		store.recordPerfSample("model", sample, at);
		store.flush();
		expect(read().perf?.samples).toBe(17);
	});

	it("keeps a failed close recoverable and orders later observations after retained samples", () => {
		const { store, read } = fixture();
		store.recordPerfSample("model", sample, at);
		vi.spyOn(nodeFs, "renameSync").mockImplementationOnce(() => {
			throw new Error("fixture close failure");
		});
		expect(() => store.close()).toThrow("fixture close failure");
		store.recordPerfSample("model", sample, at);
		store.close();
		expect(read().perf?.samples).toBe(2);
	});

	it("does not replay older observations after an explicit profile replacement", () => {
		const { store, read } = fixture();
		store.recordPerfSample("model", sample, at);
		const replacement = { rules: [], teachStats: {}, perf: { samples: 99, updatedAt: at, loadMs: 1 } };
		store.save("model", replacement, at);
		store.flush();
		expect(read()).toEqual(replacement);
	});

	it("captures the sample value at admission rather than a caller's later mutations", () => {
		const { store, read } = fixture();
		const input = { ...sample };
		store.recordPerfSample("model", input, at);
		input.headersToFirstTokenMs = 10_000;
		store.flush();
		expect(read().perf?.prefillTokensPerSecond).toBe(500);
	});

	for (const stage of ["mkdir", "write", "rename"] as const) {
		it.each([1, 2, 3])(`recovers ${stage} failure on model %s with an intervening writer`, (failedModel) => {
			const { store, read, path } = fixture();
			const models = ["a", "b", "c"];
			for (const model of models) {
				store.recordPerfSample(model, sample, at);
				store.recordPerfSample(model, sample, at);
			}
			let calls = 0;
			const mkdir = nodeFs.mkdirSync;
			const write = nodeFs.writeFileSync;
			const rename = nodeFs.renameSync;
			if (stage === "mkdir") {
				vi.spyOn(nodeFs, "mkdirSync").mockImplementation((dir, options) => {
					if (++calls === failedModel) throw new Error("fixture mkdir failure");
					mkdir(dir, options);
				});
			} else if (stage === "write") {
				vi.spyOn(nodeFs, "writeFileSync").mockImplementation((file, data, options) => {
					if (++calls === failedModel) {
						write(file, data.slice(0, Math.floor(data.length / 2)), options);
						throw new Error("fixture write failure");
					}
					write(file, data, options);
				});
			} else {
				vi.spyOn(nodeFs, "renameSync").mockImplementation((from, to) => {
					if (++calls === failedModel) throw new Error("fixture rename failure");
					rename(from, to);
				});
			}
			expect(() => store.flush()).toThrow(`fixture ${stage} failure`);
			for (const [index, model] of models.entries()) {
				expect(read(model).perf?.samples ?? 0).toBe(index < failedModel - 1 ? 2 : 0);
			}
			vi.restoreAllMocks();
			const foreign = new ModelAdaptationStore(path, { fingerprint, readOnly: false });
			stores.push(foreign);
			for (const model of models) foreign.recordPerfSample(model, sample, at);
			store.flush();
			for (const model of models) expect(read(model).perf?.samples).toBe(3);
			store.flush();
			for (const model of models) expect(read(model).perf?.samples).toBe(3);
		});
	}

	it("retains samples when explicit replacement fails, then consumes them on successful replacement", () => {
		const { store, read } = fixture();
		store.recordPerfSample("model", sample, at);
		const replacement = { rules: [], teachStats: {}, perf: { samples: 99, updatedAt: at, loadMs: 1 } };
		vi.spyOn(nodeFs, "renameSync").mockImplementationOnce(() => {
			throw new Error("fixture replacement failure");
		});
		expect(() => store.save("model", replacement, at)).toThrow("fixture replacement failure");
		expect(read().perf).toBeUndefined();
		store.flush();
		expect(read().perf?.samples).toBe(1);
		store.recordPerfSample("model", sample, at);
		store.save("model", replacement, at);
		store.flush();
		expect(read()).toEqual(replacement);
	});

	it.each([1, 2, 3])("preserves distinct observation order around failed model %s", (failedModel) => {
		const { store, read, path } = fixture();
		const models = ["a", "b", "c"];
		for (const model of models) {
			store.recordPerfSample(model, { loadMs: 100 }, at);
			store.recordPerfSample(model, { loadMs: 200 }, at);
		}
		const rename = nodeFs.renameSync;
		let writes = 0;
		const failure = vi.spyOn(nodeFs, "renameSync").mockImplementation((from, to) => {
			if (++writes === failedModel) throw new Error("fixture ordered batch failure");
			rename(from, to);
		});
		expect(() => store.flush()).toThrow("fixture ordered batch failure");
		failure.mockRestore();
		const foreign = new ModelAdaptationStore(path, { fingerprint, readOnly: false });
		stores.push(foreign);
		for (const model of models) foreign.recordPerfSample(model, { loadMs: 300 }, at);
		store.flush();
		for (const [index, model] of models.entries()) {
			// EWMA alpha is 0.3: committed 100→200→300 is 181; foreign 300→100→200 is 228.
			expect(read(model).perf).toEqual({
				samples: 3,
				updatedAt: at,
				loadMs: index < failedModel - 1 ? 181 : 228,
			});
		}
	});

	it("does not retain rejected identities when the pending cap spans sixteen models", () => {
		const { store, read } = fixture();
		const failure = vi.spyOn(nodeFs, "renameSync").mockImplementation(() => {
			throw new Error("fixture blocked cap");
		});
		for (let i = 0; i < 15; i++) store.recordPerfSample(`accepted-${i}`, { loadMs: 100 }, at);
		expect(() => store.recordPerfSample("accepted-15", { loadMs: 100 }, at)).toThrow("fixture blocked cap");
		for (let i = 0; i < 10; i++) {
			expect(() => store.recordPerfSample(`rejected-${i}`, { loadMs: 999 }, at)).toThrow("fixture blocked cap");
		}
		failure.mockRestore();
		store.flush();
		for (let i = 0; i < 16; i++) expect(read(`accepted-${i}`).perf?.loadMs).toBe(100);
		for (let i = 0; i < 10; i++) expect(read(`rejected-${i}`).perf).toBeUndefined();
		expect(store.getForHost()).toHaveLength(16);
	});

	it("performs no persistence for an empty or already committed queue", () => {
		const { store, read } = fixture();
		const writes = vi.spyOn(nodeFs, "renameSync");
		store.flush();
		expect(writes).not.toHaveBeenCalled();
		store.recordPerfSample("model", { loadMs: 100 }, at);
		store.recordPerfSample("model", { loadMs: 200 }, at);
		store.flush();
		expect(writes).toHaveBeenCalledTimes(1);
		store.flush();
		store.close();
		expect(writes).toHaveBeenCalledTimes(1);
		expect(read().perf?.loadMs).toBe(130);
	});

	it.each(Array.from({ length: 16 }, (_, index) => index + 1))(
		"recovers cap accounting after failure at commit %s of sixteen models",
		(failedCommit) => {
			const { store, read } = fixture();
			const rename = nodeFs.renameSync;
			let commits = 0;
			const failure = vi.spyOn(nodeFs, "renameSync").mockImplementation((from, to) => {
				if (++commits >= failedCommit) throw new Error("fixture cap failure");
				rename(from, to);
			});
			for (let i = 0; i < 15; i++) store.recordPerfSample(`model-${i}`, { loadMs: i + 1 }, at);
			expect(() => store.recordPerfSample("model-15", { loadMs: 16 }, at)).toThrow("fixture cap failure");
			// Successful models free capacity; fill exactly those slots, then force another failed cap flush.
			for (let i = 0; i < failedCommit - 2; i++) store.recordPerfSample(`later-${i}`, { loadMs: 100 }, at);
			if (failedCommit > 1) {
				expect(() => store.recordPerfSample(`later-${failedCommit - 2}`, { loadMs: 100 }, at)).toThrow(
					"fixture cap failure",
				);
			}
			expect(() => store.recordPerfSample("rejected", { loadMs: 999 }, at)).toThrow("fixture cap failure");
			failure.mockRestore();
			store.flush();
			for (let i = 0; i < 16; i++)
				expect(read(`model-${i}`).perf).toEqual({ samples: 1, loadMs: i + 1, updatedAt: at });
			for (let i = 0; i < failedCommit - 1; i++) expect(read(`later-${i}`).perf?.samples).toBe(1);
			expect(read("rejected").perf).toBeUndefined();
			expect(store.getForHost()).toHaveLength(16 + failedCommit - 1);
		},
	);

	it("replacement retires only its own older samples and retains later observations", () => {
		const { store, read } = fixture();
		store.recordPerfSample("replaced", { loadMs: 100 }, at);
		store.recordPerfSample("other", { loadMs: 200 }, at);
		store.save("replaced", { rules: [], teachStats: {}, perf: { samples: 99, loadMs: 300, updatedAt: at } }, at);
		expect(read("replaced").perf).toEqual({ samples: 99, loadMs: 300, updatedAt: at });
		expect(read("other").perf).toBeUndefined();
		store.recordPerfSample("replaced", { loadMs: 400 }, at);
		store.flush();
		expect(read("replaced").perf).toEqual({ samples: 100, loadMs: 330, updatedAt: at });
		expect(read("other").perf).toEqual({ samples: 1, loadMs: 200, updatedAt: at });
		store.flush();
		expect(read("replaced").perf?.samples).toBe(100);
	});

	it("keeps the admission cap after idle-flush and close failures", () => {
		vi.useFakeTimers();
		const { store, read } = fixture();
		const failure = vi.spyOn(nodeFs, "renameSync").mockImplementation(() => {
			throw new Error("fixture ongoing outage");
		});
		store.recordPerfSample("model", { loadMs: 100 }, at);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(2_000);
		expect(failure).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		for (let i = 0; i < 14; i++) store.recordPerfSample("model", { loadMs: 100 }, at);
		expect(() => store.recordPerfSample("model", { loadMs: 100 }, at)).toThrow("fixture ongoing outage");
		expect(() => store.close()).toThrow("fixture ongoing outage");
		for (let i = 0; i < 100; i++) {
			expect(() => store.recordPerfSample(`rejected-${i}`, { loadMs: 999 }, at)).toThrow("fixture ongoing outage");
		}
		expect(vi.getTimerCount()).toBe(0);
		failure.mockRestore();
		store.close();
		expect(read().perf).toEqual({ samples: 16, updatedAt: at, loadMs: 100 });
		expect(store.getForHost()).toHaveLength(1);
		store.recordPerfSample("after-close", { loadMs: 200 }, at);
		expect(read("after-close").perf?.samples).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
