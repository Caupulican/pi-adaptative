import { describe, expect, it } from "vitest";
import { parseOrchestrationProfile } from "../src/core/orchestration/profile-registry.ts";
import {
	createWorkerExecutionContract,
	parseWorkerExecutionContract,
} from "../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

describe("worker execution contract resource bounds", () => {
	it("rejects an oversized or non-canonical resource identifier before it reaches worker materialization", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "bounded-resource-profile",
			model: { provider: "faux", id: "faux-worker" },
		});

		expect(() =>
			createWorkerExecutionContract({
				worker: {
					profile,
					modelBinding: profile.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(profile),
					resourcePointers: [
						{
							id: `prompt:${"x".repeat(8_192)}`,
							kind: "prompt",
							uri: "file:///tmp/prompt.md",
							readOnly: true,
						},
					],
				},
			}),
		).toThrow("resource pointer is invalid");
	});

	it("rejects unbounded model identifiers and authority path arrays before durable cloning", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "unbounded-contract-profile",
			model: { provider: "faux", id: "m".repeat(513) },
		});

		expect(() =>
			createWorkerExecutionContract({
				worker: {
					profile,
					modelBinding: profile.modelPolicy.candidates[0]!,
					authority: {
						...createTestWorkerExecutionAuthority(profile),
						readPaths: Array.from({ length: 65 }, (_, index) => `/repo/read-${index}`),
					},
				},
			}),
		).toThrow("model candidate is invalid");
	});

	it("rejects oversized authority scope arrays before they are cloned into durable state", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "authority-array-profile",
			model: { provider: "faux", id: "faux-worker" },
		});

		expect(() =>
			createWorkerExecutionContract({
				worker: {
					profile,
					modelBinding: profile.modelPolicy.candidates[0]!,
					authority: {
						...createTestWorkerExecutionAuthority(profile),
						readPaths: Array.from({ length: 65 }, (_, index) => `/repo/read-${index}`),
					},
				},
			}),
		).toThrow("authority readPaths must be an array");
	});

	it("rejects oversized authority paths and worker soul text before durable cloning", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "authority-string-profile",
			model: { provider: "faux", id: "faux-worker" },
		});

		expect(() =>
			createWorkerExecutionContract({
				worker: {
					profile,
					modelBinding: profile.modelPolicy.candidates[0]!,
					authority: {
						...createTestWorkerExecutionAuthority(profile),
						readPaths: [`/${"p".repeat(4_096)}`],
					},
				},
			}),
		).toThrow("authority readPaths must be an array");
		expect(() =>
			createWorkerExecutionContract({
				worker: {
					profile,
					modelBinding: profile.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(profile),
					soul: "s".repeat(16 * 1024 + 1),
				},
			}),
		).toThrow("soul is invalid");
	});

	it("accepts native Windows and UNC authority scopes while running under a non-Windows host", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "windows-contract-profile",
			model: { provider: "faux", id: "faux-worker" },
		});
		const authority = createTestWorkerExecutionAuthority(profile, String.raw`C:\Repository`);
		authority.deniedPaths = [String.raw`\\Server\Share\Repository\private`];

		expect(() =>
			createWorkerExecutionContract({
				worker: { profile, modelBinding: profile.modelPolicy.candidates[0]!, authority },
			}),
		).not.toThrow();
	});

	it("rejects unknown raw budget fields before cloning nested values", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "budget-bound-profile",
			model: { provider: "faux", id: "faux-worker" },
		});
		const valid = createWorkerExecutionContract({
			worker: {
				profile,
				modelBinding: profile.modelPolicy.candidates[0]!,
				authority: createTestWorkerExecutionAuthority(profile),
			},
		});
		const nestedGetterBudget = { ...valid.worker.authority.budget } as Record<string, unknown>;
		Object.defineProperty(nestedGetterBudget, "unexpected", {
			enumerable: true,
			get() {
				throw new Error("unexpected budget value was read");
			},
		});
		const rawWorker = {
			...valid.worker,
			authority: { ...valid.worker.authority, budget: nestedGetterBudget },
		};

		expect(() => parseWorkerExecutionContract({ schemaVersion: 1, worker: rawWorker })).toThrow(
			"authority budget contains an unsupported field",
		);
		expect(() => parseOrchestrationProfile({ ...profile, budget: nestedGetterBudget })).toThrow(
			"budget contains an unsupported field",
		);
	});
});
