import { createHash } from "node:crypto";
import type { RouteChoiceJudge, WorkerTaskFitInput } from "./system-one-choice.ts";

/** Task fitness is separate from model availability, role labels, price, and thinking-level support. */
export class WorkerTaskFitness {
	private judge: RouteChoiceJudge | undefined;
	private readonly accepted = new Map<string, true>();

	async check(
		judge: RouteChoiceJudge | undefined,
		input: WorkerTaskFitInput,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		if (judge !== this.judge) {
			this.accepted.clear();
			this.judge = judge;
		}
		if (!judge?.evaluateWorkerTaskFit) return "worker_task_fitness_unavailable";
		const snapshot = { ...input };
		const key = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
		if (this.accepted.has(key)) return;
		const answers = await judge.evaluateWorkerTaskFit(snapshot, signal);
		signal?.throwIfAborted();
		if (this.judge !== judge) return "worker_task_fitness_stale";
		const answer = answers.worker_task_fit as { choice?: unknown; confidence?: unknown } | undefined;
		if (
			answer?.choice !== "adequate" ||
			typeof answer.confidence !== "number" ||
			!Number.isFinite(answer.confidence) ||
			answer.confidence < 0.9 ||
			answer.confidence > 1
		)
			return `worker_task_model_inadequate_or_unconfirmed:${input.model}; use a stronger capable model/effort or narrow the task with evidence`;
		if (this.accepted.size >= 128) this.accepted.delete(this.accepted.keys().next().value!);
		this.accepted.set(key, true);
		return;
	}
}
