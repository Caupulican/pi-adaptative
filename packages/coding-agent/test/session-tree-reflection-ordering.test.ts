import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableLearningState } from "../src/core/learning/durable-learning-state.ts";
import { ReflectionController } from "../src/core/reflection-controller.ts";
import { createHarness, type HarnessOptions } from "./suite/harness.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function createReflectionHarness(extensionFactories: HarnessOptions["extensionFactories"]) {
	vi.stubEnv("PI_NATIVE_REFLECTION", "1");
	vi.stubEnv("PI_AUTO_LEARN_CHILD", "0");
	// Disabled construction reads the empty cue once. Capture that real controller
	// through a forwarding spy instead of replacing it or accessing private fields.
	const reads = vi.spyOn(ReflectionController.prototype, "getCurrentTurnCueState");
	const harness = await createHarness({
		settings: { memorySystem: "okf", autoLearn: { enabled: false, reflectionReview: true } },
		extensionFactories,
	});
	const reflection = reads.mock.contexts.find(
		(context): context is ReflectionController => context instanceof ReflectionController,
	);
	if (!reflection) throw new Error("Native session did not construct its reflection controller");
	harness.settingsManager.setAutoLearnSettings({ enabled: true, reflectionReview: true });
	return { ...harness, reflection, learning: DurableLearningState.forAgentDir(harness.tempDir) };
}

describe("branch publication and reflection invalidation", () => {
	it("invalidates before observers run and never again when an older observer finishes", async () => {
		const invalidations = vi.spyOn(ReflectionController.prototype, "invalidateCurrentTurnCueStateCache");
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const observations: Array<{
			leaf: string | null;
			invalidations: number;
			cue: ReturnType<ReflectionController["getCurrentTurnCueState"]>;
			claimOwner: string | null | undefined;
		}> = [];
		const harness = await createReflectionHarness([
			(pi) => {
				pi.on("session_tree", async (event) => {
					observations.push({
						leaf: event.newLeafId,
						invalidations: invalidations.mock.calls.length,
						cue: harness.reflection.getCurrentTurnCueState(),
						claimOwner: harness.learning.readSnapshot()?.currentClaimOwnerId,
					});
					if (observations.length === 1) {
						entered.resolve();
						await released.promise;
					}
				});
			},
		]);
		let pending: ReturnType<typeof harness.session.navigateTree> | undefined;
		try {
			const first = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
			const second = harness.sessionManager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
			harness.sessionManager.appendMessage({ role: "user", content: "Current", timestamp: 3 });
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			expect(harness.reflection.queueExternalRootTurnCue()).toBe("attached");
			const oldCue = harness.reflection.getCurrentTurnCueState();
			if (!oldCue?.versionChange) throw new Error("Expected an actual durable claim before navigation");
			expect(harness.learning.readSnapshot()?.currentClaimOwnerId).toBe(oldCue.versionChange.token.ownerId);
			invalidations.mockClear();
			pending = harness.session.navigateTree(first);
			await Promise.race([
				entered.promise,
				pending.then(() => {
					throw new Error("Navigation settled without entering its held observer");
				}),
			]);
			expect(observations).toEqual([{ leaf: null, invalidations: 1, cue: undefined, claimOwner: null }]);
			expect(invalidations.mock.calls).toEqual([[{ releaseActiveClaim: true }]]);
			await expect(harness.session.navigateTree(second)).resolves.toMatchObject({ cancelled: false });
			expect(observations).toEqual([
				{ leaf: null, invalidations: 1, cue: undefined, claimOwner: null },
				{ leaf: first, invalidations: 2, cue: undefined, claimOwner: null },
			]);
			expect(harness.reflection.queueExternalRootTurnCue()).toBe("attached");
			expect(harness.reflection.queueCurrentTurnCue("durable")).toBe(true);
			expect(harness.reflection.beginDueReflectionTurn()).toBeDefined();
			const preview = harness.reflection.previewCurrentTurnCue();
			if (!preview) throw new Error("Expected the new branch's due reflection cue");
			preview.commit();
			const newerCue = harness.reflection.getCurrentTurnCueState();
			if (!newerCue?.versionChange) throw new Error("Expected the new branch's durable claim");
			expect(newerCue).toMatchObject({ status: "consumed", activeRunToken: expect.any(String) });
			expect(newerCue.versionChange.token.claimId).not.toBe(oldCue.versionChange.token.claimId);
			const newerLeaf = harness.sessionManager.getLeafId();
			const newerClaim = harness.learning.readSnapshot();
			const messages = harness.session.agent.state.messages;
			released.resolve();
			await pending;
			expect(invalidations.mock.calls).toEqual([[{ releaseActiveClaim: true }], [{ releaseActiveClaim: true }]]);
			expect(harness.sessionManager.getLeafId()).toBe(newerLeaf);
			expect(harness.session.agent.state.messages).toBe(messages);
			expect(harness.reflection.getCurrentTurnCueState()).toBe(newerCue);
			expect(harness.learning.readSnapshot()).toEqual(newerClaim);
			expect(harness.learning.renewClaim(newerCue.versionChange.token)).toBe(true);
		} finally {
			released.resolve();
			try {
				await pending;
			} finally {
				harness.reflection.endReflectionTurn();
				await harness.cleanup();
			}
		}
	});

	it.each(["current_leaf", "cancelled"] as const)("preserves reflection state when navigation is %s", async (kind) => {
		const invalidations = vi.spyOn(ReflectionController.prototype, "invalidateCurrentTurnCueStateCache");
		const harness = await createReflectionHarness([
			(pi) => pi.on("session_before_tree", async () => ({ cancel: true })),
		]);
		try {
			const first = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
			harness.sessionManager.appendMessage({ role: "user", content: "Current", timestamp: 2 });
			expect(harness.reflection.queueExternalRootTurnCue()).toBe("attached");
			expect(harness.reflection.queueCurrentTurnCue("durable")).toBe(true);
			expect(harness.reflection.beginDueReflectionTurn()).toBeDefined();
			const preview = harness.reflection.previewCurrentTurnCue();
			if (!preview) throw new Error("Expected a due reflection cue");
			preview.commit();
			const cue = harness.reflection.getCurrentTurnCueState();
			if (!cue?.versionChange) throw new Error("Expected an actual durable claim");
			const current = harness.sessionManager.getLeafId();
			if (!current) throw new Error("Expected the persisted cue leaf");
			const claim = harness.learning.readSnapshot();
			invalidations.mockClear();
			await expect(harness.session.navigateTree(kind === "current_leaf" ? current : first)).resolves.toEqual({
				cancelled: kind === "cancelled",
			});
			expect(harness.sessionManager.getLeafId()).toBe(current);
			expect(invalidations).not.toHaveBeenCalled();
			expect(harness.reflection.getCurrentTurnCueState()).toBe(cue);
			expect(harness.learning.readSnapshot()).toEqual(claim);
			expect(harness.learning.renewClaim(cue.versionChange.token)).toBe(true);
		} finally {
			harness.reflection.endReflectionTurn();
			await harness.cleanup();
		}
	});
});
