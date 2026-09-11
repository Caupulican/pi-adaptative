import { describe, expect, it } from "vitest";
import {
	releaseExclusiveHold,
	withExclusiveMutationBarrier,
	withFileMutationQueue,
} from "../src/core/tools/file-mutation-queue.ts";

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("condition was not reached");
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("mutation barrier", () => {
	it("exclusive waits for in-flight file mutations and blocks new ones until done", async () => {
		const order: string[] = [];
		const fileGate = deferred();
		const filing = withFileMutationQueue("/tmp/a.txt", async () => {
			order.push("file-start");
			await fileGate.promise;
			order.push("file-end");
		});
		await waitUntil(() => order.includes("file-start"));
		const exclusive = withExclusiveMutationBarrier(async () => {
			order.push("bash");
		});
		await waitUntil(() => order.includes("file-start") && !order.includes("bash"));
		fileGate.resolve();
		await Promise.all([filing, exclusive]);
		expect(order).toEqual(["file-start", "file-end", "bash"]);
	});

	it("file mutations queued during exclusive run only after it finishes", async () => {
		const order: string[] = [];
		const bashGate = deferred();
		const exclusive = withExclusiveMutationBarrier(async () => {
			order.push("bash-start");
			await bashGate.promise;
			order.push("bash-end");
		});
		await waitUntil(() => order.includes("bash-start"));
		const filing = withFileMutationQueue("/tmp/b.txt", async () => {
			order.push("file");
		});
		await waitUntil(() => order.includes("bash-start") && !order.includes("file"));
		bashGate.resolve();
		await Promise.all([exclusive, filing]);
		expect(order).toEqual(["bash-start", "bash-end", "file"]);
	});

	it("different files still run in parallel (no over-serialization)", async () => {
		const order: string[] = [];
		const g1 = deferred();
		const p1 = withFileMutationQueue("/tmp/c1.txt", async () => {
			order.push("c1-start");
			await g1.promise;
			order.push("c1-end");
		});
		await waitUntil(() => order.includes("c1-start"));
		const p2 = withFileMutationQueue("/tmp/c2.txt", async () => {
			order.push("c2");
		});
		await waitUntil(() => order.includes("c2"));
		expect(order).toContain("c2"); // c2 ran while c1 was still holding its file lock
		g1.resolve();
		await Promise.all([p1, p2]);
	});
});

describe("exclusive barrier cancellation and early release", () => {
	it("abort while queued behind an exclusive run rejects immediately with the signal reason and releases the queue position", async () => {
		const order: string[] = [];
		const holder = deferred();
		const first = withExclusiveMutationBarrier(async () => {
			order.push("first-start");
			await holder.promise;
			order.push("first-end");
		});
		await waitUntil(() => order.includes("first-start"));

		const controller = new AbortController();
		let queuedRan = false;
		const queued = withExclusiveMutationBarrier(
			async () => {
				queuedRan = true;
			},
			{ signal: controller.signal },
		);
		const successor = withExclusiveMutationBarrier(async () => {
			order.push("successor");
		});

		controller.abort("operator stopped the turn");
		// Immediately: the queued run does not wait for the predecessor it was parked behind.
		await expect(queued).rejects.toBe("operator stopped the turn");
		expect(queuedRan).toBe(false);
		expect(order).toEqual(["first-start"]);

		holder.resolve();
		await Promise.all([first, successor]);
		expect(order).toEqual(["first-start", "first-end", "successor"]);
	});

	it("releaseExclusiveHold releases the writer lock while fn is still running so a queued file mutation proceeds", async () => {
		const started = deferred();
		const running = deferred();
		let commandSettled = false;
		const held = withExclusiveMutationBarrier(
			async () => {
				started.resolve();
				await running.promise;
			},
			{ holdId: "hold-running" },
		).then(() => {
			commandSettled = true;
		});
		await started.promise;

		let mutated = false;
		const mutation = withFileMutationQueue("/tmp/hold-running.txt", async () => {
			mutated = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(mutated).toBe(false);

		expect(releaseExclusiveHold("hold-running")).toBe(true);
		await mutation;
		expect(mutated).toBe(true);
		// The command itself is still running: the barrier was released, not the work.
		expect(commandSettled).toBe(false);
		expect(releaseExclusiveHold("hold-running")).toBe(false);

		running.resolve();
		await held;
		expect(commandSettled).toBe(true);
	});

	it("releaseExclusiveHold on a still-queued hold makes it run without taking the lock", async () => {
		const holder = deferred();
		const first = withExclusiveMutationBarrier(async () => {
			await holder.promise;
		});
		let secondRunning = false;
		const secondGate = deferred();
		const second = withExclusiveMutationBarrier(
			async () => {
				secondRunning = true;
				await secondGate.promise;
			},
			{ holdId: "hold-queued" },
		);
		expect(releaseExclusiveHold("hold-queued")).toBe(true);
		expect(releaseExclusiveHold("hold-queued")).toBe(false);

		holder.resolve();
		await first;
		await waitUntil(() => secondRunning);

		let mutated = false;
		await withFileMutationQueue("/tmp/hold-queued.txt", async () => {
			mutated = true;
		});
		expect(mutated).toBe(true);

		secondGate.resolve();
		await second;
	});

	it("a signal already aborted at entry rejects without queueing", async () => {
		const controller = new AbortController();
		controller.abort("already gone");
		let ran = false;
		await expect(
			withExclusiveMutationBarrier(
				async () => {
					ran = true;
				},
				{ signal: controller.signal },
			),
		).rejects.toBe("already gone");
		expect(ran).toBe(false);
		expect(releaseExclusiveHold("unknown-hold")).toBe(false);

		// Nothing was queued, so the next exclusive run starts at once.
		let next = false;
		await withExclusiveMutationBarrier(async () => {
			next = true;
		});
		expect(next).toBe(true);
	});
});
