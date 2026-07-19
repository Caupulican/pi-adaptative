import { describe, expect, it } from "vitest";
import {
	checkTaskStepsContract,
	INITIAL_TASK_CONTRACT_STREAK,
	isTaskStepsContractViolation,
	TASK_CONTRACT_VIOLATION_THRESHOLD,
	type TaskContractStreak,
} from "../src/core/tasks/task-contract-monitor.ts";
import { addTaskStep, createTaskStepsState, setTaskSteps, type TaskStepsState } from "../src/core/tasks/task-state.ts";
import { AutoLearnController } from "../src/modes/interactive/auto-learn-controller.ts";

function openStepState(): TaskStepsState {
	// One open (pending) step, nothing in_progress — a sustained contract violation.
	return addTaskStep(createTaskStepsState("T0"), { content: "Investigate" }, "T1");
}

function activeStepState(): TaskStepsState {
	// A single in_progress step — compliant.
	return setTaskSteps(createTaskStepsState("T0"), [{ content: "Investigate", status: "in_progress" }], "T1");
}

function multiActiveStepState(): TaskStepsState {
	// Force two in_progress steps directly (the reducers themselves prevent this, but the monitor
	// must defend against the invariant being violated by any future writer).
	const state = setTaskSteps(
		createTaskStepsState("T0"),
		[
			{ content: "Investigate", status: "in_progress" },
			{ content: "Implement", status: "in_progress" },
		],
		"T1",
	);
	return { ...state, steps: state.steps.map((step) => ({ ...step, status: "in_progress" as const })) };
}

describe("isTaskStepsContractViolation", () => {
	it("is false for an absent state (no task list ever created)", () => {
		expect(isTaskStepsContractViolation(undefined)).toBe(false);
	});

	it("is false when a single step is in_progress", () => {
		expect(isTaskStepsContractViolation(activeStepState())).toBe(false);
	});

	it("is false when there are no open steps left", () => {
		const state = createTaskStepsState("T0");
		expect(isTaskStepsContractViolation(state)).toBe(false);
	});

	it("is true when open steps exist with none in_progress", () => {
		expect(isTaskStepsContractViolation(openStepState())).toBe(true);
	});

	it("is true when more than one step is in_progress", () => {
		expect(isTaskStepsContractViolation(multiActiveStepState())).toBe(true);
	});
});

describe("checkTaskStepsContract streak + threshold", () => {
	it("stays silent below the threshold", () => {
		let streak: TaskContractStreak = INITIAL_TASK_CONTRACT_STREAK;
		for (let turn = 1; turn < TASK_CONTRACT_VIOLATION_THRESHOLD; turn++) {
			const outcome = checkTaskStepsContract(openStepState(), streak);
			expect(outcome.note).toBeUndefined();
			expect(outcome.streak.consecutiveViolations).toBe(turn);
			streak = outcome.streak;
		}
	});

	it("fires exactly one note on the turn the threshold is first reached", () => {
		let streak: TaskContractStreak = INITIAL_TASK_CONTRACT_STREAK;
		for (let turn = 1; turn < TASK_CONTRACT_VIOLATION_THRESHOLD; turn++) {
			streak = checkTaskStepsContract(openStepState(), streak).streak;
		}
		const outcome = checkTaskStepsContract(openStepState(), streak);
		expect(outcome.streak.consecutiveViolations).toBe(TASK_CONTRACT_VIOLATION_THRESHOLD);
		expect(outcome.note).toBeDefined();
		expect(outcome.note).toContain("task_steps contract violated");
		expect(outcome.note?.split("\n")).toHaveLength(1);
	});

	it("does not repeat the note on further consecutive violating turns (no spam)", () => {
		let streak: TaskContractStreak = INITIAL_TASK_CONTRACT_STREAK;
		for (let turn = 1; turn <= TASK_CONTRACT_VIOLATION_THRESHOLD; turn++) {
			streak = checkTaskStepsContract(openStepState(), streak).streak;
		}
		for (let extra = 0; extra < 5; extra++) {
			const outcome = checkTaskStepsContract(openStepState(), streak);
			expect(outcome.note).toBeUndefined();
			expect(outcome.streak.consecutiveViolations).toBe(TASK_CONTRACT_VIOLATION_THRESHOLD + extra + 1);
			expect(outcome.streak.noteFired).toBe(true);
			streak = outcome.streak;
		}
	});

	it("resets the streak on a compliant turn", () => {
		let streak: TaskContractStreak = INITIAL_TASK_CONTRACT_STREAK;
		streak = checkTaskStepsContract(openStepState(), streak).streak;
		streak = checkTaskStepsContract(openStepState(), streak).streak;
		expect(streak.consecutiveViolations).toBe(2);

		const compliant = checkTaskStepsContract(activeStepState(), streak);
		expect(compliant.note).toBeUndefined();
		expect(compliant.streak).toEqual(INITIAL_TASK_CONTRACT_STREAK);
	});

	it("re-arms after a reset: fires again once the streak climbs back to the threshold", () => {
		let streak: TaskContractStreak = INITIAL_TASK_CONTRACT_STREAK;
		for (let turn = 1; turn <= TASK_CONTRACT_VIOLATION_THRESHOLD; turn++) {
			streak = checkTaskStepsContract(openStepState(), streak).streak;
		}
		expect(streak.noteFired).toBe(true);

		// Compliant turn resets and re-arms.
		streak = checkTaskStepsContract(activeStepState(), streak).streak;
		expect(streak).toEqual(INITIAL_TASK_CONTRACT_STREAK);

		// Climb back to the threshold: silent until the threshold, then exactly one note again.
		for (let turn = 1; turn < TASK_CONTRACT_VIOLATION_THRESHOLD; turn++) {
			const outcome = checkTaskStepsContract(openStepState(), streak);
			expect(outcome.note).toBeUndefined();
			streak = outcome.streak;
		}
		const secondFire = checkTaskStepsContract(openStepState(), streak);
		expect(secondFire.note).toBeDefined();
	});

	it("never fires for an absent task_steps state, however many turns pass", () => {
		let streak: TaskContractStreak = INITIAL_TASK_CONTRACT_STREAK;
		for (let turn = 0; turn < TASK_CONTRACT_VIOLATION_THRESHOLD + 2; turn++) {
			const outcome = checkTaskStepsContract(undefined, streak);
			expect(outcome.note).toBeUndefined();
			expect(outcome.streak.consecutiveViolations).toBe(0);
			streak = outcome.streak;
		}
	});
});

interface TaskContractNudgeHarness
	extends Pick<AutoLearnController, "maybeStartAutoLearn" | "maybeRunNativeReflection"> {
	deps: unknown;
	_taskContractStreak: TaskContractStreak;
	isNativeReflectionEnabled: () => boolean;
}

function createNudgeHarness(
	getTaskStepsStateSnapshot: () => TaskStepsState | undefined,
	sendCustomMessage: (message: unknown, options: unknown) => Promise<void>,
): TaskContractNudgeHarness {
	const harness = Object.create(AutoLearnController.prototype) as TaskContractNudgeHarness;
	harness.deps = {
		getSession: () => ({
			getTaskStepsStateSnapshot,
			sendCustomMessage,
			getContextUsage: () => undefined,
		}),
		ui: {
			showStatus: () => undefined,
			footerDataProvider: { setExtensionStatus: () => undefined },
			invalidateFooter: () => undefined,
			requestRender: () => undefined,
		},
	};
	harness._taskContractStreak = INITIAL_TASK_CONTRACT_STREAK;
	// Keep the legacy auto-learn/reflection machinery a no-op so the harness exercises only the
	// contract-nudge hook, mirroring how other tests in this suite stub sibling methods directly on a
	// bare `Object.create(AutoLearnController.prototype)` instance instead of building a full session
	// (see the "Native reflection cost reports" describe block above and test/auto-learn-spawn.test.ts).
	harness.isNativeReflectionEnabled = () => false;
	const stubs = harness as unknown as {
		evaluateAutoLearn: () => { shouldRun: boolean; reason: string };
		updateAutoLearnFooter: () => void;
		getEffectiveAutoLearnSettings: () => { complexTaskToolCalls: number };
		hasCorrectionSignal: () => boolean;
	};
	stubs.evaluateAutoLearn = () => ({ shouldRun: false, reason: "disabled" });
	stubs.updateAutoLearnFooter = () => undefined;
	// `maybeRunNativeReflection` reads settings/correction-signal before deciding a trigger; keep it a
	// deliberate no-trigger no-op ("none") so it returns right after the contract-nudge hook without
	// needing a full settingsManager mock.
	stubs.getEffectiveAutoLearnSettings = () => ({ complexTaskToolCalls: 999 });
	stubs.hasCorrectionSignal = () => false;
	return harness;
}

describe("AutoLearnController task_steps contract nudge integration", () => {
	it("delivers exactly one nextTurn note after N consecutive violating turns via maybeStartAutoLearn", () => {
		const sent: Array<{ message: unknown; options: unknown }> = [];
		const harness = createNudgeHarness(
			() => openStepState(),
			(message, options) => {
				sent.push({ message, options });
				return Promise.resolve();
			},
		);

		for (let turn = 0; turn < TASK_CONTRACT_VIOLATION_THRESHOLD; turn++) {
			harness.maybeStartAutoLearn();
		}

		expect(sent).toHaveLength(1);
		expect(sent[0].options).toEqual({ deliverAs: "nextTurn" });
		const message = sent[0].message as { customType: string; content: string; display: boolean };
		expect(message.customType).toBe("task_contract_nudge");
		expect(message.display).toBe(false);
		expect(message.content).toContain("task_steps contract violated");

		// Further violating turns must not spam another note.
		harness.maybeStartAutoLearn();
		harness.maybeStartAutoLearn();
		expect(sent).toHaveLength(1);
	});

	it("delivers exactly one nextTurn note after N consecutive violating turns via maybeRunNativeReflection", async () => {
		const sent: Array<{ message: unknown; options: unknown }> = [];
		const harness = createNudgeHarness(
			() => openStepState(),
			(message, options) => {
				sent.push({ message, options });
				return Promise.resolve();
			},
		);
		harness.isNativeReflectionEnabled = () => true;

		for (let turn = 0; turn < TASK_CONTRACT_VIOLATION_THRESHOLD; turn++) {
			harness.maybeRunNativeReflection([]);
		}

		expect(sent).toHaveLength(1);
	});

	it("does not fire when the session stays compliant", () => {
		const sent: unknown[] = [];
		const harness = createNudgeHarness(
			() => activeStepState(),
			(message, options) => {
				sent.push({ message, options });
				return Promise.resolve();
			},
		);

		for (let turn = 0; turn < TASK_CONTRACT_VIOLATION_THRESHOLD + 3; turn++) {
			harness.maybeStartAutoLearn();
		}

		expect(sent).toHaveLength(0);
	});

	it("swallows a delivery failure without throwing (advisory-only)", async () => {
		const harness = createNudgeHarness(
			() => openStepState(),
			() => Promise.reject(new Error("delivery failed")),
		);

		expect(() => {
			for (let turn = 0; turn < TASK_CONTRACT_VIOLATION_THRESHOLD; turn++) {
				harness.maybeStartAutoLearn();
			}
		}).not.toThrow();

		// Allow the rejected promise's .catch() to settle before the test ends.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
});
