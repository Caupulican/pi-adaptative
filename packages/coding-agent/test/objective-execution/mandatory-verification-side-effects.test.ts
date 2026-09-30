import { describe, expect, it } from "vitest";
import { compileExecutionCharter } from "../../src/core/autonomy/execution-charter.ts";
import { executeDelivery } from "../../src/core/objective-execution/delivery-coordinator.ts";

describe("mandatory verification at each typed delivery effect", () => {
	it.each([true, false])("pending=%s controls actual side effects independently of authority", async (pending) => {
		const calls: string[] = [];
		const charter = compileExecutionCharter({
			objectiveId: "delivery",
			initialGrants: {
				git: { push: true, push_remote: "origin", push_ref: "refs/heads/main" },
				release: { deploy_targets: ["stage", "production"] },
			},
		});
		const input = {
			charter,
			candidateUntrackedPaths: [],
			attributedPaths: [],
			candidateRevision: "current",
			beforeEffect: () => {
				if (pending) throw new Error("same_lane_verification_required");
			},
			git: {
				push: async () => {
					calls.push("push");
					return { remote: "origin", ref: "refs/heads/main" };
				},
			},
			release: {
				deploy: async (target: string) => {
					calls.push(target);
					return { id: target };
				},
			},
		};
		await executeDelivery(input);
		expect(calls).toEqual(pending ? [] : ["push", "stage", "production"]);
	});

	it("rechecks after awaited effects when a new finding arrives", async () => {
		let pending = false;
		const calls: string[] = [];
		const input = {
			charter: compileExecutionCharter({
				objectiveId: "delivery",
				initialGrants: { release: { deploy_targets: ["stage", "production"] } },
			}),
			candidateUntrackedPaths: [],
			attributedPaths: [],
			beforeEffect: () => {
				if (pending) throw new Error("same_lane_verification_required");
			},
			release: {
				deploy: async (target: string) => {
					calls.push(target);
					pending = true;
					return { id: target };
				},
			},
		};
		await executeDelivery(input);
		expect(calls).toEqual(["stage"]);
	});
});
