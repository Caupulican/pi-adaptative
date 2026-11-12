import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ContinuousChatClaim, ContinuousChatScheduler } from "../src/core/memory/continuous-chat-scheduler.ts";

const directories: string[] = [];
const schedulers: ContinuousChatScheduler[] = [];
afterEach(() => {
	for (const scheduler of schedulers.splice(0)) scheduler.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function scheduler(): ContinuousChatScheduler {
	const directory = mkdtempSync(join(tmpdir(), "pi-chat-scheduler-"));
	directories.push(directory);
	const queue = ContinuousChatScheduler.open(join(directory, "queue.sqlite"), true);
	schedulers.push(queue);
	queue.initialize();
	queue.arrival(1);
	return queue;
}
function claim(queue: ContinuousChatScheduler): ContinuousChatClaim {
	const value = queue.claim();
	expect(value).toBeDefined();
	return value!;
}
function wakeAfterFailure(queue: ContinuousChatScheduler, failures: number): void {
	for (let i = 0; i <= 8 * 2 ** (failures - 1); i++) queue.arrival();
}

describe("continuous chat failure budget", () => {
	it("does not count released claims or duplicate release acknowledgements as failures", () => {
		const queue = scheduler();
		for (let i = 0; i < 8; i++) {
			const current = claim(queue);
			queue.abandon(current, { kind: "release" });
			queue.abandon(current, { kind: "release" });
		}
		const stale = claim(queue);
		queue.abandon(stale, { kind: "release" });
		const current = claim(queue);
		expect(() => queue.abandon(stale, { kind: "release" })).toThrow();
		queue.abandon(current, { kind: "fail", reason: "first model failure" });
		wakeAfterFailure(queue, 1);
		expect(claim(queue)).toMatchObject({ level: 0, ordinal: 0 });
	});

	it("does not charge interrupted claims recovered after a restart", () => {
		const queue = scheduler();
		for (let i = 0; i < 8; i++) {
			claim(queue);
			queue.recover();
		}
		queue.abandon(claim(queue), { kind: "fail", reason: "first model failure" });
		wakeAfterFailure(queue, 1);
		expect(claim(queue)).toMatchObject({ level: 0, ordinal: 0 });
	});

	it("still exhausts the budget after six real failure decisions", () => {
		const queue = scheduler();
		for (let failures = 1; failures <= 6; failures++) {
			queue.abandon(claim(queue), { kind: "fail", reason: `failure ${failures}` });
			wakeAfterFailure(queue, failures);
		}
		expect(queue.claim()).toBeUndefined();
	});

	it("imports interrupted legacy running work without inventing a failure", () => {
		const queue = scheduler();
		queue.beginImport();
		queue.importBatch([{ list: "running", item: { level: 0, ordinal: 0 } }], 1);
		queue.finishImport(
			{ origin: "fresh", revision: 0, generation: 0, totalMessages: 1, nextLeaf: 1 },
			1,
			"a".repeat(64),
		);
		for (let failures = 1; failures <= 5; failures++) {
			queue.abandon(claim(queue), { kind: "fail", reason: `failure ${failures}` });
			wakeAfterFailure(queue, failures);
		}
		expect(claim(queue)).toMatchObject({ level: 0, ordinal: 0 });
	});

	it("retries recovery-only failure on normal arrivals when no configuration identity exists", () => {
		const queue = scheduler();
		queue.abandon(claim(queue), { kind: "fail", reason: "empty response", recoveryOnly: true });
		wakeAfterFailure(queue, 1);
		expect(claim(queue)).toMatchObject({ level: 0, ordinal: 0 });
	});

	it("holds a matching recovery identity until the configuration changes", () => {
		const queue = scheduler();
		queue.arrival(undefined, "model-a");
		queue.abandon(claim(queue), {
			kind: "fail",
			reason: "empty response",
			recoveryOnly: true,
			recoveryKey: "model-a",
		});
		wakeAfterFailure(queue, 1);
		expect(queue.claim()).toBeUndefined();
		queue.arrival(undefined, "model-b");
		expect(claim(queue)).toMatchObject({ level: 0, ordinal: 0 });
	});

	it("treats a mismatched recovery identity as an ordinary failure", () => {
		const queue = scheduler();
		queue.arrival(undefined, "model-a");
		queue.abandon(claim(queue), {
			kind: "fail",
			reason: "empty response",
			recoveryOnly: true,
			recoveryKey: "model-b",
		});
		wakeAfterFailure(queue, 1);
		expect(claim(queue)).toMatchObject({ level: 0, ordinal: 0 });
	});

	it("does not park indefinitely on a blank recovery identity", () => {
		const queue = scheduler();
		queue.arrival(undefined, "  ");
		queue.abandon(claim(queue), {
			kind: "fail",
			reason: "empty response",
			recoveryOnly: true,
			recoveryKey: "  ",
		});
		wakeAfterFailure(queue, 1);
		expect(claim(queue)).toMatchObject({ level: 0, ordinal: 0 });
	});
});
