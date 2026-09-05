import { SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it, vi } from "vitest";
import { getGoalStateRevision } from "../src/core/goals/goal-lifecycle.ts";
import { GoalSessionController } from "../src/core/goals/goal-session-controller.ts";
import { applyGoalEvent, createGoalState, type GoalState } from "../src/core/goals/goal-state.ts";
import { createGoalLifecycleToolDefinitions, createGoalToolDefinition } from "../src/core/tools/goal.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { type GoalCommandHost, handleGoalCommand } from "../src/modes/interactive/session-flow-commands.ts";

type BusyState = "streaming" | "retrying" | "compacting";

function createHarness(busy: BusyState, initialStatus: "active" | "blocked" = "blocked") {
	const manager = SessionManager.inMemory();
	const schedule = vi.fn();
	const controller = new GoalSessionController({
		getSessionManager: () => manager,
		getModelProvider: () => undefined,
		getLaneRecords: () => [],
		getTaskRuntimeSnapshot: () => undefined,
		getBackgroundToolTasks: () => [],
		synchronizeGoalState: vi.fn(),
		scheduleGoalAutoContinueFromIdle: schedule,
		prompt: vi.fn(async () => {}),
		emitWarning: vi.fn(),
	});
	let initial = createGoalState({ goalId: "goal-routing", userGoal: "Finish the audited work", now: "T0" });
	initial = applyGoalEvent(initial, { type: "add_requirement", id: "r1", text: "Get access", now: "T1" });
	initial = applyGoalEvent(initial, { type: "block_requirement", id: "r1", blockedReason: "access", now: "T2" });
	if (initialStatus === "blocked") {
		initial = applyGoalEvent(initial, { type: "block_goal", reason: "waiting for owner access", now: "T3" });
	}
	controller.saveState(initial);
	const initialEntries = manager.getEntryCount();
	const context = {
		defaultEditor: {} as { onSubmit?: (text: string) => Promise<void> },
		editor: { setText: vi.fn(), addToHistory: vi.fn() },
		session: {
			isStreaming: busy === "streaming",
			isRetrying: busy === "retrying",
			isCompacting: busy === "compacting",
			getGoalStateSnapshot: () => controller.getState(),
			saveGoalStateSnapshot: vi.fn(
				(state: GoalState, expected?: Parameters<GoalSessionController["saveState"]>[1]) =>
					controller.saveState(state, expected),
			),
			clearGoalStateSnapshot: (state: GoalState, now: string) => controller.clearState(state, now),
			restoreGoalRuntimeAfterResume: vi.fn(() => controller.restoreAfterResume()),
			getGoalRuntimeSnapshot: (settings: { maxStallTurns: number }) => controller.getRuntimeSnapshot(settings),
			continueGoalLoop: vi.fn<GoalCommandHost["session"]["continueGoalLoop"]>(),
			prompt: vi.fn(async (_text: string, _options?: unknown) => {}),
		},
		handleGoalCommand: (text: string): Promise<void> => handleGoalCommand(context, text),
		showStatus: vi.fn(),
		showError: vi.fn(),
		refreshAutonomyFooterStatus: vi.fn(),
		takeClipboardImagesForText: vi.fn(() => undefined),
		queueCompactionMessage: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		setupEditorSubmitHandler(this: typeof context): void;
	};
	prototype.setupEditorSubmitHandler.call(context);
	const tool = createGoalToolDefinition({
		getGoalState: () => controller.getState(),
		saveGoalState: (state, expected) => controller.saveState(state, expected),
	});
	return {
		context,
		controller,
		manager,
		schedule,
		initialEntries,
		submit: async (text: string) => context.defaultEditor.onSubmit?.(text),
		getGoal: createGoalLifecycleToolDefinitions(tool)[1],
	};
}

describe.each(["streaming", "retrying", "compacting"] as const)("owner goal commands during %s", (busy) => {
	it("persists resume once, restores the runtime, and exposes active state through get_goal", async () => {
		const { context, controller, manager, initialEntries, schedule, submit, getGoal } = createHarness(busy);
		const previous = controller.getState();

		await submit(" /goal resume ");
		const result = await getGoal.execute("read-goal", {}, undefined, undefined, undefined as never);

		expect(result.details).toMatchObject({ state: { goalId: "goal-routing", status: "active" } });
		expect(context.session.saveGoalStateSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ status: "active" }),
			getGoalStateRevision(previous!),
		);
		expect(manager.getEntryCount()).toBe(initialEntries + 1);
		expect(schedule).toHaveBeenCalledTimes(1);
		expect(context.showStatus).toHaveBeenCalledWith("Goal resumed.");
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.queueCompactionMessage).not.toHaveBeenCalled();
		expect(context.session.continueGoalLoop).not.toHaveBeenCalled();
		expect(context.editor.setText).toHaveBeenCalledWith("");

		await submit("/goal resume");
		expect(manager.getEntryCount()).toBe(initialEntries + 1);
		expect(schedule).toHaveBeenCalledTimes(1);
		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("only paused, blocked, or usage-limited"));
	});

	it.each([
		["/goal", "blocked"],
		["/goal status", "blocked"],
		["/goal pause", "paused"],
		["/goal complete", "completed"],
		["/goal cancel", "cancelled"],
		["/goal close", "cancelled"],
		["/goal clear", undefined],
		["/goal reopen r1", "active"],
	] as const)("applies %s through the existing owner handler", async (text, expectedStatus) => {
		const { context, controller, submit } = createHarness(busy, text === "/goal pause" ? "active" : "blocked");
		await submit(text);
		expect(controller.getState()?.status).toBe(expectedStatus);
		expect(context.showStatus).toHaveBeenCalledTimes(1);
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.queueCompactionMessage).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
	});

	it.each([
		"/goal edit",
		"/goal edit new objective",
		"/goal override new objective",
		"/goal new objective",
		"/goal resume now",
		"/goal resume\n/goal complete",
		"/goals resume",
		"/goal-continue",
		"/reload",
		"/secrets",
		"!exit",
		"please /goal resume",
		">> /goal resume",
	])("keeps %j as literal queued input without owner authority", async (input) => {
		const { context, controller, manager, initialEntries, submit } = createHarness(busy);
		await submit(input);
		const followUp = input.startsWith(">>");
		const text = followUp ? input.slice(2).trim() : input;
		if (busy === "compacting") {
			expect(context.queueCompactionMessage).toHaveBeenCalledWith(text, followUp ? "followUp" : "steer", undefined);
			expect(context.session.prompt).not.toHaveBeenCalled();
		} else {
			expect(context.session.prompt).toHaveBeenCalledWith(text, {
				streamingBehavior: followUp ? "followUp" : "steer",
				images: undefined,
				processSlashCommands: false,
			});
		}
		expect(controller.getState()?.status).toBe("blocked");
		expect(manager.getEntryCount()).toBe(initialEntries);
		expect(context.session.restoreGoalRuntimeAfterResume).not.toHaveBeenCalled();
		expect(context.showStatus).not.toHaveBeenCalled();
	});

	it.each(["revision", "replacement"] as const)(
		"fails closed on a %s race without queuing the rejected command",
		async (race) => {
			const { context, controller, manager, initialEntries, schedule, submit } = createHarness(busy);
			context.session.saveGoalStateSnapshot.mockImplementationOnce((state, expected) => {
				const current = controller.getState()!;
				const changed =
					race === "revision"
						? applyGoalEvent(current, { type: "progress", now: "T-race" })
						: createGoalState({ goalId: "replacement", userGoal: "Other goal", now: "T-race" });
				controller.saveState(changed);
				return controller.saveState(state, expected);
			});

			await submit("/goal resume");

			expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("Goal state changed concurrently"));
			expect(manager.getEntryCount()).toBe(initialEntries + 1);
			expect(controller.getState()?.goalId).toBe(race === "revision" ? "goal-routing" : "replacement");
			expect(schedule).not.toHaveBeenCalled();
			expect(context.showStatus).not.toHaveBeenCalled();
			expect(context.session.prompt).not.toHaveBeenCalled();
			expect(context.queueCompactionMessage).not.toHaveBeenCalled();
		},
	);

	it("keeps repeated pause/resume controls ordered across foreground phase changes", async () => {
		const { context, controller, submit } = createHarness(busy);
		let active = false;
		let seed = 17;
		for (let index = 0; index < 40; index++) {
			seed = (seed * 16807) % 2147483647;
			const resume = seed % 2 === 0;
			context.session.isStreaming = index % 3 === 0;
			context.session.isRetrying = index % 3 === 1;
			context.session.isCompacting = index % 3 === 2;
			const revision = controller.getState()?.revision ?? 0;
			await submit(resume ? "/goal resume" : "/goal pause");
			expect(controller.getState()?.revision).toBe(revision + (resume !== active ? 1 : 0));
			active = resume;
			expect(controller.getState()?.status).toBe(active ? "active" : revision === 3 ? "blocked" : "paused");
		}
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.queueCompactionMessage).not.toHaveBeenCalled();
	});
});
