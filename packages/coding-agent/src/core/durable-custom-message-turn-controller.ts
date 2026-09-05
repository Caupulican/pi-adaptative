import type { CustomMessage } from "@caupulican/pi-agent-core";
import type { ForegroundRecoveryController, ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import type { GoalExecutionLease, GoalSessionController } from "./goals/goal-session-controller.ts";

interface DurableCustomMessageTurnControllerDeps {
	foreground: ForegroundRecoveryController;
	goals: Pick<GoalSessionController, "beginExecution" | "endExecution">;
	enqueueSteeringMessage(message: CustomMessage<unknown>): void;
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

	async start<T>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		submissionLease: ForegroundSubmissionLease,
		goalId?: string,
	): Promise<{ completion: Promise<void> }> {
		const { appMessage, acceptedPromise, rejectAccepted } = this.prepare(message);
		let goalExecutionLease: GoalExecutionLease | undefined;
		try {
			goalExecutionLease = this.deps.goals.beginExecution(goalId);
		} catch (error) {
			this.pending.delete(appMessage);
			throw error;
		}
		let completion: Promise<void>;
		try {
			completion = this.deps.foreground
				.runAgentPrompt(appMessage, submissionLease)
				.finally(() => this.deps.goals.endExecution(goalExecutionLease));
		} catch (error) {
			// runAgentPrompt is expected to report failure through its returned promise, but if it
			// throws SYNCHRONOUSLY instead, the .finally() above never attaches and the goal
			// execution lease acquired above leaks forever. Every exit path must release it.
			this.deps.goals.endExecution(goalExecutionLease);
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

	/** Resume canonical history after a host handoff, retaining the ordinary goal budget lease. */
	async continue(prepare: () => Promise<void>, goalId?: string): Promise<void> {
		const submission = await this.deps.foreground.acquireSubmission();
		let goalLease: GoalExecutionLease | undefined;
		try {
			goalLease = this.deps.goals.beginExecution(goalId);
			await prepare();
			await this.deps.foreground.runAgentContinuation(submission);
		} finally {
			this.deps.goals.endExecution(goalLease);
			this.deps.foreground.releaseSubmission(submission);
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
