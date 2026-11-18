/** Recorded direct worker cost for retained tasks whose latest attempt has ended, including unsuccessful work.
 * The completed unit is one task with an accepted host outcome for its current attempt. Earlier attempts
 * contribute their own cost once. Outcome summaries and parent receipts can describe those same dollars.
 */

import { sameOutcomeAttempt } from "../delegation/worker-outcome-words.ts";
import { selectedTaskAttempt } from "../orchestration/attempt-ordering.ts";
import { EMPTY_ATTEMPT_USAGE, recordedAttemptCostUsd } from "../orchestration/attempt-usage.ts";
import type { AttemptUsageGeneration } from "../orchestration/attempt-usage-generations.ts";
import type { AttemptUsageSnapshot } from "../orchestration/contracts.ts";
import {
	type AttemptRuntimeState,
	type TaskRuntimeProjection,
	terminalAttemptStatus,
} from "../orchestration/task-runtime-state.ts";

/** A zero-dollar counter can be an unpriced response. The generation baseline can also hold recovered usage. */
function tokensWithoutRecordedCost(before: AttemptUsageSnapshot, after: AttemptUsageSnapshot): boolean {
	return (
		after.costUsd === before.costUsd &&
		(after.totalTokens > before.totalTokens ||
			after.inputTokens > before.inputTokens ||
			after.outputTokens > before.outputTokens ||
			after.cacheReadTokens > before.cacheReadTokens ||
			after.cacheWriteTokens > before.cacheWriteTokens)
	);
}

function hasUnpricedGeneration(attempt: AttemptRuntimeState): boolean {
	let first: AttemptUsageGeneration | undefined;
	for (const generation of Object.values(attempt.usageAccounting?.generations ?? {})) {
		if (tokensWithoutRecordedCost(generation.baseline, generation.reported)) return true;
		if (!first || generation.fencingToken < first.fencingToken) first = generation;
	}
	// Later baselines include earlier generations at registration time. A late charge to an earlier
	// generation can supersede that historical zero, so inspect only the original recovery baseline.
	return first !== undefined && tokensWithoutRecordedCost(EMPTY_ATTEMPT_USAGE, first.baseline);
}

export function retainedWorkerTaskSpend(snapshot: TaskRuntimeProjection) {
	let recordedUsd = 0;
	let settledTasks = 0;
	let acceptedTasks = 0;
	let attempts = 0;
	let missingCosts = 0;
	let missingOutcomes = 0;
	for (const task of Object.values(snapshot.tasks)) {
		const latest = selectedTaskAttempt(snapshot, task.task.taskId);
		if (!latest || !terminalAttemptStatus(latest.status)) continue;
		settledTasks++;
		const outcome = sameOutcomeAttempt(task.outcome, latest.attemptId);
		if (outcome?.scope !== "lane" || outcome.taskId !== task.task.taskId) missingOutcomes++;
		else if (outcome.status === "succeeded" && outcome.nextAction.kind === "accept") acceptedTasks++;
		for (const id of task.attemptIds) {
			attempts++;
			const attempt = snapshot.attempts[id];
			if (!attempt || attempt.taskId !== task.task.taskId) {
				missingCosts++;
				continue;
			}
			const cost = recordedAttemptCostUsd(attempt, snapshot.checkpoints);
			recordedUsd += cost ?? 0;
			// An empty generation is registered before the first response. Its initial zero neither establishes
			// a free task nor distinguishes it from missing billing. The ledger has no affirmative free-price flag.
			if (cost === undefined || cost === 0 || hasUnpricedGeneration(attempt)) missingCosts++;
		}
	}
	const perAcceptedUsd = acceptedTasks && !missingCosts && !missingOutcomes ? recordedUsd / acceptedTasks : undefined;
	return { recordedUsd, settledTasks, acceptedTasks, attempts, missingCosts, missingOutcomes, perAcceptedUsd };
}
