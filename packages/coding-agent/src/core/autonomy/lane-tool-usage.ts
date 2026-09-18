import type { AgentToolResult } from "@caupulican/pi-agent-core";
import type { Usage } from "@caupulican/pi-ai";
import { EMPTY_ATTEMPT_USAGE, usageDeltaFromProviderUsage } from "../orchestration/attempt-usage.ts";

type BilledUsage = ReturnType<typeof usageDeltaFromProviderUsage>;

/** One accounting path for service receipts and their later transcript projections. */
export class LaneToolUsage {
	private readonly recordUsage: ((usage: BilledUsage) => void) | undefined;
	private readonly reported = new Map<string, BilledUsage>();
	private readonly activeInvocations = new Set<string>();
	private readonly pendingFinalReceipts = new Set<string>();
	private checkpoint: (() => void) | undefined;
	private checkpointPending = false;
	private closed = false;

	constructor(recordUsage?: (usage: BilledUsage) => void) {
		this.recordUsage = recordUsage;
	}

	bindCheckpoint(checkpoint: () => void): void {
		if (this.checkpoint) throw new Error("Lane tool usage already has a checkpoint owner.");
		this.checkpoint = checkpoint;
	}

	assertOpen(): void {
		if (this.closed) throw new Error("Lane tool usage owner is closed.");
	}

	/** Execution may stop awaiting a tool before its service response finishes decoding. */
	async run<T extends AgentToolResult<unknown>>(toolCallId: string, invoke: () => Promise<T> | T): Promise<T> {
		this.assertOpen();
		if (
			this.activeInvocations.has(toolCallId) ||
			this.pendingFinalReceipts.has(toolCallId) ||
			this.reported.has(toolCallId)
		) {
			throw new Error("Lane tool invocation identity is already active.");
		}
		this.activeInvocations.add(toolCallId);
		try {
			const result = await invoke();
			// A tool may declare its first receipt only in its final result. Keep that admitted
			// identity until message settlement; accounting here could replace a valid result on error.
			if (result.usage !== undefined) this.pendingFinalReceipts.add(toolCallId);
			return result;
		} finally {
			this.activeInvocations.delete(toolCallId);
			this.releaseSettledCheckpoint();
		}
	}

	/** Reports are cumulative within one invocation, including billed transport retries. */
	report(toolCallId: string, usage: Usage): void {
		if (
			this.closed &&
			!this.activeInvocations.has(toolCallId) &&
			!this.pendingFinalReceipts.has(toolCallId) &&
			!this.reported.has(toolCallId)
		) {
			throw new Error("Lane tool usage owner is closed.");
		}
		const current = usageDeltaFromProviderUsage(usage);
		const previous = this.reported.get(toolCallId) ?? EMPTY_ATTEMPT_USAGE;
		const delta = { ...current };
		let changed = false;
		for (const key of Object.keys(delta) as Array<keyof BilledUsage>) {
			delta[key] -= previous[key];
			if (delta[key] < 0) throw new Error("Billed tool usage cannot decrease within an invocation.");
			changed ||= delta[key] > 0;
		}
		if (changed) this.recordUsage?.(delta);
		this.reported.set(toolCallId, current);
		this.checkpointPending ||= changed;
		// Persist before the tool returns, archives evidence, or waits for another transport attempt.
		this.flushCheckpoint();
	}

	settle(toolCallId: string, usage?: Usage): void {
		if (usage) this.report(toolCallId, usage);
		else this.flushCheckpoint();
		this.reported.delete(toolCallId);
		this.pendingFinalReceipts.delete(toolCallId);
		this.releaseSettledCheckpoint();
	}

	private flushCheckpoint(): void {
		if (!this.checkpointPending || !this.checkpoint) return;
		this.checkpoint();
		// A failed durable write remains pending even when its receipt is already charged.
		this.checkpointPending = false;
	}

	close(): void {
		this.closed = true;
		// Stop new execution immediately, but preserve billing for admitted asynchronous work.
		// A failed flush must retain both the invocation baseline and its retry-capable owner.
		this.flushCheckpoint();
		this.releaseSettledCheckpoint();
	}

	private releaseSettledCheckpoint(): void {
		if (
			this.closed &&
			this.activeInvocations.size === 0 &&
			this.pendingFinalReceipts.size === 0 &&
			this.reported.size === 0 &&
			!this.checkpointPending
		) {
			this.checkpoint = undefined;
		}
	}
}
