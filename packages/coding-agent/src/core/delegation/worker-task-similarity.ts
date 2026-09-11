import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { ACTIVE_WORKER_ATTEMPT_STATUSES, isManagedWorkerAttempt } from "./worker-lane-projection.ts";

/** Above this, two instruction texts are the same task; the second dispatch is absorbed, not started. */
export const DUPLICATE_WORKER_TASK_THRESHOLD = 0.9;
/** Above this, the second lane starts but the reply names the similar one so the parent can cancel a copy. */
export const SIMILAR_WORKER_TASK_THRESHOLD = 0.6;

export interface SimilarWorkerLane {
	laneId: string;
	similarity: number;
}

function tokens(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			// Punctuation and path separators split: "edit." and "edit", "a/b" and "a b" are the same words.
			.split(/[^a-z0-9_-]+/)
			.filter((token) => token.length >= 3),
	);
}

/** Jaccard similarity of the instruction vocabularies; 1 for identical text, 0 for disjoint. */
export function workerInstructionSimilarity(a: string, b: string): number {
	const left = tokens(a);
	const right = tokens(b);
	if (left.size === 0 && right.size === 0) return 1;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared++;
	return shared / (left.size + right.size - shared);
}

/**
 * Active in-process lanes (queued, leased, running) whose instructions resemble the new ones, most
 * similar first. Live census 2026-09-10: a "smart swarm" re-dispatched the same three read-only
 * reviews it had started a minute earlier and then cancelled them; the runtime saw seven lanes for
 * four tasks. Comparison is by instruction text only; the model's own agentId reuse and profiles
 * decide everything else.
 */
export function findSimilarActiveWorkerLanes(
	snapshot: TaskRuntimeProjection,
	instructions: string,
	threshold = SIMILAR_WORKER_TASK_THRESHOLD,
): SimilarWorkerLane[] {
	const seen = new Set<string>();
	const matches: SimilarWorkerLane[] = [];
	const attempts: AttemptRuntimeState[] = Object.values(snapshot.attempts);
	for (const attempt of attempts) {
		if (!ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status) || isManagedWorkerAttempt(attempt)) continue;
		if (seen.has(attempt.taskId)) continue;
		seen.add(attempt.taskId);
		const similarity = workerInstructionSimilarity(attempt.dispatch.instructions, instructions);
		if (similarity >= threshold) matches.push({ laneId: attempt.taskId, similarity });
	}
	return matches.sort((a, b) => b.similarity - a.similarity || a.laneId.localeCompare(b.laneId));
}
