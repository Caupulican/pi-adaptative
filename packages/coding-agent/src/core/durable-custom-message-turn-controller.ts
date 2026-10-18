import type { CustomMessage } from "../kernel/index.ts";
import type { ForegroundRecoveryController, ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import { runReleaseSteps } from "./util/resource-release.ts";

interface DurableCustomMessageTurnControllerDeps {
	foreground: ForegroundRecoveryController;
	/** A turn's goal execution belongs to its submission and ends when that submission releases the foreground. */
	goals: Pick<GoalSessionController, "beginExecution">;
	enqueueSteeringMessage(message: CustomMessage<unknown>): void;
	/**
	 * Runs after the turn's model run and before its lease is released, with that lease and the turn's opening
	 * message (the custom message the run sent first, by which the turn is found in the history): the claim check
	 * that every answer gets, and the one correction turn a contradicted claim buys.
	 */
	afterTurn?(turnOpening: CustomMessage<unknown>, submissionLease: ForegroundSubmissionLease): Promise<void>;
}

/**
 * Starts an internal custom-message turn and separates durable input acceptance from full model-run
 * completion. Notification outboxes may acknowledge after `start` resolves, while the foreground
 * owner retains its lease until the returned completion settles.
 */
export class DurableCustomMessageTurnController {
	private readonly deps: DurableCustomMessageTurnControllerDeps;
	private readonly pending = new Map<CustomMessage<unknown>, { resolve(): void; reject(error: unknown): void }>();

	constructor(deps: DurableCustomMessageTurnControllerDeps) {
		this.deps = deps;
	}

	/** Accept only the exact custom-message object after SessionManager append succeeds. */
	notePersisted(message: CustomMessage<unknown>): boolean {
		const acceptance = this.pending.get(message);
		if (!acceptance) return false;
		this.pending.delete(message);
		acceptance.resolve();
		return true;
	}

	/** Reject queued delivery receipts that can no longer reach persistence during session shutdown. */
	shutdown(): void {
		const error = new Error("Session disposed before a custom message was persisted");
		for (const acceptance of this.pending.values()) acceptance.reject(error);
		this.pending.clear();
	}

	/** Queue a custom message for the next provider boundary and resolve only after durable append. */
	async enqueue<T>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">): Promise<void> {
		const { appMessage, acceptedPromise } = this.prepare(message);
		try {
			this.deps.enqueueSteeringMessage(appMessage);
		} catch (error) {
			this.pending.delete(appMessage);
			throw error;
		}
		await acceptedPromise;
	}

	/**
	 * The turn's goal execution begins under `submissionLease` and ends when the caller releases it, after `completion`
	 * (the run and `afterTurn`) settles: the claim correction runs while the execution is still held.
	 */
	async start<T>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		submissionLease: ForegroundSubmissionLease,
		goalId?: string,
	): Promise<{ completion: Promise<void> }> {
		const { appMessage, acceptedPromise, rejectAccepted } = this.prepare(message);
		let completion: Promise<void>;
		try {
			this.deps.goals.beginExecution(goalId);
			completion = this.deps.foreground
				.runAgentPrompt(appMessage, submissionLease)
				.then(() => this.deps.afterTurn?.(appMessage, submissionLease));
		} catch (error) {
			this.pending.delete(appMessage);
			throw error;
		}
		void completion.then(
			() => {
				if (!this.pending.delete(appMessage)) return;
				rejectAccepted(new Error("Custom-message turn ended before its input was persisted"));
			},
			(error: unknown) => {
				if (!this.pending.delete(appMessage)) return;
				rejectAccepted(error);
			},
		);
		await acceptedPromise;
		return { completion };
	}

	/** Resume canonical history after a host handoff; the goal execution ends when the submission is released. */
	async continue(prepare: () => Promise<void>, goalId?: string): Promise<void> {
		const submission = await this.deps.foreground.acquireSubmission();
		let continuationFailure: { readonly error: unknown } | undefined;
		try {
			this.deps.goals.beginExecution(goalId);
			await prepare();
			await this.deps.foreground.runAgentContinuation(submission);
		} catch (error) {
			continuationFailure = { error };
			throw error;
		} finally {
			// A failing release surfaces with the continuation's own failure, never in place of it.
			runReleaseSteps(
				[() => this.deps.foreground.releaseSubmission(submission)],
				"Custom-message continuation release failed.",
				continuationFailure,
			);
		}
	}

	private prepare<T>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">): {
		appMessage: CustomMessage<T>;
		acceptedPromise: Promise<void>;
		rejectAccepted(error: unknown): void;
	} {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		let resolveAccepted!: () => void;
		let rejectAccepted!: (error: unknown) => void;
		const acceptedPromise = new Promise<void>((resolve, reject) => {
			resolveAccepted = resolve;
			rejectAccepted = reject;
		});
		this.pending.set(appMessage, { resolve: resolveAccepted, reject: rejectAccepted });
		return { appMessage, acceptedPromise, rejectAccepted };
	}
}
