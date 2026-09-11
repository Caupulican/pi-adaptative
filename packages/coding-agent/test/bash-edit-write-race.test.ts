import { describe, expect, it } from "vitest";
import {
	announceToolCall,
	releaseExclusiveHold,
	retireToolCall,
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

	it("a run released while still queued waits for active readers to drain before running", async () => {
		const order: string[] = [];
		const mutationGate = deferred();
		const mutation = withFileMutationQueue("/tmp/lockless-drain.txt", async () => {
			order.push("write-start");
			await mutationGate.promise;
			order.push("write-end");
		});
		await waitUntil(() => order.includes("write-start"));

		// Reaches the head of the queue, takes the writer lock, and waits for the reader side to empty.
		const locked = withExclusiveMutationBarrier(
			async () => {
				order.push("locked");
			},
			{ holdId: "drain-locked" },
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(order).toEqual(["write-start"]);

		// Queued behind it, then handed off: it drops exclusivity, not the write it arrived after.
		const lockless = withExclusiveMutationBarrier(
			async () => {
				order.push("lockless");
			},
			{ holdId: "drain-lockless" },
		);
		expect(releaseExclusiveHold("drain-lockless")).toBe(true);
		// The lock goes away while the write is still in flight: without a drain wait of its own the
		// released run would start mid-write, which is exactly what the barrier exists to prevent.
		expect(releaseExclusiveHold("drain-locked")).toBe(true);
		let duringWrite: string[];
		try {
			await new Promise((resolve) => setTimeout(resolve, 10));
		} finally {
			// The barrier is process-global: a failed expectation must never leave a write in flight.
			duringWrite = [...order];
			mutationGate.resolve();
			await Promise.all([mutation, locked, lockless]);
		}
		expect(duringWrite).toEqual(["write-start"]);
		expect(order.slice(0, 2)).toEqual(["write-start", "write-end"]);
		expect(order.slice(2).sort()).toEqual(["locked", "lockless"]);
	});

	it("several exclusive runs waiting on the same reader drain all proceed once readers reach zero", async () => {
		const order: string[] = [];
		const mutationGate = deferred();
		const mutation = withFileMutationQueue("/tmp/multi-drain.txt", async () => {
			order.push("write-start");
			await mutationGate.promise;
			await new Promise((resolve) => setTimeout(resolve, 5));
			order.push("write-end");
		});
		await waitUntil(() => order.includes("write-start"));

		const runs: Promise<void>[] = [
			withExclusiveMutationBarrier(
				async () => {
					order.push("multi-locked");
				},
				{ holdId: "multi-locked" },
			),
		];
		await new Promise((resolve) => setTimeout(resolve, 5));
		for (const name of ["multi-a", "multi-b"]) {
			runs.push(
				withExclusiveMutationBarrier(
					async () => {
						order.push(name);
					},
					{ holdId: name },
				),
			);
			expect(releaseExclusiveHold(name)).toBe(true);
		}
		expect(releaseExclusiveHold("multi-locked")).toBe(true);
		let duringWrite: string[];
		try {
			await new Promise((resolve) => setTimeout(resolve, 10));
		} finally {
			// One single-slot resolver cannot serve three waiters: every run waiting on this drain has
			// to be woken, not just the one that armed the slot last.
			duringWrite = [...order];
			mutationGate.resolve();
			await Promise.all([mutation, ...runs]);
		}
		expect(duringWrite).toEqual(["write-start"]);
		expect(order.slice(0, 2)).toEqual(["write-start", "write-end"]);
		expect(order.slice(2).sort()).toEqual(["multi-a", "multi-b", "multi-locked"]);
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

/**
 * Emission order inside one assistant message's tool batch. The host announces every reserved call
 * with its 0-based position before any body starts; a mutation announcement stays pending until its
 * tool actually joins the reader side, which happens only after that tool's own lease/credential
 * preflight. Without this an exclusive run dispatched in the same batch reached the writer lock
 * first, saw no reader, and ran against the pre-mutation workspace.
 */
describe("emission-order announcements", () => {
	it("an exclusive run announced after a pending mutation waits for that mutation to join and finish, even when the mutation joins late", async () => {
		const order: string[] = [];
		announceToolCall("write-call", 0, true, "batch-late-join");
		announceToolCall("bash-call", 1, false, "batch-late-join");

		const mutationGate = deferred();
		const exclusive = withExclusiveMutationBarrier(
			async () => {
				order.push("bash");
			},
			{ holdId: "bash-call" },
		);
		// The mutation has not reached the queue yet: this is the tool's preflight window, exactly
		// where the race used to be lost.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(order).toEqual([]);

		const mutation = withFileMutationQueue(
			"/tmp/emission-late-join.txt",
			async () => {
				order.push("write-start");
				await mutationGate.promise;
				order.push("write-end");
			},
			undefined,
			{ callId: "write-call" },
		);
		await waitUntil(() => order.includes("write-start"));
		expect(order).toEqual(["write-start"]);
		mutationGate.resolve();
		await Promise.all([mutation, exclusive]);
		expect(order).toEqual(["write-start", "write-end", "bash"]);
		retireToolCall("write-call");
		retireToolCall("bash-call");
	});

	it("an announced mutation that is retired without joining does not block the exclusive run", async () => {
		const order: string[] = [];
		announceToolCall("rejected-write", 0, true, "batch-retired");
		announceToolCall("bash-after-rejected", 1, false, "batch-retired");

		const exclusive = withExclusiveMutationBarrier(
			async () => {
				order.push("bash");
			},
			{ holdId: "bash-after-rejected" },
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(order).toEqual([]);

		// The write never reached the mutation queue: its own preflight rejected it. The terminal
		// retires the announcement, and the exclusive run must proceed instead of parking forever.
		retireToolCall("rejected-write");
		await exclusive;
		expect(order).toEqual(["bash"]);
		retireToolCall("bash-after-rejected");
	});

	it("an exclusive run announced BEFORE a mutation does not wait for it", async () => {
		const order: string[] = [];
		announceToolCall("bash-first", 0, false, "batch-bash-first");
		announceToolCall("write-second", 1, true, "batch-bash-first");

		const bashGate = deferred();
		const exclusive = withExclusiveMutationBarrier(
			async () => {
				order.push("bash-start");
				await bashGate.promise;
				order.push("bash-end");
			},
			{ holdId: "bash-first" },
		);
		await waitUntil(() => order.includes("bash-start"));

		const mutation = withFileMutationQueue(
			"/tmp/emission-bash-first.txt",
			async () => {
				order.push("write");
			},
			undefined,
			{ callId: "write-second" },
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(order).toEqual(["bash-start"]);
		bashGate.resolve();
		await Promise.all([exclusive, mutation]);
		expect(order).toEqual(["bash-start", "bash-end", "write"]);
		retireToolCall("bash-first");
		retireToolCall("write-second");
	});

	it("a new reservation wave retires whatever the previous one left pending", async () => {
		const order: string[] = [];
		// A wave that never retired its mutation: the turn died between reservation and execution.
		announceToolCall("abandoned-write", 0, true, "batch-abandoned");

		announceToolCall("next-write", 0, true, "batch-next");
		announceToolCall("next-bash", 1, false, "batch-next");
		const exclusive = withExclusiveMutationBarrier(
			async () => {
				order.push("bash");
			},
			{ holdId: "next-bash" },
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		// Still waiting for its OWN wave's mutation, not for the abandoned one.
		expect(order).toEqual([]);
		await withFileMutationQueue(
			"/tmp/emission-next-wave.txt",
			async () => {
				order.push("write");
			},
			undefined,
			{ callId: "next-write" },
		);
		await exclusive;
		expect(order).toEqual(["write", "bash"]);
		retireToolCall("next-write");
		retireToolCall("next-bash");
	});

	it("an exclusive run with no announcement of its own keeps the pre-announcement behavior", async () => {
		const order: string[] = [];
		announceToolCall("unrelated-write", 0, true, "batch-unannounced");
		await withExclusiveMutationBarrier(async () => {
			order.push("bash");
		});
		expect(order).toEqual(["bash"]);
		retireToolCall("unrelated-write");
	});
});
