import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { afterEach, describe, expect, it } from "vitest";
import { SystemOneController } from "../src/core/system-one/controller.ts";
import { ExecutionStore } from "../src/core/system-one/execution-state.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const yes = { type: "noul", noul: 0.97 };
const no = { type: "noul", noul: 0.03 };
const unsure = { type: "noul", noul: 0.6 };

/** A real System One controller whose System One answers the unsettled-item Nouls from the evidence it is sent. */
function systemOne(judge: (statement: string, evidence: string) => [unknown, unknown]) {
	const seen: { statement: string; evidence: string }[] = [];
	const controller = new SystemOneController({
		store: new ExecutionStore({
			run_id: "ladder",
			objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
			repo: { root: "/repo", baseline_revision: "rev-0" },
		}),
		adapter: {
			evaluate: async (request) => {
				const state = request.state as Record<string, string>;
				const answers: Record<string, unknown> = {};
				for (const id of Object.keys(request.questions)) {
					const index = Number(id.slice(id.lastIndexOf("_") + 1));
					const statement = state[`s${index}`] ?? "";
					const evidence = state[`e${index}`] ?? "";
					if (id.startsWith("shows_true_")) seen.push({ statement, evidence });
					answers[id] = judge(statement, evidence)[id.startsWith("shows_true_") ? 0 : 1];
				}
				return { model: "jev-1.13.0", latency_ms: 1, answers };
			},
		},
	});
	return { controller, seen };
}

function workerProfile() {
	return createTestWorkerOrchestrationProfile({
		profileId: "ladder-reader",
		model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
	});
}

const report = (inconclusive: string[]) =>
	JSON.stringify({ summary: "Read the config.", status: "completed", findings: [], inconclusive });

describe("a worker's inconclusive findings climb the ladder", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
	});

	it("System One settles an item from the worker's own tool results, and the claim is accepted", async () => {
		const { controller, seen } = systemOne((statement, evidence) =>
			evidence.includes("retries=3") && statement.includes("three retries") ? [yes, no] : [unsure, unsure],
		);
		harness = await createHarness({ systemOneController: controller, workerOrchestrationProfile: workerProfile() });
		writeFileSync(join(harness.tempDir, "config.txt"), "retries=3\n");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "config.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(report(["the client makes three retries"])),
		]);

		const run = await harness.session.runWorkerDelegationOnce({ instructions: "Check the retry setting." });

		expect(seen[0]?.evidence).toContain("retries=3");
		expect(run.outcome?.claim.systemOneSettled).toEqual(["confirmed: the client makes three retries (system_one)"]);
		expect(run.outcome?.claim.inconclusive).toBeUndefined();
		// Settled by System One, the claim no longer waits on parent review for it.
		expect(run.outcome?.accepted).toBe(true);
	});

	it("an item nothing settles stays open, named with what is missing, and holds the claim for review", async () => {
		const { controller } = systemOne(() => [unsure, unsure]);
		harness = await createHarness({ systemOneController: controller, workerOrchestrationProfile: workerProfile() });
		writeFileSync(join(harness.tempDir, "config.txt"), "retries=3\n");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "config.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(report(["the server honours the retry header"])),
		]);

		const run = await harness.session.runWorkerDelegationOnce({ instructions: "Check the retry setting." });

		expect(run.outcome?.claim.inconclusive).toEqual([
			"the server honours the retry header (missing: the agent's own results do not settle it)",
		]);
		expect(run.outcome?.accepted).toBe(false);
		expect(run.outcome?.acceptance.reasonCode).toBe("parent_review_required");
		expect(run.outcome?.claim.ownerFollowUp).toBeUndefined();
	});

	it("a refuting result settles the item the other way instead of leaving it open", async () => {
		const { controller } = systemOne((_, evidence) =>
			evidence.includes("retries=0") ? [no, yes] : [unsure, unsure],
		);
		harness = await createHarness({ systemOneController: controller, workerOrchestrationProfile: workerProfile() });
		writeFileSync(join(harness.tempDir, "config.txt"), "retries=0\n");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "config.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(report(["retries are enabled"])),
		]);

		const run = await harness.session.runWorkerDelegationOnce({ instructions: "Check the retry setting." });

		expect(run.outcome?.claim.systemOneSettled).toEqual(["refuted: retries are enabled (system_one)"]);
		expect(run.outcome?.claim.inconclusive).toBeUndefined();
	});
});
