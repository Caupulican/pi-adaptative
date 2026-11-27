import { describe, expect, it, vi } from "vitest";
import { holdPersistedGoalForOwnerStop } from "../src/core/goals/goal-lifecycle.ts";
import {
	applyGoalEvent,
	createGoalState,
	type GoalState,
	MAX_GOAL_EVENT_HISTORY,
} from "../src/core/goals/goal-state.ts";
import { goalSourcePosition } from "../src/core/goals/session-goal-correction.ts";
import { GOAL_STATE_CUSTOM_TYPE, getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { assertExtensionCustomType } from "../src/core/turn-origin.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { GOAL_OWNER_CORRECTION_CUSTOM_TYPE } from "../src/kernel/session/session-entries.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

const before = "2026-11-26T10:00:00Z";
const after = "2026-11-26T12:00:00Z";
const stopAt = Date.parse("2026-11-26T11:00:00Z");
function oldCheckpoint(state: GoalState) {
	const { ownerActivatedAt: _stamp, ...legacy } = state;
	return legacy;
}

describe("retained owner decisions", () => {
	it.each(["owner", "system"] as const)(
		"orders a delayed stop against a %s resume beyond the event window",
		(source) => {
			const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
			const goal = createGoalState({ goalId: "history", userGoal: "Prepare deployment", now: before });
			const paused = applyGoalEvent(goal, { type: "pause_goal", now: before });
			manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 1, state: oldCheckpoint(paused) });
			const resume = { type: "resume_goal", source, now: after } as const;
			manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, {
				version: 2,
				kind: "events",
				goalId: goal.goalId,
				baseRevision: paused.revision,
				events: [resume],
			});
			let active = applyGoalEvent(paused, resume);
			for (let i = 0; i <= MAX_GOAL_EVENT_HISTORY; i++)
				active = applyGoalEvent(active, { type: "progress", now: after });
			expect(active.events.some((event) => event.type === "resume_goal")).toBe(false);
			manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, {
				version: 2,
				kind: "checkpoint",
				state: oldCheckpoint(active),
			});
			const recovered = getLatestGoalStateSnapshot(manager)!;
			const host = { getGoalStateSnapshot: () => recovered, saveGoalStateSnapshot: vi.fn(() => "saved") };
			holdPersistedGoalForOwnerStop(host, stopAt, after);
			expect(host.saveGoalStateSnapshot).toHaveBeenCalledTimes(source === "owner" ? 0 : 1);
		},
	);
	it.each([false, true])(
		"certifies a legacy edit after a completed v1 checkpoint (intervening bookkeeping %s)",
		(bookkeeping) => {
			const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
			const goal = createGoalState({ goalId: "history", userGoal: "Prepare deployment", now: before });
			let state = applyGoalEvent(goal, { type: "complete_goal_manually", now: before });
			let target = manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 1, state: oldCheckpoint(state) });
			if (bookkeeping) {
				const evidence = {
					type: "add_evidence",
					id: "receipt",
					kind: "finding",
					summary: "Archived report",
					now: before,
				} as const;
				target = manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, {
					version: 2,
					kind: "events",
					goalId: goal.goalId,
					baseRevision: state.revision,
					events: [evidence],
				});
				state = applyGoalEvent(state, evidence);
			}
			const edit = { type: "edit_goal", userGoal: "Verify deployment", now: after } as const;
			const token = manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, {
				version: 2,
				kind: "events",
				goalId: goal.goalId,
				baseRevision: state.revision,
				events: [edit],
			});
			const checkpoint = manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, {
				version: 2,
				kind: "checkpoint",
				state: oldCheckpoint(applyGoalEvent(state, edit)),
			});
			const recovered = getLatestGoalStateSnapshot(manager)!;
			expect(recovered.ownerCorrection).toMatchObject({
				ownerEntryId: token,
				targetCompletionEntryId: target,
				targetCompletionRevision: state.revision,
			});
			expect(goalSourcePosition(manager, recovered)?.goalEntryId).toBe(checkpoint);
		},
	);
});

it.each([false, true])(
	"restores only a worker dispatched for the amended legacy definition (redispatched %s)",
	(redispatched) => {
		const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
		const initial = createGoalState({ goalId: "history", userGoal: "Prepare deployment", now: before });
		const requirement = applyGoalEvent(initial, {
			type: "add_requirement",
			id: "service",
			text: "Measure service",
			check: { command: "old-service" },
			now: before,
		});
		const dispatch = {
			type: "dispatch_worker",
			id: "service",
			instructions: "Measure",
			laneId: "lane",
			now: before,
		} as const;
		const bound = applyGoalEvent(requirement, dispatch);
		let state = applyGoalEvent(bound, { type: "complete_goal_manually", now: before });
		manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 1, state: oldCheckpoint(state) });
		const edit = { type: "edit_goal", userGoal: "Measure the replacement", now: after } as const;
		const change = {
			type: "set_requirement_check",
			id: "service",
			check: { command: "new-service" },
			now: after,
		} as const;
		const events = redispatched ? [edit, change, { ...dispatch, now: after }] : [edit, change];
		manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, {
			version: 2,
			kind: "events",
			goalId: state.goalId,
			baseRevision: state.revision,
			events,
		});
		for (const event of events) state = applyGoalEvent(state, event);
		// The old writer kept the previous lane even when a new check replaced its definition.
		state = {
			...state,
			requirements: state.requirements.map((item) => ({
				...item,
				boundLaneId: "lane",
				boundAt: redispatched ? after : before,
			})),
		};
		manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, {
			version: 2,
			kind: "checkpoint",
			state: oldCheckpoint(state),
		});
		const recovered = getLatestGoalStateSnapshot(manager);
		expect(recovered?.ownerCorrection).toBeDefined();
		expect(recovered?.requirements[0]?.boundLaneId).toBe(redispatched ? "lane" : undefined);
		expect(recovered?.requirements[0]?.status).toBe("open");
	},
);

it("reserves the owner correction record for the host", () => {
	expect(() => assertExtensionCustomType(GOAL_OWNER_CORRECTION_CUSTOM_TYPE)).toThrow(/reserved/);
});
