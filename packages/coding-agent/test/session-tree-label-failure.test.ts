import { buildSessionContext } from "@caupulican/pi-agent-core/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReflectionController } from "../src/core/reflection-controller.ts";
import { createHarness } from "./suite/harness.ts";

afterEach(() => vi.restoreAllMocks());

describe.each(["root", "branch", "summary"] as const)("%s navigation label publication", (destination) => {
	it.each(["success", "before_write", "after_write", "undefined_error"] as const)(
		"keeps the agent on the selected branch when the label outcome is %s",
		async (outcome) => {
			const invalidations = vi.spyOn(ReflectionController.prototype, "invalidateCurrentTurnCueStateCache");
			const observedLeaves: Array<string | null> = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_tree", async (event) =>
							event.preparation.userWantsSummary
								? { summary: { summary: "Retained branch summary" } }
								: undefined,
						);
						pi.on("session_tree", async (event) => {
							observedLeaves.push(event.newLeafId);
						});
					},
				],
			});
			try {
				const manager = harness.sessionManager;
				const agent = harness.session.agent;
				const first = manager.appendMessage({ role: "user", content: "First", timestamp: 1 });
				const second = manager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
				const previousLeaf = manager.appendMessage({ role: "user", content: "Current", timestamp: 3 });
				agent.state.messages = manager.buildSessionContext().messages;
				const previousMessages = agent.state.messages;
				const resets = vi.spyOn(agent, "resetSanitizerPrefixHorizon");
				invalidations.mockClear();
				const appendLabel = manager.appendLabelChange.bind(manager);
				const failure = outcome === "undefined_error" ? undefined : new Error("Label persistence failed");
				const publications: Array<{
					messages: typeof agent.state.messages;
					context: typeof agent.state.messages;
					invalidations: number;
					resets: number;
				}> = [];
				const labels = vi.spyOn(manager, "appendLabelChange").mockImplementation((target, label) => {
					publications.push({
						messages: agent.state.messages,
						context: manager.buildSessionContext().messages,
						invalidations: invalidations.mock.calls.length,
						resets: resets.mock.calls.length,
					});
					if (outcome === "before_write" || outcome === "undefined_error") throw failure;
					const id = appendLabel(target, label);
					if (outcome === "after_write") throw failure;
					return id;
				});
				const target = destination === "root" ? first : second;
				const navigation = harness.session.navigateTree(target, {
					summarize: destination === "summary",
					label: "Selected branch",
				});
				if (outcome === "success") {
					await expect(navigation).resolves.toMatchObject({ cancelled: false });
				} else {
					await expect(navigation).rejects.toBe(failure);
				}

				const summaries = manager.getEntries().filter((entry) => entry.type === "branch_summary");
				expect(summaries).toHaveLength(destination === "summary" ? 1 : 0);
				const selectedLeaf = destination === "summary" ? summaries[0].id : destination === "root" ? null : first;
				const labelTarget = destination === "summary" ? summaries[0].id : target;
				expect(labels.mock.calls).toEqual([[labelTarget, "Selected branch"]]);
				expect(publications).toHaveLength(1);
				expect(publications[0].messages).toEqual(publications[0].context);
				expect(publications[0].messages).not.toBe(previousMessages);
				expect(publications[0].invalidations).toBe(1);
				expect(publications[0].resets).toBe(1);
				const expectedMessages = destination === "root" ? [] : [{ role: "user", content: "First", timestamp: 1 }];
				if (destination === "summary") {
					expectedMessages.push(
						expect.objectContaining({ role: "branchSummary", summary: "Retained branch summary", fromId: first }),
					);
				}
				expect(publications[0].messages).toEqual(expectedMessages);
				expect(agent.state.messages).toEqual(expectedMessages);
				expect(agent.state.messages).toEqual(manager.buildSessionContext().messages);
				expect(buildSessionContext(manager.getEntries(), manager.getLeafId()).messages).toEqual(expectedMessages);
				expect(manager.getLeafId()).not.toBe(previousLeaf);
				if (outcome === "success" || outcome === "after_write") {
					const labelEntry = manager.getLeafEntry();
					expect(labelEntry).toMatchObject({ type: "label", parentId: selectedLeaf, targetId: labelTarget });
					expect(manager.getLabel(labelTarget)).toBe("Selected branch");
				} else {
					expect(manager.getLeafId()).toBe(selectedLeaf);
					expect(manager.getLabel(labelTarget)).toBeUndefined();
				}
				expect(observedLeaves).toEqual(outcome === "success" ? [manager.getLeafId()] : []);
				expect(invalidations.mock.calls).toEqual([[{ releaseActiveClaim: true }]]);
				expect(resets).toHaveBeenCalledTimes(1);
			} finally {
				await harness.cleanup();
			}
		},
	);
});
