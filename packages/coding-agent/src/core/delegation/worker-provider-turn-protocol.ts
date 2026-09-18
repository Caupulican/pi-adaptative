import { addUsage, createEmptyUsage } from "@caupulican/pi-agent-core/usage";
import type { Usage } from "@caupulican/pi-ai";
import { usageDeltaFromProviderUsage } from "../orchestration/attempt-usage.ts";
import type { GatewayUsageDelta, ProviderBudgetReservation } from "../orchestration/capability-gateway.ts";

export class WorkerCompletionProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerCompletionProtocolError";
	}
}

function positiveUsageDelta(reported: Usage, accounted: Usage): Required<GatewayUsageDelta> {
	return {
		inputTokens: Math.max(0, reported.input - accounted.input),
		outputTokens: Math.max(0, reported.output - accounted.output),
		cacheReadTokens: Math.max(0, reported.cacheRead - accounted.cacheRead),
		cacheWriteTokens: Math.max(0, reported.cacheWrite - accounted.cacheWrite),
		totalTokens: Math.max(0, reported.totalTokens - accounted.totalTokens),
		costUsd: Math.max(0, reported.cost.total - accounted.cost.total),
	};
}

function hasUsage(delta: Required<GatewayUsageDelta>): boolean {
	return (
		delta.inputTokens !== 0 ||
		delta.outputTokens !== 0 ||
		delta.cacheReadTokens !== 0 ||
		delta.cacheWriteTokens !== 0 ||
		delta.totalTokens !== 0 ||
		delta.costUsd !== 0
	);
}

/**
 * Owns one provider request's reservation epochs and usage evidence. The caller remains responsible
 * for persisting the assistant and checkpoint between accounting and consuming an epoch.
 */
export class WorkerProviderTurnProtocol {
	private readonly acquireReservation: () => Promise<ProviderBudgetReservation>;
	private readonly recordUsage: ((delta: GatewayUsageDelta) => void) | undefined;
	private readonly signal: AbortSignal;
	private readonly onFailure: (error: unknown) => void;
	private readonly callbackAccountedUsage = createEmptyUsage();
	private readonly chargedUsage = createEmptyUsage();
	private held: ProviderBudgetReservation | undefined;
	private heldConsumed = false;
	private assistantUsageAccounted = false;
	private inFlight = false;
	private generation = 0;
	private closed = false;
	private lateAssistantPending = false;
	private successfulPreflights = 0;
	private consumedPreflights = 0;

	constructor(options: {
		acquireReservation(): Promise<ProviderBudgetReservation>;
		recordUsage?(delta: GatewayUsageDelta): void;
		signal: AbortSignal;
		onFailure(error: unknown): void;
	}) {
		this.acquireReservation = options.acquireReservation;
		this.recordUsage = options.recordUsage;
		this.signal = options.signal;
		this.onFailure = options.onFailure;
	}

	async requestPreflight(): Promise<{ maxTokens: number }> {
		if (this.closed || this.inFlight || (this.held && !this.heldConsumed)) {
			const error = new WorkerCompletionProtocolError(
				"Worker completion attempted an overlapping or out-of-order provider preflight.",
			);
			this.generation += 1;
			this.onFailure(error);
			this.releaseHeldReservation();
			throw error;
		}
		// A terminal assistant retains capacity until either its result is reconciled or the adapter
		// proves that another provider turn is starting.
		this.releaseHeldReservation();
		this.inFlight = true;
		const generation = ++this.generation;
		let acquired: ProviderBudgetReservation | undefined;
		try {
			acquired = await this.acquireReservation();
			this.signal.throwIfAborted();
			if (this.closed || generation !== this.generation) {
				throw new WorkerCompletionProtocolError(
					"Worker completion provider preflight resolved after its ownership fence closed.",
				);
			}
			this.held = acquired;
			this.heldConsumed = false;
			this.assistantUsageAccounted = false;
			acquired = undefined;
			this.successfulPreflights += 1;
			return { maxTokens: this.held.maxTokens };
		} catch (error) {
			this.onFailure(error);
			acquired?.release();
			this.releaseHeldReservation();
			throw error;
		} finally {
			this.inFlight = false;
		}
	}

	accountAssistantUsage(usage: Usage): void {
		this.assertOutstandingReservation();
		if (this.assistantUsageAccounted) {
			this.fail(
				new WorkerCompletionProtocolError(
					"Worker completion attempted to account more than one assistant under one provider preflight.",
				),
			);
		}
		this.recordAssistantReceipt(usage);
		this.assistantUsageAccounted = true;
	}

	/** Billing survives abort for the one admitted response that had not yet been accounted. */
	accountLateAssistantUsage(usage: Usage): void {
		if (!this.closed || !this.signal.aborted || !this.lateAssistantPending) {
			this.fail(new WorkerCompletionProtocolError("Worker completion has no pending late assistant receipt."));
		}
		this.recordAssistantReceipt(usage);
		this.lateAssistantPending = false;
	}

	/** Account usage before releasing a tool-request turn for nested or subsequent provider work. */
	consumeToolAssistantAndRelease(): void {
		this.consumeAccountedAssistant();
		this.releaseHeldReservation();
	}

	/** Account usage while retaining a terminal turn's remaining capacity through result verification. */
	consumeTerminalAssistantAndHold(): void {
		this.consumeAccountedAssistant();
	}

	assertEverySuccessfulPreflightConsumed(): void {
		if (
			!this.inFlight &&
			(!this.held || this.heldConsumed) &&
			this.consumedPreflights === this.successfulPreflights
		) {
			return;
		}
		this.fail(
			new WorkerCompletionProtocolError(
				"Worker completion returned with a provider preflight authority epoch that no assistant consumed.",
			),
		);
	}

	assertProviderOutputPreflight(kind: "completion" | "compaction" = "completion"): void {
		if (this.successfulPreflights > 0) return;
		this.fail(
			new WorkerCompletionProtocolError(
				kind === "compaction"
					? "Worker compaction returned provider output without a successful authority preflight."
					: "Worker completion returned provider output without a successful authority preflight.",
			),
		);
	}

	hasSuccessfulPreflight(): boolean {
		return this.successfulPreflights > 0;
	}

	hasOutstandingAssistantReservation(): boolean {
		return this.held !== undefined && !this.heldConsumed;
	}

	/** Conservatively charge only provider-result usage not already evidenced by assistant callbacks. */
	accountUnverifiedResultUsageDelta(reported: Usage): boolean {
		return this.chargeCumulativeUsage(reported);
	}

	close(): void {
		if (!this.closed) {
			this.lateAssistantPending = this.hasOutstandingAssistantReservation() && !this.assistantUsageAccounted;
			this.closed = true;
			this.generation += 1;
		}
		this.releaseHeldReservation();
	}

	private recordAssistantReceipt(usage: Usage): void {
		try {
			usageDeltaFromProviderUsage(usage);
		} catch (error) {
			this.onFailure(error);
			throw error;
		}
		const cumulative = structuredClone(this.callbackAccountedUsage);
		addUsage(cumulative, usage);
		this.chargeCumulativeUsage(cumulative);
		addUsage(this.callbackAccountedUsage, usage);
	}

	/** Callback sums and a returned aggregate describe the same spend, in either arrival order. */
	private chargeCumulativeUsage(reported: Usage): boolean {
		try {
			usageDeltaFromProviderUsage(reported);
			const delta = positiveUsageDelta(reported, this.chargedUsage);
			if (!hasUsage(delta)) return false;
			this.recordUsage?.(delta);
			addUsage(this.chargedUsage, {
				input: delta.inputTokens,
				output: delta.outputTokens,
				cacheRead: delta.cacheReadTokens,
				cacheWrite: delta.cacheWriteTokens,
				totalTokens: delta.totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: delta.costUsd },
			});
			return this.recordUsage !== undefined;
		} catch (error) {
			this.onFailure(error);
			throw error;
		}
	}

	private consumeAccountedAssistant(): void {
		this.assertOutstandingReservation();
		if (!this.assistantUsageAccounted) {
			this.fail(
				new WorkerCompletionProtocolError(
					"Worker completion attempted to consume an assistant before its provider usage was accounted.",
				),
			);
		}
		this.consumedPreflights += 1;
		this.heldConsumed = true;
	}

	private assertOutstandingReservation(): void {
		if (this.held && !this.heldConsumed) return;
		this.fail(
			new WorkerCompletionProtocolError(
				"Worker completion attempted to persist an assistant without a held provider reservation.",
			),
		);
	}

	private releaseHeldReservation(): void {
		const held = this.held;
		this.held = undefined;
		this.heldConsumed = false;
		this.assistantUsageAccounted = false;
		held?.release();
	}

	private fail(error: WorkerCompletionProtocolError): never {
		this.onFailure(error);
		throw error;
	}
}
