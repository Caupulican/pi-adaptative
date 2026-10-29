import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { captureRepoDeliveryFingerprint } from "../objective-execution/repo-delivery-fingerprint.ts";
import { discoverWorkRepositoryAsync } from "../system-one/work-diff.ts";
import { type PeerReviewScope, peerReviewDigest } from "./peer-review-journal.ts";

interface ContextOwner {
	getSessionManager(): SessionManager;
	getGoal(): GoalState | undefined;
	getCwd(): string;
	isCurrent(): boolean;
	isSystemOneEnabled(): boolean;
}

/** Exact root, branch, objective and repository lifetime, independent of any evaluator. */
export async function capturePeerReviewContext(owner: ContextOwner, signal?: AbortSignal) {
	const manager = owner.getSessionManager();
	const assertBranch = manager.captureBranchContext();
	const cwd = owner.getCwd();
	const semanticEnabled = owner.isSystemOneEnabled();
	const objectiveOf = () => {
		const goal = owner.getGoal();
		return goal
			? {
					goalId: goal.goalId,
					objective: goal.userGoal,
					requirements: goal.requirements.map(
						({ status: _status, evidenceIds: _evidence, ...definition }) => definition,
					),
				}
			: undefined;
	};
	const objective = objectiveOf();
	const outcomeEvidence = owner.getGoal()?.evidence ?? [];
	const outcomeDigest = peerReviewDigest(outcomeEvidence);
	const contractDigest = peerReviewDigest(objective ?? null);
	const assertOwner = () => {
		signal?.throwIfAborted();
		if (
			!owner.isCurrent() ||
			owner.getSessionManager() !== manager ||
			owner.getCwd() !== cwd ||
			owner.isSystemOneEnabled() !== semanticEnabled
		)
			throw new Error("Root advisor ownership or mode changed; review is stale.");
		assertBranch();
		if (peerReviewDigest(objectiveOf() ?? null) !== contractDigest)
			throw new Error("Root objective changed; review is stale.");
	};
	assertOwner();
	const capture = async () => {
		const discovery = await discoverWorkRepositoryAsync(cwd, { signal });
		if (discovery.diagnostic) throw new Error(`Advisor repository discovery failed: ${discovery.diagnostic}`);
		if (!discovery.root) return undefined;
		const value = await captureRepoDeliveryFingerprint(discovery.root, undefined, { signal });
		if (!value.ok) throw new Error(`Advisor candidate capture failed: ${value.reason}`);
		return value;
	};
	const fingerprint = await capture();
	assertOwner();
	const scope: PeerReviewScope = {
		sessionId: manager.getSessionId(),
		...(objective ? { objectiveId: objective.goalId } : {}),
		contractDigest,
		semanticEnabled,
		candidateId: fingerprint ? fingerprint.digest : `snapshot:${peerReviewDigest([cwd, outcomeEvidence])}`,
		candidateKind: fingerprint ? "repository" : "snapshot",
		sourceRevision: fingerprint?.head ?? "unresolved",
	};
	return {
		scope,
		objective: { ...objective, evidence: outcomeEvidence },
		assertCurrent: async () => {
			assertOwner();
			const current = await capture();
			assertOwner();
			if (fingerprint ? current?.digest !== fingerprint.digest : current !== undefined)
				throw new Error("Root review candidate changed; review is stale.");
			if (!fingerprint && peerReviewDigest(owner.getGoal()?.evidence ?? []) !== outcomeDigest)
				throw new Error("Root outcome evidence changed; review is stale.");
		},
	};
}
