import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";
import { OrchestrationEventStore } from "../../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime } from "../../src/core/orchestration/task-runtime.ts";
import { sameLaneVerificationDirective } from "../../src/core/system-one/control-directive.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { tempDir } from "../temp-dir.ts";

it.each(["mandatory-return", "mandatory-throw", "ordinary-return"])("acknowledgment proof %s", async (mode) => {
	const eventStore = new OrchestrationEventStore({
		agentDir: tempDir("rank2-ack-"),
		sessionId: randomUUID(),
		now: () => new Date().toISOString(),
		createEventId: () => randomUUID(),
	});
	const runtime = new DurableTaskRuntime({ store: eventStore, now: () => Date.now(), createId: () => randomUUID() });
	await runtime.createObjective({ objectiveId: "objective", title: "Repair parser", description: "Repair parser" });
	const store = new ExecutionStore({
		run_id: "fixture",
		objective: { request: "Repair parser", normalized_goal: "Repair parser", acceptance_criteria: [] },
		repo: { root: "/fixture", baseline_revision: "base" },
	});
	const systemOne = new SystemOneController({
		store,
		adapter: { evaluate: async () => ({ model: "fixture", answers: {}, latency_ms: 0 }) },
	});
	systemOne.noteControlDirective(
		mode.startsWith("mandatory")
			? sameLaneVerificationDirective(["stale_parser_candidate"])
			: { source: "postflight", objectiveRoute: "deterministic_test", reasonCodes: ["ordinary_check"] },
	);
	const before = store.snapshot();
	let executions = 0;
	const objective = new ObjectiveExecutionController({
		mode: "objective_primary",
		runtime: { reconcileObjective: async () => runtime.getSnapshot() },
		systemOne: {
			peekControlDirective: () => systemOne.peekControlDirective(),
			consumeControlDirective: (expected) => systemOne.consumeControlDirective(expected),
			noteControlDirective: (directive) => systemOne.noteControlDirective(directive),
			evaluateObjectiveRoute: async () => ({ workRemaining: true, missingWorkClass: "implement" }),
		},
		rootExecutor: {
			execute: async () => {
				executions++;
				if (mode === "mandatory-throw") throw new Error("fixture no check");
			},
		},
	});
	expect((await objective.evaluateRouteOnce("objective")).route).toBe("deterministic_test");
	if (mode === "mandatory-throw")
		await expect(objective.runCycles("objective", 1)).rejects.toThrow("fixture no check");
	else await objective.runCycles("objective", 1);
	expect(executions).toBe(1);
	// No evidence, revision or verification was recorded by this executor.
	expect(store.snapshot()).toEqual(before);
	expect((await objective.evaluateRouteOnce("objective")).route).toBe(
		mode === "ordinary-return" ? "implement" : "deterministic_test",
	);
});
