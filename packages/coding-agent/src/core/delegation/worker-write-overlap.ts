/**
 * Concurrent-write attribution between in-process workers.
 *
 * Workers share a checkout and are deliberately not serialized: a worker with no explicit workspace holds no
 * write reservation, so two of them can write the same file at the same time. Serializing them would cost
 * long durable work, so the host attributes instead: it remembers which files each worker changed and when it
 * ran, and when a worker finishes it reports every path another worker, whose run overlapped in time, also
 * changed. The finding names the path and both workers, goes to the parent as a claim blocker (parent review),
 * and never blocks either worker.
 *
 * Only changes the host can see are compared: the files a worker's `write`/`edit` tools and reported actions
 * changed (the claim's `changedFiles`). A shell redirect or a script a worker runs is not in that set.
 */

import path from "node:path";
import { HOST_FINDING_PREFIX } from "../autonomy/host-finding-prefixes.ts";

const MAX_FINISHED_SPANS = 128;
const MAX_FINDINGS = 12;
/** A claim blocker longer than 1000 characters is dropped whole, so a finding is kept well inside it. */
const MAX_PATH_CHARS = 300;

export interface WorkerWriteSpanInput {
	laneId: string;
	agentId: string;
	/** The directory this worker's relative changed files resolve against. */
	cwd: string;
	/** The worker's live changed-file set while it runs (cwd-relative or absolute). */
	changedFiles: () => Iterable<string>;
}

interface ActiveSpan extends WorkerWriteSpanInput {
	startedAt: number;
}

interface FinishedSpan {
	laneId: string;
	agentId: string;
	startedAt: number;
	endedAt: number;
	files: ReadonlySet<string>;
}

function absoluteFiles(cwd: string, files: Iterable<string>): Set<string> {
	const resolved = new Set<string>();
	for (const file of files) resolved.add(path.resolve(cwd, file));
	return resolved;
}

function clip(value: string): string {
	return value.length > MAX_PATH_CHARS ? `${value.slice(0, MAX_PATH_CHARS - 1)}…` : value;
}

const MAX_CLAIM_HOST_FINDINGS = 8;

/**
 * The host findings one claim carries: the first {@link MAX_CLAIM_HOST_FINDINGS}, then one bounded line saying how
 * many were left out, so a cut is always visible. A claim holds at most 32 blockers of 1,000 characters.
 */
export function boundHostFindings(findings: readonly string[]): string[] {
	if (findings.length <= MAX_CLAIM_HOST_FINDINGS) return [...findings];
	const omitted = findings.length - MAX_CLAIM_HOST_FINDINGS;
	return [
		...findings.slice(0, MAX_CLAIM_HOST_FINDINGS),
		`${HOST_FINDING_PREFIX.omitted} ${omitted} further host finding(s) were omitted from this claim to keep it bounded; review the protected paths and the files this worker changed directly.`,
	];
}

export class WorkerWriteOverlapTracker {
	private readonly active = new Map<string, ActiveSpan>();
	private finished: FinishedSpan[] = [];

	/** Start tracking one worker run. */
	begin(span: WorkerWriteSpanInput, now = Date.now()): void {
		this.active.set(span.laneId, { ...span, startedAt: now });
	}

	/**
	 * One finding per path this worker changed that another worker, whose run overlapped this one, also
	 * changed. Read-only: it can be asked repeatedly (and again after the run ends) and never alters a worker.
	 */
	findingsFor(laneId: string, now = Date.now()): string[] {
		const mine = this.active.get(laneId);
		if (!mine) return [];
		const myFiles = absoluteFiles(mine.cwd, mine.changedFiles());
		if (myFiles.size === 0) return [];
		const others: { laneId: string; agentId: string; files: ReadonlySet<string> }[] = [];
		for (const other of this.active.values()) {
			if (other.laneId === laneId || other.agentId === mine.agentId) continue;
			others.push({
				laneId: other.laneId,
				agentId: other.agentId,
				files: absoluteFiles(other.cwd, other.changedFiles()),
			});
		}
		for (const done of this.finished) {
			if (done.laneId === laneId || done.agentId === mine.agentId) continue;
			if (done.endedAt < mine.startedAt || done.startedAt > now) continue;
			others.push(done);
		}
		const findings: string[] = [];
		let omitted = 0;
		for (const other of others) {
			for (const file of myFiles) {
				if (!other.files.has(file)) continue;
				if (findings.length >= MAX_FINDINGS) {
					omitted += 1;
					continue;
				}
				findings.push(
					`${HOST_FINDING_PREFIX.overlap} ${clip(file)} was changed by both worker ${laneId} (agent ${mine.agentId}) and worker ${other.laneId} (agent ${other.agentId}) while their runs overlapped, with no write reservation between them. Neither was blocked; compare both changes before accepting either.`,
				);
			}
		}
		if (omitted > 0)
			findings.push(`${HOST_FINDING_PREFIX.overlap} ${omitted} further overlapping path(s) not listed.`);
		return findings;
	}

	/** The run ended: keep what it changed and when, for the runs that overlapped it and finish later. */
	end(laneId: string, now = Date.now()): void {
		const span = this.active.get(laneId);
		if (!span) return;
		this.active.delete(laneId);
		this.finished.push({
			laneId,
			agentId: span.agentId,
			startedAt: span.startedAt,
			endedAt: now,
			files: absoluteFiles(span.cwd, span.changedFiles()),
		});
		// A finished run only matters to a run that started before it ended: drop what predates every active run.
		const earliestActive = Math.min(
			Number.POSITIVE_INFINITY,
			...[...this.active.values()].map((entry) => entry.startedAt),
		);
		this.finished = this.finished.filter((entry) => entry.endedAt >= earliestActive).slice(-MAX_FINISHED_SPANS);
	}
}
