import type { Agent, AgentContextPlanFn, AgentMessage, CustomMessage } from "../kernel/index.ts";
import { type PersistedParentInput, parentInputMessage } from "../kernel/session/parent-input-ledger.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { ForegroundRecoveryController, ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import { type WorkerReceiptOrigin, workerReceiptOriginFromValue } from "./orchestration/worker-receipt-origin.ts";
import { boundedRedactedDiagnosticText } from "./security/secret-text.ts";
import { isSessionAppendAnchorCurrent } from "./session-snapshot.ts";
import { isPlainRecord } from "./util/value-guards.ts";

export interface ParentInputDelivery {
	readonly deliveryId: string;
	readonly payloadDigest: string;
	readonly message: Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">;
	readonly origin: WorkerReceiptOrigin;
	readonly goalId?: string;
}

export interface ParentInputReceipt {
	readonly entryId: string;
	readonly sessionId: string;
}

export interface ParentInputDeliveryDeps {
	getSessionManager(): SessionManager;
	getAgent(): Pick<Agent, "state" | "resetSanitizerPrefixHorizon">;
	/** Existing lifecycle repair resolves interrupted provider/tool outcomes before continuation. */
	prepareHistory(lease: ForegroundSubmissionLease): void | Promise<void>;
	warn(message: string): void;
	onAccepted?(message: CustomMessage<unknown>, receipt: ParentInputReceipt): void;
	holdLateWork(work: Promise<void>): void;
	setRequestProjection(projection: ((base: AgentContextPlanFn) => AgentContextPlanFn) | undefined): void;
}

/** One canonical input, followed by a recoverable wake; never a second append to retry inference. */
export class ParentInputDeliveryController {
	private readonly deps: ParentInputDeliveryDeps;
	private readonly foreground: ForegroundRecoveryController;
	private readonly goals: Pick<GoalSessionController, "beginExecution">;
	private readonly afterTurn:
		| ((message: CustomMessage<unknown>, lease: ForegroundSubmissionLease) => Promise<void>)
		| undefined;
	private readonly unsubscribe: () => void;
	private readonly abort = new AbortController();
	private active = false;
	private readonly deliveries = new Set<Promise<ParentInputReceipt>>();
	private closed = false;
	private blocked = false;
	private blockedEpoch: number | undefined;
	private wake: Promise<void> | undefined;

	constructor(
		deps: ParentInputDeliveryDeps,
		foreground: ForegroundRecoveryController,
		goals: Pick<GoalSessionController, "beginExecution">,
		afterTurn?: (message: CustomMessage<unknown>, lease: ForegroundSubmissionLease) => Promise<void>,
	) {
		this.deps = deps;
		this.foreground = foreground;
		this.goals = goals;
		this.afterTurn = afterTurn;
		this.unsubscribe = foreground.subscribeActivity(() => {
			const epoch = foreground.getCurrentSubmissionEpoch();
			if (this.blocked && epoch !== undefined && epoch !== this.blockedEpoch) this.blocked = false;
			this.schedule();
		});
	}

	deliver(input: ParentInputDelivery): Promise<ParentInputReceipt> {
		const delivery = this.accept(input);
		this.deliveries.add(delivery);
		void delivery.then(
			() => this.deliveries.delete(delivery),
			() => this.deliveries.delete(delivery),
		);
		return delivery;
	}

	private async accept(input: ParentInputDelivery): Promise<ParentInputReceipt> {
		if (this.closed) throw new Error("Parent input delivery is closed.");
		const origin = workerReceiptOriginFromValue(input.origin);
		const message = parentInputMessage(
			{
				deliveryId: input.deliveryId,
				payloadDigest: input.payloadDigest,
				origin,
				...(input.goalId ? { goalId: input.goalId } : {}),
			},
			input.message,
		);
		const manager = this.deps.getSessionManager();
		const lease = await this.foreground.acquireSubmission(this.abort.signal);
		let receipt: ParentInputReceipt;
		try {
			if (this.closed || lease.signal.aborted || this.deps.getSessionManager() !== manager)
				throw new Error("Parent input session changed before acceptance.");
			const appended = manager.appendParentInput(message);
			const entry = appended.entries[0];
			if (appended.durability !== "persisted" || appended.entries.length !== 1 || !entry)
				throw new Error("Parent input has no physical canonical receipt.");
			const agent = this.deps.getAgent();
			agent.state.messages = manager.buildSessionContext().messages;
			agent.resetSanitizerPrefixHorizon();
			receipt = { entryId: entry.id, sessionId: appended.sessionId };
			if (appended.created) {
				try {
					this.deps.onAccepted?.(message, receipt);
				} catch {
					try {
						this.deps.warn("Parent input was saved, but its display notification failed.");
					} catch {
						/* Persistence stands. */
					}
				}
			}
		} finally {
			this.foreground.releaseSubmission(lease);
		}
		this.blocked = false;
		this.schedule();
		return receipt;
	}

	start(): void {
		this.active = true;
		this.recover();
	}

	async settled(): Promise<void> {
		while (this.wake || this.deliveries.size)
			await Promise.allSettled([...this.deliveries, ...(this.wake ? [this.wake] : [])]);
	}

	/** Explicit recovery only; a failed wake does not retry itself in a tight loop. */
	recover(): void {
		this.blocked = false;
		this.schedule();
	}

	shutdown(): void {
		this.closed = true;
		this.abort.abort(new Error("Parent input delivery closed."));
		this.unsubscribe();
	}

	private schedule(): void {
		if (!this.active || this.closed || this.blocked || this.wake) return;
		try {
			if (this.deps.getSessionManager().getPendingParentInputs().length === 0) return;
		} catch (error) {
			this.fail(error);
			return;
		}
		this.wake = Promise.resolve()
			.then(() => this.drain())
			.catch((error: unknown) => this.fail(error))
			.finally(() => {
				this.wake = undefined;
				if (!this.blocked) this.schedule();
			});
	}

	private assertCurrent(manager: SessionManager, input: PersistedParentInput, lease: ForegroundSubmissionLease): void {
		const origin = workerReceiptOriginFromValue(input.metadata.origin);
		if (
			this.closed ||
			lease.signal.aborted ||
			!this.foreground.ownsSubmission(lease) ||
			this.deps.getSessionManager() !== manager ||
			(origin.sessionFile !== undefined && origin.sessionFile !== manager.getSessionFile()) ||
			!isSessionAppendAnchorCurrent(manager, origin) ||
			!manager.isEntryPersisted(input.entryId)
		)
			throw new Error("Parent input wake lost its original session branch.");
	}

	private async drain(): Promise<void> {
		const manager = this.deps.getSessionManager();
		const lease = await this.foreground.acquireSubmission(this.abort.signal);
		let deactivate: (() => void) | undefined;
		try {
			const wake = manager.beginParentInputWake();
			if (!wake) return;
			const pending = new Map(manager.getPendingParentInputs().map((input) => [input.entryId, input]));
			const inputs = wake.inputs.map((item) => {
				const input = pending.get(item.entryId);
				if (
					!input ||
					input.metadata.deliveryId !== item.deliveryId ||
					input.metadata.payloadDigest !== item.payloadDigest
				)
					throw new Error("Parent wake no longer matches its exact accepted inputs.");
				this.assertCurrent(manager, input, lease);
				return input;
			});
			// This is an orchestration batch, never one input's goal applied to another input.
			this.goals.beginExecution(undefined);
			await this.deps.prepareHistory(lease);
			for (const input of inputs) this.assertCurrent(manager, input, lease);
			const agent = this.deps.getAgent();
			agent.state.messages = manager.buildSessionContext().messages;
			agent.resetSanitizerPrefixHorizon();
			const opening = agent.state.messages.find(
				(message) => manager.getMessageEntryId(message) === inputs[0]!.entryId,
			);
			if (opening?.role !== "custom") throw new Error("The first parent input is missing from canonical history.");
			deactivate = manager.activateParentInputWake(wake.wakeId);
			const selected = new Set(wake.inputs.map((input) => input.deliveryId));
			const unselected = new Set(
				manager
					.getPendingParentInputs()
					.filter((input) => !selected.has(input.metadata.deliveryId))
					.map((input) => input.metadata.deliveryId),
			);
			const keep = (message: AgentMessage): boolean => {
				if (
					message.role !== "custom" ||
					!isPlainRecord(message.details) ||
					!isPlainRecord(message.details.parentInput)
				)
					return true;
				return !unselected.has(String(message.details.parentInput.deliveryId));
			};
			this.deps.setRequestProjection((base) => async (request, signal) => {
				for (const input of inputs) this.assertCurrent(manager, input, lease);
				const messages = request.messages.filter(keep);
				const sentPrefixCount = request.messages.slice(0, request.sentPrefixCount).filter(keep).length;
				const plan = await base(
					{
						...request,
						messages,
						sentPrefixCount,
						...(request.wire ? { wire: { ...request.wire, messages: request.wire.messages?.filter(keep) } } : {}),
					},
					signal,
				);
				return {
					...plan,
					messages: plan.messages.filter(keep),
					...(plan.transientMessages ? { transientMessages: plan.transientMessages.filter(keep) } : {}),
				};
			});
			if (!manager.getParentInputWake()?.completed)
				await this.foreground.runCommittedHistory(opening, lease, this.abort.signal);
			for (const input of inputs) this.assertCurrent(manager, input, lease);
			if (!manager.getParentInputWake()?.completed)
				throw new Error("Parent wake has no matching terminal provider answer.");
			await this.afterTurn?.(opening, lease);
			for (const input of inputs) this.assertCurrent(manager, input, lease);
			manager.settleParentInputWake(wake.wakeId);
		} catch (error) {
			this.blockedEpoch = lease.epoch;
			this.blocked = true;
			throw error;
		} finally {
			this.deps.setRequestProjection(undefined);
			deactivate?.();
			this.foreground.releaseSubmission(lease);
		}
	}

	private fail(error: unknown): void {
		this.blocked = true;
		const diagnostic = boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error));
		try {
			this.deps.warn(`Parent input remains pending: ${diagnostic ?? "wake unavailable"}`);
		} catch {
			/* A warning cannot erase durable pending work. */
		}
	}
}
