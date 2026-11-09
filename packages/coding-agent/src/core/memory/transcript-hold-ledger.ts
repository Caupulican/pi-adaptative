/**
 * Hold ledger of the transcript memory coordinator: the jobs held before any provider call (by the scope of the
 * condition that releases them), the model-work block edge, what re-admission found for each accepted node this run,
 * and the re-admission jobs whose own judgment is being applied. Every change is a command of this object, so no
 * module outside it writes these containers.
 */

import type { HoldScope, ParkedHold } from "./transcript-job-outcome.ts";
import type { TranscriptReadmissionWait } from "./transcript-memory-status.ts";
import type { TranscriptSummaryHeldByKind } from "./transcript-summary-store.ts";

/** What re-admission found for an accepted node: `waiting` carries the wait code that says why it has not been judged. */
export type ReadmissionHoldState = "admitted" | "rejected" | "uncertain" | "unavailable" | "waiting";

export interface ReadmissionHold {
	state: ReadmissionHoldState;
	wait?: TranscriptReadmissionWait;
}

export class HoldLedger {
	/** Jobs held before any provider call, by the scope of the condition that releases them. */
	private readonly held = new Map<string, ParkedHold>();
	private modelBlocked = false;
	/** Per node, what re-admission found this run. */
	private readonly readmitted = new Map<string, ReadmissionHold>();
	/** Re-admission jobs whose own judgment is being applied: their node's revocation is their result, not their end. */
	private readonly settlingJobs = new Set<string>();

	get parked(): ReadonlyMap<string, ParkedHold> {
		return this.held;
	}

	get readmission(): ReadonlyMap<string, ReadmissionHold> {
		return this.readmitted;
	}

	get settling(): ReadonlySet<string> {
		return this.settlingJobs;
	}

	park(jobId: string, hold: ParkedHold): void {
		this.held.set(jobId, hold);
	}

	unpark(jobId: string): void {
		this.held.delete(jobId);
	}

	/** Releases the held jobs whose condition (`scope`) cleared; they are claimed again on the next pump. */
	release(scope: HoldScope): void {
		for (const [id, hold] of this.held) if (hold.scope === scope) this.held.delete(id);
	}

	/**
	 * Drops the holds of jobs that no longer wait: `stateOf` gives a job's scheduler state. A job waiting for its retry is
	 * still held: it would otherwise come back unheld when it is due.
	 */
	prune(stateOf: (jobId: string) => string | undefined): void {
		for (const id of [...this.held.keys()]) {
			const state = stateOf(id);
			if (state !== "queued" && state !== "retry_wait") this.held.delete(id);
		}
	}

	/**
	 * Model work becoming possible again (the block edge) releases the jobs held for it and clears the re-admission
	 * states that waited on it.
	 */
	modelWork(blocked: boolean): void {
		if (this.modelBlocked && !blocked) {
			this.release("model_work");
			for (const [id, hold] of this.readmitted) {
				if (hold.state === "unavailable" || hold.state === "waiting") this.readmitted.delete(id);
			}
		}
		this.modelBlocked = blocked;
	}

	setReadmission(nodeId: string, state: ReadmissionHoldState, wait?: TranscriptReadmissionWait): void {
		this.readmitted.set(nodeId, wait === undefined ? { state } : { state, wait });
	}

	/** The outcome this judgment records is its own: a hold an earlier attempt left on the node is never read as its result. */
	clearReadmission(nodeId: string): void {
		this.readmitted.delete(nodeId);
	}

	clearWaiting(): void {
		for (const [id, hold] of this.readmitted) if (hold.state === "waiting") this.readmitted.delete(id);
	}

	beginSettling(jobId: string): void {
		this.settlingJobs.add(jobId);
	}

	endSettling(jobId: string): void {
		this.settlingJobs.delete(jobId);
	}

	/** The held jobs by scope. */
	counts(): TranscriptSummaryHeldByKind {
		const counts: TranscriptSummaryHeldByKind = {};
		for (const { scope } of this.held.values()) counts[scope] = (counts[scope] ?? 0) + 1;
		return counts;
	}

	/** The first held job's hold: its kind and the cause recorded when it was set. */
	first(): ParkedHold | undefined {
		for (const hold of this.held.values()) return hold;
		return undefined;
	}

	/** A run starts with nothing held and nothing judged; the settling set belongs to jobs in flight and is kept. */
	reset(): void {
		this.held.clear();
		this.modelBlocked = false;
		this.readmitted.clear();
	}
}
