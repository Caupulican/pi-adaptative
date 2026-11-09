import { createHash } from "node:crypto";
import type { RouteChoiceJudge, WorkerTaskFitInput } from "./system-one-choice.ts";
import { decideWorkerTaskFit, type WorkerTaskFitVerdict } from "./worker-task-fit-exits.ts";

/** Separate the durable machine reason from the actionable, bounded diagnostic. */
export interface WorkerTaskFitnessFailure {
	reasonCode: string;
	detail?: string;
	/**
	 * Set when System One judged the fit: `inadequate` (F2) or `open` (F3). An unpinned lane's admission moves to its
	 * next ranked candidate on either and blocks with `exhaustedTaskFitBlocker` when none is left.
	 */
	fit?: Exclude<WorkerTaskFitVerdict, "adequate">;
}

export interface WorkerTaskFitnessOptions {
	/**
	 * The model is pinned, named or bound by a profile or reused contract (default true). A bound model is never
	 * replaced: an open answer keeps a pending question the owner or root may settle. An unbound lane's open answer
	 * raises no doubt; its admission moves to the next candidate.
	 */
	readonly bound?: boolean;
}

export function formatWorkerTaskFitnessFailure(failure: WorkerTaskFitnessFailure): string {
	return failure.detail ? `${failure.reasonCode}:${failure.detail}` : failure.reasonCode;
}

export function workerTaskFitKey(input: WorkerTaskFitInput): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
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
		options?: WorkerTaskFitnessOptions,
	): Promise<WorkerTaskFitnessFailure | undefined> {
		const bound = options?.bound !== false;
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
		const pending = bound ? this.pending.get(key) : undefined;
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
					fit: "inadequate",
					detail: `${input.model}; the recorded reasoning decision requires a stronger model/effort or narrower task`,
				};
			return this.pendingFailure(input, pending);
		}
		// A bound and an unbound check of the same input seal different doubts, so each has its own flight.
		const flight = `${key}:${bound ? "bound" : "unbound"}`;
		let evaluation = this.evaluating.get(flight);
		if (!evaluation) {
			const completion = Promise.withResolvers<WorkerTaskFitnessFailure | undefined>();
			evaluation = { controller: new AbortController(), promise: completion.promise, waiters: 0 };
			this.evaluating.set(flight, evaluation);
			const owned = evaluation;
			const clear = () => {
				if (this.evaluating.get(flight) === owned) this.evaluating.delete(flight);
			};
			void completion.promise.then(clear, clear);
			// Publish the flight before the judge can invoke any reentrant callbacks.
			void Promise.resolve()
				.then(() => this.evaluate(judge, snapshot, key, flight, bound, sessionIdentity, owned))
				.then(completion.resolve, completion.reject);
		}
		return this.waitForEvaluation(flight, evaluation, signal);
	}

	private async evaluate(
		judge: RouteChoiceJudge,
		input: WorkerTaskFitInput,
		key: string,
		flight: string,
		bound: boolean,
		sessionIdentity: string | undefined,
		evaluation: WorkerTaskFitnessEvaluation,
	): Promise<WorkerTaskFitnessFailure | undefined> {
		evaluation.controller.signal.throwIfAborted();
		const answers = await judge.evaluateWorkerTaskFit!(input, evaluation.controller.signal, { bound });
		if (
			this.judge !== judge ||
			this.sessionIdentity !== sessionIdentity ||
			judge.getWorkerTaskFitSessionIdentity?.() !== sessionIdentity ||
			this.evaluating.get(flight) !== evaluation
		)
			return { reasonCode: "worker_task_fitness_stale" };
		evaluation.controller.signal.throwIfAborted();
		const fit = decideWorkerTaskFit(answers);
		// F1: admit.
		if (fit.verdict === "adequate") {
			this.accept(key);
			return;
		}
		// F2: inadequate. A bound model is reported with guidance; an unbound lane moves to its next candidate.
		if (fit.verdict === "inadequate")
			return {
				reasonCode: "worker_task_model_inadequate",
				fit: "inadequate",
				detail: bound
					? `${input.model}; ${fit.trace}; use a stronger capable model/effort or narrow the task with evidence`
					: `${input.model}; ${fit.trace}`,
			};
		// F3: open. Only a bound model keeps a pending question; an unbound lane asks again on its next candidate.
		if (!bound)
			return { reasonCode: "worker_task_model_fit_open", fit: "open", detail: `${input.model}; ${fit.trace}` };
		if (typeof answers.evaluationId !== "string" || typeof answers.question !== "string")
			return {
				reasonCode: "worker_task_model_unconfirmed",
				fit: "open",
				detail: `${input.model}; task fitness has no recorded evaluation identity`,
			};
		const pending = { evaluationId: answers.evaluationId, question: answers.question };
		if (this.pending.size >= 128) this.pending.delete(this.pending.keys().next().value!);
		this.pending.set(key, pending);
		return this.pendingFailure(input, pending);
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
			fit: "open",
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
