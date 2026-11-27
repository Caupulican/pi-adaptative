import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { saveSessionGoal } from "../src/core/goals/goal-snapshot-admission.ts";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { GoalExecutionCustody } from "../src/core/objective-execution/current-objective-execution.ts";
import { appendQueuedInputRecord, readQueuedInputRecord } from "../src/core/queued-input-record.ts";
import { currentWorkUnit, WORK_UNIT_CUSTOM_TYPE, workUnitWindow } from "../src/core/work-units.ts";
import { SessionMutationBusyError } from "../src/kernel/session/session-append-order.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

it("persists the first queued input before any user or assistant message exists", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-queued-input-first-write-"));
	try {
		const roots = ownerSessionStorageRoots(directory);
		const manager = SessionManager.create(directory, roots);
		expect(manager.hasDurableSessionFile()).toBe(false);
		const input = { id: "accepted-input", kind: "followUp", text: "held on a fresh session" } as const;
		appendQueuedInputRecord(manager, undefined, [input], undefined, "borrowed");
		const reopened = SessionManager.openReadOnly(manager.getSessionFile()!, roots);
		expect(readQueuedInputRecord(reopened, undefined)?.inputs).toMatchObject([input]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it("recovers the first saved goal before any bootstrap turn or assistant reply", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-goal-first-write-"));
	try {
		const roots = ownerSessionStorageRoots(directory);
		const manager = SessionManager.create(directory, roots);
		expect(manager.hasDurableSessionFile()).toBe(false);
		const goal = createGoalState({ goalId: "fresh", userGoal: "Observe readiness", now: "2026-11-26T10:00:00Z" });
		const entry = saveSessionGoal(manager, goal, undefined, new GoalExecutionCustody(), { runtimeFacts: () => ({}) });
		expect(manager.isEntryDurableForSession(entry)).toBe(true);
		const reopened = SessionManager.openReadOnly(manager.getSessionFile()!, roots);
		expect(getLatestGoalStateSnapshot(reopened)).toEqual(goal);
		expect(currentWorkUnit(reopened, goal.goalId)?.record.goalId).toBe(goal.goalId);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it.skipIf(process.platform !== "linux")(
	"publishes background receipts before queued mutations and refuses an overlapping synchronous write",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-background-append-"));
		try {
			const roots = ownerSessionStorageRoots(directory);
			const manager = SessionManager.create(directory, roots);
			manager.flushBufferedEntries();
			manager.enableBackgroundAppends();
			const publish = (content: string) => {
				let ids: string[] = [];
				return manager.appendMessageBatchAwaitable(
					[
						[{ kind: "message", message: { role: "user", content, timestamp: 1 } }],
						(receipt) => {
							ids = receipt.entries.map((entry) => entry.id);
						},
					],
					(failure) => {
						if (failure) throw failure.error;
						return ids;
					},
				);
			};

			let nested: Promise<string[]> | undefined;
			manager.onEntriesPersisted(() => {
				nested ??= publish("from publication");
			});
			const first = publish("first");
			const second = publish("queued before the synchronous mutation");
			expect(() => manager.appendCustomEntry("must-not-overtake")).toThrow(SessionMutationBusyError);
			const replacement = { key: {}, superseded: undefined };
			const superseded = manager.queueMutation(() => manager.appendCustomEntry("superseded"), replacement);
			const beforeBarrier = manager.queueMutation(() => manager.appendCustomEntry("before-barrier"), replacement);
			const queued = manager.queueMutation(() => manager.appendCustomEntry("after-worker"));
			const afterBarrier = manager.queueMutation(() => manager.appendCustomEntry("after-barrier"), replacement);
			const [[firstId], [secondId], skipped, beforeId, queuedId, afterId] = await Promise.all([
				first,
				second,
				superseded,
				beforeBarrier,
				queued,
				afterBarrier,
			]);
			const [nestedId] = await nested!;
			expect(manager.getEntry(secondId!)?.parentId).toBe(firstId);
			expect(skipped).toBeUndefined();
			expect(manager.getEntry(beforeId!)?.parentId).toBe(secondId);
			expect(manager.getEntry(queuedId)?.parentId).toBe(beforeId);
			expect(manager.getEntry(afterId!)?.parentId).toBe(queuedId);
			expect(manager.getEntry(nestedId!)?.parentId).toBe(afterId);

			const tail = publish("during shutdown");
			await manager.settleBackgroundAppends();
			const [tailId] = await tail;
			expect(manager.getEntry(tailId!)?.parentId).toBe(nestedId);
			const reopened = SessionManager.openReadOnly(manager.getSessionFile()!, roots);
			expect(reopened.getBranch().map((entry) => entry.id)).toEqual([
				firstId,
				secondId,
				beforeId,
				queuedId,
				afterId,
				nestedId,
				tailId,
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

it("ignores an orphan legacy declaration and recognizes one followed by its goal checkpoint", () => {
	const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
	const goal = createGoalState({ goalId: "legacy", userGoal: "Recover service", now: "2026-11-26T10:00:00Z" });
	const id = manager.appendCustomEntry(WORK_UNIT_CUSTOM_TYPE, {
		kind: "declared",
		goalId: goal.goalId,
		reason: goal.userGoal,
		openedAt: 1,
		startEntryId: null,
	});
	expect(currentWorkUnit(manager)).toBeUndefined();
	expect(workUnitWindow(manager, "worker_receipts")).toBeUndefined();
	manager.appendCustomEntry("goal_state", { version: 1, state: goal });
	expect(currentWorkUnit(manager, goal.goalId)?.entryId).toBe(id);
	expect(workUnitWindow(manager, "worker_receipts")?.workUnit?.goalId).toBe(goal.goalId);
});
