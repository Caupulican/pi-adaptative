import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { GoalFileEvidenceResolution } from "../src/core/goals/file-evidence.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { createGoalToolDefinition } from "../src/core/tools/goal.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

describe("goal evidence concurrent persistence", () => {
	it.each([
		[2, 0, 1],
		[1, 2, 0],
	])("retains delayed evidence settling in order %j", async (...order) => {
		const harness = await createHarness({ initialActiveToolNames: ["goal"] });
		harness.session.saveGoalStateSnapshot(
			createGoalState({ goalId: "ordered", userGoal: "Review sources", now: "T0" }),
		);
		const pending = Array.from({ length: 3 }, () => Promise.withResolvers<GoalFileEvidenceResolution>());
		const tool = createGoalToolDefinition({
			getGoalState: () => harness.session.getGoalStateSnapshot(),
			saveGoalState: (state, expected) => {
				harness.session.saveGoalStateSnapshot(state, expected);
			},
			resolveFileEvidence: (uri) => pending[Number(uri)].promise,
		});
		const calls = pending.map((_, index) =>
			tool.execute(
				`call-${index}`,
				{
					action: "add_evidence",
					kind: "file",
					summary: `Source ${index}`,
					uri: String(index),
					evidenceId: `ev-${index}`,
				},
				undefined,
				undefined,
				harness.session.extensionRunner.createContext(),
			),
		);
		for (const index of order) {
			pending[index].resolve({ verified: true, uri: `backend://source-${index}` });
			expect((await calls[index]).isError).not.toBe(true);
		}
		expect(harness.session.getGoalStateSnapshot()?.evidence.map((entry) => entry.id)).toEqual(
			order.map((index) => `ev-${index}`),
		);
		// Replayed and conflicting identities cannot append or replace acknowledged evidence.
		const before = harness.session.getGoalStateSnapshot();
		for (const summary of ["Source 0", "Different source"]) {
			const result = await tool.execute(
				"replay",
				{ action: "add_evidence", kind: "file", summary, uri: "0", evidenceId: "ev-0" },
				undefined,
				undefined,
				harness.session.extensionRunner.createContext(),
			);
			expect(result.isError).toBe(true);
			expect(harness.session.getGoalStateSnapshot()).toBe(before);
		}
	});

	it("retains every acknowledged file in a parallel batch and can satisfy requirements after journal replay", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["goal"],
			settings: { modelCapability: { mode: "off" } },
		});
		let state = createGoalState({ goalId: "parallel-evidence", userGoal: "Review files", now: "T0" });
		const calls = Array.from({ length: 11 }, (_, index) => {
			const uri = join(harness.tempDir, `source-${index}.ts`);
			writeFileSync(uri, `export const value = ${index};\n`);
			state = applyGoalEvent(state, {
				type: "add_requirement",
				id: `req-${index}`,
				text: `Review ${index}`,
				now: "T1",
			});
			return fauxToolCall(
				"goal",
				{ action: "add_evidence", kind: "file", summary: `Source ${index}`, uri, evidenceId: `ev-${index}` },
				{ id: `record-${index}` },
			);
		});
		harness.session.saveGoalStateSnapshot(state);
		harness.setResponses([
			fauxAssistantMessage(calls, { stopReason: "toolUse" }),
			fauxAssistantMessage(
				calls.map((_, index) =>
					fauxToolCall(
						"goal",
						{ action: "satisfy_requirement", requirementId: `req-${index}`, evidenceIds: [`ev-${index}`] },
						{ id: `satisfy-${index}` },
					),
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Review complete"),
		]);
		await harness.session.prompt("Record the file evidence and satisfy the review requirements.", {
			autoContinueGoal: false,
		});
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(22);
		expect(results.filter((result) => result.isError).map(getMessageText)).toEqual([]);
		const current = harness.session.getGoalStateSnapshot()!;
		expect(current.evidence.map((entry) => entry.id).sort()).toEqual(calls.map((_, index) => `ev-${index}`).sort());
		expect(current.requirements.every((requirement) => requirement.status === "satisfied")).toBe(true);
		// A fresh reader bypasses the writer's identity cache and reconstructs the journal.
		expect(
			getLatestGoalStateSnapshot({
				getLatestCustomEntryOnBranch: harness.sessionManager.getLatestCustomEntryOnBranch.bind(
					harness.sessionManager,
				),
			}),
		).toEqual(current);
	});

	it.each(["unchanged", "revised", "replaced"] as const)(
		"keeps the runtime persistence fence when the goal is %s at commit",
		async (change) => {
			const harness = await createHarness({
				initialActiveToolNames: ["goal"],
				settings: { modelCapability: { mode: "off" } },
			});
			const initial = createGoalState({ goalId: "original", userGoal: "Review original work", now: "T0" });
			harness.session.saveGoalStateSnapshot(initial);
			const save = harness.session.saveGoalStateSnapshot.bind(harness.session);
			const next =
				change === "replaced"
					? createGoalState({ goalId: "replacement", userGoal: "Other work", now: "T1" })
					: applyGoalEvent(initial, { type: "progress", now: "T1" });
			const spy = vi.spyOn(harness.session, "saveGoalStateSnapshot").mockImplementationOnce((state, expected) => {
				if (change !== "unchanged") save(next);
				return save(state, expected);
			});
			try {
				const tool = harness.session.getToolDefinition("goal")!;
				const result = tool.execute(
					"record",
					{ action: "add_evidence", kind: "finding", summary: "Original observation" },
					undefined,
					undefined,
					harness.session.extensionRunner.createContext(),
				);
				if (change === "unchanged") {
					expect((await result).isError).not.toBe(true);
					expect(harness.session.getGoalStateSnapshot()?.evidence).toHaveLength(1);
				} else {
					await expect(result).rejects.toThrow("changed concurrently");
					expect(harness.session.getGoalStateSnapshot()).toEqual(next);
				}
			} finally {
				spy.mockRestore();
			}
		},
	);
});
