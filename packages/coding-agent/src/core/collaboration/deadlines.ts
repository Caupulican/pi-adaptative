export interface CollaborationDeadline {
	jobId: string;
	agentId: string;
	turnId: string;
	deadlineAt: number;
}
interface DeadlineEntry {
	turn: CollaborationDeadline;
	attempts: number;
	timer?: ReturnType<typeof setTimeout>;
}

/** Admission is durable before cleanup I/O, so replacing the observer cannot reset its retry budget. */
export function reserveCollaborationCleanupAttempt(
	store: CollaborationJobStore,
	turn: CollaborationDeadline,
): number | undefined {
	let attempt: number | undefined;
	store.update(turn.jobId, (job) => {
		const agent = job.agents.find((member) => member.id === turn.agentId);
		if (!agent || agent.closed || job.dismissed || agent.turnId !== turn.turnId) return;
		const key = `cleanup:${agent.id}`;
		const previous: unknown = job.metadata[key] ? JSON.parse(job.metadata[key]) : undefined;
		if (previous !== undefined && !Value.Check(cleanupAttemptsSchema, previous))
			throw new Error("Invalid durable collaboration cleanup budget.");
		const count = previous && previous.turnId === turn.turnId ? previous.attempts : 0;
		attempt = count >= 3 ? 0 : count + 1;
		if (attempt) job.metadata[key] = JSON.stringify({ turnId: turn.turnId, attempts: attempt });
	});
	return attempt;
}

/** One-shot turn watchdogs and a bounded cleanup retry ladder; never reads process output. */
export class CollaborationDeadlines {
	private readonly entries = new Map<string, DeadlineEntry>();
	private readonly stop: (jobId: string, agentId: string, turnId: string) => Promise<unknown>;
	private readonly failed: (turn: CollaborationDeadline, error: unknown) => void;
	private readonly reserveAttempt?: (turn: CollaborationDeadline) => number | undefined;
	private disposed = false;
	constructor(
		stop: CollaborationDeadlines["stop"],
		failed: CollaborationDeadlines["failed"],
		reserveAttempt?: CollaborationDeadlines["reserveAttempt"],
	) {
		this.stop = stop;
		this.failed = failed;
		this.reserveAttempt = reserveAttempt;
	}
	reconcile(turns: readonly CollaborationDeadline[]): void {
		if (this.disposed) return;
		const active = new Set<string>();
		for (const turn of turns) {
			const key = `${turn.jobId}:${turn.agentId}:${turn.turnId}`;
			active.add(key);
			if (this.entries.has(key)) continue;
			const entry = { turn, attempts: 0 };
			this.entries.set(key, entry);
			this.schedule(key, entry, Math.max(1, turn.deadlineAt - Date.now() + 10000));
		}
		for (const [key, entry] of this.entries)
			if (!active.has(key)) {
				clearTimeout(entry.timer);
				this.entries.delete(key);
			}
	}
	private schedule(key: string, entry: DeadlineEntry, delay: number): void {
		entry.timer = setTimeout(() => {
			try {
				const attempt = this.reserveAttempt ? this.reserveAttempt(entry.turn) : entry.attempts + 1;
				if (attempt === undefined) return;
				if (attempt === 0) throw new Error("Collaboration cleanup retry budget is exhausted; work remains fenced.");
				entry.attempts = attempt;
			} catch (error) {
				this.failed(entry.turn, error);
				return;
			}
			void this.stop(entry.turn.jobId, entry.turn.agentId, entry.turn.turnId).catch((error: unknown) => {
				if (this.disposed || this.entries.get(key) !== entry) return;
				if (entry.attempts < 3) this.schedule(key, entry, entry.attempts === 1 ? 1000 : 5000);
				else this.failed(entry.turn, error);
			});
		}, delay);
		entry.timer.unref();
	}
	dispose(): void {
		this.disposed = true;
		for (const entry of this.entries.values()) clearTimeout(entry.timer);
		this.entries.clear();
	}
}

import { Type } from "typebox";
import { Value } from "typebox/value";
import type { CollaborationJobStore } from "./job-store.ts";

const cleanupAttemptsSchema = Type.Object(
	{ turnId: Type.String({ maxLength: 128 }), attempts: Type.Integer({ minimum: 0, maximum: 3 }) },
	{ additionalProperties: false },
);
