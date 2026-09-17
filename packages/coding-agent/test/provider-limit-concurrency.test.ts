import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { ProviderLimitStore } from "../src/core/provider-admission/limit-state.ts";
import type { LimitContenderInput } from "./fixtures/provider-limit-contender.ts";

function contender(input: LimitContenderInput) {
	const worker = new Worker(new URL("./fixtures/provider-limit-contender.ts", import.meta.url), {
		workerData: input,
		execArgv: ["--conditions=pi-source"],
	});
	const ready = Promise.withResolvers<void>();
	const paused = Promise.withResolvers<void>();
	const decision = Promise.withResolvers<"contended" | "completed">();
	const completed = Promise.withResolvers<void>();
	let terminal = false;
	const fail = (error: Error) => {
		ready.reject(error);
		paused.reject(error);
		decision.reject(error);
		completed.reject(error);
	};
	for (const pending of [ready.promise, paused.promise, decision.promise, completed.promise]) {
		void pending.catch(() => {});
	}
	worker.on("message", (message: unknown) => {
		if (message === "ready") ready.resolve();
		else if (message === "paused-after-read") paused.resolve();
		else if (message === "contended") decision.resolve("contended");
		else if (message === "completed") {
			terminal = true;
			decision.resolve("completed");
		} else fail(new Error(`Unexpected limit contender message: ${JSON.stringify(message)}`));
	});
	worker.once("error", fail);
	worker.once("exit", (code) => {
		if (code === 0 && terminal) completed.resolve();
		else fail(new Error(`Limit contender exited ${code} without successful terminal evidence`));
	});
	return {
		worker,
		ready: ready.promise,
		paused: paused.promise,
		decision: decision.promise,
		completed: completed.promise,
	};
}

describe("provider cooldown serialization", () => {
	it.each(["record", "clear", "read", "list"] as const)(
		"%s cannot overwrite or remove a sibling's later limit after reading older state",
		async (operation) => {
			const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-limit-race-")));
			const barrier = new SharedArrayBuffer(4);
			const workers: Worker[] = [];
			try {
				new ProviderLimitStore(dir, { now: () => 0 }).record("anthropic", {
					limitedUntil: operation === "read" || operation === "list" ? 1_000 : 2_000,
					reason: "rate_limit",
				});
				const first = contender({
					agentDir: dir,
					provider: "anthropic",
					operation,
					limitedUntil: 4_000,
					now: 1_000,
					pauseAtClockRead: operation === "record" ? 2 : 1,
					barrier,
				});
				workers.push(first.worker);
				const sibling = contender({
					agentDir: dir,
					provider: "anthropic",
					operation: "record",
					limitedUntil: 9_000,
					now: 1_001,
					barrier,
				});
				workers.push(sibling.worker);
				await Promise.all([first.ready, sibling.ready]);
				first.worker.postMessage("start");
				await first.paused;
				sibling.worker.postMessage("start");
				// Before repair the sibling commits; with serialization it encounters the held lock.
				// Release on either observed event, never on an elapsed-time assumption.
				await sibling.decision;
				Atomics.store(new Int32Array(barrier), 0, 1);
				Atomics.notify(new Int32Array(barrier), 0);
				await Promise.all([first.completed, sibling.completed]);
				expect(new ProviderLimitStore(dir, { now: () => 1_001 }).read("anthropic")).toMatchObject({
					limitedUntil: 9_000,
					reason: "usage_window",
				});
			} finally {
				Atomics.store(new Int32Array(barrier), 0, 1);
				Atomics.notify(new Int32Array(barrier), 0);
				await Promise.all(workers.map((worker) => worker.terminate()));
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("preserves a longer existing reset and respects reason-scoped clear without contention", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-limit-control-"));
		try {
			const store = new ProviderLimitStore(dir, { now: () => 1_000 });
			store.record("anthropic", { limitedUntil: 9_000, reason: "usage_window" });
			store.record("anthropic", { limitedUntil: 4_000, reason: "rate_limit" });
			expect(store.clear("anthropic", ["rate_limit"])).toBe(false);
			expect(store.read("anthropic")?.limitedUntil).toBe(9_000);
			expect(store.clear("anthropic", ["usage_window"])).toBe(true);
			expect(store.read("anthropic")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("releases the path lock when the protected read throws", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-limit-unwind-"));
		try {
			const healthy = new ProviderLimitStore(dir, { now: () => 1_000 });
			healthy.record("anthropic", { limitedUntil: 2_000, reason: "rate_limit" });
			const failure = new Error("clock failed during protected read");
			let reads = 0;
			const failing = new ProviderLimitStore(dir, {
				now: () => {
					if (++reads === 2) throw failure;
					return 1_000;
				},
			});
			expect(() => failing.record("anthropic", { limitedUntil: 4_000, reason: "rate_limit" })).toThrow(failure);
			expect(healthy.read("anthropic")?.limitedUntil).toBe(2_000);
			healthy.record("anthropic", { limitedUntil: 9_000, reason: "rate_limit" });
			expect(healthy.read("anthropic")?.limitedUntil).toBe(9_000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not hold an unrelated account behind a paused cooldown update", async () => {
		const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-limit-account-")));
		const barrier = new SharedArrayBuffer(4);
		const workers: Worker[] = [];
		try {
			new ProviderLimitStore(dir, { now: () => 0 }).record("anthropic#first", {
				limitedUntil: 2_000,
				reason: "rate_limit",
			});
			const first = contender({
				agentDir: dir,
				provider: "anthropic#first",
				operation: "record",
				limitedUntil: 4_000,
				now: 1_000,
				pauseAtClockRead: 2,
				barrier,
			});
			workers.push(first.worker);
			const sibling = contender({
				agentDir: dir,
				provider: "anthropic#second",
				operation: "record",
				limitedUntil: 9_000,
				now: 1_000,
				barrier,
			});
			workers.push(sibling.worker);
			await Promise.all([first.ready, sibling.ready]);
			first.worker.postMessage("start");
			await first.paused;
			sibling.worker.postMessage("start");
			expect(await sibling.decision).toBe("completed");
			await sibling.completed;
			Atomics.store(new Int32Array(barrier), 0, 1);
			Atomics.notify(new Int32Array(barrier), 0);
			await first.completed;
			const store = new ProviderLimitStore(dir, { now: () => 1_000 });
			expect(store.read("anthropic#first")?.limitedUntil).toBe(4_000);
			expect(store.read("anthropic#second")?.limitedUntil).toBe(9_000);
		} finally {
			Atomics.store(new Int32Array(barrier), 0, 1);
			Atomics.notify(new Int32Array(barrier), 0);
			await Promise.all(workers.map((worker) => worker.terminate()));
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
