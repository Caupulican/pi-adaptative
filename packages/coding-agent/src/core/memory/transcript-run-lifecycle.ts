/**
 * Run lifecycle of the transcript memory coordinator: whether a run is starting or started, the epoch that fences its
 * background work, the start-up phase that orders admission and discovery, the summary writer and scheduler the run
 * holds, the reason it is disabled and the issues its recovery found. Each change is a command of this object; the
 * coordinator keeps the effects of starting, halting and stopping (timers, subscriptions, in-flight work).
 */

import type { TranscriptSummaryScheduler } from "./transcript-summary-scheduler.ts";
import type { TranscriptSummaryWriter } from "./transcript-summary-store.ts";

/**
 * Start-up order: `convert` (the first save turns stale version 1 jobs into durable carried budgets), then `reconcile`
 * (every recovered job adopts its version 1 budget), then `reconciled` (the save of that), then `open`: only that save's
 * acknowledgement opens admission, dispatch and discovery.
 */
export type StartPhase = "convert" | "reconcile" | "reconciled" | "open";

export class TranscriptRunState {
	private runEpoch = 0;
	private isStarted = false;
	private isStarting = false;
	private phaseNow: StartPhase = "convert";
	/** Discovery reached before admission opened; opening starts it. */
	private discoveryHeldNow = false;
	private writerNow: TranscriptSummaryWriter | undefined;
	private schedulerNow: TranscriptSummaryScheduler | undefined;
	private disabledNow: string | undefined;
	private issuesNow: string[] = [];

	get epoch(): number {
		return this.runEpoch;
	}

	get started(): boolean {
		return this.isStarted;
	}

	get starting(): boolean {
		return this.isStarting;
	}

	get phase(): StartPhase {
		return this.phaseNow;
	}

	get writer(): TranscriptSummaryWriter | undefined {
		return this.writerNow;
	}

	get scheduler(): TranscriptSummaryScheduler | undefined {
		return this.schedulerNow;
	}

	get disabledReason(): string | undefined {
		return this.disabledNow;
	}

	get recoveryIssues(): string[] {
		return this.issuesNow;
	}

	/** The epoch a new run starts in; every background result of an earlier epoch is discarded. */
	nextEpoch(): number {
		return ++this.runEpoch;
	}

	setStarting(on: boolean): void {
		this.isStarting = on;
	}

	markStarted(): void {
		this.isStarted = true;
	}

	/**
	 * Ends the run and its epoch: called before any background work is aborted, so every epoch check of the old run fails
	 * from now on.
	 */
	halt(): void {
		this.isStarted = false;
		this.runEpoch += 1;
	}

	/** The run lets go of its writer and scheduler once a stop has handed its terminal work over. */
	release(): void {
		this.writerNow = undefined;
		this.schedulerNow = undefined;
	}

	setWriter(writer: TranscriptSummaryWriter | undefined): void {
		this.writerNow = writer;
	}

	setScheduler(scheduler: TranscriptSummaryScheduler | undefined): void {
		this.schedulerNow = scheduler;
	}

	setDisabledReason(reason: string | undefined): void {
		this.disabledNow = reason;
	}

	setRecoveryIssues(issues: string[]): void {
		this.issuesNow = issues;
	}

	setPhase(phase: StartPhase): void {
		this.phaseNow = phase;
	}

	holdDiscovery(): void {
		this.discoveryHeldNow = true;
	}

	clearDiscoveryHold(): void {
		this.discoveryHeldNow = false;
	}

	/** Takes a held discovery: true when one was held (it is no longer held afterwards). */
	takeHeldDiscovery(): boolean {
		if (!this.discoveryHeldNow) return false;
		this.discoveryHeldNow = false;
		return true;
	}
}
