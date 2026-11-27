import { type Agent, type AgentMessage, type CustomMessage, createCustomMessage } from "../kernel/index.ts";
import type { ForegroundRecoveryController, ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import {
	type ParentInputDelivery,
	ParentInputDeliveryController,
	type ParentInputDeliveryDeps,
	type ParentInputDeliveryOptions,
	type ParentInputReceipt,
} from "./parent-input-delivery.ts";
import type { SteeredInputAdmission, SteeredMessage } from "./parent-input-steer.ts";
import { CLOSING_RUN_SETTLE_MS, runSettlesWithin } from "./session-shutdown.ts";
import { deepFreeze } from "./util/deep-freeze.ts";
import { runReleaseSteps } from "./util/resource-release.ts";

interface DurableCustomMessageTurnControllerDeps {
	foreground: ForegroundRecoveryController;
	parentInput?: ParentInputDeliveryDeps;
	/** A turn's goal execution belongs to its submission and ends when that submission releases the foreground. */
	goals: Pick<GoalSessionController, "beginExecution">;
	/** The agent whose steering queue a running turn reads at each model step. */
	steering(): Pick<Agent, "steer" | "withdrawQueuedMessage" | "state">;
	/** Commit under the held foreground lease before provider preparation can wait. */
	appendMessage(message: CustomMessage<unknown>, lease: ForegroundSubmissionLease): Promise<void>;
	claimCorrection(turnOpening: CustomMessage<unknown>): Promise<string | undefined>;
	flushOwnerItems(submissionLease: ForegroundSubmissionLease): Promise<void>;
}

/**
 * Starts an internal custom-message turn and separates durable input acceptance from full model-run
 * completion. Notification outboxes may acknowledge after `start` resolves, while the foreground
 * owner retains its lease until the returned completion settles.
 */
export class DurableCustomMessageTurnController {
	private readonly deps: DurableCustomMessageTurnControllerDeps;
	private readonly parentInputs: ParentInputDeliveryController | undefined;
	private readonly pending = new Map<
		CustomMessage<unknown>,
		{
			resolve(): void;
			reject(error: unknown): void;
			admit?: SteeredInputAdmission;
			persisted?: boolean;
		}
	>();

	constructor(deps: DurableCustomMessageTurnControllerDeps) {
		this.deps = deps;
		this.parentInputs = deps.parentInput
			? new ParentInputDeliveryController(
					{ ...deps.parentInput, steer: (message, admit) => this.steer(message, admit) },
					deps.foreground,
					deps.goals,
					(opening, lease) => this.finishTurn(opening, lease),
				)
			: undefined;
	}

	async deliverParentInput(
		input: ParentInputDelivery,
		options?: ParentInputDeliveryOptions,
	): Promise<ParentInputReceipt> {
		if (!this.parentInputs) throw new Error("Durable parent input delivery is unavailable.");
		return this.parentInputs.deliver(input, options);
	}

	/** Immediately before the running turn polls its steering queue: steered parent inputs join it. */
	flushParentSteers(): void {
		this.parentInputs?.flushSteers();
	}

	startParentInputs(): void {
		this.parentInputs?.start();
	}
	displayParentNotes(deliveryIds: readonly string[]): void {
		this.parentInputs?.displayAcceptedNotes(deliveryIds);
	}
	recoverParentInputs(): void {
		this.parentInputs?.recover();
	}
	async settleParentInputs(): Promise<void> {
		await this.parentInputs?.settled();
	}

	async closeParentInputsBefore(dispose: () => Promise<void>): Promise<void> {
		this.parentInputs?.shutdown();
		const settle = this.settleParentInputs();
		if (await runSettlesWithin(settle, CLOSING_RUN_SETTLE_MS)) {
			await dispose();
			return;
		}
		const late = settle.then(dispose, dispose);
		this.deps.parentInput!.holdLateWork(late);
		this.deps.parentInput!.warn(
			"Parent input shutdown is waiting for its physical work to settle; runtime dependencies remain held.",
		);
	}

	private async finishTurn(opening: CustomMessage<unknown>, lease: ForegroundSubmissionLease): Promise<void> {
		const correction = await this.deps.claimCorrection(opening);
		if (lease.signal.aborted) return;
		if (correction)
			await this.deps.foreground.runAgentPrompt(
				createCustomMessage("claim_delivery", correction, true, undefined, new Date().toISOString()),
				lease,
			);
		await this.deps.flushOwnerItems(lease);
	}

	/** Accept only the exact custom-message object after SessionManager append succeeds. */
	notePersisted(message: CustomMessage<unknown>): boolean {
		const acceptance = this.pending.get(message);
		if (!acceptance) return false;
		this.pending.delete(message);
		acceptance.resolve();
		return true;
	}

	isPersistedSteer(message: AgentMessage): boolean {
		return message.role === "custom" && this.pending.get(message)?.persisted === true;
	}

	/** A declined producer settles its own receipt without interrupting the foreground run. */
	admitQueuedInput(message: AgentMessage, signal?: AbortSignal): boolean | Promise<boolean> {
		if (message.role !== "custom") return true;
		const pending = this.pending.get(message);
		if (!pending?.admit) return true;
		return pending.admit(message, signal).then(
			(admitted) => {
				if (admitted) pending.persisted = true;
				else this.notePersisted(message);
				return admitted;
			},
			(error: unknown) => {
				this.pending.delete(message);
				pending.reject(error);
				return false;
			},
		);
	}

	/** Reject queued delivery receipts that can no longer reach persistence during session shutdown. */
	shutdown(): void {
		this.parentInputs?.shutdown();
		const error = new Error("Session disposed before a custom message was persisted");
		for (const acceptance of this.pending.values()) acceptance.reject(error);
		this.pending.clear();
	}

	/** Queue a custom message for the next provider boundary and resolve only after durable append. */
	async enqueue<T>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">): Promise<void> {
		await this.steer(message).accepted;
	}

	/**
	 * Queue a message for the running turn's next model step (an idle session's next run reads it first); the handle takes it
	 * back until a run consumes it, and its acceptance settles after durable append.
	 */
	steer<T>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		admit?: SteeredInputAdmission,
	): SteeredMessage {
		const { appMessage, acceptedPromise } = this.prepare(message, admit);
		const agent = this.deps.steering();
		try {
			agent.steer(appMessage);
		} catch (error) {
			this.pending.delete(appMessage);
			throw error;
		}
		return {
			accepted: acceptedPromise,
			withdraw: () => {
				if (!agent.withdrawQueuedMessage(appMessage)) return false;
				this.pending.delete(appMessage);
				return true;
			},
			abandon: () => {
				agent.withdrawQueuedMessage(appMessage);
				this.pending.delete(appMessage);
			},
		};
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
		const appMessage = createCustomMessage(
			message.customType,
			message.content,
			message.display,
			message.details,
			new Date().toISOString(),
		);
		this.deps.goals.beginExecution(goalId);
		await this.deps.appendMessage(appMessage, submissionLease);
		const completion = this.deps.foreground.runCommittedPrompt(appMessage, submissionLease).then(() => {
			if (!submissionLease.signal.aborted) return this.finishTurn(appMessage, submissionLease);
		});
		return { completion };
	}

	/** Resume canonical history after a host handoff; the goal execution ends when the submission is released. */
	async continue(
		prepare: (() => Promise<void>) | undefined,
		goalId?: string,
		beforeContinue?: () => boolean,
	): Promise<void> {
		const submission = await this.deps.foreground.acquireSubmission();
		let continuationFailure: { readonly error: unknown } | undefined;
		try {
			this.deps.goals.beginExecution(goalId);
			if (prepare) await prepare();
			await this.deps.foreground.runAgentContinuation(submission, undefined, beforeContinue);
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

	async continueAfterErrors(isCurrent: (() => boolean) | undefined, goalId?: string): Promise<boolean> {
		let continued = false;
		const prepare = () => {
			if (isCurrent?.() === false) return false;
			const agent = this.deps.steering();
			let messages = agent.state.messages;
			while (true) {
				const last = messages.at(-1);
				if (last?.role !== "assistant" || last.stopReason !== "error") break;
				messages = messages.slice(0, -1);
			}
			if (messages !== agent.state.messages) agent.state.messages = messages;
			continued = true;
			return true;
		};
		await this.continue(
			isCurrent
				? undefined
				: async () => {
						prepare();
					},
			goalId,
			isCurrent ? prepare : undefined,
		);
		return continued;
	}

	private prepare<T>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		admit?: SteeredInputAdmission,
	): {
		appMessage: CustomMessage<T>;
		acceptedPromise: Promise<void>;
		rejectAccepted(error: unknown): void;
	} {
		const raw = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		const appMessage = admit ? deepFreeze(structuredClone(raw)) : raw;
		let resolveAccepted!: () => void;
		let rejectAccepted!: (error: unknown) => void;
		const acceptedPromise = new Promise<void>((resolve, reject) => {
			resolveAccepted = resolve;
			rejectAccepted = reject;
		});
		this.pending.set(appMessage, { resolve: resolveAccepted, reject: rejectAccepted, admit });
		return { appMessage, acceptedPromise, rejectAccepted };
	}
}
