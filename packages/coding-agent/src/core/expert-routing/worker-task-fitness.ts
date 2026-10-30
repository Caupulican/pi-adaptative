import { createHash } from "node:crypto";
import { confidenceGate } from "../system-one/authority-line.ts";
import type { RouteChoiceJudge, WorkerTaskFitInput } from "./system-one-choice.ts";

export function workerTaskFitKey(input: WorkerTaskFitInput): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function workerTaskFitStatus(answer: unknown): "adequate" | "inadequate" | "uncertain" {
	if (!answer || typeof answer !== "object") return "uncertain";
	const { choice, confidence } = answer as { choice?: unknown; confidence?: unknown };
	return (choice === "adequate" || choice === "inadequate") &&
		confidenceGate(confidence) === "decide" &&
		typeof confidence === "number" &&
		confidence <= 1
		? choice
		: "uncertain";
}

/** Task fitness is separate from model availability, role labels, price, and thinking-level support. */
export class WorkerTaskFitness {
	private judge: RouteChoiceJudge | undefined;
	private sessionIdentity: string | undefined;
	private readonly accepted = new Map<string, true>();
	private readonly pending = new Map<string, { evaluationId: string; question: string }>();
	private readonly evaluating = new Map<string, symbol>();

	/** A synchronous lookup only: dispatch may not yield after its final capacity check. */
	hasAccepted(judge: RouteChoiceJudge | undefined, input: WorkerTaskFitInput): boolean {
		return (
			judge !== undefined &&
			judge === this.judge &&
			judge.getWorkerTaskFitSessionIdentity?.() === this.sessionIdentity &&
			this.accepted.has(workerTaskFitKey(input))
		);
	}

	async check(
		judge: RouteChoiceJudge | undefined,
		input: WorkerTaskFitInput,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const sessionIdentity = judge?.getWorkerTaskFitSessionIdentity?.();
		if (judge !== this.judge || sessionIdentity !== this.sessionIdentity) {
			this.accepted.clear();
			this.pending.clear();
			this.evaluating.clear();
			this.judge = judge;
			this.sessionIdentity = sessionIdentity;
		}
		if (!judge?.evaluateWorkerTaskFit) return "worker_task_fitness_unavailable";
		signal?.throwIfAborted();
		const snapshot = { ...input };
		const key = workerTaskFitKey(snapshot);
		if (this.accepted.has(key)) return;
		const pending = this.pending.get(key);
		if (pending) {
			const decision = judge.getWorkerTaskFitDecision?.(pending.evaluationId, pending.question);
			if (
				decision?.evaluationId === pending.evaluationId &&
				decision.question === pending.question &&
				decision.disposition === "evidence_based_decision" &&
				decision.workerTaskFit === "adequate" &&
				judge.getWorkerTaskFitSessionIdentity?.() === sessionIdentity
			) {
				this.accept(key);
				return;
			}
			if (decision?.workerTaskFit === "inadequate")
				return `worker_task_model_inadequate:${input.model}; the recorded reasoning decision requires a stronger model/effort or narrower task`;
			return this.pendingFailure(input, pending);
		}
		const evaluation = Symbol();
		this.evaluating.set(key, evaluation);
		try {
			const answers = await judge.evaluateWorkerTaskFit(snapshot, signal);
			signal?.throwIfAborted();
			if (
				this.judge !== judge ||
				this.sessionIdentity !== sessionIdentity ||
				judge.getWorkerTaskFitSessionIdentity?.() !== sessionIdentity ||
				this.evaluating.get(key) !== evaluation
			)
				return "worker_task_fitness_stale";
			const status = workerTaskFitStatus(answers.worker_task_fit);
			if (status !== "adequate") {
				if (status === "uncertain") {
					if (typeof answers.evaluationId !== "string" || typeof answers.question !== "string")
						return `worker_task_model_unconfirmed:${input.model}; task fitness has no recorded evaluation identity`;
					const pending = { evaluationId: answers.evaluationId, question: answers.question };
					if (this.pending.size >= 128) this.pending.delete(this.pending.keys().next().value!);
					this.pending.set(key, pending);
					return this.pendingFailure(input, pending);
				}
				return `worker_task_model_inadequate_or_unconfirmed:${input.model}; use a stronger capable model/effort or narrow the task with evidence`;
			}
			this.accept(key);
			return;
		} finally {
			if (this.evaluating.get(key) === evaluation) this.evaluating.delete(key);
		}
	}

	private pendingFailure(input: WorkerTaskFitInput, pending: { evaluationId: string; question: string }): string {
		return `worker_task_model_unconfirmed:${input.model}; review the exact task/model evidence in a reasoning round, then record resolve_uncertainty with workerTaskFit=adequate or inadequate for evaluationId=${pending.evaluationId}, question=${pending.question}; or use a stronger model/effort or narrower task`;
	}

	private accept(key: string): void {
		if (this.accepted.size >= 128) this.accepted.delete(this.accepted.keys().next().value!);
		this.accepted.set(key, true);
		this.pending.delete(key);
	}
}
