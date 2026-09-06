import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";

describe("backend-scoped mutation queues", () => {
	it("does not let stalled resource resolution block an unrelated backend", async () => {
		const key = Promise.withResolvers<string>();
		const events: string[] = [];
		const blocked = withFileMutationQueue(
			"fixture-resource",
			async () => {
				events.push("blocked");
			},
			{ resolveKey: () => key.promise },
		);
		const independent = withFileMutationQueue(
			"fixture-resource",
			async () => {
				events.push("independent");
			},
			{ resolveKey: async () => "same-spelling" },
		);
		try {
			await setImmediate();
			expect([...events]).toEqual(["independent"]);
		} finally {
			key.resolve("same-spelling");
			await Promise.all([blocked, independent]);
		}
	});

	it("serializes distinct aliases by the backend identity across callers", async () => {
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const backend = { resolveKey: async () => "canonical-file" };
		const events: string[] = [];
		const first = withFileMutationQueue(
			"alias-one",
			async () => {
				events.push("first-start");
				entered.resolve();
				await release.promise;
				events.push("first-end");
			},
			backend,
		);
		await entered.promise;
		const second = withFileMutationQueue(
			"alias-two",
			async () => {
				events.push("second");
			},
			backend,
		);
		try {
			await setImmediate();
			expect(events).toEqual(["first-start"]);
		} finally {
			release.resolve();
			await Promise.all([first, second]);
		}
		expect(events).toEqual(["first-start", "first-end", "second"]);
	});

	it("keeps the same spelling independent on different backends", async () => {
		const release = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		const first = withFileMutationQueue(
			"same-file",
			async () => {
				firstEntered.resolve();
				await release.promise;
			},
			{ resolveKey: async (path) => path },
		);
		await firstEntered.promise;
		let ran = false;
		const second = withFileMutationQueue(
			"same-file",
			async () => {
				ran = true;
			},
			{ resolveKey: async (path) => path },
		);
		try {
			await setImmediate();
			expect(ran).toBe(true);
		} finally {
			release.resolve();
			await Promise.all([first, second]);
		}
	});

	it("preserves resolution errors, skips the body, and admits a later call", async () => {
		const error = new Error("synthetic backend unavailable");
		let attempts = 0;
		const backend = {
			resolveKey: async () => {
				if (++attempts === 1) throw error;
				return "fixture-key";
			},
		};
		let calls = 0;
		await expect(
			withFileMutationQueue(
				"file",
				async () => {
					calls++;
				},
				backend,
			),
		).rejects.toBe(error);
		expect(calls).toBe(0);
		await withFileMutationQueue(
			"file",
			async () => {
				calls++;
			},
			backend,
		);
		expect(calls).toBe(1);
	});
});
