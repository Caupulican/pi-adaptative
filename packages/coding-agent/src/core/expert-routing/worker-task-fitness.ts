import { createHash } from "node:crypto";
import { confidenceGate } from "../system-one/authority-line.ts";
import type { RouteChoiceJudge, WorkerTaskFitInput } from "./system-one-choice.ts";

/** Separate the durable machine reason from the actionable, bounded diagnostic. */
export interface WorkerTaskFitnessFailure {
	reasonCode: string;
	detail?: string;
}

export function formatWorkerTaskFitnessFailure(failure: WorkerTaskFitnessFailure): string {
	return failure.detail ? `${failure.reasonCode}:${failure.detail}` : failure.reasonCode;
}

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

interface WorkerTaskFitnessEvaluation {
	readonly controller: AbortController;
	readonly promise: Promise<WorkerTaskFitnessFailure | undefined>;
	waiters: number;
}

/** Task fitness is separate from model availability, role labels, price, and thinking-level support. */
export class WorkerTaskFitness {
	private judge: RouteChoiceJudge | undefined;
	private sessionIdentity: string | undefined;
	private readonly accepted = new Map<string, true>();
	private readonly pending = new Map<string, { evaluationId: string; question: string }>();
	private readonly evaluating = new Map<string, WorkerTaskFitnessEvaluation>();

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
	): Promise<WorkerTaskFitnessFailure | undefined> {
		const sessionIdentity = judge?.getWorkerTaskFitSessionIdentity?.();
		if (judge !== this.judge || sessionIdentity !== this.sessionIdentity) {
			const retired = [...this.evaluating.values()];
			this.accepted.clear();
			this.pending.clear();
			this.evaluating.clear();
			this.judge = judge;
			this.sessionIdentity = sessionIdentity;
			for (const evaluation of retired) evaluation.controller.abort();
		}
		if (!judge?.evaluateWorkerTaskFit) return { reasonCode: "worker_task_fitness_unavailable" };
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
				return {
					reasonCode: "worker_task_model_inadequate",
					detail: `${input.model}; the recorded reasoning decision requires a stronger model/effort or narrower task`,
				};
			return this.pendingFailure(input, pending);
		}
		let evaluation = this.evaluating.get(key);
		if (!evaluation) {
			const completion = Promise.withResolvers<WorkerTaskFitnessFailure | undefined>();
			evaluation = { controller: new AbortController(), promise: completion.promise, waiters: 0 };
			this.evaluating.set(key, evaluation);
			const owned = evaluation;
			const clear = () => {
				if (this.evaluating.get(key) === owned) this.evaluating.delete(key);
			};
			void completion.promise.then(clear, clear);
			// Publish the flight before the judge can invoke any reentrant callbacks.
			void Promise.resolve()
				.then(() => this.evaluate(judge, snapshot, key, sessionIdentity, owned))
				.then(completion.resolve, completion.reject);
		}
		return this.waitForEvaluation(key, evaluation, signal);
	}

	private async evaluate(
		judge: RouteChoiceJudge,
		input: WorkerTaskFitInput,
		key: string,
		sessionIdentity: string | undefined,
		evaluation: WorkerTaskFitnessEvaluation,
	): Promise<WorkerTaskFitnessFailure | undefined> {
		evaluation.controller.signal.throwIfAborted();
		const answers = await judge.evaluateWorkerTaskFit!(input, evaluation.controller.signal);
		if (
			this.judge !== judge ||
			this.sessionIdentity !== sessionIdentity ||
			judge.getWorkerTaskFitSessionIdentity?.() !== sessionIdentity ||
			this.evaluating.get(key) !== evaluation
		)
			return { reasonCode: "worker_task_fitness_stale" };
		evaluation.controller.signal.throwIfAborted();
		const status = workerTaskFitStatus(answers.worker_task_fit);
		if (status !== "adequate") {
			if (status === "uncertain") {
				if (typeof answers.evaluationId !== "string" || typeof answers.question !== "string")
					return {
						reasonCode: "worker_task_model_unconfirmed",
						detail: `${input.model}; task fitness has no recorded evaluation identity`,
					};
				const pending = { evaluationId: answers.evaluationId, question: answers.question };
				if (this.pending.size >= 128) this.pending.delete(this.pending.keys().next().value!);
				this.pending.set(key, pending);
				return this.pendingFailure(input, pending);
			}
			return {
				reasonCode: "worker_task_model_inadequate_or_unconfirmed",
				detail: `${input.model}; use a stronger capable model/effort or narrow the task with evidence`,
			};
		}
		this.accept(key);
	}

	private waitForEvaluation(
		key: string,
		evaluation: WorkerTaskFitnessEvaluation,
		signal?: AbortSignal,
	): Promise<WorkerTaskFitnessFailure | undefined> {
		signal?.throwIfAborted();
		evaluation.waiters++;
		return new Promise((resolve, reject) => {
			let finished = false;
			const finish = (result: { value: WorkerTaskFitnessFailure | undefined } | { error: unknown }) => {
				if (finished) return;
				finished = true;
				signal?.removeEventListener("abort", onAbort);
				evaluation.waiters--;
				if (evaluation.waiters === 0 && this.evaluating.get(key) === evaluation) {
					this.evaluating.delete(key);
					evaluation.controller.abort();
				}
				if ("value" in result) resolve(result.value);
				else reject(result.error);
			};
			const onAbort = () => finish({ error: signal?.reason });
			signal?.addEventListener("abort", onAbort, { once: true });
			void evaluation.promise.then(
				(value) => finish({ value }),
				(error: unknown) => finish({ error }),
			);
			if (signal?.aborted) onAbort();
		});
	}

	private pendingFailure(
		input: WorkerTaskFitInput,
		pending: { evaluationId: string; question: string },
	): WorkerTaskFitnessFailure {
		return {
			reasonCode: "worker_task_model_unconfirmed",
			// The retained diagnostic is bounded. Put both exact resolution keys before advisory text.
			detail: `evaluationId=${pending.evaluationId}; question=${pending.question}; review ${input.model} and resolve_uncertainty with workerTaskFit=adequate or inadequate`,
		};
	}

	private accept(key: string): void {
		if (this.accepted.size >= 128) this.accepted.delete(this.accepted.keys().next().value!);
		this.accepted.set(key, true);
		this.pending.delete(key);
	}
}
