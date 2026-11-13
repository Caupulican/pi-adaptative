import type { Agent, CustomMessage } from "../kernel/index.ts";
import {
	type ParentInputAppendReceipt,
	type ParentInputMode,
	type PersistedParentInput,
	parentInputMessage,
} from "../kernel/session/parent-input-ledger.ts";
import { expectedSessionAppendDurability } from "../kernel/session/session-append-receipt.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { ForegroundRecoveryController, ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import { type WorkerReceiptOrigin, workerReceiptOriginFromValue } from "./orchestration/worker-receipt-origin.ts";
import { ParentInputSteerController, type SteeredMessage } from "./parent-input-steer.ts";
import type { RuntimeWorkLease } from "./runtime-generation-admission.ts";
import { boundedRedactedDiagnosticText } from "./security/secret-text.ts";
import { isSessionAppendAnchorCurrent } from "./session-snapshot.ts";

/**
 * How an input reaches the session. `turn` starts a turn of its own and `next-owner-turn` rides with the owner's next turn
 * (both durable ledger inputs). `steer` is read by a running turn at its next model step, and starts a turn like `turn` when
 * none is running.
 */
export type ParentInputDeliveryMode = ParentInputMode | "steer";

export interface ParentInputDelivery {
	readonly deliveryId: string;
	readonly payloadDigest: string;
	readonly message: Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">;
	readonly origin: WorkerReceiptOrigin;
	readonly goalId?: string;
	readonly mode?: ParentInputDeliveryMode;
}

/** An input as the durable ledger holds it: one of its own modes. */
type LedgerParentInput = Omit<ParentInputDelivery, "mode"> & { readonly mode?: ParentInputMode };

/** Throws unless `origin` is the manager's own session and an anchor of its current durable branch. */
function assertOriginCurrent(manager: SessionManager, origin: WorkerReceiptOrigin): void {
	if (
		origin.sessionId !== manager.getSessionId() ||
		(manager.isPersisted() ? origin.sessionFile !== manager.getSessionFile() : origin.sessionFile !== undefined) ||
		!isSessionAppendAnchorCurrent(manager, origin) ||
		!manager.isEntryDurableForSession(origin.leafId)
	)
		throw new Error("Parent input session or branch changed before acceptance.");
}

/** Live acceptance authority is never serialized with the durable input. */
export interface ParentInputDeliveryOptions {
	readonly runtimeLease?: RuntimeWorkLease;
	readonly beforeOwnership?: () => void;
	/** Called under the canonical transcript lock for a new append, after replay lookup. */
	readonly withAppend?: (append: () => ParentInputAppendReceipt) => ParentInputAppendReceipt;
	readonly signal?: AbortSignal;
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
	/** Queues a message for the running turn's next model step; absent, a steered input starts a turn like `turn`. */
	steer?(message: Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">): SteeredMessage;
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
	private readonly steers: ParentInputSteerController | undefined;
	private readonly abort = new AbortController();
	private active = false;
	private readonly deliveries = new Set<Promise<ParentInputReceipt>>();
	private closed = false;
	private blocked = false;
	private blockedEpoch: number | undefined;
	private wake: Promise<void> | undefined;
	private readonly deferredDisplays = new Map<
		string,
		{ message: CustomMessage<unknown>; receipt: ParentInputReceipt; assertCurrent: () => void }
	>();

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
		const steer = deps.steer?.bind(deps);
		this.steers = steer
			? new ParentInputSteerController({
					foreground,
					getSessionManager: () => deps.getSessionManager(),
					steer,
					deliverDurable: (input, options) => this.deliverLedger({ ...input, mode: "turn" }, options),
					assertAcceptable: (manager, input) =>
						assertOriginCurrent(manager, workerReceiptOriginFromValue(input.origin)),
				})
			: undefined;
		this.unsubscribe = foreground.subscribeActivity(() => {
			this.steers?.rerouteIdle();
			const epoch = foreground.getCurrentSubmissionEpoch();
			if (this.blocked && epoch !== undefined && epoch !== this.blockedEpoch) this.blocked = false;
			this.schedule();
		});
	}

	deliver(input: ParentInputDelivery, options?: ParentInputDeliveryOptions): Promise<ParentInputReceipt> {
		if (input.mode !== "steer") return this.deliverLedger({ ...input, mode: input.mode }, options);
		return this.track(
			this.steers ? this.steers.deliver(input, options) : this.accept({ ...input, mode: "turn" }, options),
		);
	}

	/** Called immediately before the running turn polls its steering queue. */
	flushSteers(): void {
		this.steers?.flush();
	}

	private deliverLedger(input: LedgerParentInput, options?: ParentInputDeliveryOptions): Promise<ParentInputReceipt> {
		return this.track(this.accept(input, options));
	}

	private track(delivery: Promise<ParentInputReceipt>): Promise<ParentInputReceipt> {
		this.deliveries.add(delivery);
		void delivery.then(
			() => this.deliveries.delete(delivery),
			() => this.deliveries.delete(delivery),
		);
		return delivery;
	}

	private async accept(
		input: LedgerParentInput,
		options: ParentInputDeliveryOptions = {},
	): Promise<ParentInputReceipt> {
		if (this.closed) throw new Error("Parent input delivery is closed.");
		const mode = input.mode ?? "turn";
		const { runtimeLease, beforeOwnership } = options;
		const signal = options.signal ? AbortSignal.any([this.abort.signal, options.signal]) : this.abort.signal;
		signal.throwIfAborted();
		const origin = workerReceiptOriginFromValue(input.origin);
		const message = parentInputMessage(
			{
				deliveryId: input.deliveryId,
				payloadDigest: input.payloadDigest,
				origin,
				mode,
				...(input.goalId ? { goalId: input.goalId } : {}),
			},
			input.message,
		);
		const manager = this.deps.getSessionManager();
		const assertBranch = manager.captureBranchContext();
		const assertAcceptance = (): void => {
			signal.throwIfAborted();
			assertBranch();
			if (this.closed || this.deps.getSessionManager() !== manager)
				throw new Error("Parent input session or branch changed before acceptance.");
			assertOriginCurrent(manager, origin);
		};
		const lease = await this.foreground.acquireSubmission(signal, {
			runtimeLease,
			beforeOwnership: () => {
				assertAcceptance();
				beforeOwnership?.();
				assertAcceptance();
			},
		});
		let receipt: ParentInputReceipt | undefined;
		let failure: unknown;
		try {
			assertAcceptance();
			this.foreground.assertSubmissionCurrent(lease);
			const appended = manager.appendParentInput(message, options.withAppend);
			const entry = appended.entries[0];
			if (
				appended.durability !== expectedSessionAppendDurability(manager.isPersisted()) ||
				appended.entries.length !== 1 ||
				!entry
			)
				throw new Error("Parent input has no physical canonical receipt.");
			receipt = { entryId: entry.id, sessionId: appended.sessionId };
			if (mode === "next-owner-turn" && appended.created) {
				for (const [id, display] of this.deferredDisplays) {
					try {
						display.assertCurrent();
					} catch {
						this.deferredDisplays.delete(id);
					}
				}
				this.deferredDisplays.set(input.deliveryId, {
					message,
					receipt,
					assertCurrent: () => {
						assertBranch();
						if (this.deps.getSessionManager() !== manager)
							throw new Error("Parent note display session changed.");
					},
				});
			}
			// Receipt truth is established before any fallible projection or display effect.
			// Pending note exposure is governed by the request projection; keep canonical
			// history complete so a consumed note remains available to later turns.
			try {
				const agent = this.deps.getAgent();
				agent.state.messages = manager.buildSessionContext().messages;
				agent.resetSanitizerPrefixHorizon();
			} catch (error) {
				this.reportAcceptedFailure("context projection", error);
			}
			if (mode === "turn" && appended.created) {
				try {
					this.deps.onAccepted?.(message, receipt);
				} catch (error) {
					this.reportAcceptedFailure("display notification", error);
				}
			}
		} catch (error) {
			failure = error;
		} finally {
			try {
				this.foreground.releaseSubmission(lease);
			} catch (error) {
				if (receipt) this.reportAcceptedFailure("foreground release", error);
				else
					failure =
						failure === undefined
							? error
							: new AggregateError([failure, error], "Parent input acceptance and release failed.");
			}
		}
		if (!receipt) throw failure ?? new Error("Parent input was not accepted.");
		if (failure !== undefined) this.reportAcceptedFailure("post-acceptance processing", failure);
		if (mode === "turn") {
			this.blocked = false;
			try {
				this.schedule();
			} catch (error) {
				this.reportAcceptedFailure("wake scheduling", error);
			}
		}
		return receipt;
	}

	/** Only notes created in this runtime need an event; restored history renders older notes. */
	displayAcceptedNotes(deliveryIds: readonly string[]): void {
		if (this.closed) return;
		for (const id of deliveryIds) {
			const display = this.deferredDisplays.get(id);
			if (!display) continue;
			this.deferredDisplays.delete(id);
			try {
				display.assertCurrent();
			} catch {
				continue;
			}
			try {
				this.deps.onAccepted?.(display.message, display.receipt);
			} catch (error) {
				this.reportAcceptedFailure("deferred note display", error);
			}
		}
	}

	private reportAcceptedFailure(effect: string, error: unknown): void {
		try {
			const diagnostic = boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error));
			this.deps.warn(
				`Parent input was saved, but ${effect} failed: ${diagnostic ?? "unavailable"}. It remains recoverable.`,
			);
		} catch {
			/* Diagnostics cannot reject a physical acceptance receipt. */
		}
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
		this.deferredDisplays.clear();
		this.steers?.shutdown();
		this.abort.abort(new Error("Parent input delivery closed."));
		this.unsubscribe();
	}

	private schedule(): void {
		if (!this.active || this.closed || this.blocked || this.wake) return;
		try {
			if (this.deps.getSessionManager().getPendingParentInputs("turn").length === 0) return;
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

	/** Throws, naming which one ended, unless the wake still holds its delivery, its foreground turn, its session and its branch. */
	private assertCurrent(manager: SessionManager, input: PersistedParentInput, lease: ForegroundSubmissionLease): void {
		const origin = workerReceiptOriginFromValue(input.metadata.origin);
		if (this.closed) throw new Error("Parent input wake was stopped: its delivery closed with the session.");
		if (lease.signal.aborted || !this.foreground.ownsSubmission(lease))
			throw new Error("Parent input wake lost its foreground turn: it was aborted or replaced.");
		if (
			this.deps.getSessionManager() !== manager ||
			(manager.isPersisted()
				? origin.sessionFile !== undefined && origin.sessionFile !== manager.getSessionFile()
				: origin.sessionFile !== undefined)
		)
			throw new Error("Parent input wake lost its original session: the session or its file changed.");
		if (!isSessionAppendAnchorCurrent(manager, origin))
			throw new Error("Parent input wake lost its original session branch.");
		if (!manager.isEntryDurableForSession(input.entryId))
			throw new Error("Parent input wake's input is not durable in this session.");
	}

	private async drain(): Promise<void> {
		const manager = this.deps.getSessionManager();
		const lease = await this.foreground.acquireSubmission(this.abort.signal);
		let deactivate: (() => void) | undefined;
		try {
			const wake = manager.beginParentInputWake();
			if (!wake) return;
			const pending = new Map(manager.getPendingParentInputs("turn").map((input) => [input.entryId, input]));
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
