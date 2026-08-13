import type { CustomMessage } from "@caupulican/pi-agent-core";
import type { ForegroundRecoveryController, ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import type { GoalExecutionLease, GoalSessionController } from "./goals/goal-session-controller.ts";

interface DurableCustomMessageTurnControllerDeps {
	foreground: ForegroundRecoveryController;
	goals: Pick<GoalSessionController, "beginExecution" | "endExecution">;
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

	async start<T>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		submissionLease: ForegroundSubmissionLease,
		goalId?: string,
	): Promise<{ completion: Promise<void> }> {
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
		let goalExecutionLease: GoalExecutionLease | undefined;
		try {
			goalExecutionLease = this.deps.goals.beginExecution(goalId);
		} catch (error) {
			this.pending.delete(appMessage);
			throw error;
		}
		const completion = this.deps.foreground
			.runAgentPrompt(appMessage, submissionLease)
			.finally(() => this.deps.goals.endExecution(goalExecutionLease));
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
}
