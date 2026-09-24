import { describe, expect, it } from "vitest";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";

/**
 * The root (the talker, on its warm cache) executes a route it may take unless the host's executor price
 * says a worker given the route's brief costs less; then the worker dispatcher takes it.
 */
function controllerWith(options: { choose?: "root" | "worker" }) {
	const executed: string[] = [];
	let stop = false;
	const now = new Date().toISOString();
	const controller = new ObjectiveExecutionController({
		runtime: {
			reconcileObjective: async (id: string) => ({
				lastOrdinal: 1,
				agents: {},
				checkpoints: {},
				approvals: {},
				notifications: {},
				objectives: {
					[id]: {
						objective: {
							schemaVersion: 1,
							objectiveId: id,
							title: "Test",
							description: "Fix bug",
							acceptanceCriteria: [],
							status: "active",
							constraints: [],
							riskBudget: {},
							createdAt: now,
							updatedAt: now,
						},
						evidence: [],
						taskIds: [],
					},
				},
				tasks: {},
				attempts: {},
			}),
			isCancelled: () => stop,
			isBudgetExhausted: () => false,
		},
		rootExecutor: {
			execute: async () => {
				executed.push("root");
				stop = true;
			},
		},
		...(options.choose ? { chooseExecutor: () => options.choose ?? "root" } : {}),
		workerDispatcher: {
			dispatch: async () => {
				executed.push("worker");
				stop = true;
			},
			continueWorker: async () => {},
			dispatchEscalated: async () => {},
		},
		getRouteProposedAction: () => ({ kind: "implement" }),
	});
	return { controller, executed };
}

describe("objective executor choice", () => {
	it("keeps a route on the root when the price favors the talker, and without a price", async () => {
		for (const options of [{ choose: "root" as const }, {}]) {
			const { controller, executed } = controllerWith(options);
			await controller.run("obj-test");
			expect(executed).toEqual(["root"]);
		}
	});

	it("hands the route to a worker when the price favors a brief", async () => {
		const { controller, executed } = controllerWith({ choose: "worker" });
		await controller.run("obj-test");
		expect(executed).toEqual(["worker"]);
	});
});
