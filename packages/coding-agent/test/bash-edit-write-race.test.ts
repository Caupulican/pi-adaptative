import { describe, expect, it } from "vitest";
import { withExclusiveMutationBarrier, withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";

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
		await new Promise((r) => setTimeout(r, 10));
		const exclusive = withExclusiveMutationBarrier(async () => {
			order.push("bash");
		});
		await new Promise((r) => setTimeout(r, 10));
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
		await new Promise((r) => setTimeout(r, 10));
		const filing = withFileMutationQueue("/tmp/b.txt", async () => {
			order.push("file");
		});
		await new Promise((r) => setTimeout(r, 10));
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
		await new Promise((r) => setTimeout(r, 10));
		const p2 = withFileMutationQueue("/tmp/c2.txt", async () => {
			order.push("c2");
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(order).toContain("c2"); // c2 ran while c1 was still holding its file lock
		g1.resolve();
		await Promise.all([p1, p2]);
	});
});
